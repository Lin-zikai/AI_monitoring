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
  config: Pick<Config, 'jwtSecret' | 'cookieSecure' | 'masterKey' | 'masterKeyVersion' | 'publicBaseUrl' | 'webDist' | 'sshTimeoutMs'> & Partial<Pick<Config, 'trustProxy'>>;
  queues: Pick<Queues, 'enqueueRuns' | 'kickMail' | 'syncSchedule'>;
  executor: RemoteExecutor;
  scanHostKey: (host: string, port: number) => Promise<string>;
  smtpSenderFactory: (db: Db, masterKey: Buffer) => Promise<MailSender | null>;
  logger?: boolean;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
export interface RouteContext extends AppDeps { authenticate: Guard; requireAdmin: Guard }

export const COOKIE_NAME = 'usage_token';
/** 会话令牌：tv 对应 users.token_version，库里的版本号一变，旧令牌立即失效 */
export interface SessionClaims { sub: string; tv: number }

const QUEUE_TIMEOUT_MS = 5000;
// 单页应用（Vite 构建）：antd 运行时注入 <style>，需要 style-src 'unsafe-inline'；ECharts 画在 canvas 上，导出图片用 data: URL。与 deploy/Caddyfile 保持一致
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/**
 * Redis 不可用时，队列操作要么立刻报错、要么一直等待重连；统一加上超时并转成 503，
 * 避免 HTTP 请求无限挂起，也避免把 Redis 的内部错误原样抛给前端。
 */
function guardQueues(queues: AppDeps['queues'], log: FastifyInstance['log']): AppDeps['queues'] {
  const guard = <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) => async (...args: A): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(...args),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`队列操作 ${name} 超过 ${QUEUE_TIMEOUT_MS}ms 未完成`)), QUEUE_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      log.error({ err, op: name }, '任务队列不可用');
      throw new HttpError(503, '任务队列暂时不可用，请稍后重试', 'QUEUE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    enqueueRuns: guard('enqueueRuns', (ids, opts) => queues.enqueueRuns(ids, opts)),
    kickMail: guard('kickMail', () => queues.kickMail()),
    syncSchedule: guard('syncSchedule', (db) => queues.syncSchedule(db)),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // 默认不采信 X-Forwarded-For（见 config.ts 的 TRUST_PROXY）。Fastify 的类型声明不含“代理层数”，换成等价的判定函数
  const tp = deps.config.trustProxy ?? false;
  const trustProxy = typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp;
  const app = Fastify({ logger: deps.logger === false ? false : loggerOptions, trustProxy, bodyLimit: 256 * 1024 });

  await app.register(cookie);
  await app.register(jwt, { secret: deps.config.jwtSecret, cookie: { cookieName: COOKIE_NAME, signed: false } });
  await app.register(rateLimit, { global: false });

  // “扫描指纹”“测试连接”等动作型 POST 没有请求体；浏览器端统一带 JSON content-type 时不应因此被拒
  app.addHook('onRequest', async (req) => {
    const h = req.headers;
    if (h['content-length'] === '0' || (h['content-length'] === undefined && h['transfer-encoding'] === undefined)) delete h['content-type'];
  });

  // 基础安全响应头由应用自己给出：不经过 Caddy 的运行方式（scripts/local-run.sh、直接暴露端口）同样生效
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  });

  // 权限校验在后台执行：每次请求都回库确认账户仍然有效、角色未变、令牌未被吊销
  const authenticate: Guard = async (req) => {
    let payload: Partial<SessionClaims>;
    try {
      payload = await req.jwtVerify<Partial<SessionClaims>>({ onlyCookie: true });
    } catch {
      throw new HttpError(401, '未登录或登录已过期');
    }
    const row = (await deps.db.query('SELECT id, email, name, role, token_version FROM users WHERE id = $1 AND is_active', [payload.sub])).rows[0];
    if (!row) throw new HttpError(401, '账户不存在或已停用');
    // 改密码、重置密码、改角色、停用、退出登录都会递增版本号；不带版本号的旧令牌一律拒绝
    if (typeof payload.tv !== 'number' || payload.tv !== row.token_version) throw new HttpError(401, '登录已失效，请重新登录');
    req.authUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  };
  const requireAdmin: Guard = async (req, reply) => {
    await authenticate(req, reply);
    if (req.authUser?.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    const expected = err instanceof HttpError; // 主动抛出的 5xx（如 503 队列不可用）带的是可以给用户看的提示
    if (status >= 500 && !expected) req.log.error({ err }, '请求处理失败');
    reply.status(status).send({ error: status >= 500 && !expected ? '服务器内部错误' : err.message, code: expected ? err.code : undefined });
  });

  const ctx: RouteContext = { ...deps, queues: guardQueues(deps.queues, app.log), authenticate, requireAdmin };
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
