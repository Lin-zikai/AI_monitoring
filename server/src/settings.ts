import { z } from 'zod';
import type { Queryable } from './db/pool.js';
import { isValidHost } from './security/validate.js';
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
  reconcileDays: 28, // Claude Code 默认只保留约 30 天的本地日志：超过这个范围去对账，只会把已被清理的旧日期误判为“用量减少”
  backfillDays: 90,
  backfillAlerts: false,
  failureAlertThreshold: 2,
  retentionDays: 0,
};

/** 账号额度提醒：任一窗口（5 小时 / 周）的剩余比例低于阈值时发邮件；同一窗口在同一刷新周期内只提醒一次 */
export const limitAlertSchema = z.object({
  enabled: z.boolean(),
  remainingBelowPercent: z.number().min(1).max(99),
  /** 5 小时窗口几小时就刷新一次，默认不为它发邮件，只看周额度 */
  includeFiveHour: z.boolean().default(false),
  notifyAdmins: z.boolean(),
  emails: z.array(z.string().trim().email().max(320)).max(20),
}).refine((v) => !v.enabled || v.notifyAdmins || v.emails.length > 0, { message: '至少需要一类收件人', path: ['emails'] });
export type LimitAlertSettings = z.infer<typeof limitAlertSchema>;
export const DEFAULT_LIMIT_ALERT: LimitAlertSettings = { enabled: false, remainingBelowPercent: 20, includeFiveHour: false, notifyAdmins: true, emails: [] };

export const smtpSettingsSchema = z.object({
  host: z.string().trim().refine(isValidHost, 'SMTP 服务器地址不合法（应为主机名或 IP）'),
  port: z.number().int().min(1).max(65535),
  /** true = 隐式 TLS（465）；false = STARTTLS（强制升级） */
  secure: z.boolean(),
  username: z.string().max(200).optional(),
  from: z.string().min(3).max(320),
});
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

/** 账目明细：人民币 / 美元换算用的汇率（1 美元 = usdCny 元）。账单金额按原币种保存，换算只发生在展示时 */
export const billingSettingsSchema = z.object({ usdCny: z.number().min(1).max(20) });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export const DEFAULT_BILLING: BillingSettings = { usdCny: 7.2 };

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

export async function getLimitAlertSettings(db: Queryable): Promise<LimitAlertSettings> {
  return { ...DEFAULT_LIMIT_ALERT, ...(await getSetting<Partial<LimitAlertSettings>>(db, 'limitAlert')) };
}

export async function getBillingSettings(db: Queryable): Promise<BillingSettings> {
  return { ...DEFAULT_BILLING, ...(await getSetting<Partial<BillingSettings>>(db, 'billing')) };
}

export const getStoredSmtp = (db: Queryable) => getSetting<StoredSmtp>(db, 'smtp');
