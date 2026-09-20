import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { parseTrustProxy } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { hashPassword } from '../src/security/password.js';
import { isValidCollectCommand } from '../src/security/validate.js';
import { DEFAULT_GENERAL } from '../src/settings.js';
import { addServer, addTarget, addUser, createTestDb, fakeExecutor, fakeQueues, masterKey, report, seedBase } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;
let credentialId: string;
let zhangsan: string;
let serverId: string;
let targetId: string;
let today: string;
const queues = fakeQueues();
const PASSWORD = 'a-long-password-1';
const config = { jwtSecret: 'x'.repeat(40), cookieSecure: false, masterKey, masterKeyVersion: 1, publicBaseUrl: 'https://usage.example.com', webDist: undefined, sshTimeoutMs: 5000 };

// 登录接口按 IP 限流（10 次/分钟）；测试里每次登录换一个来源地址，只检验按邮箱的限制
let ipSeq = 0;
const nextIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const tryLogin = (email: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: nextIp() });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;

async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await tryLogin(email, password);
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

const get = (url: string, cookie = adminCookie) => app.inject({ method: 'GET', url, headers: { cookie } });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, cookie = adminCookie) => app.inject({ method, url, headers: { cookie }, payload });

const USAGE_INSERT = `INSERT INTO usage_daily (target_id, user_id, server_id, source, usage_date, model, total_tokens, cost_usd, timezone, parser_version, collected_at)
                      VALUES ($1, $2, $3, 'claude-code', $4, $5, $6, $7, 'Asia/Shanghai', 't', now())`;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  ({ adminId, credentialId } = await seedBase(db));
  zhangsan = await addUser(db, 'zhangsan');
  await db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
  serverId = await addServer(db, 'server-a', credentialId);
  targetId = await addTarget(db, serverId, zhangsan, '/home/zhangsan/.claude');
  app = await buildApp({
    db, logger: false, config, queues,
    executor: fakeExecutor(() => report({})),
    scanHostKey: async () => `SHA256:${'A'.repeat(43)}`,
    smtpSenderFactory: async () => null,
  });
  adminCookie = await login('admin@example.com');
  today = (await get('/api/meta')).json().today;
});

afterAll(async () => {
  await app.close();
  await drop();
});

