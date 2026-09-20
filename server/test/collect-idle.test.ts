import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findIncompleteSources } from '../src/alerts/evaluate.js';
import { bundledCollectorVersion } from '../src/collect/install.js';
import { latestAccountLimits, refreshAccountLimits, resetUpgradeMemo, type LimitsDeps } from '../src/collect/limits.js';
import { createAdhocBatch, ensureSlotBatch } from '../src/collect/scheduler.js';
import { withTx, type Db } from '../src/db/pool.js';
import type { RemoteExecutor } from '../src/ssh/client.js';
import { addServer, addTarget, addUser, at, createTestDb, masterKey, seedBase, silentLog } from './helpers.js';

// 远端没装 / 没在用的数据源：平时不去连，隔一段时间才再探测一次

let db: Db;
let drop: () => Promise<void>;
let zhangsan: string;
let installed: string;
let uninstalled: string;

beforeAll(async () => { ({ db, drop } = await createTestDb()); });
afterAll(() => drop());

beforeEach(async () => {
  await db.query('TRUNCATE users, credentials, servers, collection_batches, settings, account_limit_snapshots, audit_logs CASCADE');
  resetUpgradeMemo();
  const { credentialId } = await seedBase(db);
  zhangsan = await addUser(db, 'zhangsan');
  const server = await addServer(db, 'server-a', credentialId);
  installed = await addTarget(db, server, zhangsan, '/home/zhangsan/.claude');
  uninstalled = await addTarget(db, server, zhangsan, '/home/zhangsan/.codex');
  await db.query("UPDATE collection_targets SET source = 'codex' WHERE id = $1", [uninstalled]);
  await db.query("UPDATE collection_targets SET initialized_at = $1, last_success_at = $1, last_status = 'success'", [at('2026-09-19 00:05')]);
  await db.query("UPDATE collection_targets SET last_error_code = 'NO_DATA_DIR', missing_ok = true WHERE id = $1", [uninstalled]);
});

const targetsOf = async (runIds: string[]) => (await db.query('SELECT target_id FROM collection_runs WHERE id = ANY($1::uuid[])', [runIds])).rows.map((r) => r.target_id as string).sort();

describe('没装该工具的目标', () => {
  it('每天的第一个（对账）批次探测一次，当天其余时点不再采集；手动采集不受影响', async () => {
    const first = (await ensureSlotBatch(db, at('2026-09-19 00:05')))!;
    expect(await targetsOf(first.runIds)).toEqual([installed, uninstalled].sort());

    const later = (await ensureSlotBatch(db, at('2026-09-19 02:05')))!;
    expect(await targetsOf(later.runIds)).toEqual([installed]);

    const manual = await createAdhocBatch(db, 'manual', [uninstalled], null);
    expect(await targetsOf(manual.runIds)).toEqual([uninstalled]);

    const nextDay = (await ensureSlotBatch(db, at('2026-09-20 00:05')))!;
    expect(await targetsOf(nextDay.runIds)).toEqual([installed, uninstalled].sort());
  });

  it('一天只探测一次也不算“数据未按期更新”；探测失败（连不上）仍然算', async () => {
    const now = at('2026-09-19 20:00'); // 距上次成功 20 小时，远超两个采集周期
    const stale = () => withTx(db, (tx) => findIncompleteSources(tx, zhangsan, now, 2));
    expect((await stale()).map((s) => s.dataDir)).toEqual(['/home/zhangsan/.claude']);
    await db.query("UPDATE collection_targets SET last_status = 'failed', last_error_code = 'CONNECT_FAILED' WHERE id = $1", [uninstalled]);
    expect((await stale()).map((s) => s.dataDir)).toEqual(['/home/zhangsan/.claude', '/home/zhangsan/.codex']);
  });
});

describe('账号额度：没在用的不反复查询', () => {
  /** 远端：Claude Code 没登录订阅账号；Codex 登录已过期 */
  function remote() {
    const calls: string[] = [];
    const reply = (body: object) => ({ stdout: JSON.stringify({ schema: 1, collectorVersion: bundledCollectorVersion(), ...body }), stderr: '', exitCode: 0 });
    const executor: RemoteExecutor = {
      async exec(_t, command) {
        calls.push(`${/--(identity|limits) (\S+)/.exec(command)?.slice(1).join(' ')}`);
        if (command.includes('--identity claude-code')) return reply({ status: 'error', code: 'NO_LOGIN', message: '该目录下没有订阅账号的登录信息' });
        if (command.includes('--identity codex')) return reply({ status: 'ok', accountKey: 'acct-codex', accountLabel: 'team@example.com' });
        return reply({ status: 'error', code: 'TOKEN_EXPIRED', message: '服务商返回 401：token_expired' });
      },
    };
    return { executor, calls };
  }
  const deps = (executor: RemoteExecutor, now: Date, force = false): LimitsDeps => ({ db, executor, masterKey, log: silentLog, now: () => now, force });

  it('没登录的目标 6 小时内、登录过期的账号 1 小时内不重复查询；“立即查询”全部重查', async () => {
    await db.query('UPDATE collection_targets SET last_error_code = NULL'); // 两个工具都装了，只是没在用
    const { executor, calls } = remote();
    // account_checked_at / fetched_at 取数据库时钟，这里用真实时间推算
    const t0 = new Date();
    const after = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    await refreshAccountLimits(deps(executor, t0));
    expect(calls.sort()).toEqual(['identity claude-code', 'identity codex', 'limits codex']);

    calls.length = 0;
    await refreshAccountLimits(deps(executor, after(10)));
    expect(calls).toEqual(['identity codex']); // 没登录的不再问；过期账号的额度不再查

    calls.length = 0;
    await refreshAccountLimits(deps(executor, after(70)));
    expect(calls.sort()).toEqual(['identity codex', 'limits codex']); // 过期账号一小时后再试一次

    calls.length = 0;
    await refreshAccountLimits(deps(executor, after(6 * 60 + 5)));
    expect(calls).toContain('identity claude-code'); // 六小时后重新探测是否登录了

    calls.length = 0;
    await refreshAccountLimits(deps(executor, after(6 * 60 + 6), true));
    expect(calls.sort()).toEqual(['identity claude-code', 'identity codex', 'limits codex']);
  });

  it('没登录订阅账号的机器不列入“识别不出账号”', async () => {
    await db.query('UPDATE collection_targets SET last_error_code = NULL');
    await refreshAccountLimits(deps(remote().executor, new Date()));
    const view = await latestAccountLimits(db);
    expect(view.unidentified).toEqual([]);
    expect(view.hidden.map((h) => [h.provider, h.code])).toEqual([['codex', 'TOKEN_EXPIRED']]);
  });
});
