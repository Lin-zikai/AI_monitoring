import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { loggerOptions } from '../logger.js';
import type { MailSender } from '../mail/transport.js';
import type { Queues } from '../queue/queues.js';
import type { RemoteExecutor } from '../ssh/client.js';
import { HttpError } from './http.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { settingsRoutes } from './routes/settings.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'jwtSecret' | 'cookieSecure' | 'masterKey' | 'masterKeyVersion' | 'publicBaseUrl' | 'webDist' | 'sshTimeoutMs'>;
  queues: Pick<Queues, 'enqueueRuns' | 'kickMail' | 'syncSchedule'>;
  executor: RemoteExecutor;
  scanHostKey: (host: string, port: number) => Promise<string>;
  smtpSenderFactory: (db: Db, masterKey: Buffer) => Promise<MailSender | null>;
  logger?: boolean;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
export interface RouteContext extends AppDeps { authenticate: Guard; requireAdmin: Guard }

export const COOKIE_NAME = 'usage_token';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger === false ? false : loggerOptions, trustProxy: true, bodyLimit: 256 * 1024 });

  await app.register(cookie);
  await app.register(jwt, { secret: deps.config.jwtSecret, cookie: { cookieName: COOKIE_NAME, signed: false } });
  await app.register(rateLimit, { global: false });

  // “扫描指纹”“测试连接”等动作型 POST 没有请求体；浏览器端统一带 JSON content-type 时不应因此被拒
  app.addHook('onRequest', async (req) => {
    const h = req.headers;
    if (h['content-length'] === '0' || (h['content-length'] === undefined && h['transfer-encoding'] === undefined)) delete h['content-type'];
  });

  // 权限校验在后台执行：每次请求都回库确认账户仍然有效、角色未变
  const authenticate: Guard = async (req) => {
    let payload: { sub: string };
    try {
      payload = await req.jwtVerify<{ sub: string }>({ onlyCookie: true });
    } catch {
      throw new HttpError(401, '未登录或登录已过期');
    }
    const user = (await deps.db.query('SELECT id, email, name, role FROM users WHERE id = $1 AND is_active', [payload.sub])).rows[0];
    if (!user) throw new HttpError(401, '账户不存在或已停用');
    req.authUser = user;
  };
  const requireAdmin: Guard = async (req, reply) => {
    await authenticate(req, reply);
    if (req.authUser?.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, '请求处理失败');
    reply.status(status).send({ error: status >= 500 ? '服务器内部错误' : err.message, code: err instanceof HttpError ? err.code : undefined });
  });

  const ctx: RouteContext = { ...deps, authenticate, requireAdmin };
  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await userRoutes(api, ctx);
    await serverRoutes(api, ctx);
    await statsRoutes(api, ctx);
    await alertRoutes(api, ctx);
    await settingsRoutes(api, ctx);
  }, { prefix: '/api' });

  app.get('/healthz', async () => {
    await deps.db.query('SELECT 1');
    return { ok: true };
  });

  const webDist = deps.config.webDist;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html'); // 单页应用的前端路由回退
    });
  }
  return app;
}
