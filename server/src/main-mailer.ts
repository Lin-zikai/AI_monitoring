import { Worker } from 'bullmq';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { logger } from './logger.js';
import { processOutbox } from './mail/outbox.js';
import { createSmtpSender } from './mail/transport.js';
import { MAIL_QUEUE, createQueues, redisConnection } from './queue/queues.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const log = logger.child({ worker: 'mailer' });

const worker = new Worker(MAIL_QUEUE, async () => {
  // 每次重新读取 SMTP 设置，管理员修改后无需重启
  const sender = await createSmtpSender(db, config.masterKey);
  if (!sender) {
    const pending = (await db.query("SELECT count(*)::int AS n FROM email_outbox WHERE status = 'pending'")).rows[0].n;
    if (pending > 0) log.warn({ pending }, '尚未配置 SMTP，邮件保留在发件箱');
    return { sent: 0, retried: 0, failed: 0 };
  }
  const result = await processOutbox(db, sender, { maxAttempts: config.mailMaxAttempts, log });
  if (result.sent + result.retried + result.failed > 0) log.info(result, '发件箱处理完成');
  return result;
}, { connection: redisConnection(config.redisUrl), concurrency: 1 });
worker.on('error', (err) => log.error({ err }, '队列 Worker 错误'));

const queues = createQueues(config.redisUrl, config.collectMaxAttempts);
await queues.syncSchedule(db);
log.info('邮件 Worker 已启动');

async function shutdown(): Promise<void> {
  await worker.close();
  await queues.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
