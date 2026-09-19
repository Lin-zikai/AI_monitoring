import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { logger } from './logger.js';
import { createSmtpSender } from './mail/transport.js';
import { createQueues } from './queue/queues.js';
import { hashPassword } from './security/password.js';
import { scanHostKey, sshExecutor } from './ssh/client.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) logger.info({ applied }, '已执行数据库迁移');

// 首次启动且没有任何用户时，用环境变量创建初始管理员
const userCount = (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
if (userCount === 0) {
  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) throw new Error('首次启动需要设置 ADMIN_EMAIL 与 ADMIN_PASSWORD 以创建管理员');
  if (config.bootstrapAdminPassword.length < 10) throw new Error('ADMIN_PASSWORD 至少 10 位');
  await db.query("INSERT INTO users (name, email, role, password_hash) VALUES ('管理员', $1, 'admin', $2)", [config.bootstrapAdminEmail, await hashPassword(config.bootstrapAdminPassword)]);
  logger.info({ email: config.bootstrapAdminEmail }, '已创建初始管理员，请登录后修改密码并移除 ADMIN_PASSWORD');
}

const queues = createQueues(config.redisUrl, config.collectMaxAttempts);
const app = await buildApp({ db, config, queues, executor: sshExecutor, scanHostKey, smtpSenderFactory: createSmtpSender });
await app.listen({ host: config.apiHost, port: config.apiPort });

async function shutdown(): Promise<void> {
  await app.close();
  await queues.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
