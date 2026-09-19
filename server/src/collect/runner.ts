import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { adminEmails, evaluateUsageAlerts, messageIdFor } from '../alerts/evaluate.js';
import { renderFailureAlert } from '../alerts/templates.js';
import { withTx, type Db, type Tx } from '../db/pool.js';
import { sanitizeError } from '../logger.js';
import { unseal } from '../security/crypto.js';
import { getGeneralSettings, type GeneralSettings } from '../settings.js';
import type { RemoteExecutor } from '../ssh/client.js';
import { addDays, dateInTz, maxDate, minDate } from '../util/time.js';
import { CollectError, getAdapter, parseEnvelope, type CollectRequest } from './adapter.js';
import { buildCollectCommand } from './command.js';
import { ingestSnapshot } from './ingest.js';

export interface RunnerDeps {
  db: Db;
  executor: RemoteExecutor;
  masterKey: Buffer;
  baseUrl: string;
  sshTimeoutMs: number;
  log: Logger;
  now?: () => Date;
}

export interface RunOptions {
  /** 最后一次尝试：失败计入“连续失败轮数”；否则仅记录错误，等待退避重试 */
  finalAttempt: boolean;
  acceptDecrease?: boolean;
}

export type RunOutcome =
  | { status: 'success'; rowsWritten: number; alertsCreated: number }
  | { status: 'skipped_locked' | 'stale' }
  | { status: 'failed'; code: string; message: string; retryable: boolean };

interface RunContext {
  run_id: string; trigger: string; run_status: string; reconcile: boolean | null;
  target_id: string; user_id: string; server_id: string; source: string; data_dir: string; target_enabled: boolean;
  source_start_date: string | null; source_end_date: string | null;
  initialized_at: Date | null; last_success_at: Date | null;
  host: string; port: number; collect_command: string; host_key_fingerprint: string | null; server_enabled: boolean;
  ssh_username: string; credential_id: string | null;
  ciphertext: Buffer | null; iv: Buffer | null; auth_tag: Buffer | null; revoked_at: Date | null;
}

const LOCK_MARGIN_MS = 60_000;

export function computeRange(ctx: Pick<RunContext, 'initialized_at' | 'last_success_at' | 'reconcile' | 'source_start_date' | 'source_end_date'>,
  settings: GeneralSettings, now: Date): { since: string; until: string } | null {
  const today = dateInTz(now, settings.timezone);
  const floor = addDays(today, -settings.backfillDays);
  let since: string;
  if (!ctx.initialized_at) {
    since = floor;
  } else {
    since = addDays(today, -(ctx.reconcile ? settings.reconcileDays : settings.lookbackDays));
    // 断连或停机后补采：从上次成功采集的前一天开始，一次覆盖整个缺口
    if (ctx.last_success_at) since = minDate(since, addDays(dateInTz(ctx.last_success_at, settings.timezone), -1));
    since = maxDate(since, minDate(floor, addDays(today, -settings.reconcileDays)));
  }
  let until = today;
  // 来源切换边界：日志迁移后，每份逻辑数据只从唯一来源入库
  if (ctx.source_start_date) since = maxDate(since, ctx.source_start_date);
  if (ctx.source_end_date) until = minDate(until, ctx.source_end_date);
  return since <= until ? { since, until } : null;
}

async function loadContext(db: Db, runId: string): Promise<RunContext | undefined> {
  const res = await db.query<RunContext>(
    `SELECT r.id AS run_id, r.trigger, r.status AS run_status, b.reconcile,
            t.id AS target_id, t.user_id, t.server_id, t.source, t.data_dir, t.enabled AS target_enabled,
            t.source_start_date, t.source_end_date, t.initialized_at, t.last_success_at,
            s.host, s.port, s.collect_command, s.host_key_fingerprint, s.enabled AS server_enabled,
            COALESCE(t.ssh_username, s.ssh_username) AS ssh_username,
            c.id AS credential_id, c.ciphertext, c.iv, c.auth_tag, c.revoked_at
       FROM collection_runs r
       JOIN collection_targets t ON t.id = r.target_id
       JOIN servers s ON s.id = t.server_id
       LEFT JOIN collection_batches b ON b.id = r.batch_id
       LEFT JOIN credentials c ON c.id = COALESCE(t.credential_id, s.credential_id)
      WHERE r.id = $1`,
    [runId],
  );
  return res.rows[0];
}

