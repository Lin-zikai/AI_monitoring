import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../security/password.js';
import { COOKIE_NAME, type RouteContext, type SessionClaims } from '../app.js';
import { audit, currentUser, HttpError, parse } from '../http.js';

const SESSION_SECONDS = 12 * 3600;
export const passwordSchema = z.string().min(10, '密码至少 10 位').max(200);

/** 签发会话 Cookie；tokenVersion 必须是库里当前的 users.token_version。 */
export async function issueSession(reply: FastifyReply, config: RouteContext['config'], userId: string, tokenVersion: number): Promise<void> {
  const claims: SessionClaims = { sub: userId, tv: tokenVersion };
  const token = await reply.jwtSign(claims, { expiresIn: SESSION_SECONDS });
  reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', maxAge: SESSION_SECONDS });
}

// 按邮箱限制连续失败次数：按 IP 的限流挡不住换 IP 的撞库。只存在内存里，进程重启即清零
const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_TRACKED_EMAILS = 10_000;

class LoginThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  /** 被锁定时返回还需等待的秒数 */
  blockedFor(email: string, now = Date.now()): number {
    const entry = this.failures.get(email);
    if (!entry) return 0;
    if (entry.resetAt <= now) { this.failures.delete(email); return 0; }
    return entry.count >= LOGIN_MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  fail(email: string, now = Date.now()): void {
    const entry = this.failures.get(email);
    if (entry && entry.resetAt > now) { entry.count += 1; return; }
    if (this.failures.size >= LOGIN_TRACKED_EMAILS) this.evict(now);
    this.failures.set(email, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
  }

  succeed(email: string): void { this.failures.delete(email); }

  /** 防止用海量随机邮箱撑爆内存：先清过期的，仍然超限就从最早登记的开始丢 */
  private evict(now: number): void {
    for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
    for (const key of this.failures.keys()) {
      if (this.failures.size < LOGIN_TRACKED_EMAILS) break;
      this.failures.delete(key);
    }
  }
}

export async function authRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;
  const throttle = new LoginThrottle();

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(200) }), req.body);
    const emailKey = body.email.toLowerCase();
    const wait = throttle.blockedFor(emailKey);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, '登录失败次数过多，请 15 分钟后再试', 'LOGIN_THROTTLED');
    }

    const user = (await db.query('SELECT id, email, name, role, password_hash, is_active, token_version FROM users WHERE lower(email) = lower($1)', [body.email])).rows[0];
    // 无论账户是否存在都执行一次哈希校验，避免通过响应时间探测邮箱
    const ok = await verifyPassword(body.password, user?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!user || !ok || !user.is_active) {
      throttle.fail(emailKey);
      // 失败原因只进审计日志；响应对“账户不存在 / 密码错误 / 已停用”保持一致。不记录密码
      await audit(db, req, 'auth.login_failed', 'user', user?.id ?? null, {
        email: emailKey, reason: !user ? 'unknown_email' : !ok ? 'bad_password' : 'inactive', locked: throttle.blockedFor(emailKey) > 0,
      });
      throw new HttpError(401, '邮箱或密码错误');
    }

    throttle.succeed(emailKey);
    await issueSession(reply, ctx.config, user.id, user.token_version);
    req.authUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    await audit(db, req, 'auth.login', 'user', user.id);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  });

  // 退出登录会吊销该账户已签发的全部令牌（含其他设备）：Cookie 被抄走后，“退出”才真正有效
  app.post('/auth/logout', async (req, reply) => {
    try {
      const claims = await req.jwtVerify<Partial<SessionClaims>>({ onlyCookie: true });
      if (typeof claims.tv === 'number') await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1 AND token_version = $2', [claims.sub, claims.tv]);
    } catch { /* 没带 Cookie 或令牌已过期：只需清 Cookie */ }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: ctx.authenticate }, async (req) => currentUser(req));

  app.post('/auth/password', { preHandler: ctx.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = currentUser(req);
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }), req.body);
    const row = (await db.query('SELECT password_hash FROM users WHERE id = $1', [me.id])).rows[0];
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) throw new HttpError(400, '当前密码不正确');
    const updated = await db.query('UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING token_version', [me.id, await hashPassword(body.newPassword)]);
    // 其他设备上的旧会话全部失效；当前会话换发新令牌，改完密码不必重新登录
    await issueSession(reply, ctx.config, me.id, updated.rows[0].token_version);
    await audit(db, req, 'auth.change_password', 'user', me.id);
    return { ok: true };
  });
}
