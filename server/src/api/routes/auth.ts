import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../security/password.js';
import { COOKIE_NAME, type RouteContext } from '../app.js';
import { audit, currentUser, HttpError, parse } from '../http.js';

const SESSION_SECONDS = 12 * 3600;
export const passwordSchema = z.string().min(10, '密码至少 10 位').max(200);

export async function authRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) }), req.body);
    const user = (await db.query('SELECT id, email, name, role, password_hash, is_active FROM users WHERE lower(email) = lower($1)', [body.email])).rows[0];
    // 无论账户是否存在都执行一次哈希校验，避免通过响应时间探测邮箱
    const ok = await verifyPassword(body.password, user?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!user || !ok || !user.is_active) throw new HttpError(401, '邮箱或密码错误');

    const token = await reply.jwtSign({ sub: user.id }, { expiresIn: SESSION_SECONDS });
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: ctx.config.cookieSecure, path: '/', maxAge: SESSION_SECONDS });
    req.authUser = user;
    await audit(db, req, 'auth.login', 'user', user.id);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: ctx.authenticate }, async (req) => currentUser(req));

  app.post('/auth/password', { preHandler: ctx.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const me = currentUser(req);
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }), req.body);
    const row = (await db.query('SELECT password_hash FROM users WHERE id = $1', [me.id])).rows[0];
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) throw new HttpError(400, '当前密码不正确');
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [me.id, await hashPassword(body.newPassword)]);
    await audit(db, req, 'auth.change_password', 'user', me.id);
    return { ok: true };
  });
}
