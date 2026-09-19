import type { FastifyInstance } from 'fastify';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import type { Db } from '../src/db/pool.js';
import { hashPassword } from '../src/security/password.js';
import { addServer, addTarget, addUser, at, collect, createTestDb, fakeExecutor, masterKey, report, seedBase } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let adminCookie: string;
let zhangsanCookie: string;
let zhangsan: string;
let lisi: string;
let targetId: string;
const enqueued: string[][] = [];
const PASSWORD = 'a-long-password-1';

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  const { credentialId } = await seedBase(db);
  zhangsan = await addUser(db, 'zhangsan', { budget: 500 });
  lisi = await addUser(db, 'lisi');
  await db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
  const server = await addServer(db, 'server-a', credentialId);
  targetId = await addTarget(db, server, zhangsan, '/home/zhangsan/.claude');
  const lisiTarget = await addTarget(db, server, lisi, '/home/lisi/.claude');
  const exec = fakeExecutor((req) => report({ '2026-09-19': [{ model: 'claude-opus-5', input: req.dir.includes('lisi') ? 777 : 1000, cost: 1 }] }));
  await collect(db, exec, targetId, at('2026-09-19 14:00'));
  await collect(db, exec, lisiTarget, at('2026-09-19 14:00'));

  app = await buildApp({
    db, logger: false,
    config: { jwtSecret: 'x'.repeat(40), cookieSecure: false, masterKey, masterKeyVersion: 1, publicBaseUrl: 'https://usage.example.com', webDist: undefined, sshTimeoutMs: 5000 },
    queues: { enqueueRuns: async (ids) => { enqueued.push(ids); }, kickMail: async () => undefined, syncSchedule: async () => undefined },
    executor: fakeExecutor(() => report({})),
    scanHostKey: async () => `SHA256:${'A'.repeat(43)}`,
    smtpSenderFactory: async () => null,
  });
  adminCookie = await login('admin@example.com');
  zhangsanCookie = await login('zhangsan@example.com');
});

afterAll(async () => {
  await app.close();
  await drop();
});

describe('登录与会话', () => {
  it('未登录不能访问任何业务接口', async () => {
    for (const url of ['/api/meta', '/api/stats/overview', '/api/users', '/api/servers', '/api/credentials', '/api/alerts/events', '/api/settings/smtp', '/api/audit']) {
      expect((await get(url)).statusCode, url).toBe(401);
    }
  });

  it('密码错误与不存在的账户返回相同的 401', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'zhangsan@example.com', password: 'nope-nope-nope' } });
    const ghost = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@example.com', password: 'nope-nope-nope' } });
    expect([wrong.statusCode, ghost.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(ghost.json());
  });

  it('会话 Cookie 为 HttpOnly + SameSite=Strict；停用账户后立即失效', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lisi@example.com', password: PASSWORD } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = setCookie.split(';')[0]!;
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);
    await db.query('UPDATE users SET is_active = false WHERE id = $1', [lisi]);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
    await db.query('UPDATE users SET is_active = true WHERE id = $1', [lisi]);
  });
});

describe('普通用户的访问边界', () => {
  it('无法访问他人用量', async () => {
    expect((await get(`/api/stats/users/${lisi}`, zhangsanCookie)).statusCode).toBe(403);
    expect((await get(`/api/stats/usage?userId=${lisi}`, zhangsanCookie)).statusCode).toBe(403);
    expect((await get(`/api/alerts/events?userId=${lisi}`, zhangsanCookie)).statusCode).toBe(403);
  });

  it('不带 userId 的统计查询被强制收窄到本人', async () => {
    const usage = (await get('/api/stats/usage?from=2026-09-01&to=2026-09-30&groupBy=user', zhangsanCookie)).json();
    expect(usage.rows.reduce((a: number, r: { totalTokens: number }) => a + r.totalTokens, 0)).toBe(1000);
    const overview = (await get('/api/stats/overview', zhangsanCookie)).json();
    expect(overview.ranking).toEqual([]);
    const filters = (await get('/api/stats/filters', zhangsanCookie)).json();
    expect(filters.users.map((u: { id: string }) => u.id)).toEqual([zhangsan]);

    const all = (await get('/api/stats/usage?from=2026-09-01&to=2026-09-30&groupBy=user', adminCookie)).json();
    expect(all.rows.reduce((a: number, r: { totalTokens: number }) => a + r.totalTokens, 0)).toBe(1777);
  });

  it('可以查看自己的详情', async () => {
    const detail = (await get(`/api/stats/users/${zhangsan}`, zhangsanCookie)).json();
    expect(detail.user.name).toBe('zhangsan');
    expect(detail.sources).toHaveLength(1);
  });

  it('无法访问任何服务器、凭据、规则、设置与管理操作', async () => {
    for (const url of ['/api/users', '/api/servers', '/api/credentials', '/api/alerts/rules', '/api/settings/general', '/api/settings/smtp', '/api/audit', '/api/collection/runs']) {
      expect((await get(url, zhangsanCookie)).statusCode, url).toBe(403);
    }
    expect((await send('POST', `/api/targets/${targetId}/collect`, zhangsanCookie, {})).statusCode).toBe(403);
    expect((await send('PATCH', `/api/users/${zhangsan}`, zhangsanCookie, { role: 'admin' })).statusCode).toBe(403);
    expect((await send('POST', '/api/credentials', zhangsanCookie, { name: 'x', privateKey: 'x'.repeat(60) })).statusCode).toBe(403);
  });
});

