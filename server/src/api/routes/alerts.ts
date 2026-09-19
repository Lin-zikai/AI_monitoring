import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supportedSources } from '../../collect/adapter.js';
import type { RouteContext } from '../app.js';
import { audit, currentUser, HttpError, mapDbError, notFound, parse } from '../http.js';
import { idParam } from './users.js';

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  metric: z.enum(['tokens', 'cost', 'budget_pct']),
  period: z.enum(['daily', 'monthly']),
  tiers: z.array(z.number().positive().max(1e15)).min(1).max(10),
  /** 限定数据源；null = 所有数据源合计 */
  source: z.string().refine((v) => supportedSources().includes(v), '不支持的数据源').nullable().default(null),
  scopeType: z.enum(['global', 'team', 'user']).default('global'),
  scopeUserId: z.string().uuid().nullable().default(null),
  scopeTeam: z.string().trim().min(1).max(100).nullable().default(null),
  notifyAdmins: z.boolean().default(true),
  extraEmails: z.array(z.string().email().max(320)).max(20).default([]),
  enabled: z.boolean().default(true),
}).superRefine((r, ctx) => {
  if (r.metric === 'budget_pct' && r.period !== 'monthly') ctx.addIssue({ code: 'custom', path: ['period'], message: '预算百分比规则只支持按月' });
  if (r.metric === 'budget_pct' && r.tiers.some((t) => t > 1000)) ctx.addIssue({ code: 'custom', path: ['tiers'], message: '预算百分比档位应为 1～1000' });
  if (r.metric === 'tokens' && r.tiers.some((t) => !Number.isInteger(t))) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Token 阈值必须为整数' });
  if (new Set(r.tiers).size !== r.tiers.length) ctx.addIssue({ code: 'custom', path: ['tiers'], message: '阈值档位不能重复' });
  if ((r.scopeType === 'user') !== (r.scopeUserId !== null)) ctx.addIssue({ code: 'custom', path: ['scopeUserId'], message: '适用范围为用户时必须且只能指定用户' });
  if ((r.scopeType === 'team') !== (r.scopeTeam !== null)) ctx.addIssue({ code: 'custom', path: ['scopeTeam'], message: '适用范围为团队时必须且只能指定团队' });
  if (!r.notifyAdmins && r.extraEmails.length === 0) ctx.addIssue({ code: 'custom', path: ['notifyAdmins'], message: '至少需要一类收件人' });
});

const RULE_COLUMNS = `r.id, r.name, r.metric, r.period, r.source, r.tiers::float8[] AS tiers, r.scope_type AS "scopeType", r.scope_user_id AS "scopeUserId",
  r.scope_team AS "scopeTeam", r.notify_admins AS "notifyAdmins", r.extra_emails AS "extraEmails",
  r.enabled, r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;

export async function alertRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;
  const admin = { preHandler: ctx.requireAdmin };

  app.get('/alerts/rules', admin, async () => {
    const res = await db.query(`SELECT ${RULE_COLUMNS}, u.name AS "scopeUserName" FROM alert_rules r LEFT JOIN users u ON u.id = r.scope_user_id ORDER BY r.created_at`);
    return { rules: res.rows };
  });

  app.post('/alerts/rules', admin, async (req, reply) => {
    const b = parse(ruleSchema, req.body);
    const res = await db.query(
      `INSERT INTO alert_rules (name, metric, period, tiers, scope_type, scope_user_id, scope_team, notify_admins, extra_emails, enabled, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [b.name, b.metric, b.period, [...b.tiers].sort((x, y) => x - y), b.scopeType, b.scopeUserId, b.scopeTeam, b.notifyAdmins, b.extraEmails, b.enabled, b.source],
    ).catch(mapDbError);
    await audit(db, req, 'alert_rule.create', 'alert_rule', res.rows[0].id, b);
    return reply.status(201).send({ id: res.rows[0].id });
  });

  app.put('/alerts/rules/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(ruleSchema, req.body);
    const res = await db.query(
      `UPDATE alert_rules SET name = $2, metric = $3, period = $4, tiers = $5, scope_type = $6, scope_user_id = $7, scope_team = $8,
              notify_admins = $9, extra_emails = $10, enabled = $11, source = $12, updated_at = now() WHERE id = $1`,
      [id, b.name, b.metric, b.period, [...b.tiers].sort((x, y) => x - y), b.scopeType, b.scopeUserId, b.scopeTeam, b.notifyAdmins, b.extraEmails, b.enabled, b.source],
    ).catch(mapDbError);
    if (res.rowCount === 0) throw notFound('告警规则');
    await audit(db, req, 'alert_rule.update', 'alert_rule', id, b);
    return { ok: true };
  });

  app.delete('/alerts/rules/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await db.query('DELETE FROM alert_rules WHERE id = $1', [id]);
    if (res.rowCount === 0) throw notFound('告警规则');
    await audit(db, req, 'alert_rule.delete', 'alert_rule', id);
    return { ok: true };
  });

  // 告警记录：管理员看全部；普通用户只看自己的用量告警（看不到采集失败类告警）
  app.get('/alerts/events', { preHandler: ctx.authenticate }, async (req) => {
    const me = currentUser(req);
    const q = parse(z.object({
      userId: z.string().uuid().optional(),
      kind: z.enum(['usage', 'collection_failure', 'account_limit']).optional(),
      emailStatus: z.enum(['pending', 'sending', 'sent', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    if (me.role !== 'admin' && q.userId && q.userId !== me.id) throw new HttpError(403, '无权查看其他用户的告警');
    const userId = me.role === 'admin' ? q.userId ?? null : me.id;
    const kind = me.role === 'admin' ? q.kind ?? null : 'usage';
    const res = await db.query(
      `SELECT e.id, e.kind, e.source, e.rule_name AS "ruleName", e.user_id AS "userId", u.name AS "userName", e.metric, e.period_type AS "periodType",
              e.period_key AS "periodKey", e.tier::float8 AS tier, e.observed_value::float8 AS "observedValue", e.threshold_value::float8 AS "thresholdValue",
              e.data_as_of AS "dataAsOf", e.incomplete, e.email_note AS "emailNote", e.created_at AS "createdAt",
              s.name AS "serverName", t.data_dir AS "dataDir",
              o.id AS "outboxId", o.status AS "emailStatus", o.attempts AS "emailAttempts", o.sent_at AS "emailSentAt",
              CASE WHEN $4 THEN o.last_error END AS "emailError", CASE WHEN $4 THEN o.to_addrs END AS "emailTo"
         FROM alert_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN collection_targets t ON t.id = e.target_id LEFT JOIN servers s ON s.id = t.server_id
         LEFT JOIN email_outbox o ON o.alert_event_id = e.id
        WHERE ($1::uuid IS NULL OR e.user_id = $1) AND ($2::text IS NULL OR e.kind = $2) AND ($3::text IS NULL OR o.status = $3)
        ORDER BY e.created_at DESC LIMIT $5`,
      [userId, kind, q.emailStatus ?? null, me.role === 'admin', q.limit],
    );
    return { events: res.rows };
  });

  /** 最终失败的邮件可由管理员重新排队；沿用原 Message-ID。 */
  app.post('/alerts/outbox/:id/retry', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await db.query("UPDATE email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'failed'", [id]);
    if (res.rowCount === 0) throw new HttpError(409, '只有发送失败的邮件可以重试');
    await ctx.queues.kickMail();
    await audit(db, req, 'email.retry', 'email_outbox', id);
    return { ok: true };
  });
}
