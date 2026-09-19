import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../../security/password.js';
import { getGeneralSettings } from '../../settings.js';
import { dateInTz, monthKey, monthRange } from '../../util/time.js';
import type { RouteContext } from '../app.js';
import { audit, currentUser, HttpError, mapDbError, notFound, parse } from '../http.js';
import { passwordSchema } from './auth.js';

const budget = z.number().nonnegative().max(1e9).nullable();
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320),
  role: z.enum(['admin', 'user']).default('user'),
  team: z.string().trim().min(1).max(100).nullable().default(null),
  monthlyBudgetUsd: budget.default(null),
  password: passwordSchema.optional(),
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320),
  role: z.enum(['admin', 'user']),
  team: z.string().trim().min(1).max(100).nullable(),
  monthlyBudgetUsd: budget,
  password: passwordSchema,
  isActive: z.boolean(),
}).partial();

export const idParam = z.object({ id: z.string().uuid() });

export async function userRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;

  app.get('/users', { preHandler: ctx.requireAdmin }, async () => {
    const settings = await getGeneralSettings(db);
    const today = dateInTz(new Date(), settings.timezone);
    const month = monthRange(monthKey(today));
    const res = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.team, u.is_active AS "isActive", u.monthly_budget_usd::float8 AS "monthlyBudgetUsd",
              (u.password_hash IS NOT NULL) AS "canLogin",
              d.tokens AS "todayTokens", d.cost::float8 AS "todayCost", m.tokens AS "monthTokens", m.cost::float8 AS "monthCost",
              COALESCE(a.n, 0)::int AS "monthAlerts", COALESCE(t.n, 0)::int AS "targetCount", COALESCE(t.failing, 0)::int AS "failingTargets"
         FROM users u
         LEFT JOIN LATERAL (SELECT sum(total_tokens)::bigint AS tokens, sum(cost_usd) AS cost FROM usage_daily WHERE user_id = u.id AND usage_date = $1::date) d ON true
         LEFT JOIN LATERAL (SELECT sum(total_tokens)::bigint AS tokens, sum(cost_usd) AS cost FROM usage_daily WHERE user_id = u.id AND usage_date BETWEEN $2::date AND $3::date) m ON true
         LEFT JOIN LATERAL (SELECT count(*) AS n FROM alert_events WHERE user_id = u.id AND kind = 'usage' AND period_key IN ($1::text, $4::text)) a ON true
         LEFT JOIN LATERAL (SELECT count(*) AS n, count(*) FILTER (WHERE last_status = 'failed') AS failing FROM collection_targets WHERE user_id = u.id AND enabled) t ON true
        ORDER BY "monthCost" DESC NULLS LAST, u.name`,
      [today, month.first, month.last, monthKey(today)],
    );
    return { today, month: monthKey(today), users: res.rows };
  });

  app.post('/users', { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const body = parse(createSchema, req.body);
    const hash = body.password ? await hashPassword(body.password) : null;
    const res = await db.query(
      'INSERT INTO users (name, email, role, team, monthly_budget_usd, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [body.name, body.email, body.role, body.team, body.monthlyBudgetUsd, hash],
    ).catch(mapDbError);
    const id = res.rows[0].id as string;
    await audit(db, req, 'user.create', 'user', id, { email: body.email, role: body.role, team: body.team });
    return reply.status(201).send({ id });
  });

  app.patch('/users/:id', { preHandler: ctx.requireAdmin }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(patchSchema, req.body);
    const me = currentUser(req);
    if (id === me.id && (body.role === 'user' || body.isActive === false)) throw new HttpError(400, '不能降级或停用自己的管理员账户');

    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (body.name !== undefined) set('name', body.name);
    if (body.email !== undefined) set('email', body.email);
    if (body.role !== undefined) set('role', body.role);
    if (body.team !== undefined) set('team', body.team);
    if (body.monthlyBudgetUsd !== undefined) set('monthly_budget_usd', body.monthlyBudgetUsd);
    if (body.isActive !== undefined) set('is_active', body.isActive);
    if (body.password !== undefined) set('password_hash', await hashPassword(body.password));
    if (sets.length === 0) throw new HttpError(400, '没有需要更新的字段');

    const res = await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, values).catch(mapDbError);
    if (res.rowCount === 0) throw notFound('用户');
    const { password: _omit, ...logged } = body;
    await audit(db, req, 'user.update', 'user', id, { ...logged, passwordChanged: body.password !== undefined });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: ctx.requireAdmin }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (id === currentUser(req).id) throw new HttpError(400, '不能删除自己的账户');
    // 有采集目标或历史统计的用户受外键保护，只能停用，避免静默丢失历史归属
    const res = await db.query('DELETE FROM users WHERE id = $1', [id]).catch(mapDbError);
    if (res.rowCount === 0) throw notFound('用户');
    await audit(db, req, 'user.delete', 'user', id);
    return { ok: true };
  });
}
