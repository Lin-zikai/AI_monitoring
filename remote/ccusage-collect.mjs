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
//     "costMode": "auto", "offline": true, "timeoutSeconds": 60, "allowAccountQueries": false }
//   timeoutSeconds：单次 ccusage 统计的时限。整个脚本另有总时限（totalTimeoutSeconds，默认 105 秒），
//   必须小于中央平台的 SSH 超时（默认 120 秒），否则平台先断开、远端进程却还在跑。
// 账号额度查询：ccusage-collect --limits claude-code --dir /home/u/.claude
//   读取该目录下 CLI 自己保存的登录令牌，向服务商查询 5 小时 / 周额度的已用比例与刷新时间。
//   只读：不刷新令牌（刷新会让正在使用的 CLI 掉线）；令牌只在本机使用，输出里只有百分比与时间。
//   查询额度需要读取登录令牌文件（.credentials.json / auth.json）。共用专用采集账户的部署方式下不建议给它这个权限：
//   配置 "allowAccountQueries": false 后，--limits / --identity 直接返回 ACCOUNT_QUERIES_DISABLED，平台视为“不支持”而不是故障。
//   未配置时默认允许（平台自动安装的场景：脚本就以该用户自己的身份运行）。
//
//   可用 "ccusageCommand": ["/path/npx", "--yes", "ccusage@latest"] 代替 ccusageBin：每次采集自动确认并使用最新版；
//   此时不要设置 expectedCcusageVersion。

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR_VERSION = '1.8.0';
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
    if (!/^--(source|dir|since|until|timezone|limits|identity)$/.test(key ?? '') || value === undefined) fail('BAD_ARGS', '不支持的参数');
    args[key.slice(2)] = value;
  }
  return args;
}

function normalizeDate(value) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value ?? '');
  if (!m) fail('BAD_ARGS', '日期格式应为 YYYYMMDD');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function dirAllowed(realDir, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
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

/** existsSync 在没有权限时同样返回 false：必须区分“不存在”与“无权访问”，否则读不了的目录会被当成“该用户没用过这个工具” */
export function probePath(path) {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'denied';
  }
}

// 总时限：必须小于中央平台的 SSH 超时（默认 120 秒），让平台拿到明确的超时错误码，而不是连接被掐断、远端进程继续空跑
const STARTED_AT = Date.now();
let totalBudgetMs = 105_000;
/** 某一步最多可用的时间：不超过它自己的上限，也不超过总时限里剩下的部分（reserveMs 留给后续步骤） */
const within = (stepMs, reserveMs = 0) => Math.max(0, Math.min(stepMs, STARTED_AT + totalBudgetMs - Date.now() - reserveMs));

const MAX_OUTPUT = 64 * 1024 * 1024;
const activeChildren = new Set();
// npx 会再拉起 node 子进程：只杀 npx 本身，真正干活的孙进程还在跑。子进程放在独立进程组里，超时后整组终止
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
}

function run(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) return resolve({ error: Object.assign(new Error('timeout'), { killed: true }), stdout: '', stderr: '' });
    let child;
    try {
      child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ error, stdout: '', stderr: '' });
    }
    activeChildren.add(child);
    const out = []; const errOut = [];
    let size = 0; let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ error, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') });
    };
    const abort = (error) => { killGroup(child); child.stdout.destroy(); child.stderr.destroy(); settle(error); };
    const timer = setTimeout(() => abort(Object.assign(new Error('timeout'), { killed: true })), timeoutMs);
    const collect = (list) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) return abort(new Error('输出过大'));
      list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(errOut));
    child.on('error', (error) => settle(error));
    child.on('close', (code, signal) => settle(code === 0 ? null : Object.assign(new Error(`exit ${code ?? signal}`), { code })));
  });
}

/** 登录 shell 的环境变量（代理、CLAUDE_CONFIG_DIR 等通常只写在 shell 配置里）；一次调用内只取一次 */
let loginEnvPromise;
function loginEnv() {
  loginEnvPromise ??= run('bash', ['-lc', 'env'], { PATH: process.env.PATH, HOME: process.env.HOME }, within(5000, 10000)).then((login) => {
    const env = {};
    if (!login.error) for (const line of String(login.stdout).split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); }
    return env;
  });
  return loginEnvPromise;
}

// ---------------------------------------------------------------- 账号额度

