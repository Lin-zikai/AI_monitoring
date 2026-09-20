import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, type Queryable } from '../../db/pool.js';
import { billingSettingsSchema, getBillingSettings, getGeneralSettings, putSetting } from '../../settings.js';
import { addDays, dateInTz, monthKey, monthRange } from '../../util/time.js';
import type { RouteContext } from '../app.js';
import { audit, currentUser, dateStr, HttpError, mapDbError, notFound, parse } from '../http.js';
import { idParam } from './users.js';

// 账目明细：管理员手工登记的实际支出（VPN、Claude Code / Codex 订阅）和账单截图。
// 金额按原币种保存，人民币 / 美元换算由前端按 /bills/settings 的汇率完成；截图存在库里（见 013_bills.sql）。

const CATEGORIES = ['vpn', 'claude-code', 'codex'] as const;
const AI_SOURCES = ['claude-code', 'codex'] as const;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ImageType = typeof IMAGE_TYPES[number];

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 4 张 × 5 MB 的图片经 base64 膨胀约 1/3 后不到 27 MB；全局 bodyLimit 只有 256 KB，仅给上传接口单独放宽 */
const UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;
const MIN_MONTH = '2020-01';

const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM').refine((v) => v >= MIN_MONTH, `月份不能早于 ${MIN_MONTH}`);
const amount = z.number().min(0, '金额不能为负数').max(10_000_000, '金额过大')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, '金额最多保留两位小数');
// 可选文本：空字符串视为不填
const optionalText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable());
const optionalDate = z.preprocess((v) => (v === '' ? null : v), dateStr.nullable());
const yearParam = z.coerce.number().int().min(2020).max(2100);

const attachmentInput = z.object({
  filename: z.string().max(500).default(''),
  contentType: z.enum(IMAGE_TYPES, '截图只支持 PNG、JPEG、WebP'),
  // 大小、base64 合法性和文件头在 decodeAttachments 里核对（报错能指出是第几张）
  dataBase64: z.string().min(1, '截图内容为空'),
});
const attachmentList = z.array(attachmentInput).max(MAX_ATTACHMENTS, `每笔账单最多 ${MAX_ATTACHMENTS} 张截图`);

const createSchema = z.object({
  category: z.enum(CATEGORIES),
  month: monthStr,
  amount,
  currency: z.enum(['CNY', 'USD']),
  title: optionalText(200).default(null),
  paidOn: optionalDate.default(null),
  note: optionalText(2000).default(null),
  attachments: attachmentList.default([]),
});
// 没有 default()：.partial() 之后缺失的字段就是 undefined，不会被悄悄重置
const patchSchema = z.object({
  category: z.enum(CATEGORIES),
  month: monthStr,
  amount,
  currency: z.enum(['CNY', 'USD']),
  title: optionalText(200),
  paidOn: optionalDate,
  note: optionalText(2000),
  addAttachments: attachmentList,
  removeAttachmentIds: z.array(z.string().uuid()).max(50),
}).partial();

interface DecodedAttachment { filename: string; contentType: ImageType; data: Buffer }

function magicMatches(type: ImageType, b: Buffer): boolean {
  if (type === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
}

const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 文件名只用于展示和下载：去掉路径、控制字符，限制长度（超长时保留扩展名） */
export function sanitizeFilename(raw: string, type: ImageType): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').replace(/[<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
  if (!base) return `screenshot.${EXT[type]}`;
  if (base.length <= 120) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, 120 - ext.length) + ext;
}

