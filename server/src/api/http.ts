import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export const notFound = (what = '资源') => new HttpError(404, `${what}不存在`);

/** YYYY-MM-DD 且必须是日历上真实存在的日期（2026-02-30 这类值传到 Postgres 会变成 500）。 */
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01';
}, '日期不存在');

/** 分页偏移：与 limit 搭配，响应结构不变 */
export const offsetParam = z.coerce.number().int().min(0).max(100_000).default(0);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  const issue = res.error.issues[0];
  throw new HttpError(400, `参数错误: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
}

/**
 * 解析 PATCH 请求体：只保留请求里实际出现的字段。
 * zod 的 .partial() 仍会为缺失字段套用 default()，直接使用会把“没传的字段”悄悄重置成默认值。
 */
export function parsePatch<S extends z.ZodType>(schema: S, data: unknown): Partial<z.infer<S>> {
  const parsed = parse(schema, data) as Record<string, unknown>;
  const sent = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(sent, key))) as Partial<z.infer<S>>;
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
  try {
    await db.query(
      'INSERT INTO audit_logs (actor_user_id, actor_email, action, entity_type, entity_id, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [actor?.id ?? null, actor?.email ?? null, action, entityType, entityId, JSON.stringify(detail), req.ip],
    );
  } catch (err) {
    // 审计在业务写入提交之后执行：写不进去只记日志，不能把已经生效的操作变成 500（调用方会以为没成功而重试）
    req.log.error({ err, action, entityType, entityId }, '审计日志写入失败');
  }
}

const fkMissing = () => new HttpError(400, '引用的记录不存在（用户、服务器或凭据可能已被删除）', 'REFERENCE_NOT_FOUND');
const fkInUse = () => new HttpError(409, '该记录仍被其他数据引用，无法执行此操作', 'STILL_REFERENCED');

/** 把 Postgres 约束错误转成可读的 4xx（用于 INSERT / UPDATE；删除用 mapDeleteError）。 */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; detail?: string };
  if (e.code === '23505') throw new HttpError(409, '已存在相同的记录（名称、邮箱或目录重复）');
  // 外键冲突有两种：写入时引用了不存在的记录（400），或者被引用的记录正要被删除/改键（409）
  // （ON DELETE RESTRICT 的冲突在 PostgreSQL 18 起改用 23001 restrict_violation，之前的版本是 23503）
  if (e.code === '23001') throw fkInUse();
  if (e.code === '23503') throw e.detail?.includes('is still referenced') ? fkInUse() : fkMissing();
  if (e.code === '23514') throw new HttpError(400, `数据不满足约束 ${e.constraint ?? ''}`.trim());
  throw err;
}

/** DELETE 专用：外键冲突一律表示“仍被引用”。 */
export function mapDeleteError(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code === '23503' || code === '23001') throw fkInUse();
  return mapDbError(err);
}
