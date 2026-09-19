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
// 账号额度查询：ccusage-collect --limits claude-code --dir /home/u/.claude
//   读取该目录下 CLI 自己保存的登录令牌，向服务商查询 5 小时 / 周额度的已用比例与刷新时间。
//   只读：不刷新令牌（刷新会让正在使用的 CLI 掉线）；令牌只在本机使用，输出里只有百分比与时间。
//
//   可用 "ccusageCommand": ["/path/npx", "--yes", "ccusage@latest"] 代替 ccusageBin：每次采集自动确认并使用最新版；
//   此时不要设置 expectedCcusageVersion。

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const COLLECTOR_VERSION = '1.5.0';
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
    if (!/^--(source|dir|since|until|timezone|limits)$/.test(key ?? '') || value === undefined) fail('BAD_ARGS', '不支持的参数');
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

// ---------------------------------------------------------------- 账号额度

/** 非交互 SSH 会话通常没有代理变量：依次从当前环境、登录 shell、Claude 的 settings.json 里找 */
async function proxyEnv(realDir) {
  const pick = (env) => Object.fromEntries(Object.entries(env).filter(([k, v]) => /^(https?|all|no)_proxy$/i.test(k) && v));
  const usable = (env) => Object.keys(env).some((k) => /^(https?|all)_proxy$/i.test(k)); // 只有 no_proxy 不算配置了代理
  let found = pick(process.env);
  if (!usable(found)) {
    const login = await run('bash', ['-lc', 'env'], { PATH: process.env.PATH, HOME: process.env.HOME }, 8000);
    if (!login.error) found = pick(Object.fromEntries(String(login.stdout).split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })));
  }
  if (!usable(found)) {
    try { found = pick(JSON.parse(readFileSync(join(realDir, 'settings.json'), 'utf8')).env ?? {}); } catch { /* 没有该文件或没有 env 段 */ }
  }
  return found;
}

/** 令牌经标准输入交给 curl（不出现在进程命令行里）；curl 会遵循代理环境变量 */
function httpGetJson(url, headers, env) {
  const cfg = [`url = "${url}"`, 'silent', 'max-time = 25', 'write-out = "\\n%{http_code}"', ...headers.map((h) => `header = "${h.replace(/["\\\r\n]/g, '')}"`)].join('\n');
  return new Promise((resolve) => {
    const child = execFile('curl', ['--config', '-'], { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ status: 0, error: error.killed ? '请求超时' : `curl 失败（${error.code ?? '未知'}）` });
      const out = String(stdout); const i = out.lastIndexOf('\n');
      let json; try { json = JSON.parse(out.slice(0, i)); } catch { /* 非 JSON */ }
      resolve({ status: Number(out.slice(i + 1)), json });
    });
    child.stdin.end(cfg);
  });
}

const toIso = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : null);