/** 执行一次采集运行。幂等：同一 runId 可被队列重试多次调用。 */
export async function runCollection(deps: RunnerDeps, runId: string, opts: RunOptions): Promise<RunOutcome> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  const ctx = await loadContext(db, runId);
  if (!ctx) throw new Error(`采集运行 ${runId} 不存在`);
  // 队列重复投递已结束的运行：直接返回原结果，不再执行
  if (ctx.run_status === 'success') return { status: 'success', rowsWritten: 0, alertsCreated: 0 };
  if (ctx.run_status === 'stale' || ctx.run_status === 'skipped_locked') return { status: ctx.run_status };
  if (!ctx.target_enabled || !ctx.server_enabled) {
    // 入队后被停用：不算采集失败，不计入连续失败轮数
    await db.query("UPDATE collection_runs SET status = 'failed', finished_at = $2, error_code = 'DISABLED', error_message = '服务器或采集目标已停用' WHERE id = $1", [runId, now()]);
    return { status: 'failed', code: 'DISABLED', message: '服务器或采集目标已停用', retryable: false };
  }

  // 同一采集目标加锁（带租约，进程崩溃后自动过期），避免定时、手动与重试并发覆盖
  const lockMs = deps.sshTimeoutMs + LOCK_MARGIN_MS;
  const locked = await db.query(
    `UPDATE collection_targets SET lock_run_id = $1, lock_expires_at = $3::timestamptz + make_interval(secs => $4)
      WHERE id = $2 AND (lock_run_id IS NULL OR lock_run_id = $1 OR lock_expires_at < $3::timestamptz) RETURNING id`,
    [runId, ctx.target_id, now(), lockMs / 1000],
  );
  if (locked.rowCount === 0) {
    await db.query("UPDATE collection_runs SET status = 'skipped_locked', finished_at = $2, error_message = '该目标已有采集在进行' WHERE id = $1", [runId, now()]);
    return { status: 'skipped_locked' };
  }

  await db.query("UPDATE collection_runs SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, $2) WHERE id = $1", [runId, now()]);
  await db.query('UPDATE collection_targets SET last_attempt_at = $2 WHERE id = $1', [ctx.target_id, now()]);

  try {
    const settings = await getGeneralSettings(db);
    if (!ctx.credential_id || !ctx.ciphertext || !ctx.iv || !ctx.auth_tag) throw new CollectError('NO_CREDENTIAL', '未配置 SSH 凭据');
    if (ctx.revoked_at) throw new CollectError('CREDENTIAL_REVOKED', 'SSH 凭据已撤销');

    const adapter = getAdapter(ctx.source);
    const range = computeRange(ctx, settings, now());
    const isBackfill = !ctx.initialized_at;
    let rows: ReturnType<typeof adapter.parse> = [];
    let meta = { ccusageVersion: null as string | null, costMode: null as string | null, priceVersion: null as string | null };

    if (range) {
      const req: CollectRequest = { source: ctx.source, dir: ctx.data_dir, since: range.since, until: range.until, timezone: settings.timezone };
      const command = buildCollectCommand(ctx.collect_command, req);
      const secret = JSON.parse(unseal(deps.masterKey, { ciphertext: ctx.ciphertext, iv: ctx.iv, authTag: ctx.auth_tag }, `credential:${ctx.credential_id}`)) as { privateKey: string; passphrase?: string };
      const result = await deps.executor.exec(
        { host: ctx.host, port: ctx.port, username: ctx.ssh_username, privateKey: secret.privateKey, passphrase: secret.passphrase, expectedHostFingerprint: ctx.host_key_fingerprint },
        command, deps.sshTimeoutMs,
      );
      if (result.exitCode !== 0 && result.stdout.trim() === '') {
        throw new CollectError('REMOTE_EXEC_FAILED', `远端命令退出码 ${result.exitCode}: ${result.stderr.slice(0, 200)}`, true);
      }
      const envelope = parseEnvelope(result.stdout, req);
      rows = adapter.parse(envelope.report);
      const version = envelope.ccusageVersion ?? null;
      meta = {
        ccusageVersion: version,
        costMode: envelope.costMode ?? null,
        priceVersion: version ? `ccusage@${version}/${envelope.offline === false ? 'live' : 'offline'}` : null,
      };
    }

    // 只有完整、校验成功的结果才走到这里；入库、状态更新与告警在同一事务内完成
    const outcome = await withTx(db, async (tx) => {
      const held = await tx.query('SELECT 1 FROM collection_targets WHERE id = $1 AND lock_run_id = $2 FOR UPDATE', [ctx.target_id, runId]);
      if (held.rowCount === 0) return null; // 租约已被更新的运行接管：放弃旧结果，避免覆盖新结果

      const collectedAt = now();
      const ingest = range
        ? await ingestSnapshot(tx, {
          targetId: ctx.target_id, serverId: ctx.server_id, source: ctx.source, runId, since: range.since, until: range.until, rows,
          timezone: settings.timezone, costMode: meta.costMode, priceVersion: meta.priceVersion, parserVersion: adapter.parserVersion,
          collectedAt, acceptDecrease: opts.acceptDecrease ?? false,
        })
        : { rowsWritten: 0, replacedDates: [], userIds: [], anomalies: [] };

      await tx.query(
        `UPDATE collection_targets
            SET last_success_at = $2, last_status = 'success', last_error = NULL, last_error_code = NULL,
                consecutive_failures = 0, failure_streak_id = NULL, initialized_at = COALESCE(initialized_at, $2),
                lock_run_id = NULL, lock_expires_at = NULL, updated_at = $2
          WHERE id = $1`,
        [ctx.target_id, collectedAt],
      );
      await tx.query('UPDATE servers SET last_connect_ok_at = $2, last_error = NULL WHERE id = $1', [ctx.server_id, collectedAt]);

      // 除了本次数据有变化的用户，始终评估目标当前绑定的用户：新建规则或预算调整后无需等到用量变化才生效
      const alertsCreated = range
        ? await evaluateUsageAlerts(tx, {
          userIds: [...new Set([...ingest.userIds, ctx.user_id])], touchedSince: range.since, today: dateInTz(collectedAt, settings.timezone), now: collectedAt,
          isBackfill, settings, runId, baseUrl: deps.baseUrl,
        })
        : 0;

      await tx.query(
        `UPDATE collection_runs SET status = 'success', finished_at = $2, range_since = $3, range_until = $4, rows_written = $5,
                anomalies = $6, ccusage_version = $7, parser_version = $8, error_code = NULL, error_message = NULL WHERE id = $1`,
        [runId, collectedAt, range?.since ?? null, range?.until ?? null, ingest.rowsWritten, JSON.stringify(ingest.anomalies), meta.ccusageVersion, adapter.parserVersion],
      );
      return { rowsWritten: ingest.rowsWritten, alertsCreated };
    });

    if (!outcome) {
      await db.query("UPDATE collection_runs SET status = 'stale', finished_at = $2, error_message = '结果已过期，被更新的采集取代' WHERE id = $1", [runId, now()]);
      return { status: 'stale' };
    }
    log.info({ runId, targetId: ctx.target_id, ...outcome }, '采集成功');
    return { status: 'success', ...outcome };
  } catch (err) {
    const code = err instanceof CollectError ? err.code : 'INTERNAL';
    const retryable = err instanceof CollectError ? err.retryable : true;
    const message = sanitizeError(err);
    const final = opts.finalAttempt || !retryable;
    log.warn({ runId, targetId: ctx.target_id, code, final }, `采集失败: ${message}`);
    await withTx(db, (tx) => recordFailure(tx, deps, ctx, { code, message, final, at: now() }));
    return { status: 'failed', code, message, retryable };
  }
}

