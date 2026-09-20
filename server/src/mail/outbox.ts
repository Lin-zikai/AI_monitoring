import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import { sanitizeError } from '../logger.js';
import type { MailSender } from './transport.js';

export interface OutboxResult { sent: number; retried: number; failed: number }

const SEND_LEASE_SECONDS = 300;
const backoffSeconds = (attempts: number) => Math.min(3600, 60 * 2 ** (attempts - 1));

/**
 * 发送到期的发件箱邮件。FOR UPDATE SKIP LOCKED 允许多个邮件 Worker 并行。
 * 'sending' 且租约过期的记录视为上次发送中途崩溃：会用同一个 Message-ID 重发——
 * SMTP 无法绝对保证只投递一次，稳定的邮件标识用于把重复风险降到最低。
 */
export async function processOutbox(db: Db, sender: MailSender, opts: { maxAttempts: number; log: Logger; limit?: number }): Promise<OutboxResult> {
  const result: OutboxResult = { sent: 0, retried: 0, failed: 0 };
  for (let i = 0; i < (opts.limit ?? 200); i++) {
    const claimed = (await db.query(
      `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, locked_until = now() + make_interval(secs => $1)
        WHERE id = (SELECT id FROM email_outbox
                     WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
                     ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, message_id, to_addrs, subject, body_text, attempts`,
      [SEND_LEASE_SECONDS],
    )).rows[0];
    if (!claimed) break;

    try {
      await sender.send({ messageId: claimed.message_id, to: claimed.to_addrs, subject: claimed.subject, text: claimed.body_text });
      await db.query("UPDATE email_outbox SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1", [claimed.id]);
      result.sent++;
    } catch (err) {
      const exhausted = claimed.attempts >= opts.maxAttempts;
      // 只在这封信仍归本次领取所有时才退回重试（attempts 每次领取都会递增，相当于领取凭证）：
      // 如果发送拖过了租约、别的 Worker 已经接手甚至发成功了，这里再把它改回 pending 就会重复投递
      const released = await db.query(
        `UPDATE email_outbox SET status = $2, locked_until = NULL, last_error = $3, next_attempt_at = now() + make_interval(secs => $4)
          WHERE id = $1 AND status = 'sending' AND attempts = $5`,
        [claimed.id, exhausted ? 'failed' : 'pending', sanitizeError(err), backoffSeconds(claimed.attempts), claimed.attempts],
      );
      if (released.rowCount === 0) continue;
      exhausted ? result.failed++ : result.retried++;
      opts.log.warn({ outboxId: claimed.id, attempts: claimed.attempts, exhausted }, `邮件发送失败: ${sanitizeError(err)}`);
    }
  }
  return result;
}
