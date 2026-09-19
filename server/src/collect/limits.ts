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
import { CollectError, SOURCE_INFO, supportedSources } from './adapter.js';
import { installCollector } from './install.js';

// 账号额度：由被采集服务器上的采集脚本就地查询（登录令牌不离开那台机器），平台只拿到已用百分比与刷新时间。

const limitsEnvelope = z.object({
  schema: z.literal(1),
  status: z.enum(['ok', 'error']),
  code: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
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

export interface LimitsDeps { db: Db; executor: RemoteExecutor; masterKey: Buffer; log: Logger; baseUrl?: string }

export function buildAccountCommand(collectCommand: string, mode: 'limits' | 'identity', provider: string, dir: string): string {
  if (!isValidCollectCommand(collectCommand) || !supportedSources().includes(provider) || !isSafeAbsolutePath(dir)) throw new CollectError('BAD_ARGS', '额度查询参数不合法');
  return `${collectCommand} --${mode} ${provider} --dir ${dir}`;
}

interface Candidate { target_id: string; server_id: string; server_name: string; data_dir: string; collect_command: string; ssh: SshTarget; accountKey?: string; accountLabel?: string | null }

/** 该数据源下采集正常的全部目标，最近用量大的排前面（同一账号下优先用它查询：令牌最可能是新鲜的） */
async function candidates(deps: LimitsDeps, provider: string): Promise<Candidate[]> {
  const res = await deps.db.query(
    `SELECT t.id AS target_id, s.id AS server_id, s.name AS server_name, t.data_dir, s.collect_command, s.host, s.port, s.host_key_fingerprint,
            COALESCE(t.ssh_username, s.ssh_username) AS username, c.id AS credential_id, c.ciphertext, c.iv, c.auth_tag,
            (SELECT COALESCE(sum(d.total_tokens), 0) FROM usage_daily d WHERE d.target_id = t.id AND d.usage_date >= current_date - 2) AS recent
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
       JOIN credentials c ON c.id = COALESCE(t.credential_id, s.credential_id)
      WHERE t.source = $1 AND t.enabled AND s.enabled AND t.last_status = 'success' AND t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR'
        AND s.host_key_fingerprint IS NOT NULL AND c.revoked_at IS NULL
      ORDER BY recent DESC, t.last_success_at DESC LIMIT 60`,
    [provider],
  );
  return res.rows.map((r) => {
    const secret = JSON.parse(unseal(deps.masterKey, { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, `credential:${r.credential_id}`)) as { privateKey: string; passphrase?: string };
    return {
      target_id: r.target_id, server_id: r.server_id, server_name: r.server_name, data_dir: r.data_dir, collect_command: r.collect_command,
      ssh: { host: r.host, port: r.port, username: r.username, privateKey: secret.privateKey, passphrase: secret.passphrase, expectedHostFingerprint: r.host_key_fingerprint },
    };
  });
}

async function ask(deps: LimitsDeps, c: Candidate, mode: 'limits' | 'identity', provider: string) {
  const out = await deps.executor.exec(c.ssh, buildAccountCommand(c.collect_command, mode, provider, c.data_dir), 60_000);
  let json: unknown;
  try { json = JSON.parse(out.stdout); } catch { throw new CollectError('BAD_OUTPUT', '远端没有返回结果'); }
  const env = limitsEnvelope.safeParse(json);
  if (!env.success) throw new CollectError('BAD_OUTPUT', '远端返回的结构不符合预期');
  if (env.data.status === 'error') throw new CollectError(env.data.code ?? 'REMOTE_ERROR', env.data.message ?? '查询失败');
  return env.data;
}

/** 旧版采集脚本不认识新参数（BAD_ARGS）：自动安装的服务器先升级脚本再试一次 */
async function askWithUpgrade(deps: LimitsDeps, c: Candidate, mode: 'limits' | 'identity', provider: string, upgraded: Set<string>) {
  try {
    return await ask(deps, c, mode, provider);
  } catch (err) {
    if (!(err instanceof CollectError && err.code === 'BAD_ARGS') || upgraded.has(c.server_id)) throw err;
    upgraded.add(c.server_id);
    c.collect_command = (await installCollector(deps.executor, c.ssh)).collectCommand;
    return ask(deps, c, mode, provider);
  }
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export interface LimitsOutcome { provider: string; accountLabel: string | null; ok: boolean; serverName?: string; code?: string; message?: string }

/**
 * 刷新账号额度。不同服务器可能登录不同账号，所以分两步：
 * 1. 每个采集目标报告自己登录的是哪个账号（远端本地读取，不访问服务商）；
 * 2. 按账号分组，每个账号只向服务商查询一次——用该账号下最近用量最大的服务器，失败（如令牌过期）就换同账号的下一台。
 */
export async function refreshAccountLimits(deps: LimitsDeps): Promise<LimitsOutcome[]> {
  const outcomes: LimitsOutcome[] = [];
  const upgraded = new Set<string>();
  for (const provider of supportedSources()) {
    const all = await candidates(deps, provider).catch(() => [] as Candidate[]);
    await inBatches(all, 4, async (c) => {
      try {
        const id = await askWithUpgrade(deps, c, 'identity', provider, upgraded);
        c.accountKey = id.accountKey ?? undefined;
        c.accountLabel = id.accountLabel ?? null;
        await deps.db.query('UPDATE collection_targets SET account_key = $2, account_label = $3, account_checked_at = now(), account_error = NULL WHERE id = $1', [c.target_id, c.accountKey ?? null, c.accountLabel]);
      } catch (err) {
        const code = err instanceof CollectError ? err.code : 'ERROR';
        deps.log.warn({ provider, server: c.server_name, code }, `识别登录账号失败: ${sanitizeError(err)}`);
        await deps.db.query('UPDATE collection_targets SET account_key = NULL, account_label = NULL, account_checked_at = now(), account_error = $2 WHERE id = $1', [c.target_id, `${code}: ${sanitizeError(err)}`.slice(0, 300)]);
      }
    });

    const groups = new Map<string, Candidate[]>();
    for (const c of all) if (c.accountKey) groups.set(c.accountKey, [...(groups.get(c.accountKey) ?? []), c]);

    for (const [accountKey, members] of groups) {
      const label = members.find((m) => m.accountLabel)?.accountLabel ?? null;
      let last: { code: string; message: string; c: Candidate } | undefined;
      let done = false;
      for (const c of members.slice(0, 4)) {
        try {
          const data = await askWithUpgrade(deps, c, 'limits', provider, upgraded);
          await deps.db.query(
            "INSERT INTO account_limit_snapshots (provider, account_key, account_label, target_id, server_name, status, plan, windows) VALUES ($1, $2, $3, $4, $5, 'ok', $6, $7)",
            [provider, accountKey, label, c.target_id, c.server_name, data.plan ?? null, JSON.stringify(data.windows ?? [])],
          );
          if (data.shape && (data.windows ?? []).length < 2) deps.log.debug({ provider, shape: data.shape }, '账号额度：服务商只返回了一个窗口，记录返回结构备查');
          await evaluateLimitAlerts(deps, { provider, accountKey, accountLabel: label, plan: data.plan ?? null, servers: [...new Set(members.map((m) => m.server_name))] }, data.windows ?? [], c.server_name)
            .catch((err) => deps.log.error({ err, provider }, '账号额度提醒评估失败'));
          outcomes.push({ provider, accountLabel: label, ok: true, serverName: c.server_name });
          done = true;
          break;
        } catch (err) {
          last = { code: err instanceof CollectError ? err.code : 'ERROR', message: sanitizeError(err), c };
          deps.log.warn({ provider, server: c.server_name, code: last.code }, `账号额度查询失败: ${last.message}`);
        }
      }
      if (!done && last) {
        await deps.db.query(
          "INSERT INTO account_limit_snapshots (provider, account_key, account_label, target_id, server_name, status, error_code, error_message) VALUES ($1, $2, $3, $4, $5, 'error', $6, $7)",
          [provider, accountKey, label, last.c.target_id, last.c.server_name, last.code, last.message],
        );
        outcomes.push({ provider, accountLabel: label, ok: false, serverName: last.c.server_name, code: last.code, message: last.message });
      }
    }
  }
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
export async function latestAccountLimits(db: Db): Promise<{ limits: LimitsView[]; unidentified: UnidentifiedSource[]; checked: boolean }> {
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
  const limits = accounts.map((a) => {
    const ok = snaps.find((r) => r.provider === a.provider && r.account_key === a.account_key && r.status === 'ok');
    const bad = snaps.find((r) => r.provider === a.provider && r.account_key === a.account_key && r.status === 'error');
    const errorIsNewer = bad && (!ok || bad.fetched_at > ok.fetched_at);
    return {
      provider: a.provider, accountKey: a.account_key, accountLabel: a.account_label, servers: a.servers,
      plan: ok?.plan ?? null, windows: ok?.windows ?? [], fetchedAt: ok?.fetched_at?.toISOString() ?? null, serverName: ok?.server_name ?? null,
      lastError: errorIsNewer ? { code: bad.error_code, message: bad.error_message, at: bad.fetched_at.toISOString() } : null,
    };
  });
  return { limits, unidentified, checked };
}

/**
 * 剩余比例低于提醒线时创建告警与邮件任务（同一事务）。
 * 去重键含窗口的刷新时间（取整到 10 分钟以吸收服务商返回值的抖动）：同一窗口在同一刷新周期内只提醒一次，刷新后重新计。
 */
export interface LimitAccount { provider: string; accountKey: string; accountLabel: string | null; plan: string | null; servers: string[] }

export async function evaluateLimitAlerts(deps: LimitsDeps, account: LimitAccount, windows: LimitWindow[], serverName: string | null): Promise<number> {
  const { provider, plan } = account;
  const cfg = await getLimitAlertSettings(deps.db);
  if (!cfg.enabled) return 0;
  const general = await getGeneralSettings(deps.db);
  const baseUrl = deps.baseUrl ?? '';
  const label = SOURCE_INFO[provider]?.label ?? provider;
  let created = 0;
  for (const w of windows) {
    if (w.key === 'five_hour' && !cfg.includeFiveHour) continue;
    if (w.usedPercent === null || 100 - w.usedPercent >= cfg.remainingBelowPercent) continue;
    const resetsAt = w.resetsAt ? new Date(w.resetsAt) : null;
    if (resetsAt && resetsAt.getTime() <= Date.now()) continue; // 已过刷新时间的旧读数不提醒
    const cycle = resetsAt ? new Date(Math.round(resetsAt.getTime() / 600_000) * 600_000).toISOString() : 'unknown';
    created += await withTx(deps.db, async (tx) => {
      const event = (await tx.query(
        `INSERT INTO alert_events (kind, dedupe_key, rule_name, metric, period_type, period_key, tier, observed_value, threshold_value, data_as_of, source)
         VALUES ('account_limit', $1, $2, 'limit_used_pct', $3, $4, $5, $6, $7, now(), $8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [`limit:${provider}:${account.accountKey}:${w.key}:${cycle}:${cfg.remainingBelowPercent}`, `${label}${account.accountLabel ? `（${account.accountLabel}）` : ''} ${w.label}额度剩余不足 ${cfg.remainingBelowPercent}%`, w.key, cycle,
          cfg.remainingBelowPercent, w.usedPercent, 100 - cfg.remainingBelowPercent, provider],
      )).rows[0];
      if (!event) return 0;
      const to = new Set<string>(cfg.emails.map((e) => e.toLowerCase()));
      if (cfg.notifyAdmins) for (const e of await adminEmails(tx)) to.add(e.toLowerCase());
      if (to.size === 0) return 1;
      const mail = renderLimitAlert({
        providerLabel: label, accountLabel: account.accountLabel, servers: account.servers, plan, windowLabel: w.label, usedPercent: w.usedPercent!, thresholdRemaining: cfg.remainingBelowPercent, resetsAt,
        others: windows.filter((o) => o.key !== w.key).map((o) => ({ label: o.label, usedPercent: o.usedPercent, resetsAt: o.resetsAt ? new Date(o.resetsAt) : null })),
        fetchedAt: new Date(), serverName, timezone: general.timezone, baseUrl,
      });
      await tx.query('INSERT INTO email_outbox (alert_event_id, message_id, to_addrs, subject, body_text) VALUES ($1, $2, $3, $4, $5)',
        [event.id, messageIdFor(event.id, baseUrl || 'http://usage-monitor.local'), [...to], mail.subject, mail.text]);
      return 1;
    });
  }
  return created;
}

