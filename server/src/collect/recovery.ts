import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import { failLostRun } from './runner.js';

// 回收丢失的采集运行。正常情况下每个运行都由队列任务（jobId = runId）推进到终态；以下情况会让它永远停在半路：
// - queued：创建后进程在入队前崩溃；或重试之间任务从队列里丢失（Redis 数据丢失、任务被移入 failed 集合）；
// - running：进程在采集途中被杀，而队列已不再重试；或最后一次尝试在记录失败之前就抛了错。
// 是否“丢失”以队列里的任务状态为准，而不是靠时间猜：任务还在等待 / 延迟重试 / 执行中的一律不动。

export interface QueueJobLike {
  data?: { acceptDecrease?: boolean };
  getState(): Promise<string>;
  remove(): Promise<void>;
}

export interface RunQueue {
  getJob(runId: string): Promise<QueueJobLike | null | undefined>;
  enqueue(runIds: string[], opts?: { acceptDecrease?: boolean }): Promise<void>;
}

export interface RecoveryDeps {
  db: Db;
  baseUrl: string;
  log: Logger;
  sshTimeoutMs: number;
  /** 队列为每个运行安排的最多尝试次数：已经用完的不再重新入队，直接记为失败 */
  maxAttempts: number;
  now?: () => Date;
}

const ALIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children', 'paused']);
const QUEUED_GRACE_MS = 10 * 60_000;
const RUNNING_GRACE_MS = 5 * 60_000;
const LOCK_MARGIN_MS = 60_000; // 与 runner.ts 的租约余量一致

async function jobOf(queue: RunQueue, runId: string): Promise<{ job: QueueJobLike | null; alive: boolean }> {
  const job = (await queue.getJob(runId)) ?? null;
  return { job, alive: job ? ALIVE_STATES.has(await job.getState()) : false };
}

export async function recoverLostRuns(deps: RecoveryDeps, queue: RunQueue): Promise<{ requeued: string[]; failed: string[] }> {
  const { db, log } = deps;
  const now = deps.now?.() ?? new Date();
  const requeued: string[] = [];
  const failed: string[] = [];

  // 1. 排队超过一天的：当时的采集范围早已由后续批次覆盖，不再补跑，也不计入连续失败
  const expired = await db.query(
    `UPDATE collection_runs SET status = 'failed', finished_at = $1, error_code = 'RUN_LOST', error_message = '排队超过一天仍未执行，已放弃（后续批次会覆盖同一范围）'
      WHERE status = 'queued' AND created_at < $1::timestamptz - interval '1 day' RETURNING id`,
    [now],
  );
  failed.push(...expired.rows.map((r) => r.id as string));

  // 2. 停在 queued：任务不在队列里（或躺在 failed 集合里挡住同名任务）就重新入队；尝试次数已用完的记为失败
  const queuedRuns = await db.query<{ id: string; attempt: number }>(
    "SELECT id, attempt FROM collection_runs WHERE status = 'queued' AND created_at < $1::timestamptz - make_interval(secs => $2) ORDER BY created_at LIMIT 500",
    [now, QUEUED_GRACE_MS / 1000],
  );
  for (const run of queuedRuns.rows) {
    const { job, alive } = await jobOf(queue, run.id);
    if (alive) continue;
    // 留在 completed / failed 集合里的旧任务会让同一个 jobId 的新任务被忽略：先移除
    if (job) await job.remove().catch((err) => log.warn({ err, runId: run.id }, '移除已结束的队列任务失败'));
    if (run.attempt >= deps.maxAttempts) {
      if (await failLostRun(deps, run.id, '重试途中任务从队列里丢失，且尝试次数已用完')) failed.push(run.id);
    } else {
      await queue.enqueue([run.id], { acceptDecrease: job?.data?.acceptDecrease });
      requeued.push(run.id);
    }
  }

  // 3. 停在 running：锁的租约已过期一段时间（或锁已被别的运行接管），队列里也没有会继续推进它的任务
  const runningRuns = await db.query<{ id: string }>(
    `SELECT r.id FROM collection_runs r JOIN collection_targets t ON t.id = r.target_id
      WHERE r.status = 'running' AND COALESCE(r.started_at, r.created_at) < $1::timestamptz - make_interval(secs => $2)
        AND (t.lock_run_id IS DISTINCT FROM r.id OR t.lock_expires_at < $1::timestamptz - make_interval(secs => $3))
      ORDER BY r.created_at LIMIT 500`,
    [now, (deps.sshTimeoutMs + LOCK_MARGIN_MS + RUNNING_GRACE_MS) / 1000, RUNNING_GRACE_MS / 1000],
  );
  for (const run of runningRuns.rows) {
    if ((await jobOf(queue, run.id)).alive) continue;
    if (await failLostRun(deps, run.id, '采集途中中断（进程重启或队列任务丢失），未能完成')) failed.push(run.id);
  }

  if (requeued.length + failed.length > 0) log.warn({ requeued: requeued.length, failed: failed.length }, '已回收丢失的采集运行');
  return { requeued, failed };
}
