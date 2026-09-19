import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Queryable } from '../db/pool.js';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export const notFound = (what = '资源') => new HttpError(404, `${what}不存在`);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  const issue = res.error.issues[0];
  throw new HttpError(400, `参数错误: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
}

export interface AuthUser { id: string; email: string; name: string; role: 'admin' | 'user' }

declare module 'fastify' {
  interface FastifyRequest { authUser?: AuthUser }
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.authUser) throw new HttpError(401, '未登录');
  return req.authUser;
}

/** 审计日志：凭据修改、用户绑定、告警规则变更等管理操作。detail 中不得包含密钥或密码。 */
export async function audit(db: Queryable, req: FastifyRequest, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  const actor = req.authUser;
  await db.query(
    'INSERT INTO audit_logs (actor_user_id, actor_email, action, entity_type, entity_id, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [actor?.id ?? null, actor?.email ?? null, action, entityType, entityId, JSON.stringify(detail), req.ip],
  );
}

/** 把 Postgres 约束错误转成可读的 4xx。 */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') throw new HttpError(409, '已存在相同的记录（名称、邮箱或目录重复）');
  if (e.code === '23503') throw new HttpError(409, '该记录仍被其他数据引用，无法执行此操作');
  if (e.code === '23514') throw new HttpError(400, `数据不满足约束 ${e.constraint ?? ''}`.trim());
  throw err;
}
