import type { Logger } from 'pino';
import { z } from 'zod';
import { adminEmails, messageIdFor } from '../alerts/evaluate.js';
import { renderLimitAlert } from '../alerts/templates.js';
import { withTx, type Db } from '../db/pool.js';
import { sanitizeError } from '../logger.js';
import { unseal } from '../security/crypto.js';
import { isSafeAbsolutePath, isValidCollectCommand } from '../security/validate.js';
import type { RemoteExecutor, SshTarget } from '../ssh/client.js';
import { getGeneralSettings, getLimitAlertSettings } from '../settings.js';
import { dateInTz, isoWeekKey } from '../util/time.js';
import { CollectError, SOURCE_INFO, remoteErrorText, supportedSources } from './adapter.js';
import { bundledCollectorVersion, installCollector, isManagedCommand, isOlderVersion, type InstallMode } from './install.js';

// 账号额度：由被采集服务器上的采集脚本就地查询（登录令牌不离开那台机器），平台只拿到已用百分比与刷新时间。

const limitsEnvelope = z.object({
  schema: z.literal(1),
  status: z.enum(['ok', 'error']),
  collectorVersion: z.string().max(32).optional(),
  code: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
  configDirs: z.record(z.string(), z.string().max(512)).optional(),
  accountKey: z.string().max(128).nullish(),
  accountLabel: z.string().max(320).nullish(),
  plan: z.string().max(64).nullish(),
  shape: z.unknown().optional(),
  fetchedAt: z.string().optional(),
  windows: z.array(z.object({
    key: z.string().max(32),
    label: z.string().max(32),
    windowMinutes: z.number().nullable(),
    usedPercent: z.number().min(0).max(100).nullable(),
    resetsAt: z.string().nullable(),
  })).max(8).optional(),
});
export type LimitWindow = NonNullable<z.infer<typeof limitsEnvelope>['windows']>[number];

export interface LimitsDeps {
  db: Db; executor: RemoteExecutor; masterKey: Buffer; log: Logger; baseUrl?: string;
  now?: () => Date;
  /** 一轮刷新的总时限（默认 8 分钟，小于 10 分钟的调度间隔）：到点后不再发起新的远程调用，剩下的留给下一轮 */
  deadlineMs?: number;
}

export function buildAccountCommand(collectCommand: string, mode: 'limits' | 'identity', provider: string, dir: string): string {
  if (!isValidCollectCommand(collectCommand) || !supportedSources().includes(provider) || !isSafeAbsolutePath(dir)) throw new CollectError('BAD_ARGS', '额度查询参数不合法');
  return `${collectCommand} --${mode} ${provider} --dir ${dir}`;
}

// ---- 远端回报内容的整理。账号标识、邮箱、套餐名、窗口名都来自被采集服务器（其中邮箱取自远端用户可编辑的文件），
// 会进入数据库、页面和提醒邮件：一律按白名单整理，不符合的用中性的说法代替。

const ACCOUNT_KEY = /^[\w.@:|+=-]{1,128}$/;
const EMAIL_LIKE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;
const WINDOW_KEY = /^[a-z0-9_]{1,32}$/;
// 只有这几个窗口的名字无法从时长推出来；其余一律按窗口时长生成
const FIXED_WINDOW_LABELS: Record<string, string> = { seven_day_opus: '每周 · Opus', seven_day_sonnet: '每周 · Sonnet' };

/** 账号显示名只接受邮箱的样子；其他内容一律不显示（页面与邮件会写“未知账号”或只写服务商名） */
export function cleanAccountLabel(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v.length <= 254 && EMAIL_LIKE.test(v) ? v : null;
}

export const cleanPlan = (value: string | null | undefined): string | null => (value && PLAN_NAME.test(value.trim()) ? value.trim() : null);

/** 短窗口（5 小时一类）：默认不提醒，由设置里的 includeFiveHour 打开 */
const isShortWindow = (w: LimitWindow) => w.key.startsWith('five_hour');

function windowLabel(key: string, minutes: number | null): string {
  if (Object.hasOwn(FIXED_WINDOW_LABELS, key)) return FIXED_WINDOW_LABELS[key]!;
  if (minutes && minutes > 0) return minutes >= 1440 ? (Math.round(minutes / 1440) === 7 ? '每周' : `${Math.round(minutes / 1440)} 天`) : `${Math.max(1, Math.round(minutes / 60))} 小时`;
  return key.startsWith('five_hour') ? '5 小时' : key.startsWith('seven_day') ? '每周' : '其他窗口';
}

