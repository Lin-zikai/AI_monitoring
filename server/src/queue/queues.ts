import { Queue, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/pool.js';
import { getGeneralSettings } from '../settings.js';

export const COLLECT_QUEUE = 'collect';
export const SCHEDULE_QUEUE = 'schedule';
export const MAIL_QUEUE = 'mail';

export interface CollectJob { runId: string; acceptDecrease?: boolean }

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export interface Queues {
  collect: Queue<CollectJob>;
  schedule: Queue;
  mail: Queue;
  enqueueRuns(runIds: string[], opts?: { acceptDecrease?: boolean }): Promise<void>;
  kickMail(): Promise<void>;
  syncSchedule(db: Db): Promise<void>;
  close(): Promise<void>;
}

export function createQueues(redisUrl: string, collectMaxAttempts: number): Queues {
  const connection = redisConnection(redisUrl);
  const collect = new Queue<CollectJob>(COLLECT_QUEUE, { connection });
  const schedule = new Queue(SCHEDULE_QUEUE, { connection });
  const mail = new Queue(MAIL_QUEUE, { connection });

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
      await mail.upsertJobScheduler('mail-sweep', { every: 60_000 }, { name: 'drain', opts: { removeOnComplete: true, removeOnFail: 100 } });
    },

    async close() {
      await Promise.all([collect.close(), schedule.close(), mail.close()]);
    },
  };
}
