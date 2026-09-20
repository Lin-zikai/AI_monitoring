import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sanitizeError } from '../../logger.js';
import { smtpPasswordAad } from '../../mail/transport.js';
import { seal } from '../../security/crypto.js';
import { isValidHost } from '../../security/validate.js';
import { generalSettingsSchema, getGeneralSettings, getLimitAlertSettings, getStoredSmtp, limitAlertSchema, putSetting, smtpSettingsSchema, type StoredSmtp } from '../../settings.js';
import type { RouteContext } from '../app.js';
import { withTx } from '../../db/pool.js';
import { audit, HttpError, offsetParam, parse } from '../http.js';

const smtpBody = smtpSettingsSchema.extend({
  /** 省略 = 保留原密码；空字符串 = 清除密码 */
  password: z.string().max(500).optional(),
});

export async function settingsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, config } = ctx;
  const admin = { preHandler: ctx.requireAdmin };

  app.get('/settings/general', admin, async () => getGeneralSettings(db));

  app.put('/settings/general', admin, async (req) => {
    const body = parse(generalSettingsSchema, req.body);
    const before = await getGeneralSettings(db);
    // 采集周期或时区变更后要重新登记定时调度；与保存放在同一事务里，队列不可用时设置一并回滚，不留下“设置已改、调度没改”的半截状态
    await withTx(db, async (tx) => {
      await putSetting(tx, 'general', body);
      if (before.collectIntervalHours !== body.collectIntervalHours || before.timezone !== body.timezone) await ctx.queues.syncSchedule(tx);
    });
    await audit(db, req, 'settings.general.update', 'settings', 'general', { before, after: body });
    return body;
  });

  app.get('/settings/limit-alert', admin, async () => getLimitAlertSettings(db));

  app.put('/settings/limit-alert', admin, async (req) => {
    const body = parse(limitAlertSchema, req.body);
    const before = await getLimitAlertSettings(db);
    await putSetting(db, 'limitAlert', body);
    await audit(db, req, 'settings.limit_alert.update', 'settings', 'limitAlert', { before, after: body });
    return body;
  });

  app.get('/settings/smtp', admin, async () => {
    const stored = await getStoredSmtp(db);
    if (!stored) return { configured: false, envFallback: Boolean(process.env.SMTP_HOST) };
    const { passwordSealed, ...visible } = stored;
    return { configured: true, ...visible, hasPassword: Boolean(passwordSealed) }; // 密码不回显
  });

  app.put('/settings/smtp', admin, async (req) => {
    const { password, ...body } = parse(smtpBody, req.body);
    const existing = await getStoredSmtp(db);
    const next: StoredSmtp = { ...body, passwordSealed: existing?.passwordSealed };
    if (password === '') delete next.passwordSealed;
    else if (password !== undefined) {
      const s = seal(config.masterKey, password, smtpPasswordAad());
      next.passwordSealed = { ciphertext: s.ciphertext.toString('base64'), iv: s.iv.toString('base64'), authTag: s.authTag.toString('base64') };
    }
    await putSetting(db, 'smtp', next);
    await audit(db, req, 'settings.smtp.update', 'settings', 'smtp', { ...body, passwordChanged: password !== undefined });
    return { ok: true };
  });

  app.post('/settings/smtp/test', { ...admin, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ to: z.string().email().max(320) }), req.body);
    // 早期版本保存的 SMTP 地址没有校验过：发起连接前兜底检查
    const stored = await getStoredSmtp(db);
    if (stored && !isValidHost(stored.host)) throw new HttpError(400, '已保存的 SMTP 服务器地址不合法，请重新填写后保存');
    const sender = await ctx.smtpSenderFactory(db, config.masterKey);
    if (!sender) throw new HttpError(400, '尚未配置 SMTP');
    try {
      await sender.send({
        messageId: `<smtp-test-${Date.now()}@usage-monitor>`, to: [body.to],
        subject: '[用量监控] SMTP 测试邮件', text: '这是一封测试邮件，说明用量监控平台的 SMTP 配置可用。',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: sanitizeError(err) };
    }
  });

  app.get('/audit', admin, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), offset: offsetParam, entityType: z.string().max(50).optional() }), req.query);
    const res = await db.query(
      `SELECT id, actor_email AS "actorEmail", action, entity_type AS "entityType", entity_id AS "entityId", detail, ip, created_at AS "createdAt"
         FROM audit_logs WHERE ($1::text IS NULL OR entity_type = $1) ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [q.entityType ?? null, q.limit, q.offset],
    );
    return { logs: res.rows };
  });
}