/**
 * 窗口的 key 是提醒去重、页面区分窗口的依据，必须唯一（旧版采集脚本会把 Codex 的两个长窗口都报成 seven_day）；
 * 显示名不采用远端给的文字，按 key 白名单 / 窗口时长生成。
 */
export function normalizeWindows(windows: LimitWindow[]): LimitWindow[] {
  const keys = new Set<string>(); const labels = new Set<string>();
  return windows.map((w, i) => {
    const base = WINDOW_KEY.test(w.key) ? w.key : `window_${i + 1}`;
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base.slice(0, 28)}_${n}`;
    keys.add(key);
    const baseLabel = windowLabel(key, w.windowMinutes);
    let label = baseLabel;
    for (let n = 2; labels.has(label); n++) label = `${baseLabel} · ${n}`;
    labels.add(label);
    const resetsAt = w.resetsAt && !Number.isNaN(Date.parse(w.resetsAt)) ? new Date(w.resetsAt).toISOString() : null;
    return { ...w, key, label, resetsAt };
  });
}

interface Candidate {
  target_id: string; server_id: string; server_name: string; data_dir: string; collect_command: string; install_mode: InstallMode;
  /** 采集命令由平台自动安装、且这个目标用的就是服务器登记的 SSH 账户：只有这种情况平台才会自动升级远端脚本 */
  upgradable: boolean;
  ssh: SshTarget; accountKey?: string; accountLabel?: string | null;
}

/** 该数据源下采集正常的全部目标，最近用量大的排前面（同一账号下优先用它查询：令牌最可能是新鲜的） */
async function candidates(deps: LimitsDeps, provider: string): Promise<Candidate[]> {
  const res = await deps.db.query(
    `SELECT t.id AS target_id, s.id AS server_id, s.name AS server_name, t.data_dir, s.collect_command, s.install_mode, s.host, s.port, s.host_key_fingerprint,
            COALESCE(t.ssh_username, s.ssh_username) AS username, (t.ssh_username IS NULL OR t.ssh_username = s.ssh_username) AS server_account,
            c.id AS credential_id, c.ciphertext, c.iv, c.auth_tag,
            (SELECT COALESCE(sum(d.total_tokens), 0) FROM usage_daily d WHERE d.target_id = t.id AND d.usage_date >= current_date - 2) AS recent
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
       JOIN credentials c ON c.id = COALESCE(t.credential_id, s.credential_id)
      WHERE t.source = $1 AND t.enabled AND s.enabled AND t.last_status = 'success' AND t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR'
        AND s.host_key_fingerprint IS NOT NULL AND c.revoked_at IS NULL
      ORDER BY recent DESC, t.last_success_at DESC LIMIT 60`,
    [provider],
  );
  const out: Candidate[] = [];
  for (const r of res.rows) {
    // 逐行解密：一份损坏的凭据只影响用它的目标，不能让整个数据源的额度查询停摆
    try {
      const secret = JSON.parse(unseal(deps.masterKey, { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, `credential:${r.credential_id}`)) as { privateKey: string; passphrase?: string };
      out.push({
        target_id: r.target_id, server_id: r.server_id, server_name: r.server_name, data_dir: r.data_dir, collect_command: r.collect_command, install_mode: r.install_mode,
        upgradable: isManagedCommand(r.collect_command) && r.server_account,
        ssh: { host: r.host, port: r.port, username: r.username, privateKey: secret.privateKey, passphrase: secret.passphrase, expectedHostFingerprint: r.host_key_fingerprint },
      });
    } catch (err) {
      deps.log.error({ provider, server: r.server_name, credentialId: r.credential_id }, `SSH 凭据解密失败，跳过该目标的额度查询: ${sanitizeError(err)}`);
    }
  }
  return out;
}

/** 一轮刷新的上下文：总时限，以及同一台服务器的全部候选（升级后要一起换成新的采集命令） */
interface RefreshRun { deps: LimitsDeps; deadline: number; candidates: Candidate[] }

const DEFAULT_DEADLINE_MS = 8 * 60_000;
const remainingMs = (run: RefreshRun) => run.deadline - Date.now();

async function ask(run: RefreshRun, c: Candidate, mode: 'limits' | 'identity', provider: string) {
  const budget = remainingMs(run);
  if (budget < 2000) throw new CollectError('DEADLINE', '本轮额度刷新已到时限，留待下一轮');
  const out = await run.deps.executor.exec(c.ssh, buildAccountCommand(c.collect_command, mode, provider, c.data_dir), Math.min(60_000, budget));
  let json: unknown;
  try { json = JSON.parse(out.stdout); } catch { throw new CollectError('BAD_OUTPUT', '远端没有返回结果'); }
  const env = limitsEnvelope.safeParse(json);
  if (!env.success) throw new CollectError('BAD_OUTPUT', '远端返回的结构不符合预期');
  if (env.data.status === 'error') throw new CollectError(env.data.code ?? 'REMOTE_ERROR', remoteErrorText(env.data.code ?? '', env.data.message, '查询失败'));
  if (env.data.accountKey != null && !ACCOUNT_KEY.test(env.data.accountKey)) throw new CollectError('BAD_OUTPUT', '远端返回的账号标识不合法');
  return { ...env.data, accountLabel: cleanAccountLabel(env.data.accountLabel), plan: cleanPlan(env.data.plan), windows: normalizeWindows(env.data.windows ?? []) };
}

// ---- 远端采集脚本的自动升级
// 每台服务器、每个随附版本只尝试一次：无论成败都记下来，几小时内不再重试（进程内记忆；进程重启后最多再试一次）。
// 否则一台升级不了的服务器会每 10 分钟重装一遍，每次最长数分钟。
const UPGRADE_BACKOFF_MS = 6 * 3_600_000;
const upgradeMemo = new Map<string, { bundledVersion: string; at: number }>();
const upgradesInFlight = new Map<string, Promise<boolean>>();
/** 仅供测试：清空“已尝试升级”的记忆 */
export const resetUpgradeMemo = () => { upgradeMemo.clear(); upgradesInFlight.clear(); };

async function systemAudit(deps: LimitsDeps, action: string, serverId: string, detail: Record<string, unknown>): Promise<void> {
  // 没有操作人：actor_user_id 为空，actor_email 记为 system，与管理员手动安装的审计记录区分
  await deps.db.query("INSERT INTO audit_logs (actor_user_id, actor_email, action, entity_type, entity_id, detail, ip) VALUES (NULL, 'system', $1, 'server', $2, $3, NULL)", [action, serverId, JSON.stringify(detail)])
    .catch((err) => deps.log.error({ err, action, serverId }, '审计日志写入失败'));
}

/**
 * 升级远端采集脚本；返回是否升级成功。
 * 只动平台自己装的（upgradable）；沿用这台服务器登记的安装方式（install_mode），不会把固定版本 / 复用已装的服务器悄悄改成“始终最新”；
 * 新的采集命令写回 servers.collect_command，并记审计日志。
 */
function upgradeCollector(run: RefreshRun, c: Candidate, reason: string): Promise<boolean> {
  const { deps } = run;
  if (!c.upgradable) return Promise.resolve(false);
  const inFlight = upgradesInFlight.get(c.server_id);
  if (inFlight) return inFlight; // 同一台服务器的其他目标：等这一次升级的结果，不重复安装
  const bundledVersion = bundledCollectorVersion();
  const memo = upgradeMemo.get(c.server_id);
  if (memo && memo.bundledVersion === bundledVersion && Date.now() - memo.at < UPGRADE_BACKOFF_MS) return Promise.resolve(false);
  if (remainingMs(run) < 30_000) return Promise.resolve(false);
  upgradeMemo.set(c.server_id, { bundledVersion, at: Date.now() });

  const attempt = (async () => {
    const before = c.collect_command;
    try {
      const result = await installCollector(deps.executor, c.ssh, { mode: c.install_mode, timeoutMs: Math.min(300_000, remainingMs(run)) });
      // 只在登记的命令没被管理员改过时写回
      await deps.db.query('UPDATE servers SET collect_command = $2, updated_at = now() WHERE id = $1 AND collect_command = $3', [c.server_id, result.collectCommand, before]);
      for (const other of run.candidates) if (other.server_id === c.server_id && other.collect_command === before) other.collect_command = result.collectCommand;
      await systemAudit(deps, 'server.auto_upgrade_collector', c.server_id, {
        reason, installMode: c.install_mode, collectorVersion: bundledVersion, collectCommand: result.collectCommand, previousCollectCommand: before,
        ccusageVersion: result.ccusageVersion, ccusageMode: result.ccusageMode,
      });
      deps.log.info({ server: c.server_name, collectorVersion: bundledVersion, installMode: c.install_mode }, '已自动升级远端采集脚本');
      return true;
    } catch (err) {
      const message = sanitizeError(err);
      await systemAudit(deps, 'server.auto_upgrade_collector_failed', c.server_id, { reason, installMode: c.install_mode, collectorVersion: bundledVersion, message: message.slice(0, 500) });
      deps.log.warn({ server: c.server_name }, `采集脚本自动升级未成功，沿用旧版本（${UPGRADE_BACKOFF_MS / 3_600_000} 小时内不再重试）: ${message}`);
      return false;
    }
  })().finally(() => upgradesInFlight.delete(c.server_id));
  upgradesInFlight.set(c.server_id, attempt);
  return attempt;
}

/** 远端采集脚本落后于平台随附的版本（或不认识新参数）时：自动安装的服务器先升级脚本再试一次；手工部署 / 受限密钥的服务器不动它，沿用旧结果 */
async function askWithUpgrade(run: RefreshRun, c: Candidate, mode: 'limits' | 'identity', provider: string) {
  let first;
  try {
    first = await ask(run, c, mode, provider);
  } catch (err) {
    if (!(err instanceof CollectError && err.code === 'BAD_ARGS') || !(await upgradeCollector(run, c, 'BAD_ARGS'))) throw err;
    return ask(run, c, mode, provider);
  }
  if (mode === 'identity' && isOlderVersion(first.collectorVersion, bundledCollectorVersion()) && await upgradeCollector(run, c, `outdated:${first.collectorVersion ?? 'unknown'}`)) {
    try { return await ask(run, c, mode, provider); } catch (err) { run.deps.log.warn({ server: c.server_name }, `升级后重新查询失败，沿用升级前的结果: ${sanitizeError(err)}`); }
  }
  return first;
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export interface LimitsOutcome { provider: string; accountLabel: string | null; ok: boolean; serverName?: string; code?: string; message?: string }

// 登录已过期 / 被吊销 / 没有订阅登录 / 本机关闭了账号查询：这个成员“查不了”，换一台也许就行；其余错误（网络、服务商接口）算“还活着”
const DEAD_CODES = new Set(['TOKEN_EXPIRED', 'NO_LOGIN', 'ACCOUNT_QUERIES_DISABLED']);
const MAX_MEMBER_TRIES = 8;
let refreshTurn = 0;

/**
 * 同一账号下这一轮依次尝试哪些成员：最近用量最大的两台总是先试（令牌最可能新鲜）；
 * 成员多于上限时，其余名额在剩下的成员里逐轮轮换，排在后面的成员也有机会被用到。
 */
export function pickMembers<T>(members: T[], cap: number, turn: number): T[] {
  if (members.length <= cap) return members;
  const head = members.slice(0, 2); const tail = members.slice(2);
  const offset = turn % tail.length;
  return [...head, ...tail.slice(offset), ...tail.slice(0, offset)].slice(0, cap);
}

/**
 * 刷新账号额度。不同服务器可能登录不同账号，所以分两步：
 * 1. 每个采集目标报告自己登录的是哪个账号（远端本地读取，不访问服务商）；
 * 2. 按账号分组，每个账号只向服务商查询一次——用该账号下最近用量最大的服务器，失败（如令牌过期）就换同账号的下一台。
 */
export async function refreshAccountLimits(deps: LimitsDeps): Promise<LimitsOutcome[]> {
  const outcomes: LimitsOutcome[] = [];
  const run: RefreshRun = { deps, deadline: Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS), candidates: [] };
  const turn = refreshTurn++;
  let timedOut = false;
  const isDeadline = (err: unknown) => { const hit = err instanceof CollectError && err.code === 'DEADLINE'; timedOut ||= hit; return hit; };

  for (const provider of supportedSources()) {
    const all = await candidates(deps, provider).catch((err) => {
      deps.log.error({ err, provider }, '读取额度查询的候选目标失败');
      return [] as Candidate[];
    });
    run.candidates = all;
    await inBatches(all, 4, async (c) => {
      try {
        const id = await askWithUpgrade(run, c, 'identity', provider);
        c.accountKey = id.accountKey ?? undefined;
        c.accountLabel = id.accountLabel ?? null;
        // 该账户用环境变量把数据目录改到了别处，而平台采集的不是那个目录：记下来提示管理员
        const actual = id.configDirs?.[provider];
        const hint = actual && actual !== c.data_dir && isSafeAbsolutePath(actual) ? actual : null;
        await deps.db.query('UPDATE collection_targets SET account_key = $2, account_label = $3, account_checked_at = now(), account_error = NULL, dir_hint = $4 WHERE id = $1', [c.target_id, c.accountKey ?? null, c.accountLabel, hint]);
      } catch (err) {
        if (isDeadline(err)) return; // 没来得及查：保留上一轮的识别结果
        const code = err instanceof CollectError ? err.code : 'ERROR';
        if (code === 'ACCOUNT_QUERIES_DISABLED') {
          // 这台服务器的采集配置关闭了账号查询（共用采集账户的部署）：属于“不支持”，不是故障，也不列入“识别不出账号”
          await deps.db.query('UPDATE collection_targets SET account_key = NULL, account_label = NULL, account_checked_at = now(), account_error = NULL WHERE id = $1', [c.target_id]);
          return;
        }
        deps.log.warn({ provider, server: c.server_name, code }, `识别登录账号失败: ${sanitizeError(err)}`);
        await deps.db.query('UPDATE collection_targets SET account_key = NULL, account_label = NULL, account_checked_at = now(), account_error = $2 WHERE id = $1', [c.target_id, `${code}: ${sanitizeError(err)}`.slice(0, 300)]);
      }
    });

    const groups = new Map<string, Candidate[]>();
    for (const c of all) if (c.accountKey) groups.set(c.accountKey, [...(groups.get(c.accountKey) ?? []), c]);

    for (const [accountKey, members] of groups) {
      const label = members.find((m) => m.accountLabel)?.accountLabel ?? null;
      // 全部失败时记哪个错误：优先“还活着”的（网络抖动、服务商接口异常）。否则最后一台恰好令牌过期，就会把整个账号藏进“登录已过期”
      let worst: { code: string; message: string; c: Candidate } | undefined;
      let done = false;
      for (const c of pickMembers(members, MAX_MEMBER_TRIES, turn)) {
        try {
          const data = await askWithUpgrade(run, c, 'limits', provider);
          await deps.db.query(
            "INSERT INTO account_limit_snapshots (provider, account_key, account_label, target_id, server_name, status, plan, windows) VALUES ($1, $2, $3, $4, $5, 'ok', $6, $7)",
            [provider, accountKey, label, c.target_id, c.server_name, data.plan ?? null, JSON.stringify(data.windows)],
          );
          if (data.shape && data.windows.length < 2) deps.log.debug({ provider, shape: data.shape }, '账号额度：服务商只返回了一个窗口，记录返回结构备查');
          await evaluateLimitAlerts(deps, { provider, accountKey, accountLabel: label, plan: data.plan ?? null, servers: [...new Set(members.map((m) => m.server_name))] }, data.windows, c.server_name)
            .catch((err) => deps.log.error({ err, provider }, '账号额度提醒评估失败'));
          outcomes.push({ provider, accountLabel: label, ok: true, serverName: c.server_name });
          done = true;
          break;
        } catch (err) {
          if (isDeadline(err)) break;
          const failure = { code: err instanceof CollectError ? err.code : 'ERROR', message: sanitizeError(err), c };
          deps.log.warn({ provider, server: c.server_name, code: failure.code }, `账号额度查询失败: ${failure.message}`);
          if (!worst || !DEAD_CODES.has(failure.code) || DEAD_CODES.has(worst.code)) worst = failure;
        }
      }
      if (!done && worst && !(timedOut && DEAD_CODES.has(worst.code))) {
        await deps.db.query(
          "INSERT INTO account_limit_snapshots (provider, account_key, account_label, target_id, server_name, status, error_code, error_message) VALUES ($1, $2, $3, $4, $5, 'error', $6, $7)",
          [provider, accountKey, label, worst.c.target_id, worst.c.server_name, worst.code, worst.message],
        );
        outcomes.push({ provider, accountLabel: label, ok: false, serverName: worst.c.server_name, code: worst.code, message: worst.message });
      }
    }
  }
  if (timedOut) deps.log.warn({ deadlineMs: deps.deadlineMs ?? DEFAULT_DEADLINE_MS }, '账号额度刷新到达时限，未查完的部分留待下一轮');
  await deps.db.query("DELETE FROM account_limit_snapshots WHERE fetched_at < now() - interval '14 days'");
  return outcomes;
}

export interface LimitsView {
  provider: string; accountKey: string; accountLabel: string | null; servers: string[];
  plan: string | null; windows: LimitWindow[]; fetchedAt: string | null; serverName: string | null;
  /** 最近一次查询失败且晚于最近一次成功时给出：页面据此提示“数据可能已过期” */
  lastError: { code: string; message: string; at: string } | null;
}
export interface UnidentifiedSource { provider: string; serverName: string; dataDir: string; error: string }

/** 当前各采集目标登录的账号（去重），以及每个账号最近一次的额度快照 */
export interface HiddenAccount { provider: string; accountLabel: string | null; servers: string[]; code: string; message: string }

// 登录已过期 / 被吊销 / 没有订阅登录的账号查不到当前额度：不占版面，只汇总成一行说明
const HIDE_CODES = new Set(['TOKEN_EXPIRED', 'NO_LOGIN']);

export async function latestAccountLimits(db: Db): Promise<{ limits: LimitsView[]; hidden: HiddenAccount[]; unidentified: UnidentifiedSource[]; checked: boolean }> {
  const active = "t.enabled AND s.enabled AND t.last_status = 'success' AND t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR'";
  const accounts = (await db.query(
    `SELECT t.source AS provider, t.account_key, max(t.account_label) AS account_label, array_agg(DISTINCT s.name ORDER BY s.name) AS servers
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
      WHERE ${active} AND t.account_key IS NOT NULL GROUP BY t.source, t.account_key ORDER BY t.source, max(t.account_label)`,
  )).rows;
  const snaps = (await db.query(
    `SELECT DISTINCT ON (provider, account_key, status) provider, account_key, status, plan, windows, server_name, error_code, error_message, fetched_at
       FROM account_limit_snapshots ORDER BY provider, account_key, status, fetched_at DESC`,
  )).rows;
  const unidentified = (await db.query(
    `SELECT t.source AS provider, s.name AS "serverName", t.data_dir AS "dataDir", t.account_error AS error
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
      WHERE ${active} AND t.account_key IS NULL AND t.account_error IS NOT NULL ORDER BY t.source, s.name`,
  )).rows;
  const checked = (await db.query('SELECT 1 FROM collection_targets WHERE account_checked_at IS NOT NULL LIMIT 1')).rowCount !== 0;
  const all = accounts.map((a) => {
    const ok = snaps.find((r) => r.provider === a.provider && r.account_key === a.account_key && r.status === 'ok');
    const bad = snaps.find((r) => r.provider === a.provider && r.account_key === a.account_key && r.status === 'error');
    const errorIsNewer = bad && (!ok || bad.fetched_at > ok.fetched_at);
    return {
      provider: a.provider, accountKey: a.account_key, accountLabel: a.account_label, servers: a.servers,
      plan: ok?.plan ?? null, windows: ok?.windows ?? [], fetchedAt: ok?.fetched_at?.toISOString() ?? null, serverName: ok?.server_name ?? null,
      lastError: errorIsNewer ? { code: bad.error_code, message: bad.error_message, at: bad.fetched_at.toISOString() } : null,
    };
  });
  const limits = all.filter((a) => !(a.lastError && HIDE_CODES.has(a.lastError.code)));
  const hidden = all.filter((a) => a.lastError && HIDE_CODES.has(a.lastError.code))
    .map((a) => ({ provider: a.provider, accountLabel: a.accountLabel, servers: a.servers, code: a.lastError!.code, message: a.lastError!.message }));
  return { limits, hidden, unidentified, checked };
}

export interface LimitAccount { provider: string; accountKey: string; accountLabel: string | null; plan: string | null; servers: string[] }

const SAME_CYCLE_MS = 30 * 60_000;

/**
 * 两个周期标识是否指同一个刷新周期。周期标识是窗口的刷新时间（取整到 10 分钟）；服务商不给刷新时间时退化为时间桶
 * （短窗口按天 day:YYYY-MM-DD，长窗口按 ISO 周 week:YYYY-Www），否则这类窗口一辈子只能提醒一次。
 * 刷新时间会抖动，取整后仍可能落到相邻的两个 10 分钟格：相差不到 30 分钟的视为同一周期。
 */
export function sameLimitCycle(previous: string, current: string, currentBucket: string, now: Date): boolean {
  if (previous === current) return true;
  const a = Date.parse(previous); const b = Date.parse(current);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.abs(a - b) < SAME_CYCLE_MS;
  // 服务商时而给刷新时间、时而不给：上次按时间桶提醒过且仍在同一个桶里，或上次记下的刷新时间还没到，都算同一周期
  if (Number.isNaN(a)) return previous === currentBucket;
  return a > now.getTime();
}

/**
 * 剩余比例低于提醒线时创建告警与邮件任务（同一事务）。
 * 同一账号、同一窗口、同一提醒线在一个刷新周期内只提醒一次，刷新后重新计（周期的判定见 sameLimitCycle）。
 */
export async function evaluateLimitAlerts(deps: LimitsDeps, account: LimitAccount, rawWindows: LimitWindow[], serverName: string | null): Promise<number> {
  const { provider } = account;
  const cfg = await getLimitAlertSettings(deps.db);
  if (!cfg.enabled) return 0;
  const general = await getGeneralSettings(deps.db);
  const baseUrl = deps.baseUrl ?? '';
  const label = SOURCE_INFO[provider]?.label ?? provider;
  const now = deps.now?.() ?? new Date();
  const today = dateInTz(now, general.timezone);
  const windows = normalizeWindows(rawWindows);
  const accountLabel = cleanAccountLabel(account.accountLabel);
  const plan = cleanPlan(account.plan);
  let created = 0;
  for (const w of windows) {
    if (isShortWindow(w) && !cfg.includeFiveHour) continue;
    if (w.usedPercent === null || 100 - w.usedPercent >= cfg.remainingBelowPercent) continue;
    const resetsAt = w.resetsAt ? new Date(w.resetsAt) : null;
    if (resetsAt && resetsAt.getTime() <= now.getTime()) continue; // 已过刷新时间的旧读数不提醒
    const bucket = isShortWindow(w) ? `day:${today}` : `week:${isoWeekKey(today)}`;
    const cycle = resetsAt ? new Date(Math.round(resetsAt.getTime() / 600_000) * 600_000).toISOString() : bucket;
    const keyPrefix = `limit:${provider}:${account.accountKey}:${w.key}:`;
    created += await withTx(deps.db, async (tx) => {
      const previous = (await tx.query(
        `SELECT period_key FROM alert_events
          WHERE kind = 'account_limit' AND source = $1 AND period_type = $2 AND tier = $3 AND left(dedupe_key, length($4)) = $4
          ORDER BY created_at DESC LIMIT 1`,
        [provider, w.key, cfg.remainingBelowPercent, keyPrefix],
      )).rows[0];
      if (previous?.period_key && sameLimitCycle(previous.period_key, cycle, bucket, now)) return 0;
      const event = (await tx.query(
        `INSERT INTO alert_events (kind, dedupe_key, rule_name, metric, period_type, period_key, tier, observed_value, threshold_value, data_as_of, source)
         VALUES ('account_limit', $1, $2, 'limit_used_pct', $3, $4, $5, $6, $7, $9, $8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [`${keyPrefix}${cycle}:${cfg.remainingBelowPercent}`, `${label}${accountLabel ? `（${accountLabel}）` : ''} ${w.label}额度剩余不足 ${cfg.remainingBelowPercent}%`, w.key, cycle,
          cfg.remainingBelowPercent, w.usedPercent, 100 - cfg.remainingBelowPercent, provider, now],
      )).rows[0];
      if (!event) return 0;
      const to = new Set<string>(cfg.emails.map((e) => e.toLowerCase()));
      if (cfg.notifyAdmins) for (const e of await adminEmails(tx)) to.add(e.toLowerCase());
      if (to.size === 0) return 1;
      const mail = renderLimitAlert({
        providerLabel: label, accountLabel, servers: account.servers, plan, windowLabel: w.label, usedPercent: w.usedPercent!, thresholdRemaining: cfg.remainingBelowPercent, resetsAt,
        others: windows.filter((o) => o.key !== w.key).map((o) => ({ label: o.label, usedPercent: o.usedPercent, resetsAt: o.resetsAt ? new Date(o.resetsAt) : null })),
        fetchedAt: now, serverName, timezone: general.timezone, baseUrl,
      });
      await tx.query('INSERT INTO email_outbox (alert_event_id, message_id, to_addrs, subject, body_text) VALUES ($1, $2, $3, $4, $5)',
        [event.id, messageIdFor(event.id, baseUrl || 'http://usage-monitor.local'), [...to], mail.subject, mail.text]);
      return 1;
    });
  }
  return created;
}
