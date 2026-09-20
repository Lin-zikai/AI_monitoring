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

// 优雅退出：重复信号只处理一次；15 秒内收不了尾（SMTP 连接卡住、Redis 无响应）就强制退出
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, '正在退出');
  setTimeout(() => { log.error('退出超时，强制结束进程'); process.exit(1); }, 15_000).unref();
  try {
    await worker.close();
    await queues.close();
    await db.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, '退出过程中出错');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
