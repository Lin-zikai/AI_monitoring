#!/usr/bin/env node
// 受限采集脚本：部署在被采集服务器上，由中央平台通过 SSH 调用。
// 只接受白名单参数，只读取配置中允许的目录，只输出 ccusage 的统计 JSON（不含提示词、回答正文或会话日志）。
//
// 调用方式（二选一）：
//   1. 直接执行：ccusage-collect --source claude-code --dir /home/u/.claude --since 20260901 --until 20260919 --timezone Asia/Shanghai
//   2. authorized_keys forced command：command="/usr/local/bin/ccusage-collect",restrict ssh-ed25519 AAAA...
//      此时参数取自 SSH_ORIGINAL_COMMAND。
//
// 配置文件（默认 /etc/ccusage-collect/config.json）：
//   { "allowedDirs": ["/home/zhangsan/.claude", "/home/*/.claude"],
//     "ccusageBin": "/usr/local/bin/ccusage", "expectedCcusageVersion": "20.0.23",
//     "costMode": "auto", "offline": true, "timeoutSeconds": 100 }
//   可用 "ccusageCommand": ["/path/npx", "--yes", "ccusage@latest"] 代替 ccusageBin：每次采集自动确认并使用最新版；
//   此时不要设置 expectedCcusageVersion。

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const COLLECTOR_VERSION = '1.4.0';
const CONFIG_PATH = process.env.CCUSAGE_COLLECT_CONFIG || '/etc/ccusage-collect/config.json';
const SAFE_PATH = /^\/[A-Za-z0-9._@+\-/]*$/;
// requireLogRoot：Claude 没有 projects/ 时 ccusage 会报错，视为“确实没有用量”；Codex 的记录位置随版本变化（sessions/ 或 sqlite），交给 ccusage 判断
const SOURCES = {
  'claude-code': { subcommand: 'claude', dirEnv: 'CLAUDE_CONFIG_DIR', logRoot: 'projects', requireLogRoot: true, extraArgs: (mode) => ['--breakdown', '--order', 'asc', '--mode', mode] },
  codex: { subcommand: 'codex', dirEnv: 'CODEX_HOME', logRoot: 'sessions', requireLogRoot: false, extraArgs: () => [] },
};

const echo = {};

// finish/fail 通过抛出 Done 结束流程，由文件末尾统一输出（避免 process.exit 截断管道中的大输出）
class Done {
  constructor(payload) { this.payload = payload; }
}
function finish(payload) {
  throw new Done(payload);
}
const rethrowDone = (err) => { if (err instanceof Done) throw err; };
const fail = (code, message) => finish({ status: 'error', code, message });

function parseArgs() {
  let argv = process.argv.slice(2);
  const original = process.env.SSH_ORIGINAL_COMMAND;
  if (argv.length === 0 && original) argv = original.trim().split(/\s+/).slice(1); // 首个词是命令名
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!/^--(source|dir|since|until|timezone)$/.test(key ?? '') || value === undefined) fail('BAD_ARGS', '不支持的参数');
    args[key.slice(2)] = value;
  }
  return args;
}

function normalizeDate(value) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value ?? '');
  if (!m) fail('BAD_ARGS', '日期格式应为 YYYYMMDD');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function dirAllowed(realDir, patterns) {
  return patterns.some((pattern) => {
    if (pattern === '**') return true; // 平台自动安装的场景：账户本身有 shell 权限，白名单不构成边界
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) return false;
    // 仅支持 * 通配单个路径段，例如 /home/*/.claude
    const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
    return re.test(realDir);
  });
}

function countLogFiles(root, limit = 200000) {
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.name.endsWith('.jsonl')) count++;
    }
  }
  return count;
}

