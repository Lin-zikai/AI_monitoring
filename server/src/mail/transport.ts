import nodemailer from 'nodemailer';
import type { Queryable } from '../db/pool.js';
import { unseal } from '../security/crypto.js';
import { getStoredSmtp, type StoredSmtp } from '../settings.js';

export interface OutgoingMail { messageId: string; to: string[]; subject: string; text: string }
export interface MailSender { send(mail: OutgoingMail): Promise<void> }

const SMTP_PASSWORD_AAD = 'setting:smtp-password';

export function smtpPasswordAad(): string {
  return SMTP_PASSWORD_AAD;
}

function envSmtp(): (StoredSmtp & { password?: string }) | undefined {
  const host = process.env.SMTP_HOST;
  if (!host) return undefined;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host, port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    username: process.env.SMTP_USERNAME, password: process.env.SMTP_PASSWORD, from: process.env.SMTP_FROM ?? `usage-monitor@${host}`,
  };
}

/** 优先使用系统设置中的 SMTP；未配置时回退到环境变量；都没有则返回 null（邮件留在发件箱等待）。 */
export async function createSmtpSender(db: Queryable, masterKey: Buffer): Promise<MailSender | null> {
  const stored = await getStoredSmtp(db);
  const cfg: (StoredSmtp & { password?: string }) | undefined = stored
    ? {
      ...stored,
      password: stored.passwordSealed
        ? unseal(masterKey, {
          ciphertext: Buffer.from(stored.passwordSealed.ciphertext, 'base64'),
          iv: Buffer.from(stored.passwordSealed.iv, 'base64'),
          authTag: Buffer.from(stored.passwordSealed.authTag, 'base64'),
        }, SMTP_PASSWORD_AAD)
        : undefined,
    }
    : envSmtp();
  if (!cfg) return null;

  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    requireTLS: !cfg.secure, // 非隐式 TLS 时强制 STARTTLS，拒绝明文投递
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined,
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: cfg.from, to: mail.to, subject: mail.subject, text: mail.text, messageId: mail.messageId });
    },
  };
}