describe('凭据管理', () => {
  it('提交后只返回标识与指纹，任何接口都不回显私钥；库内为密文', async () => {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    const created = await send('POST', '/api/credentials', adminCookie, { name: 'new-key', privateKey: pair.private });
    expect(created.statusCode).toBe(201);
    expect(created.json().publicFingerprint).toMatch(/^SHA256:/);
    expect(created.body).not.toContain('PRIVATE KEY');

    const list = await get('/api/credentials', adminCookie);
    expect(list.body).not.toContain('PRIVATE KEY');
    expect(Object.keys(list.json().credentials[0]).sort()).toEqual(['createdAt', 'id', 'keyType', 'kind', 'name', 'publicFingerprint', 'revokedAt', 'rotatedAt', 'usedBy']);

    const stored = (await db.query("SELECT ciphertext FROM credentials WHERE name = 'new-key'")).rows[0].ciphertext as Buffer;
    expect(stored.toString('utf8')).not.toContain('PRIVATE KEY');
    const auditLog = await get('/api/audit?entityType=credential', adminCookie);
    expect(auditLog.json().logs[0].action).toBe('credential.create');
    expect(auditLog.body).not.toContain('PRIVATE KEY');
  });

  it('带口令的私钥：缺口令与口令错误给出明确提示，口令正确则保存', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/usage-monitor-key-');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'key-pass-123', '-Z', 'aes256-cbc', '-f', `${dir}/k`]);
    const privateKey = readFileSync(`${dir}/k`, 'utf8');
    rmSync(dir, { recursive: true });

    const missing = await send('POST', '/api/credentials', adminCookie, { name: 'enc', privateKey });
    expect([missing.statusCode, missing.json().error]).toEqual([400, '该私钥有口令保护，请在“私钥口令”中填写口令']);
    const wrong = await send('POST', '/api/credentials', adminCookie, { name: 'enc', privateKey, passphrase: 'nope' });
    expect([wrong.statusCode, wrong.json().error]).toEqual([400, '私钥口令不正确']);
    expect((await send('POST', '/api/credentials', adminCookie, { name: 'enc', privateKey, passphrase: 'key-pass-123' })).statusCode).toBe(201);
  });

  it('拒绝无法解析的私钥', async () => {
    expect((await send('POST', '/api/credentials', adminCookie, { name: 'bad', privateKey: 'not-a-key'.repeat(10) })).statusCode).toBe(400);
  });
});