function run(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

async function main() {
  const args = parseArgs();
  const source = SOURCES[args.source];
  if (!source) fail('UNSUPPORTED_SOURCE', '不支持的数据源');
  if (!args.dir || !SAFE_PATH.test(args.dir) || args.dir.split('/').includes('..')) fail('BAD_ARGS', '目录参数不合法');
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(args.timezone ?? '')) fail('BAD_ARGS', '时区参数不合法');
  Object.assign(echo, { source: args.source, dir: args.dir, since: normalizeDate(args.since), until: normalizeDate(args.until), timezone: args.timezone });

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    rethrowDone(err);
    fail('CONFIG_MISSING', `无法读取采集配置 ${CONFIG_PATH}`);
  }

  // 区分“确实没有用量”与“目录缺失 / 权限异常”
  if (!existsSync(args.dir)) fail('DIR_MISSING', '数据目录不存在');
  let realDir;
  try {
    realDir = realpathSync(args.dir);
    if (!statSync(realDir).isDirectory()) fail('DIR_MISSING', '数据路径不是目录');
  } catch (err) {
    rethrowDone(err);
    fail('DIR_UNREADABLE', '无法访问数据目录');
  }
  if (!dirAllowed(realDir, config.allowedDirs ?? [])) fail('DIR_NOT_ALLOWED', '目录不在本机采集白名单内');

  let logFiles = 0;
  const logRoot = join(realDir, source.logRoot);
  try {
    accessSync(realDir, constants.R_OK | constants.X_OK);
    if (existsSync(logRoot)) logFiles = countLogFiles(logRoot);
  } catch (err) {
    rethrowDone(err);
    fail('DIR_UNREADABLE', '采集账户没有数据目录的读取权限');
  }

  // ccusageCommand 形如 ["npx", "--yes", "ccusage@latest"]：首个元素是可执行文件，其余是固定前缀参数
  const command = Array.isArray(config.ccusageCommand) && config.ccusageCommand.every((c) => typeof c === 'string') && config.ccusageCommand.length > 0
    ? [...config.ccusageCommand] : [config.ccusageBin || 'ccusage'];
  const prefix = command.slice(1);
  const bin = command[0];
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', npm_config_yes: 'true', npm_config_update_notifier: 'false', [source.dirEnv]: realDir };

  // 经 npx 运行时首次调用可能要下载新版本，给足时间
  let version = await run(bin, [...prefix, '--version'], childEnv, prefix.length ? 180000 : 20000);
  if (version.error && prefix.length && config.ccusageBin) {
    // 取不到最新版（多为 npm 源暂时不可达）：退回本机已安装的 ccusage，保证这一轮能采到
    command.splice(0, command.length, config.ccusageBin);
    version = await run(config.ccusageBin, ['--version'], childEnv, 20000);
  }
  if (version.error) fail('CCUSAGE_MISSING', prefix.length ? '无法通过 npx 获取 ccusage（需要能访问 npm 源）' : '未找到 ccusage，请预装固定版本');
  const ccusageVersion = (/(\d+\.\d+\.\d+\S*)/.exec(version.stdout) ?? [])[1] ?? 'unknown';
  if (config.expectedCcusageVersion && ccusageVersion !== config.expectedCcusageVersion) {
    fail('CCUSAGE_VERSION_MISMATCH', `ccusage 版本为 ${ccusageVersion}，要求 ${config.expectedCcusageVersion}`);
  }

  const costMode = ['auto', 'calculate', 'display'].includes(config.costMode) ? config.costMode : 'auto';
  const offline = config.offline !== false;
  const meta = { ccusageVersion, costMode, offline, logFiles };
  const emptyReport = { daily: [] };

  // 没有 projects 目录时 ccusage 会报错退出；目录本身可读，属于“确实没有用量”
  if (source.requireLogRoot && !existsSync(logRoot)) finish({ status: 'ok', ...meta, report: emptyReport });

  const ccArgs = [
    source.subcommand, 'daily', '--json', ...source.extraArgs(costMode),
    '--since', echo.since.replaceAll('-', ''), '--until', echo.until.replaceAll('-', ''),
    '--timezone', args.timezone, offline ? '--offline' : '--no-offline',
  ];
  const result = await run(command[0], [...command.slice(1), ...ccArgs], childEnv, (config.timeoutSeconds ?? 100) * 1000);
  if (result.error) {
    if (result.error.killed) fail('CCUSAGE_TIMEOUT', 'ccusage 执行超时');
    fail('CCUSAGE_FAILED', `ccusage 执行失败: ${String(result.stderr).slice(0, 300)}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    rethrowDone(err);
    fail('CCUSAGE_FAILED', 'ccusage 输出不是有效 JSON');
  }
  finish({ status: 'ok', ...meta, report });
}

// 业务错误通过信封传递并以 0 退出；非零退出码保留给脚本自身崩溃
main().catch((err) => {
  if (!(err instanceof Done)) throw err;
  // home：供平台在一步接入时推断各数据源的默认目录（~/.claude、~/.codex）
  process.stdout.write(JSON.stringify({ schema: 1, collectorVersion: COLLECTOR_VERSION, home: process.env.HOME, ...echo, ...err.payload }));
});
