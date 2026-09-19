import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { sanitizeError } from '../logger.js';
import { unseal } from '../security/crypto.js';
import { isSafeAbsolutePath, isValidCollectCommand } from '../security/validate.js';
import type { RemoteExecutor, SshTarget } from '../ssh/client.js';
import { CollectError, supportedSources } from './adapter.js';
import { installCollector } from './install.js';

// 账号额度：由被采集服务器上的采集脚本就地查询（登录令牌不离开那台机器），平台只拿到已用百分比与刷新时间。

const limitsEnvelope = z.object({
  schema: z.literal(1),
  status: z.enum(['ok', 'error']),
  code: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
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

export interface LimitsDeps { db: Db; executor: RemoteExecutor; masterKey: Buffer; log: Logger }

export function buildLimitsCommand(collectCommand: string, provider: string, dir: string): string {
  if (!isValidCollectCommand(collectCommand) || !supportedSources().includes(provider) || !isSafeAbsolutePath(dir)) throw new CollectError('BAD_ARGS', '额度查询参数不合法');
  return `${collectCommand} --limits ${provider} --dir ${dir}`;
}

interface Candidate { target_id: string; server_id: string; server_name: string; data_dir: string; collect_command: string; ssh: SshTarget }

/** 候选来源：该数据源下采集正常的目标，最近用量大的优先（令牌最可能是新鲜的）。目前所有人共用一个账号，任取其一即可。 */
async function candidates(deps: LimitsDeps, provider: string): Promise<Candidate[]> {
  const res = await deps.db.query(
    `SELECT t.id AS target_id, s.id AS server_id, s.name AS server_name, t.data_dir, s.collect_command, s.host, s.port, s.host_key_fingerprint,
            COALESCE(t.ssh_username, s.ssh_username) AS username, c.id AS credential_id, c.ciphertext, c.iv, c.auth_tag,
            (SELECT COALESCE(sum(d.total_tokens), 0) FROM usage_daily d WHERE d.target_id = t.id AND d.usage_date >= current_date - 2) AS recent
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
       JOIN credentials c ON c.id = COALESCE(t.credential_id, s.credential_id)
      WHERE t.source = $1 AND t.enabled AND s.enabled AND t.last_status = 'success' AND t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR'
        AND s.host_key_fingerprint IS NOT NULL AND c.revoked_at IS NULL
      ORDER BY recent DESC, t.last_success_at DESC LIMIT 4`,
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

async function queryOnce(deps: LimitsDeps, c: Candidate, provider: string) {
  const out = await deps.executor.exec(c.ssh, buildLimitsCommand(c.collect_command, provider, c.data_dir), 60_000);
  let json: unknown;
  try { json = JSON.parse(out.stdout); } catch { throw new CollectError('BAD_OUTPUT', '远端没有返回额度查询结果'); }
  const env = limitsEnvelope.safeParse(json);
  if (!env.success) throw new CollectError('BAD_OUTPUT', '远端返回的额度结构不符合预期');
  if (env.data.status === 'error') throw new CollectError(env.data.code ?? 'REMOTE_ERROR', env.data.message ?? '额度查询失败');
  return env.data;
}

export interface LimitsOutcome { provider: string; ok: boolean; serverName?: string; code?: string; message?: string }

/** 刷新各数据源的账号额度快照。某台服务器失败（如令牌过期）时换下一台；旧版采集脚本不认识 --limits 时先自动升级再试一次。 */
export async function refreshAccountLimits(deps: LimitsDeps): Promise<LimitsOutcome[]> {
  const outcomes: LimitsOutcome[] = [];
  for (const provider of supportedSources()) {
    let last: { code: string; message: string; c?: Candidate } = { code: 'NO_SOURCE', message: '还没有可用于查询的采集目标（需要至少一个采集成功的目标）' };
    let done = false;
    for (const c of await candidates(deps, provider).catch(() => [] as Candidate[])) {
      try {
        let data;
        try {
          data = await queryOnce(deps, c, provider);
        } catch (err) {
          if (!(err instanceof CollectError && err.code === 'BAD_ARGS')) throw err;
          const upgraded = await installCollector(deps.executor, c.ssh); // 远端采集脚本版本过旧：升级后重试
          c.collect_command = upgraded.collectCommand;
          data = await queryOnce(deps, c, provider);
        }
        await deps.db.query(
          "INSERT INTO account_limit_snapshots (provider, target_id, server_name, status, plan, windows, fetched_at) VALUES ($1, $2, $3, 'ok', $4, $5, now())",
          [provider, c.target_id, c.server_name, data.plan ?? null, JSON.stringify(data.windows ?? [])],
        );
        if (data.shape && (data.windows ?? []).length < 2) deps.log.debug({ provider, shape: data.shape }, '账号额度：服务商只返回了一个窗口，记录返回结构备查');
        outcomes.push({ provider, ok: true, serverName: c.server_name });
        done = true;
        break;
      } catch (err) {
        last = { code: err instanceof CollectError ? err.code : 'ERROR', message: sanitizeError(err), c };
        deps.log.warn({ provider, server: c.server_name, code: last.code }, `账号额度查询失败: ${last.message}`);
      }
    }
    if (!done) {
      await deps.db.query(
        "INSERT INTO account_limit_snapshots (provider, target_id, server_name, status, error_code, error_message) VALUES ($1, $2, $3, 'error', $4, $5)",
        [provider, last.c?.target_id ?? null, last.c?.server_name ?? null, last.code, last.message],
      );
      outcomes.push({ provider, ok: false, serverName: last.c?.server_name, code: last.code, message: last.message });
    }
  }
  await deps.db.query("DELETE FROM account_limit_snapshots WHERE fetched_at < now() - interval '14 days'");
  return outcomes;
}

export interface LimitsView {
  provider: string; plan: string | null; windows: LimitWindow[]; fetchedAt: string | null; serverName: string | null;
  /** 最近一次查询失败且晚于最近一次成功时给出：页面据此提示“数据可能已过期” */
  lastError: { code: string; message: string; at: string } | null;
}

export async function latestAccountLimits(db: Db): Promise<LimitsView[]> {
  const rows = (await db.query(
    `SELECT DISTINCT ON (provider, status) provider, status, plan, windows, server_name, error_code, error_message, fetched_at
       FROM account_limit_snapshots ORDER BY provider, status, fetched_at DESC`,
  )).rows;
  return supportedSources().map((provider) => {
    const ok = rows.find((r) => r.provider === provider && r.status === 'ok');
    const bad = rows.find((r) => r.provider === provider && r.status === 'error');
    const errorIsNewer = bad && (!ok || bad.fetched_at > ok.fetched_at);
    return {
      provider, plan: ok?.plan ?? null, windows: ok?.windows ?? [], fetchedAt: ok?.fetched_at?.toISOString() ?? null, serverName: ok?.server_name ?? null,
      lastError: errorIsNewer ? { code: bad.error_code, message: bad.error_message, at: bad.fetched_at.toISOString() } : null,
    };
  });
}