describe('管理操作', () => {
  it('用户列表带今日/本月用量；没有用量的用户显示为未知（null）而不是 0', async () => {
    const res = await get('/api/users', adminCookie);
    expect(res.statusCode).toBe(200);
    const users = res.json().users as Array<{ name: string; monthTokens: number | null; targetCount: number }>;
    expect(users.find((u) => u.name === 'zhangsan')).toMatchObject({ targetCount: 1 }); // 用量取决于运行当天的日期，这里不断言
    expect(users.find((u) => u.name === '管理员')!.monthTokens).toBeNull();
  });

  it('校验服务器地址与数据目录，拒绝可注入的输入', async () => {
    const cred = (await get('/api/credentials', adminCookie)).json().credentials[0].id;
    const bad = await send('POST', '/api/servers', adminCookie, { name: 'x', host: 'a.example.com; id', sshUsername: 'collector', credentialId: cred });
    expect(bad.statusCode).toBe(400);
    const server = (await get('/api/servers', adminCookie)).json().servers[0].id;
    const badDir = await send('POST', `/api/servers/${server}/targets`, adminCookie, { userId: zhangsan, dataDir: '/home/u/.claude; id' });
    expect(badDir.statusCode).toBe(400);
  });

  it('修改服务器地址后必须重新确认主机指纹', async () => {
    const server = (await get('/api/servers', adminCookie)).json().servers[0];
    expect(server.hostKeyFingerprint).toBe('SHA256:host');
    const res = await send('PATCH', `/api/servers/${server.id}`, adminCookie, { host: 'moved.internal' });
    expect(res.json().hostKeyReset).toBe(true);
    const scan = (await send('POST', `/api/servers/${server.id}/scan-host-key`, adminCookie)).json();
    expect(scan.matches).toBe(false);
    expect((await send('POST', `/api/servers/${server.id}/confirm-host-key`, adminCookie, { fingerprint: scan.fingerprint })).statusCode).toBe(200);
  });

  it('手动采集立即入队；有历史统计的目标默认不可删除', async () => {
    const res = await send('POST', `/api/targets/${targetId}/collect`, adminCookie, {});
    expect(res.statusCode).toBe(202);
    expect(enqueued.at(-1)).toEqual(res.json().runIds);
    const del = await send('DELETE', `/api/targets/${targetId}`, adminCookie);
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe('HAS_USAGE');
  });

  it('调整绑定：默认保留历史归属，显式重归属才迁移历史', async () => {
    const keep = (await send('POST', `/api/targets/${targetId}/rebind`, adminCookie, { userId: lisi, effectiveFrom: '2026-09-20' })).json();
    expect(keep.reattributedRows).toBe(0);
    const moved = (await send('POST', `/api/targets/${targetId}/rebind`, adminCookie, { userId: lisi, reattributeHistory: true })).json();
    expect(moved.reattributedRows).toBe(1);
    const log = (await get('/api/audit?entityType=target', adminCookie)).json().logs.filter((l: { action: string }) => l.action === 'target.rebind');
    expect(log).toHaveLength(2);
  });

  it('告警规则校验：预算百分比只能按月，至少一类收件人', async () => {
    const base = { name: 'r', metric: 'budget_pct', period: 'monthly', tiers: [80, 100] };
    expect((await send('POST', '/api/alerts/rules', adminCookie, { ...base, period: 'daily' })).statusCode).toBe(400);
    expect((await send('POST', '/api/alerts/rules', adminCookie, { ...base, notifyUser: false })).statusCode).toBe(400);
    expect((await send('POST', '/api/alerts/rules', adminCookie, base)).statusCode).toBe(201);
    expect((await get('/api/alerts/rules', adminCookie)).json().rules[0].tiers).toEqual([80, 100]);
  });

  it('SMTP 密码加密保存且不回显；采集周期必须能整除 24 小时', async () => {
    const put = await send('PUT', '/api/settings/smtp', adminCookie, { host: 'smtp.example.com', port: 587, secure: false, username: 'bot', from: 'bot@example.com', password: 'smtp-secret' });
    expect(put.statusCode).toBe(200);
    const shown = await get('/api/settings/smtp', adminCookie);
    expect(shown.json()).toMatchObject({ configured: true, hasPassword: true });
    expect(shown.body).not.toContain('smtp-secret');
    expect(JSON.stringify((await db.query("SELECT value FROM settings WHERE key = 'smtp'")).rows[0].value)).not.toContain('smtp-secret');

    const general = (await get('/api/settings/general', adminCookie)).json();
    expect(general).toMatchObject({ timezone: 'Asia/Shanghai', collectIntervalHours: 2 });
    expect((await send('PUT', '/api/settings/general', adminCookie, { ...general, collectIntervalHours: 5 })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings/general', adminCookie, { ...general, collectIntervalHours: 4 })).statusCode).toBe(200);
  });

  it('管理员不能降级或停用自己', async () => {
    const me = (await get('/api/auth/me', adminCookie)).json();
    expect((await send('PATCH', `/api/users/${me.id}`, adminCookie, { role: 'user' })).statusCode).toBe(400);
  });
});

describe('请求体', () => {
  it('无请求体的动作型 POST 即使带 JSON content-type 也能处理', async () => {
    const server = (await get('/api/servers', adminCookie)).json().servers[0].id;
    const res = await app.inject({ method: 'POST', url: `/api/servers/${server}/scan-host-key`, headers: { cookie: adminCookie, 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('登录输入', () => {
  it('邮箱首尾的空白（复制粘贴带入）不影响登录', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ' admin@example.com ', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
  });
});
