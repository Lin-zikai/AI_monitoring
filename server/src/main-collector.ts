import { UnrecoverableError, Worker } from 'bullmq';
import { refreshAccountLimits } from './collect/limits.js';
import { runCollection } from './collect/runner.js';
import { applyRetention, ensureSlotBatch, findOrphanedRuns } from './collect/scheduler.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { logger } from './logger.js';
import { COLLECT_QUEUE, SCHEDULE_QUEUE, createQueues, redisConnection, type CollectJob } from './queue/queues.js';
import { sshExecutor } from './ssh/client.js';

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
  await queues.enqueueRuns(await findOrphanedRuns(db));
}

const limitsDeps = { db, executor: sshExecutor, masterKey: config.masterKey, log };
const scheduleWorker = new Worker(SCHEDULE_QUEUE, async (job) => (job.name === 'limits' ? refreshAccountLimits(limitsDeps) : tick()), { connection });

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
await tick().catch((err) => log.error({ err }, '启动补采检查失败'));
void refreshAccountLimits(limitsDeps).catch((err) => log.error({ err }, '账号额度查询失败'));
log.info({ concurrency: config.collectConcurrency }, '采集 Worker 已启动');

async function shutdown(): Promise<void> {
  await Promise.all([scheduleWorker.close(), collectWorker.close()]);
  await queues.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
