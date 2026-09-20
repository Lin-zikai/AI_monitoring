import { Queue, type ConnectionOptions } from 'bullmq';
import type { Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import { getGeneralSettings } from '../settings.js';

export const COLLECT_QUEUE = 'collect';
export const SCHEDULE_QUEUE = 'schedule';
export const MAIL_QUEUE = 'mail';

export interface CollectJob { runId: string; acceptDecrease?: boolean }

export interface RedisConnectionOptions {
  /**
   * 供 API 进程使用：Redis 断开后，命令重试一次就报错，而不是无限排队等待重连（否则 HTTP 请求会一直挂起）。
   * 启动时就连不上的情况 BullMQ 会一直等连接就绪，由 API 层的超时兜底（api/app.ts 的 guardQueues）。
   * 不关闭 enableOfflineQueue：实测关闭后，Redis 不可用时 Queue.close() 内部的 QUIT 会抛出无人接收的异常，直接打崩进程。
   * Worker 必须保持默认（maxRetriesPerRequest: null），这是 BullMQ 对阻塞连接的要求。
   */
  failFast?: boolean;
}

export function redisConnection(redisUrl: string, opts: RedisConnectionOptions = {}): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    ...(opts.failFast ? { maxRetriesPerRequest: 1, connectTimeout: 5000 } : { maxRetriesPerRequest: null }),
  };
}

export interface Queues {
  collect: Queue<CollectJob>;
  schedule: Queue;
  mail: Queue;
  enqueueRuns(runIds: string[], opts?: { acceptDecrease?: boolean }): Promise<void>;
  kickMail(): Promise<void>;
  syncSchedule(db: Queryable): Promise<void>;
  close(): Promise<void>;
}

export function createQueues(redisUrl: string, collectMaxAttempts: number, opts: RedisConnectionOptions = {}): Queues {
  const connection = redisConnection(redisUrl, opts);
  const collect = new Queue<CollectJob>(COLLECT_QUEUE, { connection });
  const schedule = new Queue(SCHEDULE_QUEUE, { connection });
  const mail = new Queue(MAIL_QUEUE, { connection });
  // 连接错误（Redis 重启、断网）由 ioredis 自动重连；这里只负责留下日志
  for (const q of [collect, schedule, mail]) q.on('error', (err) => logger.warn({ err: err.message, queue: q.name }, '任务队列连接出错'));

  return {
    collect, schedule, mail,

    async enqueueRuns(runIds, opts) {
      if (runIds.length === 0) return;
      await collect.addBulk(runIds.map((runId) => ({
        name: 'collect',
        data: { runId, acceptDecrease: opts?.acceptDecrease },
        opts: {
          jobId: runId, // 与运行一一对应，重复入队会被忽略
          attempts: collectMaxAttempts,
          backoff: { type: 'exponential', delay: 60_000 }, // 有限次数退避重试，不必等下一个调度时点
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        },
      })));
    },

    async kickMail() {
      await mail.add('drain', {}, { removeOnComplete: true, removeOnFail: 100 });
    },

    /** 按系统设置（采集周期、统计时区）登记定时调度；设置变更后重新调用即可。 */
    async syncSchedule(db) {
      const s = await getGeneralSettings(db);
      const pattern = s.collectIntervalHours === 24 ? '0 0 * * *' : `0 */${s.collectIntervalHours} * * *`;
      await schedule.upsertJobScheduler('collect-tick', { pattern, tz: s.timezone }, { name: 'tick', opts: { removeOnComplete: 50, removeOnFail: 100 } });
      // 账号额度（5 小时 / 周）变化快：独立于 2 小时的用量采集，每 10 分钟查一次
      await schedule.upsertJobScheduler('limits-tick', { every: 10 * 60_000 }, { name: 'limits', opts: { removeOnComplete: 20, removeOnFail: 50 } });
      await mail.upsertJobScheduler('mail-sweep', { every: 60_000 }, { name: 'drain', opts: { removeOnComplete: true, removeOnFail: 100 } });
    },

    async close() {
      await Promise.all([collect.close(), schedule.close(), mail.close()]);
    },
  };
}