describe('日期参数', () => {
  it('日历上不存在的日期返回 400 而不是 500', async () => {
    for (const url of ['/api/stats/usage?from=2026-02-30', '/api/stats/usage?to=2026-13-45', '/api/stats/daily-ranking?date=2026-02-30', '/api/stats/daily-ranking?date=0000-01-01']) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
    expect((await send('POST', `/api/targets/${targetId}/rebind`, { userId: zhangsan, effectiveFrom: '2026-02-30' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/targets/${targetId}`, { sourceStartDate: '2026-13-45' })).statusCode).toBe(400);
    expect((await send('POST', `/api/servers/${serverId}/targets`, { userId: zhangsan, dataDir: '/home/x/.claude', sourceEndDate: '2026-04-31' })).statusCode).toBe(400);
    expect((await get('/api/stats/usage?from=2024-02-29&to=2024-03-01')).statusCode).toBe(200); // 闰日是合法日期
  });

  it('来源开始日期不能晚于结束日期；PATCH 只改一端时与库里的另一端比较', async () => {
    const bad = await send('POST', `/api/servers/${serverId}/targets`, { userId: zhangsan, dataDir: '/home/range/.claude', sourceStartDate: '2026-09-10', sourceEndDate: '2026-09-01' });
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'BAD_DATE_RANGE']);
    const created = await send('POST', `/api/servers/${serverId}/targets`, { userId: zhangsan, dataDir: '/home/range/.claude', sourceStartDate: '2026-09-01', sourceEndDate: '2026-09-10' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    expect((await send('PATCH', `/api/targets/${id}`, { sourceStartDate: '2026-10-01', sourceEndDate: '2026-09-30' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/targets/${id}`, { sourceEndDate: '2026-08-31' })).statusCode).toBe(400); // 早于库里的开始日期
    expect((await send('PATCH', `/api/targets/${id}`, { sourceStartDate: '2026-09-11' })).statusCode).toBe(400); // 晚于库里的结束日期
    expect((await send('PATCH', `/api/targets/${id}`, { sourceEndDate: null })).statusCode).toBe(200);
    expect((await send('PATCH', `/api/targets/${id}`, { sourceStartDate: '2026-09-11' })).statusCode).toBe(200);
    expect((await send('PATCH', `/api/targets/${randomUUID()}`, { enabled: false })).statusCode).toBe(404);
    // 绕过接口直接写库也会被 CHECK 约束拦下
    await expect(db.query("UPDATE collection_targets SET source_end_date = '2026-01-01' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23514' });
    expect((await send('DELETE', `/api/targets/${id}`)).statusCode).toBe(200);
  });
});

describe('外键错误', () => {
  it('写入时引用了不存在的记录返回 400/404，而不是“仍被引用”的 409', async () => {
    const ghost = randomUUID();
    const noCred = await send('POST', '/api/servers', { name: 'fk-server', host: 'fk.internal', sshUsername: 'collector', credentialId: ghost });
    expect([noCred.statusCode, noCred.json().code]).toEqual([400, 'REFERENCE_NOT_FOUND']);
    expect((await send('PATCH', `/api/servers/${serverId}`, { credentialId: ghost })).statusCode).toBe(400);
    expect((await send('POST', `/api/servers/${serverId}/targets`, { userId: ghost, dataDir: '/home/fk/.claude' })).statusCode).toBe(400);
    expect((await send('POST', `/api/servers/${ghost}/targets`, { userId: zhangsan, dataDir: '/home/fk/.claude' })).statusCode).toBe(404);
    expect((await send('POST', `/api/targets/${targetId}/rebind`, { userId: ghost })).statusCode).toBe(400);
    expect((await send('POST', '/api/alerts/rules', { name: 'fk', metric: 'cost', period: 'daily', tiers: [1], scopeType: 'user', scopeUserId: ghost })).statusCode).toBe(400);
    expect((await send('POST', `/api/servers/${serverId}/onboard`, { userId: ghost })).statusCode).toBe(400);
    // 重名仍然是 409
    expect((await send('POST', '/api/servers', { name: 'server-a', host: 'fk.internal', sshUsername: 'collector', credentialId })).statusCode).toBe(409);
  });
});

describe('删除接口', () => {
  it('用户：有采集目标的受外键保护（409），无引用的可删除；不能删除自己', async () => {
    const inUse = await send('DELETE', `/api/users/${zhangsan}`);
    expect([inUse.statusCode, inUse.json().code]).toEqual([409, 'STILL_REFERENCED']);
    const temp = await addUser(db, 'temp-user');
    expect((await send('DELETE', `/api/users/${temp}`)).statusCode).toBe(200);
    expect((await send('DELETE', `/api/users/${temp}`)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/users/${adminId}`)).statusCode).toBe(400);
    expect((await get('/api/audit?entityType=user')).json().logs.some((l: { action: string; entityId: string }) => l.action === 'user.delete' && l.entityId === temp)).toBe(true);
  });

  it('凭据：仍被服务器使用时 409，未使用的可删除', async () => {
    expect((await send('DELETE', `/api/credentials/${credentialId}`)).statusCode).toBe(409);
    const spare = randomUUID();
    await db.query("INSERT INTO credentials (id, name, ciphertext, iv, auth_tag, public_fingerprint, key_type) VALUES ($1, 'spare', '\\x00', '\\x00', '\\x00', 'SHA256:spare', 'ssh-ed25519')", [spare]);
    expect((await send('DELETE', `/api/credentials/${spare}`)).statusCode).toBe(200);
    expect((await send('DELETE', `/api/credentials/${spare}`)).statusCode).toBe(404);
  });

  it('服务器：有历史统计时需要 purge=true 确认，删除后目标与统计一并清除', async () => {
    const doomed = await addServer(db, 'doomed', credentialId);
    const doomedTarget = await addTarget(db, doomed, zhangsan, '/home/doomed/.claude');
    await db.query(USAGE_INSERT, [doomedTarget, zhangsan, doomed, '2026-01-05', 'm', 10, 0.1]);
    const refused = await send('DELETE', `/api/servers/${doomed}`);
    expect([refused.statusCode, refused.json().code]).toEqual([409, 'HAS_USAGE']);
    expect((await send('DELETE', `/api/servers/${doomed}?purge=true`)).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM usage_daily WHERE server_id = $1', [doomed])).rows[0].n).toBe(0);
    expect((await send('DELETE', `/api/servers/${doomed}`)).statusCode).toBe(404);
  });

  it('告警规则：可修改、可删除；不存在的规则返回 404', async () => {
    const rule = { name: '日费用', metric: 'cost', period: 'daily', tiers: [50, 10] };
    const id = (await send('POST', '/api/alerts/rules', rule)).json().id as string;
    expect((await send('PUT', `/api/alerts/rules/${id}`, { ...rule, name: '日费用（改）', tiers: [30, 20, 5], enabled: false })).statusCode).toBe(200);
    const listed = (await get('/api/alerts/rules')).json().rules.find((r: { id: string }) => r.id === id);
    expect(listed).toMatchObject({ name: '日费用（改）', tiers: [5, 20, 30], enabled: false });
    expect((await send('PUT', `/api/alerts/rules/${id}`, { ...rule, tiers: [] })).statusCode).toBe(400);
    expect((await send('PUT', `/api/alerts/rules/${randomUUID()}`, rule)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/alerts/rules/${id}`)).statusCode).toBe(200);
    expect((await send('DELETE', `/api/alerts/rules/${id}`)).statusCode).toBe(404);
    const actions = (await get('/api/audit?entityType=alert_rule')).json().logs.filter((l: { entityId: string }) => l.entityId === id).map((l: { action: string }) => l.action);
    expect(actions).toEqual(['alert_rule.delete', 'alert_rule.update', 'alert_rule.create']);
  });
});

describe('会话吊销', () => {
  it('修改密码后其他设备上的旧 Cookie 立即失效，当前会话换发新 Cookie', async () => {
    const user = await addUser(db, 'session-a');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user, await hashPassword(PASSWORD)]);
    const current = await login('session-a@example.com');
    const otherDevice = await login('session-a@example.com');

    const changed = await send('POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another-password-2' }, current);
    expect(changed.statusCode).toBe(200);
    const fresh = cookieOf(changed);
    expect(fresh).not.toBe(current);
    expect((await get('/api/auth/me', current)).statusCode).toBe(401);
    expect((await get('/api/auth/me', otherDevice)).statusCode).toBe(401);
    const me = await get('/api/auth/me', fresh);
    expect(me.statusCode).toBe(200);
    expect(Object.keys(me.json()).sort()).toEqual(['email', 'id', 'name', 'role']); // 版本号不外泄
  });

  it('退出登录后，被抄走的 Cookie 不能继续使用', async () => {
    const user = await addUser(db, 'session-b');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user, await hashPassword(PASSWORD)]);
    const cookie = await login('session-b@example.com');
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);
    expect((await send('POST', '/api/auth/logout', undefined, cookie)).statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(200); // 没带 Cookie 也不报错
    expect((await get('/api/auth/me', await login('session-b@example.com'))).statusCode).toBe(200);
  });

  it('管理员重置密码、修改角色、停用账户都会吊销该用户的会话；只改资料不会', async () => {
    const user = await addUser(db, 'session-c');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user, await hashPassword(PASSWORD)]);
    let cookie = await login('session-c@example.com');
    expect((await send('PATCH', `/api/users/${user}`, { team: '平台组', monthlyBudgetUsd: 100 })).statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);

    expect((await send('PATCH', `/api/users/${user}`, { password: 'reset-by-admin-3' })).statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);

    cookie = await login('session-c@example.com', 'reset-by-admin-3');
    expect((await send('PATCH', `/api/users/${user}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);

    cookie = await login('session-c@example.com', 'reset-by-admin-3');
    expect((await send('PATCH', `/api/users/${user}`, { isActive: false })).statusCode).toBe(200);
    await db.query('UPDATE users SET is_active = true WHERE id = $1', [user]); // 即使重新启用，停用前签发的令牌也不再有效
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('管理员重置自己的密码时当前会话保持登录', async () => {
    const res = await send('PATCH', `/api/users/${adminId}`, { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/auth/me')).statusCode).toBe(401); // 旧 Cookie 失效
    adminCookie = cookieOf(res);
    expect((await get('/api/auth/me')).statusCode).toBe(200);
  });

  it('不带版本号的旧格式令牌被拒绝', async () => {
    const legacy = app.jwt.sign({ sub: adminId }, { expiresIn: 3600 });
    expect((await get('/api/auth/me', `usage_token=${legacy}`)).statusCode).toBe(401);
    const version = (await db.query('SELECT token_version FROM users WHERE id = $1', [adminId])).rows[0].token_version;
    expect((await get('/api/auth/me', `usage_token=${app.jwt.sign({ sub: adminId, tv: version }, { expiresIn: 3600 })}`)).statusCode).toBe(200);
    expect((await get('/api/auth/me', `usage_token=${app.jwt.sign({ sub: adminId, tv: version + 1 }, { expiresIn: 3600 })}`)).statusCode).toBe(401);
  });
});

describe('登录失败限制', () => {
  it('同一邮箱 15 分钟内失败 10 次后被锁定（换 IP、换大小写也一样）；失败记录进审计日志且不含密码', async () => {
    const user = await addUser(db, 'throttled');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user, await hashPassword(PASSWORD)]);
    for (let i = 0; i < 10; i++) expect((await tryLogin(i % 2 ? 'Throttled@Example.com' : 'throttled@example.com', 'wrong-password-xyz')).statusCode).toBe(401);
    const locked = await tryLogin('throttled@example.com'); // 密码正确也不放行
    expect([locked.statusCode, locked.json().code]).toEqual([429, 'LOGIN_THROTTLED']);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await tryLogin('admin@example.com')).statusCode).toBe(200); // 不影响其他账户

    const logs = (await get('/api/audit?entityType=user&limit=500')).json().logs.filter((l: { action: string; entityId: string }) => l.action === 'auth.login_failed' && l.entityId === user);
    expect(logs).toHaveLength(10);
    expect(logs[0].detail).toMatchObject({ email: 'throttled@example.com', reason: 'bad_password', locked: true });
    expect(JSON.stringify(logs)).not.toContain('wrong-password-xyz');
  });

  it('登录成功后失败计数清零；不存在的邮箱同样计数，响应与密码错误一致', async () => {
    const user = await addUser(db, 'forgetful');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user, await hashPassword(PASSWORD)]);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 9; i++) expect((await tryLogin('forgetful@example.com', 'nope-nope-nope')).statusCode).toBe(401);
      expect((await tryLogin('forgetful@example.com')).statusCode).toBe(200);
    }
    for (let i = 0; i < 10; i++) expect((await tryLogin('ghost@example.com', 'nope-nope-nope')).json()).toEqual({ error: '邮箱或密码错误' });
    expect((await tryLogin('ghost@example.com', 'nope-nope-nope')).statusCode).toBe(429);
  });
});

describe('客户端 IP 与安全响应头', () => {
  it('默认不采信 X-Forwarded-For', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: PASSWORD }, remoteAddress: '10.8.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.statusCode).toBe(200);
    const log = (await get('/api/audit?entityType=user&limit=1')).json().logs[0];
    expect([log.action, log.ip]).toEqual(['auth.login', '10.8.0.1']);
  });

  it('TRUST_PROXY=1 时取代理给出的地址', async () => {
    const proxied = await buildApp({ db, logger: false, config: { ...config, trustProxy: 1 }, queues: fakeQueues(), executor: fakeExecutor(() => report({})), scanHostKey: async () => '', smtpSenderFactory: async () => null });
    const res = await proxied.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: PASSWORD }, remoteAddress: '10.8.0.1', headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' } });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/audit?entityType=user&limit=1')).json().logs[0].ip).toBe('203.0.113.7'); // 只信最近的一跳，更左边的值可由客户端伪造
    await proxied.close();
  });

  it('TRUST_PROXY 的取值解析', () => {
    expect([parseTrustProxy(undefined), parseTrustProxy(''), parseTrustProxy('false'), parseTrustProxy('true'), parseTrustProxy('2')]).toEqual([false, false, false, true, 2]);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.1,fd00::/8')).toEqual(['10.0.0.0/8', '172.16.0.1', 'fd00::/8']);
    for (const bad of ['yes', '10.0.0.0/33', 'caddy', '10.0.0.1/8/8']) expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
  });

  it('接口响应自带基础安全头与 CSP', async () => {
    for (const res of [await get('/api/auth/me'), await app.inject({ method: 'GET', url: '/healthz' }), await app.inject({ method: 'GET', url: '/api/meta' })]) {
      expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    }
  });
});

describe('分页', () => {
  it('审计日志、采集运行、告警记录支持 offset，响应结构不变', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query("INSERT INTO collection_runs (target_id, trigger, status, created_at) VALUES ($1, 'manual', $2, now() - make_interval(mins => $3))", [targetId, i % 2 ? 'failed' : 'success', i]);
      await db.query("INSERT INTO alert_events (kind, dedupe_key, user_id, created_at) VALUES ('usage', $1, $2, now() - make_interval(mins => $3))", [`page:${i}`, zhangsan, i]);
    }
    for (const [url, key] of [['/api/audit', 'logs'], ['/api/collection/runs', 'runs'], ['/api/alerts/events', 'events']] as const) {
      const ids = async (query: string) => ((await get(`${url}?${query}`)).json()[key] as Array<{ id: string }>).map((r) => r.id);
      const all = await ids('limit=5');
      expect(all, url).toHaveLength(5);
      expect(await ids('limit=2&offset=0'), url).toEqual(all.slice(0, 2));
      expect(await ids('limit=2&offset=2'), url).toEqual(all.slice(2, 4));
      expect(await ids('limit=2&offset=99999'), url).toEqual([]);
      for (const bad of ['offset=-1', 'offset=1.5', 'offset=100001', 'offset=abc']) expect((await get(`${url}?${bad}`)).statusCode, `${url}?${bad}`).toBe(400);
    }
  });

  it('采集运行的 status 只接受真实的状态值', async () => {
    const failed = (await get('/api/collection/runs?status=failed')).json().runs as Array<{ status: string }>;
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.status === 'failed')).toBe(true);
    expect((await get('/api/collection/runs?status=skipped_locked')).statusCode).toBe(200);
    expect((await get('/api/collection/runs?status=done')).statusCode).toBe(400);
  });
});

describe('合计值：没有用量是 0，未知才是 null', () => {
  it('区间内没有任何用量行时合计为 0', async () => {
    const idle = await addUser(db, 'idle');
    await addTarget(db, serverId, idle, '/home/idle/.claude');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [idle, await hashPassword(PASSWORD)]);
    const zeros = { todayTokens: 0, todayCost: 0, monthTokens: 0, monthCost: 0 };

    expect((await get('/api/stats/overview', await login('idle@example.com'))).json().totals).toMatchObject({ ...zeros, activeUsersToday: 0, activeUsersMonth: 0 });
    const detail = (await get(`/api/stats/users/${idle}`)).json();
    expect(detail.totals).toEqual(zeros);
    expect(detail.sources).toEqual([expect.objectContaining({ dataDir: '/home/idle/.claude', totalTokens: 0, costUsd: 0, flagged: false })]);
    expect((await get('/api/users')).json().users.find((u: { id: string }) => u.id === idle)).toMatchObject(zeros);
  });

  it('有用量行但数值缺失时保持 null（未知），不冒充 0', async () => {
    const vague = await addUser(db, 'vague');
    const vagueTarget = await addTarget(db, serverId, vague, '/home/vague/.claude');
    await db.query(USAGE_INSERT, [vagueTarget, vague, serverId, today, 'mystery-model', null, null]);
    const unknown = { todayTokens: null, todayCost: null, monthTokens: null, monthCost: null };
    const detail = (await get(`/api/stats/users/${vague}`)).json();
    expect(detail.totals).toEqual(unknown);
    expect(detail.sources[0]).toMatchObject({ totalTokens: null, costUsd: null });
    expect((await get('/api/users')).json().users.find((u: { id: string }) => u.id === vague)).toMatchObject(unknown);

    // 当日排名：只用了 Claude Code 的用户，Codex 一列是 0；全部未知的用户仍是 null
    const busy = await addUser(db, 'busy');
    const busyTarget = await addTarget(db, serverId, busy, '/home/busy/.claude');
    await db.query(USAGE_INSERT, [busyTarget, busy, serverId, today, 'claude-opus-5', 1200, 0.6]);
    const rows = (await get('/api/stats/daily-ranking')).json().rows as Array<{ userId: string }>;
    expect(rows.find((r) => r.userId === busy)).toMatchObject({ claudeTokens: 1200, claudeCost: 0.6, codexTokens: 0, codexCost: 0, totalTokens: 1200 });
    expect(rows.find((r) => r.userId === vague)).toMatchObject({ claudeTokens: null, codexTokens: 0, totalTokens: null });

    const overview = (await get('/api/stats/overview')).json();
    expect(overview).not.toHaveProperty('todayRanking');
    expect(overview.ranking.find((r: { userId: string }) => r.userId === busy)).toMatchObject({ monthTokens: 1200, todayTokens: 1200 });
    // 筛选项里的模型列表：去重、排序，普通用户只看到自己用过的
    expect((await get('/api/stats/filters')).json().models).toEqual(['claude-opus-5', 'mystery-model']);
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [busy, await hashPassword(PASSWORD)]);
    expect((await get('/api/stats/filters', await login('busy@example.com'))).json().models).toEqual(['claude-opus-5']);
  });
});

describe('输入校验', () => {
  it('采集命令只能是 ccusage-collect（裸命令或以它结尾的安全绝对路径）', async () => {
    const base = { host: 'cmd.internal', sshUsername: 'collector', credentialId };
    for (const collectCommand of ['bash', '/bin/sh', '/usr/bin/curl', 'ccusage-collect2', '/opt/ccusage-collect/run', '/opt/../bin/ccusage-collect', 'ccusage-collect --exec', '/ccusage-collect;id']) {
      expect((await send('POST', '/api/servers', { ...base, name: `cmd-${collectCommand}`, collectCommand })).statusCode, collectCommand).toBe(400);
      expect((await send('PATCH', `/api/servers/${serverId}`, { collectCommand })).statusCode, collectCommand).toBe(400);
    }
    expect((await send('POST', '/api/servers', { ...base, name: 'cmd-ok', collectCommand: '/opt/usage/bin/ccusage-collect' })).statusCode).toBe(201);
    expect((await send('PATCH', `/api/servers/${serverId}`, { collectCommand: '/home/u/.local/share/usage-monitor/ccusage-collect' })).statusCode).toBe(200);
    expect((await send('PATCH', `/api/servers/${serverId}`, { collectCommand: 'ccusage-collect' })).statusCode).toBe(200);
    expect(isValidCollectCommand('/ccusage-collect')).toBe(true);
  });

  it('SMTP 服务器地址必须是主机名或 IP', async () => {
    const smtp = { port: 587, secure: false, from: 'bot@example.com' };
    for (const host of ['smtp.example.com; id', 'smtp example.com', '-oProxyCommand=x', 'http://smtp.example.com', '']) {
      expect((await send('PUT', '/api/settings/smtp', { ...smtp, host })).statusCode, host).toBe(400);
    }
    expect((await send('PUT', '/api/settings/smtp', { ...smtp, host: 'smtp.example.com' })).statusCode).toBe(200);
    // 旧版本留下的脏地址：测试发信前拦下
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{host}', '"bad host"') WHERE key = 'smtp'`);
    expect((await send('POST', '/api/settings/smtp/test', { to: 'a@example.com' })).statusCode).toBe(400);
  });

  it('对账范围默认 28 天（Claude Code 只保留约 30 天日志）', async () => {
    expect(DEFAULT_GENERAL.reconcileDays).toBe(28);
  });
});

