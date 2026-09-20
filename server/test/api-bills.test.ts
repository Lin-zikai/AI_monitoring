import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { sanitizeFilename } from '../src/api/routes/bills.js';
import type { Db } from '../src/db/pool.js';
import { hashPassword } from '../src/security/password.js';
import { addDays, monthKey, monthRange } from '../src/util/time.js';
import { addServer, addTarget, addUser, createTestDb, fakeExecutor, fakeQueues, masterKey, report, seedBase } from './helpers.js';
import { DEFAULT_BILLING, putSetting } from '../src/settings.js';

// 账目明细：账单的增删改查、截图的校验与读取、月度汇总（含 ccusage 估算值）、汇率设置、权限与审计

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let adminCookie: string;
let userCookie: string;
let today: string;
let year: number;
const PASSWORD = 'a-long-password-1';

const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })).headers['set-cookie']).split(';')[0]!;
const get = (url: string, cookie = adminCookie) => app.inject({ method: 'GET', url, headers: { cookie } });
const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = adminCookie) =>
  app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

/** 生成一张合法的 1×1 PNG（签名 + IHDR + IDAT + IEND，CRC 按规范计算） */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 0x2a, 0x78, 0xd6]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = tinyPng();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 2)]);
const shot = (filename: string, data: Buffer = PNG, contentType = 'image/png') => ({ filename, contentType, dataBase64: data.toString('base64') });
const month = (m: number) => `${year}-${String(m).padStart(2, '0')}`;
const bill = (over: Record<string, unknown> = {}) => ({ category: 'vpn', month: month(1), amount: 98, currency: 'CNY', ...over });
const create = async (over: Record<string, unknown> = {}) => (await send('POST', '/api/bills', bill(over))).json().id as string;
const listed = async (query = '') => (await get(`/api/bills${query}`)).json().bills as Array<Record<string, any>>;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  const { credentialId } = await seedBase(db);
  app = await buildApp({
    db, logger: false, queues: fakeQueues(), executor: fakeExecutor(() => report({})),
    config: { jwtSecret: 'x'.repeat(40), cookieSecure: false, masterKey, masterKeyVersion: 1, publicBaseUrl: 'https://usage.example.com', webDist: undefined, sshTimeoutMs: 5000 },
    scanHostKey: async () => `SHA256:${'A'.repeat(43)}`, smtpSenderFactory: async () => null,
  });
  const anna = await addUser(db, 'anna');
  await db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
  adminCookie = await login('admin@example.com');
  userCookie = await login('anna@example.com');
  today = (await get('/api/meta')).json().today;
  // 下面的用例沿用各自的历史月份：把记账起始月份放到最早，起始月份本身的行为在“记账起始月份”一组里单独检验
  await putSetting(db, 'billing', { usdCny: 7.2, startMonth: '2020-01' });
  year = Number(today.slice(0, 4));

  // ccusage 估算值：1 月 Claude Code 两天共 310.5、Codex 40；2 月只有 Claude Code；上一年的不计入
  const server = await addServer(db, 'server-a', credentialId);
  const claude = await addTarget(db, server, anna, '/home/anna/.claude');
  const codex = await addTarget(db, server, anna, '/home/anna/.codex');
  await db.query("UPDATE collection_targets SET source = 'codex' WHERE id = $1", [codex]);
  const insert = `INSERT INTO usage_daily (target_id, user_id, server_id, source, usage_date, model, total_tokens, cost_usd, timezone, parser_version, collected_at)
                  VALUES ($1, $2, $3, $4, $5, 'm', 1, $6, 'Asia/Shanghai', 't', now())`;
  await db.query(insert, [claude, anna, server, 'claude-code', `${year}-01-03`, 300]);
  await db.query(insert, [claude, anna, server, 'claude-code', `${year}-01-31`, 10.5]);
  await db.query(insert, [codex, anna, server, 'codex', `${year}-01-15`, 40]);
  await db.query(insert, [claude, anna, server, 'claude-code', `${year}-02-01`, 7]);
  await db.query(insert, [claude, anna, server, 'claude-code', `${year - 1}-12-31`, 999]);
});