/** 失败时保留上次成功数据，只更新状态；达到连续失败阈值时通知管理员（每段连续失败只通知一次）。 */
async function recordFailure(tx: Tx, deps: RunnerDeps, ctx: RunContext, f: { code: string; message: string; final: boolean; at: Date }): Promise<void> {
  await tx.query(
    `UPDATE collection_runs SET status = $2, finished_at = $3, error_code = $4, error_message = $5 WHERE id = $1`,
    [ctx.run_id, f.final ? 'failed' : 'queued', f.final ? f.at : null, f.code, f.message],
  );
  if (!f.final) {
    await tx.query('UPDATE collection_targets SET lock_run_id = NULL, lock_expires_at = NULL WHERE id = $1 AND lock_run_id = $2', [ctx.target_id, ctx.run_id]);
    return;
  }
  const target = (await tx.query(
    `UPDATE collection_targets
        SET last_status = 'failed', last_error_code = $3, last_error = $4, consecutive_failures = consecutive_failures + 1,
            failure_streak_id = COALESCE(failure_streak_id, $5), updated_at = $6,
            lock_run_id = CASE WHEN lock_run_id = $2 THEN NULL ELSE lock_run_id END,
            lock_expires_at = CASE WHEN lock_run_id = $2 THEN NULL ELSE lock_expires_at END
      WHERE id = $1 RETURNING consecutive_failures, failure_streak_id, last_success_at, user_id`,
    [ctx.target_id, ctx.run_id, f.code, f.message, randomUUID(), f.at],
  )).rows[0];
  await tx.query('UPDATE servers SET last_error = $2 WHERE id = $1', [ctx.server_id, `${f.code}: ${f.message}`]);

  const settings = await getGeneralSettings(tx);
  if (target.consecutive_failures < settings.failureAlertThreshold) return;
  const event = (await tx.query(
    `INSERT INTO alert_events (kind, dedupe_key, target_id, user_id, data_as_of, run_id)
     VALUES ('collection_failure', $1, $2, NULL, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [`collect_fail:${ctx.target_id}:${target.failure_streak_id}`, ctx.target_id, f.at, ctx.run_id],
  )).rows[0];
  if (!event) return;
  const admins = await adminEmails(tx);
  if (admins.length === 0) return;
  const names = (await tx.query('SELECT s.name AS server, u.name AS user_name FROM servers s, users u WHERE s.id = $1 AND u.id = $2', [ctx.server_id, target.user_id])).rows[0];
  const mail = renderFailureAlert({
    serverName: names.server, host: ctx.host, dataDir: ctx.data_dir, userName: names.user_name,
    consecutiveFailures: target.consecutive_failures, errorCode: f.code, errorMessage: f.message,
    lastSuccessAt: target.last_success_at, timezone: settings.timezone, baseUrl: deps.baseUrl,
  });
  await tx.query(
    'INSERT INTO email_outbox (alert_event_id, message_id, to_addrs, subject, body_text) VALUES ($1, $2, $3, $4, $5)',
    [event.id, messageIdFor(event.id, deps.baseUrl), admins, mail.subject, mail.text],
  );
}