/** 解码并核对截图：大小上限、base64 合法性、文件头与声明的类型一致（不信任浏览器给的 Content-Type） */
function decodeAttachments(list: Array<z.infer<typeof attachmentInput>>): DecodedAttachment[] {
  return list.map((a, i) => {
    const label = `第 ${i + 1} 张截图`;
    if (a.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new HttpError(400, `${label}超过 5 MB`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(a.dataBase64)) throw new HttpError(400, `${label}不是合法的 base64 数据`);
    const data = Buffer.from(a.dataBase64, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(400, `${label}超过 5 MB`);
    if (!magicMatches(a.contentType, data)) throw new HttpError(400, `${label}不是有效的 ${EXT[a.contentType].toUpperCase()} 图片（只支持 PNG、JPEG、WebP）`);
    return { filename: sanitizeFilename(a.filename, a.contentType), contentType: a.contentType, data };
  });
}

const attachmentMeta = (list: DecodedAttachment[]) => list.map((a) => ({ filename: a.filename, contentType: a.contentType, sizeBytes: a.data.length }));

async function insertAttachments(tx: Queryable, billId: string, list: DecodedAttachment[]): Promise<void> {
  // 同一事务里 now() 不变：用 clock_timestamp() 记下逐张写入的先后，列表才能按上传顺序排
  for (const a of list) {
    await tx.query('INSERT INTO bill_attachments (bill_id, filename, content_type, size_bytes, data, created_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())', [billId, a.filename, a.contentType, a.data.length, a.data]);
  }
}

/** RFC 5987：encodeURIComponent 不转义的 ' ( ) * 也要转义 */
const encodeRfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function billRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;
  const admin = { preHandler: ctx.requireAdmin };
  // 上传接口放宽了请求体上限：权限校验提前到 onRequest（解析请求体之前），未登录的请求不会让服务器先收下几十 MB 再拒绝
  const upload = { onRequest: ctx.requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT };

  const statsToday = async () => dateInTz(new Date(), (await getGeneralSettings(db)).timezone);
  /** 账单月份最晚到下个月（预付下月订阅），防止手滑填到很远的将来 */
  /** 账单月份的范围：不早于记账起始月份（账目设置），不晚于下个月 */
  const assertMonthInRange = async (month: string) => {
    const { startMonth } = await getBillingSettings(db);
    if (month < startMonth) throw new HttpError(400, `参数错误: month 账单从 ${startMonth} 开始统计，不能早于这个月份`);
    const next = monthKey(addDays(monthRange(monthKey(await statsToday())).last, 1));
    if (month > next) throw new HttpError(400, `参数错误: month 账单月份不能晚于 ${next}`);
  };

  app.get('/bills', admin, async (req) => {
    const q = parse(z.object({ year: yearParam.optional(), category: z.enum(CATEGORIES).optional() }), req.query);
    // 列表只带截图的元数据，图片内容走 /bills/attachments/:id
    const res = await db.query(
      `SELECT b.id, b.category, to_char(b.bill_month, 'YYYY-MM') AS month, b.amount::float8 AS amount, b.currency, b.title, b.paid_on AS "paidOn", b.note,
              b.created_at AS "createdAt", u.name AS "createdByName", COALESCE(a.list, '[]'::json) AS attachments
         FROM bills b
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', id, 'filename', filename, 'contentType', content_type, 'sizeBytes', size_bytes) ORDER BY created_at, id) AS list
             FROM bill_attachments WHERE bill_id = b.id) a ON true
        WHERE ($1::int IS NULL OR b.bill_month BETWEEN make_date($1, 1, 1) AND make_date($1, 12, 1))
          AND ($2::text IS NULL OR b.category = $2)
        ORDER BY b.bill_month DESC, b.category, b.created_at DESC`,
      [q.year ?? null, q.category ?? null],
    );
    return { bills: res.rows };
  });

  app.post('/bills', upload, async (req, reply) => {
    const body = parse(createSchema, req.body);
    await assertMonthInRange(body.month);
    const files = decodeAttachments(body.attachments);
    const id = await withTx(db, async (tx) => {
      const res = await tx.query(
        'INSERT INTO bills (category, bill_month, amount, currency, title, paid_on, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [body.category, `${body.month}-01`, body.amount, body.currency, body.title, body.paidOn, body.note, currentUser(req).id],
      ).catch(mapDbError);
      const billId = res.rows[0].id as string;
      await insertAttachments(tx, billId, files);
      return billId;
    });
    const { attachments: _omit, ...logged } = body;
    await audit(db, req, 'bill.create', 'bill', id, { ...logged, attachments: attachmentMeta(files) }); // 只记截图的元数据，不记图片内容
    return reply.status(201).send({ id });
  });

  app.patch('/bills/:id', upload, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(patchSchema, req.body);
    if (body.month !== undefined) await assertMonthInRange(body.month);
    const files = decodeAttachments(body.addAttachments ?? []);
    const removeIds = [...new Set(body.removeAttachmentIds ?? [])];

    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (body.category !== undefined) set('category', body.category);
    if (body.month !== undefined) set('bill_month', `${body.month}-01`);
    if (body.amount !== undefined) set('amount', body.amount);
    if (body.currency !== undefined) set('currency', body.currency);
    if (body.title !== undefined) set('title', body.title);
    if (body.paidOn !== undefined) set('paid_on', body.paidOn);
    if (body.note !== undefined) set('note', body.note);
    if (sets.length === 0 && files.length === 0 && removeIds.length === 0) throw new HttpError(400, '没有需要更新的字段');

    await withTx(db, async (tx) => {
      // 锁住账单行：并发的两次编辑不会各自通过“最多 4 张”的检查后一起写入
      if ((await tx.query('SELECT 1 FROM bills WHERE id = $1 FOR UPDATE', [id])).rowCount === 0) throw notFound('账单');
      if (removeIds.length > 0) {
        const removed = await tx.query('DELETE FROM bill_attachments WHERE bill_id = $1 AND id = ANY($2::uuid[])', [id, removeIds]);
        if (removed.rowCount !== removeIds.length) throw new HttpError(400, '要移除的截图不属于这笔账单，或已被删除');
      }
      if (files.length > 0) {
        const existing = (await tx.query('SELECT count(*)::int AS n FROM bill_attachments WHERE bill_id = $1', [id])).rows[0].n as number;
        if (existing + files.length > MAX_ATTACHMENTS) throw new HttpError(400, `每笔账单最多 ${MAX_ATTACHMENTS} 张截图（已有 ${existing} 张）`);
        await insertAttachments(tx, id, files);
      }
      await tx.query(`UPDATE bills SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, values).catch(mapDbError);
    });
    const { addAttachments: _omit, removeAttachmentIds: _ids, ...logged } = body;
    await audit(db, req, 'bill.update', 'bill', id, { ...logged, addedAttachments: attachmentMeta(files), removedAttachmentIds: removeIds });
    return { ok: true };
  });

  app.delete('/bills/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    // 截图随账单级联删除；审计里留下被删账单的要点，事后能看出删掉的是哪一笔
    const res = await db.query(
      `DELETE FROM bills WHERE id = $1
       RETURNING category, to_char(bill_month, 'YYYY-MM') AS month, amount::float8 AS amount, currency, title`,
      [id],
    );
    if (res.rowCount === 0) throw notFound('账单');
    await audit(db, req, 'bill.delete', 'bill', id, res.rows[0]);
    return { ok: true };
  });

  app.get('/bills/attachments/:id', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const row = (await db.query('SELECT filename, content_type, data FROM bill_attachments WHERE id = $1', [id])).rows[0] as { filename: string; content_type: string; data: Buffer } | undefined;
    if (!row) throw notFound('截图');
    // 类型只可能是入库时核对过文件头的三种位图；nosniff 与 CSP 由 app.ts 的 onSend 统一加上。
    // private：截图只给登录的管理员看，不能进共享缓存；附件内容不会变（改图 = 删旧加新，id 不同），浏览器缓存一天没有问题
    return reply
      .header('Content-Type', row.content_type)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeRfc5987(row.filename)}`)
      .header('Cache-Control', 'private, max-age=86400')
      .send(row.data);
  });

  app.get('/bills/summary', admin, async (req) => {
    const currentYear = Number((await statsToday()).slice(0, 4));
    const q = parse(z.object({ year: yearParam.default(currentYear) }), req.query);
    const [paid, estimated, yearRows, billing] = await Promise.all([
      db.query(
        `SELECT to_char(bill_month, 'YYYY-MM') AS month, category, currency, sum(amount)::float8 AS amount, count(*)::int AS count
           FROM bills WHERE bill_month BETWEEN make_date($1, 1, 1) AND make_date($1, 12, 1)
          GROUP BY bill_month, category, currency ORDER BY bill_month, category, currency`,
        [q.year],
      ),
      // ccusage 按公开 API 价格估算的同期用量价值：与实际付的订阅费对照
      db.query(
        `SELECT to_char(date_trunc('month', usage_date), 'YYYY-MM') AS month, source, sum(cost_usd)::float8 AS cost
           FROM usage_daily WHERE usage_date BETWEEN make_date($1, 1, 1) AND make_date($1, 12, 31) AND source = ANY($2::text[])
          GROUP BY 1, 2`,
        [q.year, AI_SOURCES],
      ),
      db.query("SELECT DISTINCT extract(year FROM bill_month)::int AS year FROM bills"),
      getBillingSettings(db),
    ]);
    // 只统计记账起始月份之后的月份：更早的用量估算与这本账无关
    const startYear = Number(billing.startMonth.slice(0, 4));
    const years = [...new Set<number>([currentYear, ...yearRows.rows.map((r) => r.year as number)])].filter((y) => y >= startYear || y === currentYear).sort((a, b) => b - a);
    const months = Array.from({ length: 12 }, (_, i) => `${q.year}-${String(i + 1).padStart(2, '0')}`).filter((month) => month >= billing.startMonth).map((month) => {
      const cost = (source: string) => (estimated.rows.find((r) => r.month === month && r.source === source)?.cost as number | null | undefined) ?? null;
      return {
        month,
        items: paid.rows.filter((r) => r.month === month).map((r) => ({ category: r.category as string, currency: r.currency as string, amount: r.amount as number, count: r.count as number })),
        estimatedUsd: { 'claude-code': cost('claude-code'), codex: cost('codex') },
      };
    });
    return { year: q.year, years, usdCny: billing.usdCny, startMonth: billing.startMonth, months };
  });

  app.get('/bills/settings', admin, async () => getBillingSettings(db));

  app.put('/bills/settings', admin, async (req) => {
    // 两项可以分开改：没给的那一项保持原值
    const patch = parse(billingSettingsSchema.partial().refine((v) => Object.keys(v).length > 0, '没有需要更新的字段'), req.body ?? {});
    const before = await getBillingSettings(db);
    const body = { ...before, ...patch };
    await putSetting(db, 'billing', body);
    await audit(db, req, 'settings.billing.update', 'settings', 'billing', { before, after: body });
    return body;
  });
}
