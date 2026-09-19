import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import { inject } from 'vitest';
import { CollectError, type CollectRequest } from '../src/collect/adapter.js';
import { runCollection, type RunnerDeps, type RunOutcome } from '../src/collect/runner.js';
import { createAdhocBatch } from '../src/collect/scheduler.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { seal } from '../src/security/crypto.js';
import type { ExecResult, RemoteExecutor } from '../src/ssh/client.js';

export const masterKey = randomBytes(32);
export const silentLog = pino({ level: 'silent' });
export const TZ = 'Asia/Shanghai';

/** 统计时区（UTC+8，无夏令时）下的本地时间 → Date */
export const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00+08:00`);

export async function createTestDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db);
  return { db, drop: async () => { await db.end(); } };
}

export interface ModelUsage { model: string; input?: number; output?: number; cacheCreate?: number; cacheRead?: number; cost?: number }

/** 生成与 ccusage@20.0.23 `claude daily --json --breakdown` 同结构的报告 */
export function report(days: Record<string, ModelUsage[]>): unknown {
  return {
    daily: Object.entries(days).map(([date, models]) => {
      const breakdowns = models.map((m) => ({
        modelName: m.model, inputTokens: m.input ?? 0, outputTokens: m.output ?? 0,
        cacheCreationTokens: m.cacheCreate ?? 0, cacheReadTokens: m.cacheRead ?? 0, cost: m.cost ?? 0,
      }));
      const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens') => breakdowns.reduce((a, b) => a + b[k], 0);
      return {
        date, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheCreationTokens: sum('cacheCreationTokens'), cacheReadTokens: sum('cacheReadTokens'),
        totalTokens: sum('inputTokens') + sum('outputTokens') + sum('cacheCreationTokens') + sum('cacheReadTokens'),
        totalCost: breakdowns.reduce((a, b) => a + b.cost, 0), modelsUsed: models.map((m) => m.model), modelBreakdowns: breakdowns,
      };
    }),
  };
}

export function parseCommand(command: string): CollectRequest {
  const parts = command.split(' ');
  const arg = (name: string) => parts[parts.indexOf(`--${name}`) + 1]!;
  const dash = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return { source: arg('source'), dir: arg('dir'), since: dash(arg('since')), until: dash(arg('until')), timezone: arg('timezone') };
}

export type FakeRemote = (req: CollectRequest & { host: string }) => unknown | Promise<unknown>;

/** 假的远程执行器：handler 返回 ccusage 报告，或抛出 CollectError 模拟 SSH/远端故障。只返回请求范围内的日期，与真实 ccusage 一致。 */
export function fakeExecutor(handler: FakeRemote): RemoteExecutor & { calls: Array<CollectRequest & { host: string }> } {
  const calls: Array<CollectRequest & { host: string }> = [];
  return {
    calls,
    async exec(target, command): Promise<ExecResult> {
      const req = { ...parseCommand(command), host: target.host };
      calls.push(req);
      const rep = (await handler(req)) as { daily: Array<{ date: string }> };
      const daily = rep.daily.filter((d) => d.date >= req.since && d.date <= req.until);
      const envelope = { schema: 1, status: 'ok', collectorVersion: '1.0.0', ccusageVersion: '20.0.23', costMode: 'auto', offline: true, logFiles: daily.length, ...req, host: undefined, report: { daily } };
      return { stdout: JSON.stringify(envelope), stderr: '', exitCode: 0 };
    },
  };
}

export const remoteError = (code: string, message = code, retryable = false) => new CollectError(code, message, retryable);

export interface Seeded { adminId: string; credentialId: string }

export async function seedBase(db: Db): Promise<Seeded> {
  const adminId = (await db.query("INSERT INTO users (name, email, role) VALUES ('管理员', 'admin@example.com', 'admin') RETURNING id")).rows[0].id;
  const credentialId = randomUUID();
  const sealed = seal(masterKey, JSON.stringify({ privateKey: 'test-key' }), `credential:${credentialId}`);
  await db.query(
    "INSERT INTO credentials (id, name, ciphertext, iv, auth_tag, public_fingerprint, key_type) VALUES ($1, 'collector', $2, $3, $4, 'SHA256:test', 'ssh-ed25519')",
    [credentialId, sealed.ciphertext, sealed.iv, sealed.authTag],
  );
  return { adminId, credentialId };
}

export async function addUser(db: Db, name: string, opts: { team?: string; budget?: number; role?: string } = {}): Promise<string> {
  return (await db.query(
    'INSERT INTO users (name, email, role, team, monthly_budget_usd) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, `${name}@example.com`, opts.role ?? 'user', opts.team ?? null, opts.budget ?? null],
  )).rows[0].id;
}

export async function addServer(db: Db, name: string, credentialId: string): Promise<string> {
  return (await db.query(
    "INSERT INTO servers (name, host, ssh_username, credential_id, host_key_fingerprint) VALUES ($1, $2, 'collector', $3, 'SHA256:host') RETURNING id",
    [name, `${name}.internal`, credentialId],
  )).rows[0].id;
}

export async function addTarget(db: Db, serverId: string, userId: string, dataDir: string): Promise<string> {
  const id = (await db.query('INSERT INTO collection_targets (server_id, user_id, data_dir) VALUES ($1, $2, $3) RETURNING id', [serverId, userId, dataDir])).rows[0].id;
  await db.query("INSERT INTO target_user_bindings (target_id, user_id, effective_from) VALUES ($1, $2, '1970-01-01')", [id, userId]);
  return id;
}

export interface RuleInput { name?: string; metric: 'tokens' | 'cost' | 'budget_pct'; period: 'daily' | 'monthly'; tiers: number[]; notifyAdmins?: boolean; createdAt?: string }

export async function addRule(db: Db, r: RuleInput): Promise<string> {
  return (await db.query(
    'INSERT INTO alert_rules (name, metric, period, tiers, notify_admins, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [r.name ?? `${r.metric}-${r.period}`, r.metric, r.period, r.tiers, r.notifyAdmins ?? true, r.createdAt ?? '2020-01-01T00:00:00Z'],
  )).rows[0].id;
}

export function runnerDeps(db: Db, executor: RemoteExecutor, now: Date): RunnerDeps {
  return { db, executor, masterKey, baseUrl: 'https://usage.example.com', sshTimeoutMs: 5000, log: silentLog, now: () => now };
}

/** 为目标创建一次手动运行并立即执行（相当于队列 Worker 处理一个任务） */
export async function collect(db: Db, executor: RemoteExecutor, targetId: string, now: Date, opts: { finalAttempt?: boolean; acceptDecrease?: boolean } = {}): Promise<RunOutcome> {
  const batch = await createAdhocBatch(db, 'manual', [targetId], null);
  return runCollection(runnerDeps(db, executor, now), batch.runIds[0]!, { finalAttempt: opts.finalAttempt ?? true, acceptDecrease: opts.acceptDecrease });
}

export async function userTotals(db: Db, userId: string, from: string, to: string): Promise<{ tokens: number; cost: number }> {
  const r = (await db.query(
    'SELECT COALESCE(sum(total_tokens), 0) AS tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost FROM usage_daily WHERE user_id = $1 AND usage_date BETWEEN $2 AND $3',
    [userId, from, to],
  )).rows[0];
  return { tokens: Number(r.tokens), cost: r.cost };
}

export const events = async (db: Db) => (await db.query('SELECT kind, period_key, tier::float8 AS tier, incomplete, email_note FROM alert_events ORDER BY created_at, tier')).rows;
export const outbox = async (db: Db) => (await db.query('SELECT to_addrs, subject, body_text, status, attempts FROM email_outbox ORDER BY created_at')).rows;
