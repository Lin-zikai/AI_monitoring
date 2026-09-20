import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import type { Db } from '../src/db/pool.js';
import { hashPassword } from '../src/security/password.js';
import { addDays } from '../src/util/time.js';
import { addServer, addTarget, addUser, createTestDb, fakeExecutor, fakeQueues, masterKey, report, seedBase } from './helpers.js';

// 仪表盘的“按数据源 × 模型”趋势，以及用量明细里每行“用量最多的 3 个用户”

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let adminCookie: string;
let userCookie: string;
let today: string;
const users: Record<string, string> = {};
const PASSWORD = 'a-long-password-1';

const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })).headers['set-cookie']).split(';')[0]!;
const get = (url: string, cookie = adminCookie) => app.inject({ method: 'GET', url, headers: { cookie } });

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  const { credentialId } = await seedBase(db);
  const server = await addServer(db, 'server-a', credentialId);
  app = await buildApp({
    db, logger: false, queues: fakeQueues(), executor: fakeExecutor(() => report({})),
    config: { jwtSecret: 'x'.repeat(40), cookieSecure: false, masterKey, masterKeyVersion: 1, publicBaseUrl: 'https://usage.example.com', webDist: undefined, sshTimeoutMs: 5000 },
    scanHostKey: async () => `SHA256:${'A'.repeat(43)}`, smtpSenderFactory: async () => null,
  });
  for (const name of ['anna', 'bob', 'cindy', 'dave']) users[name] = await addUser(db, name);
  await db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
  adminCookie = await login('admin@example.com');
  userCookie = await login('anna@example.com');
  today = (await get('/api/meta')).json().today;

  const insert = `INSERT INTO usage_daily (target_id, user_id, server_id, source, usage_date, model, total_tokens, cost_usd, timezone, parser_version, collected_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Asia/Shanghai', 't', now())`;
  const targets: Record<string, { claude: string; codex: string }> = {};
  for (const [name, id] of Object.entries(users)) {
    const claude = await addTarget(db, server, id, `/home/${name}/.claude`);
    const codex = await addTarget(db, server, id, `/home/${name}/.codex`);
    await db.query("UPDATE collection_targets SET source = 'codex' WHERE id = $1", [codex]);
    targets[name] = { claude, codex };
  }
  const add = (name: string, source: 'claude' | 'codex', daysAgo: number, model: string, tokens: number) =>
    db.query(insert, [targets[name]![source], users[name], server, source === 'claude' ? 'claude-code' : 'codex', addDays(today, -daysAgo), model, tokens]);
  // 今天：anna 最多；近 7 天：dave 靠前几天的大用量排第一；9 天前的用量不计入今天的“近 7 天”
  await add('anna', 'claude', 0, 'claude-opus-5', 500);
  await add('bob', 'claude', 0, 'claude-opus-5', 300);
  await add('cindy', 'codex', 0, 'gpt-6-astra', 200);
  await add('dave', 'codex', 0, 'gpt-6-astra', 100);
  await add('dave', 'claude', 3, 'claude-fable-5-1', 5000);
  await add('bob', 'codex', 6, 'gpt-5.6-terra', 1000);
  await add('cindy', 'claude', 9, 'claude-opus-5', 9000);
});

afterAll(async () => {
  await app.close();
  await drop();
});

