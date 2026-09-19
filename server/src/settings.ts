import { z } from 'zod';
import type { Queryable } from './db/pool.js';
import { isValidTimeZone } from './util/time.js';

export const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24] as const;

export const generalSettingsSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, '无效的 IANA 时区'),
  collectIntervalHours: z.number().int().refine((n) => (INTERVAL_CHOICES as readonly number[]).includes(n), '采集周期必须能整除 24 小时'),
  /** 常规轮询重算“当天及最近几天” */
  lookbackDays: z.number().int().min(1).max(30),
  /** 每日首个批次执行较长范围的对账 */
  reconcileDays: z.number().int().min(1).max(400),
  /** 首次接入回填的历史天数 */
  backfillDays: z.number().int().min(1).max(1500),
  /** 首次历史回填是否触发告警（默认关闭，避免集中发送过期提醒） */
  backfillAlerts: z.boolean(),
  /** 连续失败多少轮后通知管理员 */
  failureAlertThreshold: z.number().int().min(1).max(100),
  /** 统计数据保留天数；0 表示永久保留 */
  retentionDays: z.number().int().min(0).max(10000),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export const DEFAULT_GENERAL: GeneralSettings = {
  timezone: 'Asia/Shanghai',
  collectIntervalHours: 2,
  lookbackDays: 3,
  reconcileDays: 35,
  backfillDays: 90,
  backfillAlerts: false,
  failureAlertThreshold: 2,
  retentionDays: 0,
};

export const smtpSettingsSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** true = 隐式 TLS（465）；false = STARTTLS（强制升级） */
  secure: z.boolean(),
  username: z.string().max(200).optional(),
  from: z.string().min(3).max(320),
});
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

/** 入库形态：密码以 AES-GCM 密文保存，永不回显。 */
export interface StoredSmtp extends SmtpSettings {
  passwordSealed?: { ciphertext: string; iv: string; authTag: string };
}

async function getSetting<T>(db: Queryable, key: string): Promise<T | undefined> {
  const res = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows[0]?.value as T | undefined;
}

export async function putSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
    [key, JSON.stringify(value)],
  );
}

export async function getGeneralSettings(db: Queryable): Promise<GeneralSettings> {
  return { ...DEFAULT_GENERAL, ...(await getSetting<Partial<GeneralSettings>>(db, 'general')) };
}

export const getStoredSmtp = (db: Queryable) => getSetting<StoredSmtp>(db, 'smtp');