const LIMIT_PROVIDERS = {
  'claude-code': {
    async query(realDir, env) {
      let cred;
      try { cred = JSON.parse(readFileSync(join(realDir, '.credentials.json'), 'utf8')).claudeAiOauth; } catch { fail('NO_LOGIN', '该目录下没有 Claude Code 的订阅登录信息（.credentials.json）'); }
      if (!cred?.accessToken) fail('NO_LOGIN', 'Claude Code 不是订阅登录（可能用的是 API Key），没有 5 小时 / 周额度');
      if (cred.expiresAt && cred.expiresAt < Date.now()) fail('TOKEN_EXPIRED', '登录令牌已过期：等该账户下次使用 Claude Code 时会自动续期（平台不会替它续期）');
      const r = await httpGetJson('https://api.anthropic.com/api/oauth/usage', [`Authorization: Bearer ${cred.accessToken}`, 'anthropic-beta: oauth-2025-04-20', 'User-Agent: claude-cli/2.0.0 (external, cli)'], env);
      if (r.status !== 200 || !r.json) fail(r.status === 401 ? 'TOKEN_EXPIRED' : 'LIMITS_UNAVAILABLE', r.error ?? `服务商返回 ${r.status}${r.json?.error?.message ? `：${String(r.json.error.message).slice(0, 120)}` : ''}`);
      const w = (key, label, minutes) => (r.json[key] ? { key, label, windowMinutes: minutes, usedPercent: pct(r.json[key].utilization), resetsAt: toIso(r.json[key].resets_at) } : null);
      return { plan: cred.subscriptionType ?? null, windows: [w('five_hour', '5 小时', 300), w('seven_day', '每周', 10080), w('seven_day_opus', '每周 · Opus', 10080), w('seven_day_sonnet', '每周 · Sonnet', 10080)].filter(Boolean) };
    },
  },
  codex: {
    async query(realDir, env) {
      let auth;
      try { auth = JSON.parse(readFileSync(join(realDir, 'auth.json'), 'utf8')); } catch { fail('NO_LOGIN', '该目录下没有 Codex 的登录信息（auth.json）'); }
      if (!auth?.tokens?.access_token) fail('NO_LOGIN', 'Codex 不是 ChatGPT 账号登录（可能用的是 API Key），没有 5 小时 / 周额度');
      const r = await httpGetJson('https://chatgpt.com/backend-api/wham/usage', [`Authorization: Bearer ${auth.tokens.access_token}`, ...(auth.tokens.account_id ? [`chatgpt-account-id: ${auth.tokens.account_id}`] : []), 'User-Agent: codex_cli_rs/0.50.0'], env);
      if (r.status !== 200 || !r.json) fail(r.status === 401 ? 'TOKEN_EXPIRED' : 'LIMITS_UNAVAILABLE', r.error ?? `服务商返回 ${r.status}${r.json?.error?.code ? `：${String(r.json.error.code).slice(0, 60)}` : ''}`);
      const rl = r.json.rate_limit ?? r.json.rate_limits ?? {};
      const w = (src, fallbackKey) => {
        if (!src) return null;
        const seconds = src.limit_window_seconds ?? (src.window_minutes ? src.window_minutes * 60 : null);
        const minutes = seconds ? Math.round(seconds / 60) : null;
        const resets = src.reset_at ?? src.resets_at ?? (typeof src.reset_after_seconds === 'number' ? Date.now() + src.reset_after_seconds * 1000 : null);
        const weekly = minutes ? minutes >= 1440 : fallbackKey === 'seven_day';
        return { key: weekly ? 'seven_day' : 'five_hour', label: weekly ? '每周' : minutes && minutes !== 300 ? `${Math.round(minutes / 60)} 小时` : '5 小时', windowMinutes: minutes, usedPercent: pct(src.used_percent), resetsAt: toIso(resets) };
      };
      const windows = [w(rl.primary_window ?? rl.primary, 'five_hour'), w(rl.secondary_window ?? rl.secondary, 'seven_day')].filter(Boolean);
      // 接口结构与预期不符时，只回传字段名（不含任何取值），便于排查
      if (windows.length === 0) fail('LIMITS_UNPARSED', `无法识别服务商返回的额度结构（顶层字段：${Object.keys(r.json).slice(0, 12).join(', ')}）`);
      // shape：仅字段名与类型（数值只保留窗口长度这类非敏感量），用于在接口结构变化时排查
      const shape = (v, k = '') => (v === null ? null : Array.isArray(v) ? v.slice(0, 2).map((x) => shape(x)) : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, shape(x, kk)])) : /window_seconds|window_minutes/.test(k) ? v : typeof v);
      return { plan: r.json.plan_type ?? null, windows, shape: shape(r.json) };
    },
  },
};

async function mainLimits(args) {
  const provider = LIMIT_PROVIDERS[args.limits];
  if (!provider) fail('UNSUPPORTED_SOURCE', '不支持的数据源');
  if (!args.dir || !SAFE_PATH.test(args.dir) || args.dir.split('/').includes('..')) fail('BAD_ARGS', '目录参数不合法');
  Object.assign(echo, { limits: args.limits, dir: args.dir });
  let config;
  try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (err) { rethrowDone(err); fail('CONFIG_MISSING', `无法读取采集配置 ${CONFIG_PATH}`); }
  if (!existsSync(args.dir)) fail('DIR_MISSING', '数据目录不存在');
  const realDir = realpathSync(args.dir);
  if (!dirAllowed(realDir, config.allowedDirs ?? [])) fail('DIR_NOT_ALLOWED', '目录不在本机采集白名单内');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(await proxyEnv(realDir)) };
  const result = await provider.query(realDir, env);
  finish({ status: 'ok', fetchedAt: new Date().toISOString(), ...result });
}

async function main() {
  const args = parseArgs();
  if (args.limits !== undefined) return mainLimits(args);
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