describe('GET /stats/model-trend', () => {
  it('默认近 7 天，按数据源 × 模型给出每天的用量；offset 往前翻一周；30 / 90 天忽略 offset', async () => {
    const week = (await get('/api/stats/model-trend')).json();
    expect(week).toMatchObject({ from: addDays(today, -6), to: today, today, earliest: addDays(today, -9), days: 7, offset: 0 });
    expect(week.rows.map((r: { date: string; source: string; model: string; totalTokens: number }) => [r.date, r.source, r.model, r.totalTokens])).toEqual([
      [addDays(today, -6), 'codex', 'gpt-5.6-terra', 1000],
      [addDays(today, -3), 'claude-code', 'claude-fable-5-1', 5000],
      [today, 'claude-code', 'claude-opus-5', 800],
      [today, 'codex', 'gpt-6-astra', 300],
    ]);

    const previous = (await get('/api/stats/model-trend?days=7&offset=1')).json();
    expect(previous).toMatchObject({ from: addDays(today, -13), to: addDays(today, -7), offset: 1 });
    expect(previous.rows).toEqual([expect.objectContaining({ date: addDays(today, -9), model: 'claude-opus-5', totalTokens: 9000 })]);

    expect((await get('/api/stats/model-trend?days=30&offset=3')).json()).toMatchObject({ from: addDays(today, -29), to: today, offset: 0 });
    expect((await get('/api/stats/model-trend?days=14')).statusCode).toBe(400);
  });

  it('普通用户只看到自己的用量', async () => {
    const mine = (await get('/api/stats/model-trend', userCookie)).json();
    expect(mine.rows).toEqual([expect.objectContaining({ date: today, source: 'claude-code', totalTokens: 500 })]);
    expect(mine.earliest).toBe(today);
  });

  it('总览接口不再返回趋势', async () => {
    expect((await get('/api/stats/overview')).json()).not.toHaveProperty('trend');
  });
});

describe('GET /stats/usage 的用量最多用户', () => {
  const names = (list: Array<{ name: string; tokens: number }>) => list.map((l) => [l.name, l.tokens]);

  it('按日期分组：每行给出当天与截至当天 7 天内用量最多的 3 人', async () => {
    const res = (await get(`/api/stats/usage?from=${addDays(today, -3)}&to=${today}&groupBy=date`)).json();
    expect(res.leaders).toBe(true);
    const row = (date: string) => res.rows.find((r: { key0: string }) => r.key0 === date);
    expect(names(row(today).top1)).toEqual([['anna', 500], ['bob', 300], ['cindy', 200]]);
    expect(names(row(today).top7)).toEqual([['dave', 5100], ['bob', 1300], ['anna', 500]]); // cindy 9 天前的 9000 不在窗口内
    // 3 天前那一行：7 天窗口往前伸到范围之外，能看到 cindy 9 天前的用量
    expect(names(row(addDays(today, -3)).top1)).toEqual([['dave', 5000]]);
    expect(names(row(addDays(today, -3)).top7)).toEqual([['cindy', 9000], ['dave', 5000], ['bob', 1000]]);
  });

  it('再按数据源细分：每个数据源各自排名；不按日期分组时以范围末尾为准', async () => {
    const bySource = (await get(`/api/stats/usage?from=${today}&to=${today}&groupBy=date,source`)).json();
    const codex = bySource.rows.find((r: { key1: string }) => r.key1 === 'codex');
    expect(names(codex.top1)).toEqual([['cindy', 200], ['dave', 100]]);
    expect(names(codex.top7)).toEqual([['bob', 1000], ['cindy', 200], ['dave', 100]]);

    const noDate = (await get(`/api/stats/usage?from=${addDays(today, -29)}&to=${today}&groupBy=source`)).json();
    const claude = noDate.rows.find((r: { key0: string }) => r.key0 === 'claude-code');
    expect(names(claude.top1)).toEqual([['anna', 500], ['bob', 300]]);
    expect(names(claude.top7)).toEqual([['dave', 5000], ['anna', 500], ['bob', 300]]);
  });

  it('按用户分组、限定单个用户、普通用户：不附带排名', async () => {
    expect((await get('/api/stats/usage?groupBy=user')).json()).toMatchObject({ leaders: false });
    expect((await get(`/api/stats/usage?groupBy=date&userId=${users.bob}`)).json().leaders).toBe(false);
    const mine = (await get('/api/stats/usage?groupBy=date', userCookie)).json();
    expect(mine.leaders).toBe(false);
    expect(mine.rows[0]).not.toHaveProperty('top7');
  });
});