afterAll(async () => {
  await app.close();
  await drop();
});

describe('账单的创建与列表', () => {
  it('带截图创建：列表给出元数据但不含图片内容；截图接口返回原始字节和正确的响应头', async () => {
    const res = await send('POST', '/api/bills', bill({ title: ' 某机场 · 年付 ', paidOn: `${year}-01-05`, note: '', attachments: [shot('C:\\Users\\me\\账单 (1月).png')] }));
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;

    const rows = await listed(`?year=${year}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, category: 'vpn', month: month(1), amount: 98, currency: 'CNY', title: '某机场 · 年付', paidOn: `${year}-01-05`, note: null, createdByName: '管理员' });
    expect(rows[0]!.attachments).toEqual([{ id: expect.any(String), filename: '账单 (1月).png', contentType: 'image/png', sizeBytes: PNG.length }]);
    expect(JSON.stringify(rows)).not.toContain(PNG.toString('base64'));

    const img = await get(`/api/bills/attachments/${rows[0]!.attachments[0].id}`);
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('账单 ').replace(/'/g, '%27')}%281${encodeURIComponent('月')}%29.png`);
    expect(img.headers['cache-control']).toBe('private, max-age=86400');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await get('/api/bills/attachments/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    await send('DELETE', `/api/bills/${id}`);
  });

  it('JPEG / WebP 同样按文件头核对；按年份和类别筛选，新月份在前', async () => {
    const a = await create({ month: month(1), attachments: [shot('a.jpg', JPEG, 'image/jpeg'), shot('b.webp', WEBP, 'image/webp')] });
    const b = await create({ category: 'codex', month: month(2), amount: 20, currency: 'USD' });
    const old = await create({ category: 'claude-code', month: `${year - 1}-12`, amount: 200, currency: 'USD' });
    expect((await listed(`?year=${year}`)).map((r) => r.id)).toEqual([b, a]);
    expect((await listed(`?year=${year}&category=vpn`)).map((r) => r.id)).toEqual([a]);
    expect((await listed()).map((r) => r.id)).toEqual([b, a, old]);
    expect((await listed(`?year=${year}`))[1]!.attachments.map((x: { contentType: string }) => x.contentType)).toEqual(['image/jpeg', 'image/webp']);
    expect((await get('/api/bills?year=abc')).statusCode).toBe(400);
    expect((await get('/api/bills?category=other')).statusCode).toBe(400);
    for (const id of [a, b, old]) await send('DELETE', `/api/bills/${id}`);
  });

  it('拒绝：文件头与类型不符、不支持的类型、非法 base64、超过 5 MB、超过 4 张', async () => {
    const bad = async (attachments: unknown[]) => { const r = await send('POST', '/api/bills', bill({ attachments })); return [r.statusCode, r.json().error as string] as const; };
    expect(await bad([shot('x.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))])).toEqual([400, expect.stringContaining('第 1 张截图不是有效的 PNG')]);
    expect(await bad([shot('ok.png'), shot('x.jpg', PNG, 'image/jpeg')])).toEqual([400, expect.stringContaining('第 2 张截图不是有效的 JPG')]);
    expect(await bad([shot('x.webp', Buffer.from('RIFF0000WAVEfmt '), 'image/webp')])).toEqual([400, expect.stringContaining('WEBP')]);
    expect((await bad([shot('x.svg', PNG, 'image/svg+xml')]))[0]).toBe(400);
    expect(await bad([{ filename: 'x.png', contentType: 'image/png', dataBase64: '不是 base64!' }])).toEqual([400, expect.stringContaining('base64')]);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    expect(await bad([shot('big.png', big)])).toEqual([400, expect.stringContaining('超过 5 MB')]);
    expect((await bad(Array.from({ length: 5 }, (_, i) => shot(`${i}.png`))))[0]).toBe(400);
    expect(await listed()).toEqual([]); // 校验失败时什么都不会写入
  });

  it('接近上限的截图可以上传（路由级 bodyLimit 生效），其余接口仍受 256 KB 的全局上限约束', async () => {
    const large = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const id = await create({ attachments: [shot('large.png', large)] });
    const att = (await listed())[0]!.attachments[0];
    expect(att.sizeBytes).toBe(large.length);
    expect((await get(`/api/bills/attachments/${att.id}`)).rawPayload.length).toBe(large.length);
    await send('DELETE', `/api/bills/${id}`);
    expect((await send('PUT', '/api/bills/settings', { usdCny: 7, pad: 'x'.repeat(300 * 1024) })).statusCode).toBe(413);
  });

  it('拒绝：不存在的月份、过早或过远的月份、负数或超过两位小数的金额、未知类别和币种、不存在的付款日期', async () => {
    const status = async (over: Record<string, unknown>) => (await send('POST', '/api/bills', bill(over))).statusCode;
    const nextMonth = monthKey(addDays(monthRange(monthKey(today)).last, 1));
    const tooFar = monthKey(addDays(monthRange(nextMonth).last, 1));
    expect(await status({ month: `${year}-13` })).toBe(400);
    expect(await status({ month: `${year}-00` })).toBe(400);
    expect(await status({ month: `${year}-1` })).toBe(400);
    expect(await status({ month: '2019-12' })).toBe(400);
    expect(await status({ month: tooFar })).toBe(400);
    expect(await status({ amount: -1 })).toBe(400);
    expect(await status({ amount: 1.234 })).toBe(400);
    expect(await status({ amount: 10_000_001 })).toBe(400);
    expect(await status({ amount: '98' })).toBe(400);
    expect(await status({ category: 'other' })).toBe(400);
    expect(await status({ currency: 'EUR' })).toBe(400);
    expect(await status({ paidOn: `${year}-02-30` })).toBe(400);
    expect(await listed()).toEqual([]);
    // 下个月（预付）和 0 元、两位小数都是合法的
    const id = await create({ month: nextMonth, amount: 0 });
    const id2 = await create({ amount: 19.99 });
    expect((await listed()).find((r) => r.id === id2)!.amount).toBe(19.99);
    for (const x of [id, id2]) await send('DELETE', `/api/bills/${x}`);
  });

  it('文件名：去掉路径和控制字符、限制长度并保留扩展名，空文件名给默认名', () => {
    expect(sanitizeFilename('../../etc/passwd', 'image/png')).toBe('passwd');
    expect(sanitizeFilename('a\u0000b\r\nc.png', 'image/png')).toBe('abc.png');
    expect(sanitizeFilename('', 'image/jpeg')).toBe('screenshot.jpg');
    expect(sanitizeFilename('..', 'image/webp')).toBe('screenshot.webp');
    const long = sanitizeFilename(`${'长'.repeat(300)}.jpeg`, 'image/jpeg');
    expect(long).toHaveLength(120);
    expect(long.endsWith('.jpeg')).toBe(true);
  });
});

describe('PATCH / DELETE', () => {
  it('修改字段、追加与移除截图在同一个事务里完成；每笔最多 4 张', async () => {
    const id = await create({ title: '旧名称', note: '备注', attachments: [shot('1.png'), shot('2.png')] });
    const [first, second] = (await listed())[0]!.attachments as Array<{ id: string }>;

    expect((await send('PATCH', `/api/bills/${id}`, { amount: 120.5, currency: 'USD', category: 'claude-code', month: month(2), title: 'Max 20x', note: '', paidOn: `${year}-02-03`, addAttachments: [shot('3.png')], removeAttachmentIds: [first!.id] })).json()).toEqual({ ok: true });
    let row = (await listed())[0]!;
    expect(row).toMatchObject({ category: 'claude-code', month: month(2), amount: 120.5, currency: 'USD', title: 'Max 20x', note: null, paidOn: `${year}-02-03` });
    expect(row.attachments.map((a: { filename: string }) => a.filename)).toEqual(['2.png', '3.png']);
    expect((await get(`/api/bills/attachments/${first!.id}`)).statusCode).toBe(404);

    // 只传截图也可以；没传的字段保持原样
    expect((await send('PATCH', `/api/bills/${id}`, { addAttachments: [shot('4.png'), shot('5.png')] })).statusCode).toBe(200);
    row = (await listed())[0]!;
    expect(row).toMatchObject({ amount: 120.5, title: 'Max 20x' });
    expect(row.attachments).toHaveLength(4);

    // 已满 4 张：再加就拒绝，且同一请求里的字段修改一并回滚；先移除再加则可以
    const over = await send('PATCH', `/api/bills/${id}`, { amount: 1, addAttachments: [shot('6.png')] });
    expect([over.statusCode, over.json().error]).toEqual([400, expect.stringContaining('最多 4 张')]);
    expect((await listed())[0]!.amount).toBe(120.5);
    expect((await send('PATCH', `/api/bills/${id}`, { addAttachments: [shot('6.png')], removeAttachmentIds: [second!.id] })).statusCode).toBe(200);
    expect((await listed())[0]!.attachments.map((a: { filename: string }) => a.filename)).toEqual(['3.png', '4.png', '5.png', '6.png']);

    // 别的账单的截图不能经由这笔账单移除
    const other = await create({ attachments: [shot('other.png')] });
    const otherAtt = (await listed()).find((r) => r.id === other)!.attachments[0].id as string;
    expect((await send('PATCH', `/api/bills/${id}`, { removeAttachmentIds: [otherAtt] })).statusCode).toBe(400);
    expect((await get(`/api/bills/attachments/${otherAtt}`)).statusCode).toBe(200);

    expect((await send('PATCH', `/api/bills/${id}`, {})).statusCode).toBe(400);
    expect((await send('PATCH', `/api/bills/${id}`, { amount: -5 })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/bills/${id}`, { addAttachments: [shot('x.png', JPEG)] })).statusCode).toBe(400);
    expect((await send('PATCH', '/api/bills/00000000-0000-4000-8000-000000000000', { amount: 1 })).statusCode).toBe(404);
    expect((await send('PATCH', '/api/bills/not-a-uuid', { amount: 1 })).statusCode).toBe(400);
    for (const x of [id, other]) await send('DELETE', `/api/bills/${x}`);
  });

  it('删除账单时截图一并删除；重复删除返回 404', async () => {
    const id = await create({ attachments: [shot('1.png'), shot('2.png')] });
    const attId = (await listed())[0]!.attachments[0].id as string;
    expect((await send('DELETE', `/api/bills/${id}`)).json()).toEqual({ ok: true });
    expect(await listed()).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM bill_attachments')).rows[0].n).toBe(0);
    expect((await get(`/api/bills/attachments/${attId}`)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/bills/${id}`)).statusCode).toBe(404);
  });

  it('登记人被删除后账单保留（created_by 置空）', async () => {
    const tempId = await addUser(db, 'temp-admin', { role: 'admin' });
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), tempId]);
    const id = (await send('POST', '/api/bills', bill(), await login('temp-admin@example.com'))).json().id as string;
    expect((await listed())[0]).toMatchObject({ id, createdByName: 'temp-admin' });
    await db.query('DELETE FROM users WHERE id = $1', [tempId]);
    expect((await listed())[0]).toMatchObject({ id, createdByName: null });
    await send('DELETE', `/api/bills/${id}`);
  });
});

describe('GET /bills/summary', () => {
  it('12 个月逐月给出各类别、各币种的合计与笔数，以及同期的 ccusage 估算值；金额保持原币种', async () => {
    const ids = [
      await create({ category: 'vpn', month: month(1), amount: 98, currency: 'CNY' }),
      await create({ category: 'claude-code', month: month(1), amount: 200, currency: 'USD' }),
      await create({ category: 'claude-code', month: month(1), amount: 100.25, currency: 'USD' }),
      await create({ category: 'claude-code', month: month(1), amount: 700, currency: 'CNY' }),
      await create({ category: 'codex', month: month(2), amount: 20, currency: 'USD' }),
      await create({ category: 'vpn', month: `${year - 2}-06`, amount: 50, currency: 'CNY' }),
    ];
    const s = (await get(`/api/bills/summary?year=${year}`)).json();
    expect(s).toMatchObject({ year, years: [year, year - 2], usdCny: 7.2 });
    expect(s.months.map((m: { month: string }) => m.month)).toEqual(Array.from({ length: 12 }, (_, i) => month(i + 1)));
    expect(s.months[0]).toEqual({
      month: month(1),
      items: [
        { category: 'claude-code', currency: 'CNY', amount: 700, count: 1 },
        { category: 'claude-code', currency: 'USD', amount: 300.25, count: 2 },
        { category: 'vpn', currency: 'CNY', amount: 98, count: 1 },
      ],
      estimatedUsd: { 'claude-code': 310.5, codex: 40 },
    });
    expect(s.months[1]).toEqual({ month: month(2), items: [{ category: 'codex', currency: 'USD', amount: 20, count: 1 }], estimatedUsd: { 'claude-code': 7, codex: null } });
    expect(s.months[2]).toEqual({ month: month(3), items: [], estimatedUsd: { 'claude-code': null, codex: null } });

    // 不带 year = 统计时区的今年；没有账单的年份也能看（估算值照常给出）
    expect((await get('/api/bills/summary')).json().year).toBe(year);
    const last = (await get(`/api/bills/summary?year=${year - 1}`)).json();
    expect(last.months[11]).toEqual({ month: `${year - 1}-12`, items: [], estimatedUsd: { 'claude-code': 999, codex: null } });
    expect(last.years).toEqual([year, year - 2]);
    expect((await get('/api/bills/summary?year=1999')).statusCode).toBe(400);
    for (const id of ids) await send('DELETE', `/api/bills/${id}`);
  });
});

describe('汇率设置', () => {
  it('默认 7.2；保存后汇总接口跟着变；超出 1～20 或不是数字则拒绝', async () => {
    expect((await get('/api/bills/settings')).json()).toEqual({ usdCny: 7.2, startMonth: '2020-01' });
    expect((await send('PUT', '/api/bills/settings', { usdCny: 7.05 })).json()).toEqual({ usdCny: 7.05, startMonth: '2020-01' }); // 只改汇率，起始月份不变
    expect((await get('/api/bills/settings')).json()).toEqual({ usdCny: 7.05, startMonth: '2020-01' });
    expect((await get('/api/bills/summary')).json().usdCny).toBe(7.05);
    for (const usdCny of [0.5, 21, '7.2', null]) expect((await send('PUT', '/api/bills/settings', { usdCny })).statusCode).toBe(400);
    expect((await send('PUT', '/api/bills/settings', {})).statusCode).toBe(400);
    expect((await get('/api/bills/settings')).json()).toEqual({ usdCny: 7.05, startMonth: '2020-01' });
  });
});

describe('记账起始月份', () => {
  it('默认从 2026-09 开始', () => {
    expect(DEFAULT_BILLING.startMonth).toBe('2026-09');
  });

  it('更早的月份不进汇总、不接受更早的账单；已有的旧账单仍可改其他字段；改回更早的起始月份后恢复', async () => {
    const old = await create({ month: `${year}-02`, amount: 10 });
    const start = `${year}-06`;
    expect((await send('PUT', '/api/bills/settings', { startMonth: start })).json()).toMatchObject({ startMonth: start });

    const s = (await get(`/api/bills/summary?year=${year}`)).json();
    expect(s.startMonth).toBe(start);
    expect(s.months.map((m: { month: string }) => m.month)).toEqual(['06', '07', '08', '09', '10', '11', '12'].map((m) => `${year}-${m}`));
    expect((await get(`/api/bills/summary?year=${year - 1}`)).json().months).toEqual([]);

    const early = await send('POST', '/api/bills', bill({ month: `${year}-05` }));
    expect([early.statusCode, early.json().error]).toEqual([400, expect.stringContaining(start)]);
    expect((await send('PATCH', `/api/bills/${old}`, { month: `${year}-03` })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/bills/${old}`, { amount: 12 })).statusCode).toBe(200);

    for (const startMonth of ['2019-12', '2026-13', '2026/09', 202609]) expect((await send('PUT', '/api/bills/settings', { startMonth })).statusCode).toBe(400);
    await send('PUT', '/api/bills/settings', { startMonth: '2020-01' });
    expect((await get(`/api/bills/summary?year=${year}`)).json().months).toHaveLength(12);
    await send('DELETE', `/api/bills/${old}`);
  });
});

describe('权限与审计', () => {
  it('所有接口都只对管理员开放：普通用户 403，未登录 401（上传接口在解析请求体之前就拒绝）', async () => {
    const id = await create({ attachments: [shot('1.png')] });
    const attId = (await listed())[0]!.attachments[0].id as string;
    const calls: Array<['GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/bills'], ['GET', '/api/bills/summary'], ['GET', '/api/bills/settings'], ['GET', `/api/bills/attachments/${attId}`],
      ['POST', '/api/bills', bill()], ['PATCH', `/api/bills/${id}`, { amount: 1 }], ['PUT', '/api/bills/settings', { usdCny: 8 }], ['DELETE', `/api/bills/${id}`],
    ];
    for (const [method, url, payload] of calls) {
      const asUser = await app.inject({ method, url, headers: { cookie: userCookie }, ...(payload ? { payload: payload as object } : {}) });
      expect([method, url, asUser.statusCode]).toEqual([method, url, 403]);
      const anonymous = await app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
      expect([method, url, anonymous.statusCode]).toEqual([method, url, 401]);
    }
    // 校验不通过的请求体也一样：先看权限，再看内容
    expect((await app.inject({ method: 'POST', url: '/api/bills', headers: { cookie: userCookie }, payload: { nonsense: true } })).statusCode).toBe(403);
    expect((await listed()).map((r) => [r.id, r.amount])).toEqual([[id, 98]]);
    await send('DELETE', `/api/bills/${id}`);
  });

  it('每次写入都留审计记录，且不包含图片内容', async () => {
    await db.query("DELETE FROM audit_logs WHERE entity_type IN ('bill', 'settings')");
    const id = await create({ title: 'Max 20x', category: 'claude-code', currency: 'USD', amount: 200, attachments: [shot('pay.png')] });
    const attId = (await listed())[0]!.attachments[0].id as string;
    await send('PATCH', `/api/bills/${id}`, { amount: 100, addAttachments: [shot('new.png')], removeAttachmentIds: [attId] });
    await send('DELETE', `/api/bills/${id}`);
    await send('PUT', '/api/bills/settings', { usdCny: 7.3 });

    const logs = (await db.query("SELECT actor_email, action, entity_type, entity_id, detail FROM audit_logs WHERE entity_type IN ('bill', 'settings') ORDER BY id")).rows;
    expect(logs.map((l) => [l.actor_email, l.action, l.entity_id])).toEqual([
      ['admin@example.com', 'bill.create', id], ['admin@example.com', 'bill.update', id], ['admin@example.com', 'bill.delete', id], ['admin@example.com', 'settings.billing.update', 'billing'],
    ]);
    expect(logs[0]!.detail).toEqual({ category: 'claude-code', month: month(1), amount: 200, currency: 'USD', title: 'Max 20x', paidOn: null, note: null, attachments: [{ filename: 'pay.png', contentType: 'image/png', sizeBytes: PNG.length }] });
    expect(logs[1]!.detail).toEqual({ amount: 100, addedAttachments: [{ filename: 'new.png', contentType: 'image/png', sizeBytes: PNG.length }], removedAttachmentIds: [attId] });
    expect(logs[2]!.detail).toEqual({ category: 'claude-code', month: month(1), amount: 100, currency: 'USD', title: 'Max 20x' });
    expect(logs[3]!.detail).toEqual({ before: { usdCny: 7.05, startMonth: '2020-01' }, after: { usdCny: 7.3, startMonth: '2020-01' } });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(PNG.toString('base64'));
    expect(dump).not.toContain('dataBase64');
  });
});