/** 非交互 SSH 会话通常没有代理变量：依次从当前环境、登录 shell、Claude 的 settings.json 里找 */
async function proxyEnv(realDir) {
  const pick = (env) => Object.fromEntries(Object.entries(env).filter(([k, v]) => /^(https?|all|no)_proxy$/i.test(k) && v));
  const usable = (env) => Object.keys(env).some((k) => /^(https?|all)_proxy$/i.test(k)); // 只有 no_proxy 不算配置了代理
  let found = pick(process.env);
  if (!usable(found)) found = pick(await loginEnv());
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

/** 这个目录登录的是哪个账号：只读 CLI 自己保存的账号信息，不联网。accountKey 是服务商的账号 ID（不是令牌），label 是登录邮箱 */
const IDENTITY = {
  'claude-code'(realDir, allowedDirs) {
    // Claude Code 把账号信息放在与 .claude 同级的 ~/.claude.json；设置了 CLAUDE_CONFIG_DIR 时则在目录内。
    // 同级的那份在数据目录之外：只有白名单放行了它所在的目录（自动安装时为 "**"），或把文件本身写进白名单
    // （如 "/home/*/.claude.json"）时才读；按解析符号链接后的真实路径判断。
    for (const file of [join(dirname(realDir), '.claude.json'), join(realDir, '.claude.json')]) {
      try {
        const real = realpathSync(file);
        if (!dirAllowed(dirname(real), allowedDirs) && !dirAllowed(real, allowedDirs)) continue;
        const a = JSON.parse(readFileSync(real, 'utf8')).oauthAccount;
        if (a?.accountUuid) return { accountKey: String(a.accountUuid), accountLabel: a.emailAddress ? String(a.emailAddress) : null };
      } catch { /* 换下一个位置 */ }
    }
    return null;
  },
  codex(realDir) {
    try {
      const auth = JSON.parse(readFileSync(join(realDir, 'auth.json'), 'utf8'));
      let claims = {};
      try { claims = JSON.parse(Buffer.from(String(auth.tokens.id_token).split('.')[1], 'base64url').toString('utf8')); } catch { /* id_token 不是 JWT */ }
      const key = auth.tokens?.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.sub;
      return key ? { accountKey: String(key), accountLabel: claims.email ? String(claims.email) : null } : null;
    } catch { return null; }
  },
};

/** Claude 的额度接口应答 → 窗口列表 */
export function claudeWindows(json) {
  const w = (key, label, minutes) => (json?.[key] ? { key, label, windowMinutes: minutes, usedPercent: pct(json[key].utilization), resetsAt: toIso(json[key].resets_at) } : null);
  return [w('five_hour', '5 小时', 300), w('seven_day', '每周', 10080), w('seven_day_opus', '每周 · Opus', 10080), w('seven_day_sonnet', '每周 · Sonnet', 10080)].filter(Boolean);
}

/**
 * Codex 的额度接口应答 → 窗口列表。窗口按时长归类：不足一天算短窗口（five_hour），一天及以上算长窗口（seven_day）。
 * key 是平台去重提醒、页面区分窗口的依据，必须唯一：两个窗口归到同一类时，后一个带上自己的时长（如 seven_day_1440m）。
 */
export function codexWindows(json, now = Date.now()) {
  const rl = json?.rate_limit ?? json?.rate_limits ?? {};
  const keys = new Set(); const labels = new Set();
  const windows = [];
  [[rl.primary_window ?? rl.primary, 'five_hour'], [rl.secondary_window ?? rl.secondary, 'seven_day']].forEach(([src, fallbackKey], index) => {
    if (!src || typeof src !== 'object') return;
    const seconds = src.limit_window_seconds ?? (src.window_minutes ? src.window_minutes * 60 : null);
    const minutes = typeof seconds === 'number' && seconds > 0 ? Math.round(seconds / 60) : null;
    const resets = src.reset_at ?? src.resets_at ?? (typeof src.reset_after_seconds === 'number' ? now + src.reset_after_seconds * 1000 : null);
    const long = minutes ? minutes >= 1440 : fallbackKey === 'seven_day';
    const base = long ? 'seven_day' : 'five_hour';
    let key = base;
    if (keys.has(key) && minutes) key = `${base}_${minutes}m`;
    if (keys.has(key)) key = `${base}_${index + 1}`;
    keys.add(key);
    let label = long
      ? (!minutes || Math.round(minutes / 1440) === 7 ? '每周' : `${Math.round(minutes / 1440)} 天`)
      : (minutes && minutes !== 300 ? `${Math.round(minutes / 60)} 小时` : '5 小时');
    if (labels.has(label)) label = `${label} · ${index + 1}`;
    labels.add(label);
    windows.push({ key, label, windowMinutes: minutes, usedPercent: pct(src.used_percent), resetsAt: toIso(resets) });
  });
  return windows;
}

const LIMIT_PROVIDERS = {
  'claude-code': {
    async query(realDir, env) {
      let cred;
      try { cred = JSON.parse(readFileSync(join(realDir, '.credentials.json'), 'utf8')).claudeAiOauth; } catch { fail('NO_LOGIN', '该目录下没有 Claude Code 的订阅登录信息（.credentials.json）'); }
      if (!cred?.accessToken) fail('NO_LOGIN', 'Claude Code 不是订阅登录（可能用的是 API Key），没有 5 小时 / 周额度');
      if (cred.expiresAt && cred.expiresAt < Date.now()) fail('TOKEN_EXPIRED', '登录令牌已过期：等该账户下次使用 Claude Code 时会自动续期（平台不会替它续期）');
      const r = await httpGetJson('https://api.anthropic.com/api/oauth/usage', [`Authorization: Bearer ${cred.accessToken}`, 'anthropic-beta: oauth-2025-04-20', 'User-Agent: claude-cli/2.0.0 (external, cli)'], env);
      if (r.status !== 200 || !r.json) fail(r.status === 401 ? 'TOKEN_EXPIRED' : 'LIMITS_UNAVAILABLE', r.error ?? `服务商返回 ${r.status}${r.json?.error?.message ? `：${String(r.json.error.message).slice(0, 120)}` : ''}`);
      return { plan: cred.subscriptionType ?? null, windows: claudeWindows(r.json) };
    },
  },
  codex: {
    async query(realDir, env) {
      let auth;
      try { auth = JSON.parse(readFileSync(join(realDir, 'auth.json'), 'utf8')); } catch { fail('NO_LOGIN', '该目录下没有 Codex 的登录信息（auth.json）'); }
      if (!auth?.tokens?.access_token) fail('NO_LOGIN', 'Codex 不是 ChatGPT 账号登录（可能用的是 API Key），没有 5 小时 / 周额度');
      const r = await httpGetJson('https://chatgpt.com/backend-api/wham/usage', [`Authorization: Bearer ${auth.tokens.access_token}`, ...(auth.tokens.account_id ? [`chatgpt-account-id: ${auth.tokens.account_id}`] : []), 'User-Agent: codex_cli_rs/0.50.0'], env);
      if (r.status !== 200 || !r.json) fail(r.status === 401 ? 'TOKEN_EXPIRED' : 'LIMITS_UNAVAILABLE', r.error ?? `服务商返回 ${r.status}${r.json?.error?.code ? `：${String(r.json.error.code).slice(0, 60)}` : ''}`);
      const windows = codexWindows(r.json);
      // 接口结构与预期不符时，只回传字段名（不含任何取值），便于排查
      if (windows.length === 0) fail('LIMITS_UNPARSED', `无法识别服务商返回的额度结构（顶层字段：${Object.keys(r.json).slice(0, 12).join(', ')}）`);
      // shape：仅字段名与类型（数值只保留窗口长度这类非敏感量），用于在接口结构变化时排查
      const shape = (v, k = '') => (v === null ? null : Array.isArray(v) ? v.slice(0, 2).map((x) => shape(x)) : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, shape(x, kk)])) : /window_seconds|window_minutes/.test(k) ? v : typeof v);
      return { plan: r.json.plan_type ?? null, windows, shape: shape(r.json) };
    },
  },
};

