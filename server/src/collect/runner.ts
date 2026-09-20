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

/** 采集范围的额外依据（由 runCollection 查库得出；单元测试可直接传入） */
export interface RangeHints {
  /** 管理员“接受减少”的手动采集：要覆盖到对账范围，否则每日对账标出的较早日期永远清不掉 */
  acceptDecrease?: boolean;
  /** 该目标最早一条待确认（retained / decrease_flagged）数据的日期 */
  flaggedFrom?: string | null;
  /** 该目标按其他统计时区入库的数据的起止日期：统计时区变更后要整段重新分桶 */
  rebucketFrom?: string | null;
  rebucketUntil?: string | null;
}

export type RunOutcome =
  | { status: 'success'; rowsWritten: number; alertsCreated: number }
  | { status: 'skipped_locked' | 'stale' }
  | { status: 'failed'; code: string; message: string; retryable: boolean };

interface RunContext {
  run_id: string; trigger: string; run_status: string; run_error_code: string | null; run_error_message: string | null; reconcile: boolean | null;
  target_id: string; user_id: string; server_id: string; source: string; data_dir: string; target_enabled: boolean; missing_ok: boolean;
  source_start_date: string | null; source_end_date: string | null;
  initialized_at: Date | null; last_success_at: Date | null;
  host: string; port: number; collect_command: string; host_key_fingerprint: string | null; server_enabled: boolean;
  ssh_username: string; credential_id: string | null;
  ciphertext: Buffer | null; iv: Buffer | null; auth_tag: Buffer | null; revoked_at: Date | null;
}

const LOCK_MARGIN_MS = 60_000;
// 尚未结束的运行状态：所有“写入终态”的语句都带这个条件，重复投递的任务不会覆盖已经提交的结果
const OPEN_STATUSES = "'queued', 'running'";
// pg_advisory_xact_lock(int, int) 的第一个键：用量告警评估按用户串行化
const USER_ALERT_LOCK_SPACE = 7_203_912;

export function computeRange(ctx: Pick<RunContext, 'initialized_at' | 'last_success_at' | 'reconcile' | 'source_start_date' | 'source_end_date'>,
  settings: GeneralSettings, now: Date, hints: RangeHints = {}): { since: string; until: string } | null {
  const today = dateInTz(now, settings.timezone);
  const floor = addDays(today, -settings.backfillDays);
  let since: string;
  let until = today;
  if (!ctx.initialized_at) {
    since = floor;
  } else {
    since = addDays(today, -(ctx.reconcile || hints.acceptDecrease ? settings.reconcileDays : settings.lookbackDays));
    // 断连或停机后补采：从上次成功采集的前一天开始，一次覆盖整个缺口
    if (ctx.last_success_at) since = minDate(since, addDays(dateInTz(ctx.last_success_at, settings.timezone), -1));
    // “接受减少”要能清掉所有待确认的日期（长时间断连后的补采可能在对账范围之外留下标记）
    if (hints.acceptDecrease && hints.flaggedFrom) since = minDate(since, hints.flaggedFrom);
    since = maxDate(since, minDate(floor, addDays(today, -settings.reconcileDays)));
  }
  // 统计时区变更：把按旧时区入库的日期一次全部覆盖（不超过回填下限）。小时在相邻日期之间挪动，所以两头各多带一天
  if (hints.rebucketFrom) since = minDate(since, maxDate(addDays(hints.rebucketFrom, -1), floor));
  if (hints.rebucketUntil) until = maxDate(until, minDate(hints.rebucketUntil, addDays(today, 1)));
  // 来源切换边界：日志迁移后，每份逻辑数据只从唯一来源入库
  if (ctx.source_start_date) since = maxDate(since, ctx.source_start_date);
  if (ctx.source_end_date) until = minDate(until, ctx.source_end_date);
  return since <= until ? { since, until } : null;
}

async function loadRangeHints(db: Db, ctx: RunContext, settings: GeneralSettings, now: Date, acceptDecrease: boolean): Promise<RangeHints> {
  const floor = addDays(dateInTz(now, settings.timezone), -settings.backfillDays);
  const r = (await db.query(
    // 已标记待确认的旧时区行不触发扩大范围：它们在等管理员核对，否则每一轮采集都会白白回看到那一天
    `SELECT min(usage_date) FILTER (WHERE timezone <> $3 AND integrity = 'complete')::text AS rebucket_from,
            max(usage_date) FILTER (WHERE timezone <> $3 AND integrity = 'complete')::text AS rebucket_until,
            min(usage_date) FILTER (WHERE integrity <> 'complete')::text AS flagged_from
       FROM usage_daily
      WHERE target_id = $1 AND source = $2 AND usage_date >= $4 AND (timezone <> $3 OR integrity <> 'complete')
        AND ($5::date IS NULL OR usage_date >= $5) AND ($6::date IS NULL OR usage_date <= $6)`, // 来源切换边界之外的日期本来就采不到，不为它们扩大范围
    [ctx.target_id, ctx.source, settings.timezone, floor, ctx.source_start_date, ctx.source_end_date],
  )).rows[0];
  return { acceptDecrease, flaggedFrom: r?.flagged_from ?? null, rebucketFrom: r?.rebucket_from ?? null, rebucketUntil: r?.rebucket_until ?? null };
}

