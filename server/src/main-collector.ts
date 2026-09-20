import { UnrecoverableError, Worker } from 'bullmq';
import { refreshAccountLimits } from './collect/limits.js';
import { recoverLostRuns } from './collect/recovery.js';
import { runCollection } from './collect/runner.js';
import { applyRetention, ensureSlotBatch } from './collect/scheduler.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { logger } from './logger.js';
import { COLLECT_QUEUE, SCHEDULE_QUEUE, createQueues, redisConnection, type CollectJob } from './queue/queues.js';
import { sshExecutor } from './ssh/client.js';
import { SKIPPED, createExclusive } from './util/exclusive.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const queues = createQueues(config.redisUrl, config.collectMaxAttempts);
const connection = redisConnection(config.redisUrl);
const log = logger.child({ worker: 'collector' });

async function tick(): Promise<void> {
  const batch = await ensureSlotBatch(db);
  if (batch) {
    await queues.enqueueRuns(batch.runIds);
    log.info({ batchId: batch.batchId, kind: batch.kind, runs: batch.runIds.length }, '已创建采集批次');
    if (batch.kind === 'scheduled') await applyRetention(db).catch((err) => log.error({ err }, '数据保留清理失败'));
  }
  const recovered = await recoverLostRuns(
    { db, baseUrl: config.publicBaseUrl, log, sshTimeoutMs: config.sshTimeoutMs, maxAttempts: config.collectMaxAttempts },
    { getJob: (runId) => queues.collect.getJob(runId), enqueue: (runIds, opts) => queues.enqueueRuns(runIds, opts) },
  );
  if (recovered.failed.length > 0) await queues.kickMail(); // 可能产生了采集失败通知
}

const limitsDeps = { db, executor: sshExecutor, masterKey: config.masterKey, log, baseUrl: config.publicBaseUrl };

// 用量采集的 tick 与每 10 分钟的额度刷新共用一个调度队列。额度刷新要逐台 SSH，慢的时候能跑好几分钟：
// 并发设为 2 让两者互不阻塞（否则 tick 被拖成 catchup、跳过数据保留清理）；同名任务则在进程内互斥——
// 上一轮还没跑完时新的一轮直接跳过，保证任何时刻最多各有一个在执行，启动时的那一次也走同一道闸。
const exclusive = createExclusive();
async function runScheduled(name: 'tick' | 'limits'): Promise<unknown> {
  // tick 幂等且很快：被跳过的那次可能正好落在新的调度时点上，合并到当前这轮之后补跑一遍；额度刷新则直接跳过，等下一个 10 分钟
  const result = await exclusive.run<unknown>(name, () => (name === 'limits' ? refreshAccountLimits(limitsDeps) : tick()), { coalesce: name === 'tick' });
  if (result === SKIPPED) log.warn({ job: name }, name === 'tick' ? '上一轮 tick 还在执行：本轮合并到它结束之后' : '上一轮额度刷新还在执行，跳过本轮');
  return result === SKIPPED ? { skipped: true } : result;
}
const scheduleWorker = new Worker(SCHEDULE_QUEUE, (job) => runScheduled(job.name === 'limits' ? 'limits' : 'tick'), { connection, concurrency: 2 });

const collectWorker = new Worker<CollectJob>(COLLECT_QUEUE, async (job) => {
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const outcome = await runCollection(
    { db, executor: sshExecutor, masterKey: config.masterKey, baseUrl: config.publicBaseUrl, sshTimeoutMs: config.sshTimeoutMs, log },
    job.data.runId, { finalAttempt, acceptDecrease: job.data.acceptDecrease },
  );
  if (outcome.status === 'success' && outcome.alertsCreated > 0) await queues.kickMail();
  if (outcome.status === 'failed') {
    await queues.kickMail(); // 可能产生了采集失败通知
    if (!outcome.retryable) throw new UnrecoverableError(`${outcome.code}: ${outcome.message}`);
    throw new Error(`${outcome.code}: ${outcome.message}`);
  }
  return outcome;
}, { connection, concurrency: config.collectConcurrency }); // 有限并发，控制中央平台与远端服务器负载

for (const w of [scheduleWorker, collectWorker]) w.on('error', (err) => log.error({ err }, '队列 Worker 错误'));

await queues.syncSchedule(db);
// 启动即检查：若当前调度时点的批次因停机被遗漏，则补建一次
await runScheduled('tick').catch((err) => log.error({ err }, '启动补采检查失败'));
void runScheduled('limits').catch((err) => log.error({ err }, '账号额度查询失败'));
log.info({ concurrency: config.collectConcurrency }, '采集 Worker 已启动');

async function shutdown(): Promise<void> {
  await Promise.all([scheduleWorker.close(), collectWorker.close()]);
  await queues.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