describe('任务队列不可用', () => {
  it('手动采集返回 503，已创建的运行记为失败而不是永远排队', async () => {
    queues.failWith = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    try {
      const one = await send('POST', `/api/targets/${targetId}/collect`, {});
      expect([one.statusCode, one.json()]).toEqual([503, { error: '任务队列暂时不可用，请稍后重试', code: 'QUEUE_UNAVAILABLE' }]);
      const all = await send('POST', '/api/collection/run-all');
      expect(all.statusCode).toBe(503);
      const stuck = (await db.query("SELECT count(*)::int AS n FROM collection_runs WHERE status = 'queued'")).rows[0].n;
      expect(stuck).toBe(0);
      const failed = (await db.query("SELECT error_code, finished_at FROM collection_runs WHERE error_code = 'QUEUE_UNAVAILABLE'")).rows;
      expect(failed.length).toBeGreaterThanOrEqual(2);
      expect(failed.every((r) => r.finished_at !== null)).toBe(true);
    } finally {
      queues.failWith = null;
    }
    const before = queues.enqueued.length;
    expect((await send('POST', `/api/targets/${targetId}/collect`, {})).statusCode).toBe(202);
    expect(queues.enqueued.length).toBe(before + 1);
  });

  it('修改采集周期：调度登记失败时设置一并回滚', async () => {
    const general = (await get('/api/settings/general')).json();
    queues.failWith = new Error('redis down');
    try {
      expect((await send('PUT', '/api/settings/general', { ...general, collectIntervalHours: 6 })).statusCode).toBe(503);
      expect((await get('/api/settings/general')).json().collectIntervalHours).toBe(general.collectIntervalHours);
      // 不涉及调度的修改不依赖队列
      expect((await send('PUT', '/api/settings/general', { ...general, lookbackDays: 5 })).statusCode).toBe(200);
    } finally {
      queues.failWith = null;
    }
    const syncs = queues.scheduleSyncs;
    expect((await send('PUT', '/api/settings/general', { ...general, collectIntervalHours: 6 })).statusCode).toBe(200);
    expect(queues.scheduleSyncs).toBe(syncs + 1);
    expect((await get('/api/settings/general')).json()).toMatchObject({ collectIntervalHours: 6 });
  });

  it('队列操作一直不返回时，5 秒后超时并返回 503', async () => {
    const hanging = await buildApp({
      db, logger: false, config, executor: fakeExecutor(() => report({})), scanHostKey: async () => '', smtpSenderFactory: async () => null,
      queues: { ...fakeQueues(), enqueueRuns: () => new Promise<void>(() => undefined) },
    });
    const started = Date.now();
    const res = await hanging.inject({ method: 'POST', url: `/api/targets/${targetId}/collect`, headers: { cookie: adminCookie }, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(10_000);
    await hanging.close();
  });
});

describe('审计日志', () => {
  it('重新接入时更换归属用户会留下审计记录', async () => {
    const owner = await addUser(db, 'new-owner');
    await db.query('UPDATE servers SET default_user_id = $2 WHERE id = $1', [serverId, zhangsan]);
    expect((await send('POST', `/api/servers/${serverId}/onboard`, { userId: owner })).statusCode).toBe(200);
    const log = (await get('/api/audit?entityType=server&limit=50')).json().logs.find((l: { action: string }) => l.action === 'server.set_default_user');
    expect(log).toMatchObject({ entityId: serverId, detail: { previousUserId: zhangsan, userId: owner } });
    // 归属用户没变就不重复记录
    await send('POST', `/api/servers/${serverId}/onboard`, { userId: owner });
    expect((await get('/api/audit?entityType=server&limit=50')).json().logs.filter((l: { action: string }) => l.action === 'server.set_default_user')).toHaveLength(1);
  });

  it('审计写入失败不会把已经生效的操作变成 500', async () => {
    await db.query('ALTER TABLE audit_logs RENAME TO audit_logs_broken');
    try {
      const res = await send('POST', '/api/users', { name: '审计故障期间创建' });
      expect(res.statusCode).toBe(201);
      expect((await db.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [res.json().id])).rows[0].n).toBe(1);
    } finally {
      await db.query('ALTER TABLE audit_logs_broken RENAME TO audit_logs');
    }
  });
});

describe('数据库连接池与迁移', () => {
  it('连接池挂了 error 监听器，并带语句超时；迁移结束后连接恢复默认超时', async () => {
    expect(db.listenerCount('error')).toBeGreaterThan(0);
    expect((await db.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('1min');
    const unlimited = createPool(inject('adminDatabaseUrl'), { statementTimeoutMs: 0 });
    expect((await unlimited.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
    await unlimited.end();
  });

  it('010：已有的倒置日期区间被安全修复（停用 + 清结束日期 + 留审计记录），其余目标不受影响', async () => {
    const all = fileURLToPath(new URL('../migrations', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'usage-monitor-mig-'));
    const name = `t_${randomUUID().replaceAll('-', '')}`;
    const adminUrl = inject('adminDatabaseUrl');
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const old = createPool(url.toString());
    try {
      for (const f of readdirSync(all).filter((x) => x < '010')) cpSync(join(all, f), join(dir, f));
      await migrate(old, dir);
      const seeded = await seedBase(old);
      const user = await addUser(old, 'u');
      const server = await addServer(old, 's', seeded.credentialId);
      const inverted = await addTarget(old, server, user, '/home/u/.claude');
      const fine = await addTarget(old, server, user, '/home/u/.codex');
      await old.query("UPDATE collection_targets SET source_start_date = '2026-09-10', source_end_date = '2026-09-01' WHERE id = $1", [inverted]);
      await old.query("UPDATE collection_targets SET source_start_date = '2026-09-01', source_end_date = '2026-09-10' WHERE id = $1", [fine]);

      expect(await migrate(old)).toContain('010_indexes_token_version.sql');
      const rows = (await old.query('SELECT id, source_start_date, source_end_date, enabled FROM collection_targets ORDER BY data_dir')).rows;
      expect(rows).toEqual([
        { id: inverted, source_start_date: '2026-09-10', source_end_date: null, enabled: false },
        { id: fine, source_start_date: '2026-09-01', source_end_date: '2026-09-10', enabled: true },
      ]);
      const logged = (await old.query("SELECT entity_id, detail FROM audit_logs WHERE action = 'migration.fix_source_date_range'")).rows;
      expect(logged).toEqual([{ entity_id: inverted, detail: { sourceStartDate: '2026-09-10', sourceEndDate: '2026-09-01', wasEnabled: true } }]);
      expect((await old.query('SELECT token_version FROM users LIMIT 1')).rows[0].token_version).toBe(0);
    } finally {
      await old.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('接入流程的并发', () => {
  it('同一台服务器被同时接入两次：不会撞唯一约束，目标只创建一份', async () => {
    const fresh = await addServer(db, 'race', credentialId);
    await db.query('UPDATE servers SET default_user_id = $2, host_key_fingerprint = NULL WHERE id = $1', [fresh, zhangsan]);
    const results = await Promise.all([send('POST', `/api/servers/${fresh}/onboard`), send('POST', `/api/servers/${fresh}/onboard`)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await db.query('SELECT count(*)::int AS n FROM collection_targets WHERE server_id = $1', [fresh])).rows[0].n).toBe(2);
  });
});