async function loadContext(db: Db, runId: string): Promise<RunContext | undefined> {
  const res = await db.query<RunContext>(
    `SELECT r.id AS run_id, r.trigger, r.status AS run_status, r.error_code AS run_error_code, r.error_message AS run_error_message, b.reconcile,
            t.id AS target_id, t.user_id, t.server_id, t.source, t.data_dir, t.enabled AS target_enabled, t.missing_ok,
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
  // failed 一定是终态（可重试的失败会退回 queued）：包括被“丢失运行”清理判为失败之后才迟到的重试
  if (ctx.run_status === 'failed') return { status: 'failed', code: ctx.run_error_code ?? 'FAILED', message: ctx.run_error_message ?? '采集失败', retryable: false };

  // 从加锁开始都放在 try 里：这几条语句抛错（数据库瞬时故障）同样要走失败记录，否则运行会永远停在 queued / running
  try {
    if (!ctx.target_enabled || !ctx.server_enabled) {
      // 入队后被停用：不算采集失败，不计入连续失败轮数
      await db.query(`UPDATE collection_runs SET status = 'failed', finished_at = $2, error_code = 'DISABLED', error_message = '服务器或采集目标已停用' WHERE id = $1 AND status IN (${OPEN_STATUSES})`, [runId, now()]);
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
      await db.query(`UPDATE collection_runs SET status = 'skipped_locked', finished_at = $2, error_message = '该目标已有采集在进行' WHERE id = $1 AND status IN (${OPEN_STATUSES})`, [runId, now()]);
      return { status: 'skipped_locked' };
    }

    const started = await db.query(`UPDATE collection_runs SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, $2) WHERE id = $1 AND status IN (${OPEN_STATUSES})`, [runId, now()]);
    if (started.rowCount === 0) {
      // 读取状态之后，重复投递的另一份已经把这次运行做完了：放掉刚拿到的锁，按终态返回
      await db.query('UPDATE collection_targets SET lock_run_id = NULL, lock_expires_at = NULL WHERE id = $1 AND lock_run_id = $2', [ctx.target_id, runId]);
      return await runCollection(deps, runId, opts);
    }
    await db.query('UPDATE collection_targets SET last_attempt_at = $2 WHERE id = $1', [ctx.target_id, now()]);

    const settings = await getGeneralSettings(db);
    if (!ctx.credential_id || !ctx.ciphertext || !ctx.iv || !ctx.auth_tag) throw new CollectError('NO_CREDENTIAL', '未配置 SSH 凭据');
    if (ctx.revoked_at) throw new CollectError('CREDENTIAL_REVOKED', 'SSH 凭据已撤销');

    const adapter = getAdapter(ctx.source);
    const range = computeRange(ctx, settings, now(), await loadRangeHints(db, ctx, settings, now(), opts.acceptDecrease ?? false));
    const isBackfill = !ctx.initialized_at;
    // 自动创建的目标：远端目录不存在 = 该用户还没用过这个工具。不算失败，也不标记“已初始化”，目录出现后仍会回填历史
    let dirMissing = false;
    let rows: ReturnType<typeof adapter.parse> = [];
    let meta = { ccusageVersion: null as string | null, costMode: null as string | null, priceVersion: null as string | null };

    if (range) {
      const req: CollectRequest = { source: ctx.source, dir: ctx.data_dir, since: range.since, until: range.until, timezone: settings.timezone };
      const command = buildCollectCommand(ctx.collect_command, req);
      const secret = JSON.parse(unseal(deps.masterKey, { ciphertext: ctx.ciphertext, iv: ctx.iv, authTag: ctx.auth_tag }, `credential:${ctx.credential_id}`)) as { privateKey: string; passphrase?: string };
      try {
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
      } catch (err) {
        if (!(ctx.missing_ok && err instanceof CollectError && err.code === 'DIR_MISSING')) throw err;
        dirMissing = true;
      }
    }

    // 只有完整、校验成功的结果才走到这里；入库、状态更新与告警在同一事务内完成
    const outcome = await withTx(db, async (tx) => {
      const held = await tx.query('SELECT 1 FROM collection_targets WHERE id = $1 AND lock_run_id = $2 FOR UPDATE', [ctx.target_id, runId]);
      if (held.rowCount === 0) return null; // 租约已被更新的运行接管：放弃旧结果，避免覆盖新结果

      const collectedAt = now();
      const ingest = range && !dirMissing
        ? await ingestSnapshot(tx, {
          targetId: ctx.target_id, serverId: ctx.server_id, source: ctx.source, runId, since: range.since, until: range.until, rows,
          timezone: settings.timezone, costMode: meta.costMode, priceVersion: meta.priceVersion, parserVersion: adapter.parserVersion,
          collectedAt, acceptDecrease: opts.acceptDecrease ?? false,
        })
        : { rowsWritten: 0, replacedDates: [], userIds: [], anomalies: [], changedDates: [] };

      await tx.query(
        `UPDATE collection_targets
            SET last_success_at = $2, last_status = 'success', last_error = NULL, last_error_code = CASE WHEN $3 THEN 'NO_DATA_DIR' END,
                consecutive_failures = 0, failure_streak_id = NULL, initialized_at = CASE WHEN $3 THEN initialized_at ELSE COALESCE(initialized_at, $2) END,
                lock_run_id = NULL, lock_expires_at = NULL, updated_at = $2
          WHERE id = $1`,
        [ctx.target_id, collectedAt, dirMissing],
      );
      await tx.query('UPDATE servers SET last_connect_ok_at = $2, last_error = NULL WHERE id = $1', [ctx.server_id, collectedAt]);

      // 除了本次数据有变化的用户，始终评估目标当前绑定的用户：新建规则或预算调整后无需等到用量变化才生效
      let alertsCreated = 0;
      if (range && !dirMissing) {
        const userIds = [...new Set([...ingest.userIds, ctx.user_id])].sort();
        // 同一用户在不同服务器上的入库可能并发：各自的事务看不到对方尚未提交的行，两边都按“只有自己这份”求和，
        // 合计已过阈值却谁也没发现。评估前按用户串行化：后拿到锁的事务求和时，先行者已经提交。
        // 加锁顺序固定为 采集目标行 → 服务器行 → 用户（按 ID 升序），所有事务一致，不会死锁。
        for (const userId of userIds) await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [USER_ALERT_LOCK_SPACE, userId]);
        alertsCreated = await evaluateUsageAlerts(tx, {
          userIds, touchedSince: range.since, changedDates: ingest.changedDates, today: dateInTz(collectedAt, settings.timezone), now: collectedAt,
          isBackfill, settings, runId, baseUrl: deps.baseUrl,
        });
      }

      await tx.query(
        `UPDATE collection_runs SET status = 'success', finished_at = $2, range_since = $3, range_until = $4, rows_written = $5,
                anomalies = $6, ccusage_version = $7, parser_version = $8, error_code = NULL, error_message = NULL WHERE id = $1`,
        [runId, collectedAt, range?.since ?? null, range?.until ?? null, ingest.rowsWritten, JSON.stringify(ingest.anomalies), meta.ccusageVersion, adapter.parserVersion],
      );
      return { rowsWritten: ingest.rowsWritten, alertsCreated };
    });

    if (!outcome) {
      // 只改仍在 running 的记录：同一运行被队列重复投递时，另一份可能已经提交了 success，不能被这里覆盖
      await db.query("UPDATE collection_runs SET status = 'stale', finished_at = $2, error_message = '结果已过期，被更新的采集取代' WHERE id = $1 AND status = 'running'", [runId, now()]);
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
async function recordFailure(tx: Tx, deps: Pick<RunnerDeps, 'baseUrl'>, ctx: RunContext, f: { code: string; message: string; final: boolean; at: Date }): Promise<boolean> {
  const updated = await tx.query(
    `UPDATE collection_runs SET status = $2, finished_at = $3, error_code = $4, error_message = $5 WHERE id = $1 AND status IN (${OPEN_STATUSES})`,
    [ctx.run_id, f.final ? 'failed' : 'queued', f.final ? f.at : null, f.code, f.message],
  );
  // 运行已有终态（重复投递的另一份已经提交）：这次失败不再记到目标头上
  if (updated.rowCount === 0) return false;
  if (!f.final) {
    await tx.query('UPDATE collection_targets SET lock_run_id = NULL, lock_expires_at = NULL WHERE id = $1 AND lock_run_id = $2', [ctx.target_id, ctx.run_id]);
    return true;
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
  if (target.consecutive_failures < settings.failureAlertThreshold) return true;
  const event = (await tx.query(
    `INSERT INTO alert_events (kind, dedupe_key, target_id, user_id, data_as_of, run_id)
     VALUES ('collection_failure', $1, $2, NULL, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [`collect_fail:${ctx.target_id}:${target.failure_streak_id}`, ctx.target_id, f.at, ctx.run_id],
  )).rows[0];
  if (!event) return true;
  const admins = await adminEmails(tx);
  if (admins.length === 0) return true;
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
  return true;
}

/**
 * 把中断的运行记为最终失败（与普通失败一样计入连续失败轮数、达到阈值时通知管理员）。
 * 用于回收丢失的运行：进程在采集途中被杀且队列不再重试，或任务在重试之间从队列里丢失。
 * 返回 false 表示运行已有终态，什么都没改。
 */
export async function failLostRun(deps: Pick<RunnerDeps, 'db' | 'baseUrl'> & { now?: () => Date }, runId: string, reason: string): Promise<boolean> {
  const ctx = await loadContext(deps.db, runId);
  if (!ctx) return false;
  return withTx(deps.db, (tx) => recordFailure(tx, deps, ctx, { code: 'RUN_LOST', message: reason, final: true, at: deps.now?.() ?? new Date() }));
}