/**
 * 该账户实际使用的数据目录：CLI 支持用环境变量改目录（CLAUDE_CONFIG_DIR、CODEX_HOME），而这些变量通常写在 shell 配置里，
 * 非交互 SSH 会话看不到。从登录 shell 里读出来回报给平台，避免采集到一个早已不用的默认目录。
 */
async function configuredDirs() {
  const env = { ...process.env, ...(await loginEnv()) };
  const dirs = {};
  for (const [name, source] of Object.entries(SOURCES)) {
    const value = (env[source.dirEnv] ?? '').split(',')[0].trim().replace(/\/+$/, '');
    if (value && SAFE_PATH.test(value) && !value.split('/').includes('..') && probePath(value) === 'dir') dirs[name] = value;
  }
  return dirs;
}

function loadConfig() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    fail('CONFIG_MISSING', `无法读取采集配置 ${CONFIG_PATH}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('CONFIG_MISSING', `采集配置 ${CONFIG_PATH} 不是 JSON 对象`);
  if (typeof config.totalTimeoutSeconds === 'number' && Number.isFinite(config.totalTimeoutSeconds)) totalBudgetMs = Math.max(20, Math.min(3600, config.totalTimeoutSeconds)) * 1000;
  return config;
}

/** 校验并解析数据目录：区分“目录缺失”（DIR_MISSING）、“无权访问”（DIR_UNREADABLE）与“白名单之外”（DIR_NOT_ALLOWED） */
function resolveDataDir(dir, config) {
  const kind = probePath(dir);
  if (kind === 'missing') fail('DIR_MISSING', '数据目录不存在');
  if (kind === 'denied') fail('DIR_UNREADABLE', '采集账户没有权限访问数据目录（或它的上级目录）');
  if (kind !== 'dir') fail('DIR_MISSING', '数据路径不是目录');
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    fail('DIR_UNREADABLE', '无法访问数据目录');
  }
  if (!dirAllowed(realDir, Array.isArray(config.allowedDirs) ? config.allowedDirs : [])) fail('DIR_NOT_ALLOWED', '目录不在本机采集白名单内');
  return realDir;
}

/** --limits：查询额度；--identity：只报告账号标识（不联网） */
async function mainAccount(args) {
  const provider = args.limits ?? args.identity;
  if (!Object.hasOwn(LIMIT_PROVIDERS, provider)) fail('UNSUPPORTED_SOURCE', '不支持的数据源');
  if (!args.dir || !SAFE_PATH.test(args.dir) || args.dir.split('/').includes('..')) fail('BAD_ARGS', '目录参数不合法');
  Object.assign(echo, args.limits !== undefined ? { limits: provider } : { identity: provider }, { dir: args.dir });
  const config = loadConfig();
  // 账号查询要读登录令牌文件：共用采集账户的部署可以整体关闭，平台把这个错误码当作“不支持”，不算故障
  if (config.allowAccountQueries === false) fail('ACCOUNT_QUERIES_DISABLED', '本机采集配置未开启账号额度查询（allowAccountQueries）');
  const realDir = resolveDataDir(args.dir, config);
  Object.assign(echo, IDENTITY[provider](realDir, config.allowedDirs) ?? { accountKey: null, accountLabel: null }); // 即使后面查询失败，也带上账号标识
  if (args.identity !== undefined) {
    if (!echo.accountKey) fail('NO_LOGIN', '该目录下没有订阅账号的登录信息');
    finish({ status: 'ok' });
  }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(await proxyEnv(realDir)) };
  const result = await LIMIT_PROVIDERS[provider].query(realDir, env);
  finish({ status: 'ok', fetchedAt: new Date().toISOString(), ...result });
}

async function main() {
  const args = parseArgs();
  echo.configDirs = await configuredDirs();
  if (args.limits !== undefined || args.identity !== undefined) return mainAccount(args);
  const source = Object.hasOwn(SOURCES, args.source ?? '') ? SOURCES[args.source] : null;
  if (!source) fail('UNSUPPORTED_SOURCE', '不支持的数据源');
  if (!args.dir || !SAFE_PATH.test(args.dir) || args.dir.split('/').includes('..')) fail('BAD_ARGS', '目录参数不合法');
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(args.timezone ?? '')) fail('BAD_ARGS', '时区参数不合法');
  Object.assign(echo, { source: args.source, dir: args.dir, since: normalizeDate(args.since), until: normalizeDate(args.until), timezone: args.timezone });

  const config = loadConfig();

  // 区分“确实没有用量”与“目录缺失 / 权限异常”
  const realDir = resolveDataDir(args.dir, config);

  let logFiles = 0;
  const logRoot = join(realDir, source.logRoot);
  const logRootKind = probePath(logRoot);
  try {
    accessSync(realDir, constants.R_OK | constants.X_OK);
    if (logRootKind === 'denied') throw new Error('EACCES');
    if (logRootKind === 'dir') logFiles = countLogFiles(logRoot);
  } catch {
    fail('DIR_UNREADABLE', '采集账户没有数据目录的读取权限');
  }

  // ccusageCommand 形如 ["npx", "--yes", "ccusage@latest"]：首个元素是可执行文件，其余是固定前缀参数
  const command = Array.isArray(config.ccusageCommand) && config.ccusageCommand.every((c) => typeof c === 'string') && config.ccusageCommand.length > 0
    ? [...config.ccusageCommand] : [config.ccusageBin || 'ccusage'];
  const prefix = command.slice(1);
  const bin = command[0];
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', npm_config_yes: 'true', npm_config_update_notifier: 'false', [source.dirEnv]: realDir };

  // 经 npx 运行时可能要先下载新版本：给它 40 秒，同时为后面的统计留出时间；超时则退回本机已装的那份，或让平台稍后重试（下载缓存通常已就绪）
  let version = await run(bin, [...prefix, '--version'], childEnv, within(prefix.length ? 40000 : 15000, 30000));
  if (version.error && prefix.length && config.ccusageBin) {
    // 取不到最新版（多为 npm 源暂时不可达）：退回本机已安装的 ccusage，保证这一轮能采到
    command.splice(0, command.length, config.ccusageBin);
    version = await run(config.ccusageBin, ['--version'], childEnv, within(10000, 20000));
  }
  if (version.error?.killed) fail('CCUSAGE_TIMEOUT', command.length > 1 ? '通过 npx 获取 ccusage 超时（首次下载较慢，稍后重试通常即可）' : 'ccusage --version 执行超时');
  if (version.error) fail('CCUSAGE_MISSING', command.length > 1 ? '无法通过 npx 获取 ccusage（需要能访问 npm 源）' : '未找到 ccusage，请预装固定版本');
  const ccusageVersion = (/(\d+\.\d+\.\d+\S*)/.exec(version.stdout) ?? [])[1] ?? 'unknown';
  if (config.expectedCcusageVersion && ccusageVersion !== config.expectedCcusageVersion) {
    fail('CCUSAGE_VERSION_MISMATCH', `ccusage 版本为 ${ccusageVersion}，要求 ${config.expectedCcusageVersion}`);
  }

  const costMode = ['auto', 'calculate', 'display'].includes(config.costMode) ? config.costMode : 'auto';
  const offline = config.offline !== false;
  const meta = { ccusageVersion, costMode, offline, logFiles };
  const emptyReport = { daily: [] };

  // 没有 projects 目录时 ccusage 会报错退出；目录本身可读，属于“确实没有用量”
  if (source.requireLogRoot && logRootKind === 'missing') finish({ status: 'ok', ...meta, report: emptyReport });

  const ccArgs = [
    source.subcommand, 'daily', '--json', ...source.extraArgs(costMode),
    '--since', echo.since.replaceAll('-', ''), '--until', echo.until.replaceAll('-', ''),
    '--timezone', args.timezone, offline ? '--offline' : '--no-offline',
  ];
  const stepSeconds = typeof config.timeoutSeconds === 'number' && config.timeoutSeconds > 0 ? config.timeoutSeconds : 60;
  const result = await run(command[0], [...command.slice(1), ...ccArgs], childEnv, within(stepSeconds * 1000, 3000));
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

// 被测试代码 import 时只导出纯函数，不执行采集；判断不了就按“直接执行”处理
function isEntryPoint() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return true; }
}

// 业务错误通过信封传递并以 0 退出；非零退出码保留给脚本自身崩溃
if (isEntryPoint()) {
  // 平台断开连接或本脚本被终止时，不留下还在跑的 ccusage / npx
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    process.on(signal, () => { for (const child of activeChildren) killGroup(child); process.exit(143); });
  }
  main().catch((err) => {
    if (!(err instanceof Done)) throw err;
    // home：供平台在一步接入时推断各数据源的默认目录（~/.claude、~/.codex）
    process.stdout.write(JSON.stringify({ schema: 1, collectorVersion: COLLECTOR_VERSION, home: process.env.HOME, ...echo, ...err.payload }));
  });
}
