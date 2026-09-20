import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { periodsToEvaluate } from '../src/alerts/evaluate.js';
import { budgetPercent, renderLimitAlert, renderUsageAlert } from '../src/alerts/templates.js';
import { CollectError } from '../src/collect/adapter.js';
import { bundledCollectorVersion, installCollector } from '../src/collect/install.js';
import { cleanAccountLabel, evaluateLimitAlerts, latestAccountLimits, normalizeWindows, pickMembers, refreshAccountLimits, resetUpgradeMemo, sameLimitCycle, type LimitsDeps } from '../src/collect/limits.js';
import { recoverLostRuns, type QueueJobLike, type RunQueue } from '../src/collect/recovery.js';
import { computeRange, runCollection } from '../src/collect/runner.js';
import { createAdhocBatch } from '../src/collect/scheduler.js';
import type { Db } from '../src/db/pool.js';
import { processOutbox } from '../src/mail/outbox.js';
import { DEFAULT_GENERAL } from '../src/settings.js';
import type { ExecResult, RemoteExecutor } from '../src/ssh/client.js';
import { SKIPPED, createExclusive } from '../src/util/exclusive.js';
import { addDays, isoWeekKey } from '../src/util/time.js';
import { addRule, addServer, addTarget, addUser, at, collect, createTestDb, events, fakeExecutor, masterKey, outbox, report, runnerDeps, seedBase, silentLog, userTotals } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;
let credentialId: string;
let zhangsan: string;
let serverA: string;
let serverB: string;
let targetA: string;
let targetB: string;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
});
afterAll(() => drop());

beforeEach(async () => {
  await db.query('TRUNCATE users, credentials, servers, collection_batches, alert_rules, alert_events, email_outbox, settings, account_limit_snapshots, audit_logs CASCADE');
  resetUpgradeMemo();
  ({ credentialId } = await seedBase(db));
  zhangsan = await addUser(db, 'zhangsan', { budget: 500 });
  serverA = await addServer(db, 'server-a', credentialId);
  serverB = await addServer(db, 'server-b', credentialId);
  targetA = await addTarget(db, serverA, zhangsan, '/home/zhangsan/.claude');
  targetB = await addTarget(db, serverB, zhangsan, '/home/developer/.claude');
});

const NOW = at('2026-09-19 14:00');
/** helpers 的 addRule 只设了 created_at；updated_at 默认是真实的当前时间，这里对齐成“规则建好后没再改过” */
const addOldRule = async (r: Parameters<typeof addRule>[1]) => { const id = await addRule(db, r); await db.query('UPDATE alert_rules SET updated_at = created_at WHERE id = $1', [id]); return id; };
const opus = (tokens: number, cost: number) => ({ model: 'claude-opus-5', input: tokens, cost });
const limitsDeps = (executor: RemoteExecutor, extra: Partial<LimitsDeps> = {}): LimitsDeps => ({ db, executor, masterKey, log: silentLog, baseUrl: 'https://usage.example.com', ...extra });
const reply = (body: object, collectorVersion = bundledCollectorVersion()): ExecResult => ({ stdout: JSON.stringify({ schema: 1, collectorVersion, ...body }), stderr: '', exitCode: 0 });
const markHealthy = () => db.query("UPDATE collection_targets SET last_status = 'success', last_success_at = now(), initialized_at = now()");

describe('采集脚本自动升级（H1）', () => {
  const MANAGED = '/home/collector/.local/share/usage-monitor/ccusage-collect';

  /** 远端：identity 回报脚本版本；`sh -s` 是安装脚本（记录它用的 MODE），装完后版本变成随附版本 */
  function remote(opts: { installFails?: boolean; newCommand?: string } = {}) {
    const installs: Array<{ host: string; mode: string }> = [];
    const upgradedHosts = new Set<string>();
    const commands: string[] = [];
    const executor: RemoteExecutor = {
      async exec(t, command, _timeout, stdin) {
        if (command === 'sh -s') {
          installs.push({ host: t.host, mode: /^MODE=(\w+)$/m.exec(stdin ?? '')?.[1] ?? '?' });
          if (opts.installFails) return { stdout: '', stderr: '[install] Node.js 下载失败', exitCode: 22 };
          upgradedHosts.add(t.host);
          return { stdout: `RESULT ${opts.newCommand ?? MANAGED} v20.18.1 20.0.23 /home/collector installed /x/ccusage\n`, stderr: '', exitCode: 0 };
        }
        commands.push(`${t.host} ${command}`);
        return reply({ status: 'ok', accountKey: 'acct-1', accountLabel: 'team@example.com', ...(command.includes('--limits') ? { windows: [] } : {}) }, upgradedHosts.has(t.host) ? bundledCollectorVersion() : '1.0.0');
      },
    };
    return { executor, installs, commands };
  }

  it('沿用服务器登记的安装方式；新的采集命令写回数据库并记审计；同一版本不会反复重装', async () => {
    await markHealthy();
    const moved = '/data/home/collector/.local/share/usage-monitor/ccusage-collect';
    await db.query("UPDATE servers SET collect_command = $2, install_mode = 'pinned' WHERE id = $1", [serverA, MANAGED]);
    await db.query('UPDATE servers SET enabled = false WHERE id = $1', [serverB]);
    const r = remote({ newCommand: moved });

    await refreshAccountLimits(limitsDeps(r.executor));
    expect(r.installs).toEqual([{ host: 'server-a.internal', mode: 'pinned' }]); // 不是默认的 latest
    expect((await db.query('SELECT collect_command, install_mode FROM servers WHERE id = $1', [serverA])).rows[0]).toEqual({ collect_command: moved, install_mode: 'pinned' });
    expect(r.commands.at(-1)).toContain(`${moved} --limits`); // 本轮后续查询已改用新命令
    const audits = (await db.query("SELECT actor_user_id, actor_email, action, entity_id, detail FROM audit_logs WHERE action LIKE 'server.auto_upgrade%'")).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: null, actor_email: 'system', action: 'server.auto_upgrade_collector', entity_id: serverA, detail: { installMode: 'pinned', collectCommand: moved, previousCollectCommand: MANAGED } });

    await refreshAccountLimits(limitsDeps(r.executor));
    expect(r.installs).toHaveLength(1);
  });

  it('手工部署的采集命令（非平台安装）版本再旧也不去重装', async () => {
    await markHealthy(); // 两台服务器都是默认的 ccusage-collect（forced command 方式）
    const r = remote();
    await refreshAccountLimits(limitsDeps(r.executor));
    await refreshAccountLimits(limitsDeps(r.executor));
    expect(r.installs).toEqual([]);
    expect((await db.query('SELECT DISTINCT collect_command FROM servers')).rows).toEqual([{ collect_command: 'ccusage-collect' }]);
    expect((await latestAccountLimits(db)).limits.map((l) => l.accountLabel)).toEqual(['team@example.com']); // 旧版本照常使用
  });

  it('升级失败后几小时内不再重试（不会每 10 分钟重装一次），失败也记审计', async () => {
    await markHealthy();
    await db.query('UPDATE servers SET collect_command = $1', [MANAGED]);
    const r = remote({ installFails: true });
    for (let i = 0; i < 3; i++) await refreshAccountLimits(limitsDeps(r.executor));
    expect(r.installs.map((i) => i.host).sort()).toEqual(['server-a.internal', 'server-b.internal']); // 每台只试一次，方式为默认的 latest
    expect(r.installs.every((i) => i.mode === 'latest')).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'server.auto_upgrade_collector_failed'")).rows[0].n).toBe(2);
    expect((await db.query('SELECT DISTINCT collect_command FROM servers')).rows).toEqual([{ collect_command: MANAGED }]);
  });

  it('目标用的不是服务器登记的 SSH 账户时不升级（装到别人的家目录会改掉整台服务器的采集命令）', async () => {
    await markHealthy();
    await db.query('UPDATE servers SET collect_command = $1', [MANAGED]);
    await db.query("UPDATE collection_targets SET ssh_username = 'someone-else'");
    const r = remote();
    await refreshAccountLimits(limitsDeps(r.executor));
    expect(r.installs).toEqual([]);
  });

  it('安装结果里的家目录不合法时拒绝（S1）', async () => {
    const executor: RemoteExecutor = { exec: async () => ({ stdout: `RESULT ${MANAGED} v20.18.1 20.0.23 /home/u;reboot installed /x\n`, stderr: '', exitCode: 0 }) };
    await expect(installCollector(executor, { host: 'h', port: 22, username: 'u', privateKey: 'k', expectedHostFingerprint: 'SHA256:x' })).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
  });
});

describe('采集范围（M1 / M2）', () => {
  it('“接受减少”的手动采集覆盖到对账范围，能清掉 3 天回看范围之外的待确认日期', async () => {
    const base = { initialized_at: NOW, last_success_at: NOW, reconcile: false, source_start_date: null, source_end_date: null };
    expect(computeRange(base, DEFAULT_GENERAL, NOW)).toEqual({ since: '2026-09-16', until: '2026-09-19' });
    expect(computeRange(base, DEFAULT_GENERAL, NOW, { acceptDecrease: true })).toEqual({ since: addDays('2026-09-19', -DEFAULT_GENERAL.reconcileDays), until: '2026-09-19' });
    expect(computeRange(base, { ...DEFAULT_GENERAL, reconcileDays: 10 }, NOW, { acceptDecrease: true, flaggedFrom: '2026-09-01' })).toEqual({ since: '2026-09-01', until: '2026-09-19' });

    await collect(db, fakeExecutor(() => report({ '2026-09-05': [opus(1000, 1)], '2026-09-19': [opus(10, 0.1)] })), targetA, NOW);
    await db.query("UPDATE usage_daily SET integrity = 'decrease_flagged' WHERE usage_date = '2026-09-05'"); // 每日对账标出来的
    const shrunk = fakeExecutor(() => report({ '2026-09-05': [opus(400, 0.4)], '2026-09-19': [opus(10, 0.1)] }));

    await collect(db, shrunk, targetA, NOW); // 普通手动采集：范围到不了 09-05
    expect(shrunk.calls.at(-1)!.since).toBe('2026-09-16');
    expect((await db.query("SELECT integrity FROM usage_daily WHERE usage_date = '2026-09-05'")).rows[0].integrity).toBe('decrease_flagged');

    await collect(db, shrunk, targetA, NOW, { acceptDecrease: true });
    expect(shrunk.calls.at(-1)!.since <= '2026-09-05').toBe(true);
    expect((await db.query("SELECT total_tokens, integrity FROM usage_daily WHERE usage_date = '2026-09-05'")).rows).toEqual([{ total_tokens: 400, integrity: 'complete' }]);
  });

  it('统计时区变更后整段重新分桶：变小的日期直接替换、并入邻日的旧日期删除，总量不重复也不被标成“数据减少”，也不补发历史告警', async () => {
    await addOldRule({ metric: 'tokens', period: 'daily', tiers: [1200] });
    await collect(db, fakeExecutor(() => report({ '2026-09-10': [opus(100, 0.1)], '2026-09-17': [opus(1000, 1)], '2026-09-18': [opus(500, 0.5)] })), targetA, NOW);
    expect(await userTotals(db, zhangsan, '2026-09-01', '2026-09-30')).toMatchObject({ tokens: 1600 });

    await db.query("INSERT INTO settings (key, value) VALUES ('general', $1)", [JSON.stringify({ timezone: 'UTC' })]);
    // 同样的用量按 UTC 分桶：09-10 的那一点并进了 09-09，09-18 的一部分挪到了 09-17
    const utc = fakeExecutor(() => report({ '2026-09-09': [opus(100, 0.1)], '2026-09-17': [opus(1300, 1.3)], '2026-09-18': [opus(200, 0.2)] }));
    const outcome = await collect(db, utc, targetA, NOW);
    expect(outcome.status).toBe('success');
    expect(utc.calls[0]).toMatchObject({ since: '2026-09-09', timezone: 'UTC' }); // 一次覆盖到最早的旧时区日期（再往前一天）

    const rows = (await db.query("SELECT usage_date::text AS d, total_tokens, timezone, integrity FROM usage_daily ORDER BY usage_date")).rows;
    expect(rows).toEqual([
      { d: '2026-09-09', total_tokens: 100, timezone: 'UTC', integrity: 'complete' },
      { d: '2026-09-17', total_tokens: 1300, timezone: 'UTC', integrity: 'complete' },
      { d: '2026-09-18', total_tokens: 200, timezone: 'UTC', integrity: 'complete' },
    ]);
    expect((await db.query('SELECT anomalies FROM collection_runs ORDER BY created_at DESC LIMIT 1')).rows[0].anomalies).toEqual([]);
    expect(await events(db)).toEqual([]); // 09-17 重新分桶后超过了 1200，但那只是换了归属日

    // 之后的常规采集回到正常范围
    await collect(db, utc, targetA, NOW);
    expect(utc.calls.at(-1)!.since).toBe('2026-09-16');
  });

  it('时区变更的同时远端日志也被清理过（总量变少）：消失的旧日期按“日期缺失”保留并标记，不直接删', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-17': [opus(1000, 1)], '2026-09-18': [opus(500, 0.5)] })), targetA, NOW);
    await db.query("INSERT INTO settings (key, value) VALUES ('general', $1)", [JSON.stringify({ timezone: 'UTC' })]);
    await collect(db, fakeExecutor(() => report({ '2026-09-18': [opus(200, 0.2)] })), targetA, NOW);
    const rows = (await db.query("SELECT usage_date::text AS d, total_tokens, integrity FROM usage_daily ORDER BY usage_date")).rows;
    expect(rows).toEqual([{ d: '2026-09-17', total_tokens: 1000, integrity: 'retained' }, { d: '2026-09-18', total_tokens: 200, integrity: 'complete' }]);
  });
});

describe('补采后的告警评估（M5 / L7）', () => {
  it('停机多天后的补采：缺口里每个超限的日子都评估；已提醒过的不重发；邮件写明是哪一天', async () => {
    await addOldRule({ metric: 'cost', period: 'daily', tiers: [50] });
    await collect(db, fakeExecutor(() => report({ '2026-09-14': [opus(1, 10)] })), targetA, at('2026-09-14 22:00'));
    const gap = fakeExecutor(() => report({ '2026-09-14': [opus(1, 10)], '2026-09-15': [opus(1, 80)], '2026-09-16': [opus(1, 20)], '2026-09-17': [opus(1, 90)], '2026-09-19': [opus(1, 5)] }));
    await collect(db, gap, targetA, NOW);
    expect((await events(db)).map((e) => e.period_key)).toEqual(['2026-09-15', '2026-09-17']);
    const subjects = (await outbox(db)).map((m) => m.subject);
    expect(subjects[0]).toBe('[用量提醒] zhangsan 2026-09-15 估算费用 US$ 80.00，已超过 US$ 50.00');
    expect((await outbox(db))[0].body_text).toContain('统计周期：2026-09-15（已结束）');

    await collect(db, gap, targetA, at('2026-09-19 16:00')); // 数据没变：不重复评估，更不会重发
    expect(await events(db)).toHaveLength(2);
  });

  it('补评估只看这次数据有增长的日期；周期结束后才改过的规则不回头补发；首次回填仍然不集中补发', async () => {
    expect(periodsToEvaluate('2026-09-19', '2026-09-10', true, ['2026-09-12', '2026-09-18', '2026-08-01']).map((p) => p.key))
      .toEqual(['2026-09-19', '2026-09', '2026-09-18', '2026-09-12']);
    expect(periodsToEvaluate('2026-09-19', '2026-06-01', true, ['2026-06-20', '2026-08-31']).map((p) => p.key))
      .toEqual(['2026-09-19', '2026-09', '2026-09-18', '2026-08', '2026-08-31']); // 超过 35 天的不再评估
    expect(periodsToEvaluate('2026-10-02', '2026-08-30', true, ['2026-08-30']).map((p) => p.key))
      .toEqual(['2026-10-02', '2026-10', '2026-10-01', '2026-09', '2026-08-30', '2026-08']);
    expect(periodsToEvaluate('2026-09-19', '2026-06-01', false, ['2026-09-12']).map((p) => p.key)).toEqual(['2026-09-19', '2026-09']);

    const ruleId = await addOldRule({ metric: 'cost', period: 'daily', tiers: [50] });
    await collect(db, fakeExecutor(() => report({ '2026-09-12': [opus(1, 80)], '2026-09-14': [opus(1, 10)] })), targetA, at('2026-09-14 22:00'));
    expect(await events(db)).toEqual([]); // 首次回填：09-12 虽然超限也不补发
    await db.query("UPDATE alert_rules SET tiers = '{15}', updated_at = '2026-09-18T00:00:00Z' WHERE id = $1", [ruleId]);
    await collect(db, fakeExecutor(() => report({ '2026-09-14': [opus(1, 10)], '2026-09-16': [opus(1, 20)], '2026-09-19': [opus(1, 5)] })), targetA, NOW);
    expect(await events(db)).toEqual([]); // 09-16 超过了新阈值 15，但阈值是 09-18 才调低的
  });

  it('邮件文案：已结束的月份写明年月；百分比用定点运算，不因浮点误差少 1', () => {
    expect(Math.floor((1.15 / 1) * 100)).toBe(114); // 旧算法的问题
    expect(budgetPercent('1.15', '1')).toBe(115);
    expect(budgetPercent('420.000000', '500')).toBe(84);
    expect(budgetPercent('10', '0')).toBe(0);
    const mail = renderUsageAlert({
      userId: 'u', userName: 'zhangsan', ruleName: 'r', metric: 'budget_pct', periodType: 'monthly', periodKey: '2026-08', periodEnded: true, tier: '100.000000',
      observed: '1.15', threshold: '1', budget: '1', dataAsOf: NOW, timezone: 'Asia/Shanghai', intervalHours: 2, incomplete: [], baseUrl: 'https://x',
    });
    expect(mail.subject).toBe('[用量提醒] zhangsan 2026 年 8 月预算已达到 100%');
    expect(mail.text).toContain('2026 年 8 月估算费用：US$ 1.15');
    expect(mail.text).toContain('预算使用率：115%');
    expect(mail.text).not.toContain('本月');
    const cost = renderUsageAlert({
      userId: 'u', userName: 'zhangsan', ruleName: 'r', metric: 'cost', periodType: 'daily', periodKey: '2026-09-19', tier: '0.1', observed: '0.300000', threshold: '0.100000',
      budget: null, dataAsOf: NOW, timezone: 'Asia/Shanghai', intervalHours: 2, incomplete: [], baseUrl: 'https://x',
    });
    expect(cost.subject).toContain('zhangsan 当日估算费用');
    expect(cost.text).toContain('超出：US$ 0.20');
  });

  it('同一用户在两台服务器上同时入库：合计超限不会因为互相看不到对方未提交的数据而漏掉（L4）', async () => {
    await addOldRule({ metric: 'tokens', period: 'daily', tiers: [1500] });
    for (let round = 0; round < 3; round++) {
      await db.query('TRUNCATE alert_events, usage_daily CASCADE');
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let waiting = 0;
      const exec = fakeExecutor(async () => { if (++waiting === 2) release(); await barrier; return report({ '2026-09-19': [opus(1000, 1)] }); });
      const outcomes = await Promise.all([collect(db, exec, targetA, NOW), collect(db, exec, targetB, NOW)]);
      expect(outcomes.map((o) => o.status)).toEqual(['success', 'success']);
      expect((await events(db)).map((e) => e.period_key)).toEqual(['2026-09-19']);
    }
  });
});

describe('运行状态（L2 / L6）', () => {
  it('同一运行被重复投递：另一份已经提交 success 后，迟到的这份不会把它改成 stale 或 failed', async () => {
    const batch = await createAdhocBatch(db, 'manual', [targetA], null);
    const runId = batch.runIds[0]!;
    const finishElsewhere = async () => {
      await db.query("UPDATE collection_runs SET status = 'success', finished_at = now(), rows_written = 7 WHERE id = $1", [runId]);
      await db.query('UPDATE collection_targets SET lock_run_id = NULL, lock_expires_at = NULL WHERE id = $1', [targetA]);
    };
    const exec = fakeExecutor(async () => { await finishElsewhere(); return report({ '2026-09-19': [opus(1, 1)] }); });
    expect((await runCollection(runnerDeps(db, exec, NOW), runId, { finalAttempt: true })).status).toBe('stale');
    expect((await db.query('SELECT status, rows_written FROM collection_runs WHERE id = $1', [runId])).rows[0]).toEqual({ status: 'success', rows_written: 7 });

    // 迟到的那份是失败的：同样不覆盖，也不计入连续失败
    const batch2 = await createAdhocBatch(db, 'manual', [targetA], null);
    const run2 = batch2.runIds[0]!;
    const failing = fakeExecutor(async () => {
      await db.query("UPDATE collection_runs SET status = 'success', finished_at = now() WHERE id = $1", [run2]);
      throw new CollectError('SSH_TIMEOUT', '超时', true);
    });
    await runCollection(runnerDeps(db, failing, NOW), run2, { finalAttempt: true });
    expect((await db.query('SELECT status FROM collection_runs WHERE id = $1', [run2])).rows[0].status).toBe('success');
    expect((await db.query('SELECT consecutive_failures FROM collection_targets WHERE id = $1', [targetA])).rows[0].consecutive_failures).toBe(0);
  });

  it('回收丢失的运行：按队列里的任务状态决定重新入队、记为失败或不动', async () => {
    const mk = async (targetId: string) => (await createAdhocBatch(db, 'manual', [targetId], null)).runIds[0]!;
    const targetC = await addTarget(db, await addServer(db, 'server-c', credentialId), zhangsan, '/home/c/.claude');
    const targetD = await addTarget(db, await addServer(db, 'server-d', credentialId), zhangsan, '/home/d/.claude');
    const targetE = await addTarget(db, await addServer(db, 'server-e', credentialId), zhangsan, '/home/e/.claude');
    const [neverEnqueued, blockedByFailedJob, waitingRetry, exhausted, fresh, stuckRunning] = [await mk(targetA), await mk(targetB), await mk(targetC), await mk(targetD), await mk(targetA), await mk(targetE)];
    const old = at('2026-09-19 13:00');
    await db.query('UPDATE collection_runs SET created_at = $1 WHERE id <> $2', [old, fresh]);
    await db.query('UPDATE collection_runs SET created_at = $1 WHERE id = $2', [NOW, fresh]);
    await db.query('UPDATE collection_runs SET attempt = 1 WHERE id = ANY($1)', [[blockedByFailedJob, waitingRetry]]);
    await db.query('UPDATE collection_runs SET attempt = 3 WHERE id = $1', [exhausted]);
    await db.query("UPDATE collection_runs SET status = 'running', attempt = 3, started_at = $2 WHERE id = $1", [stuckRunning, old]);
    await db.query('UPDATE collection_targets SET lock_run_id = $1, lock_expires_at = $2 WHERE id = $3', [stuckRunning, at('2026-09-19 13:02'), targetE]);

    const removed: string[] = [];
    const enqueued: Array<{ ids: string[]; acceptDecrease?: boolean }> = [];
    const job = (id: string, state: string, data = {}): QueueJobLike => ({ data, getState: async () => state, remove: async () => { removed.push(id); } });
    const jobs = new Map<string, QueueJobLike>([
      [blockedByFailedJob, job(blockedByFailedJob, 'failed', { acceptDecrease: true })],
      [waitingRetry, job(waitingRetry, 'delayed')],
    ]);
    const queue: RunQueue = { getJob: async (id) => jobs.get(id), enqueue: async (ids, opts) => { enqueued.push({ ids, acceptDecrease: opts?.acceptDecrease }); } };

    const result = await recoverLostRuns({ db, baseUrl: 'https://usage.example.com', log: silentLog, sshTimeoutMs: 5000, maxAttempts: 3, now: () => NOW }, queue);
    expect(result.requeued.sort()).toEqual([neverEnqueued, blockedByFailedJob].sort());
    expect(result.failed.sort()).toEqual([exhausted, stuckRunning].sort());
    expect(removed).toEqual([blockedByFailedJob]); // failed 集合里的旧任务会挡住同名 jobId，先移除
    expect(enqueued.find((e) => e.ids[0] === blockedByFailedJob)).toMatchObject({ acceptDecrease: true });

    const status = async (id: string) => (await db.query('SELECT status, error_code FROM collection_runs WHERE id = $1', [id])).rows[0];
    expect(await status(waitingRetry)).toMatchObject({ status: 'queued' });
    expect(await status(fresh)).toMatchObject({ status: 'queued' });
    expect(await status(stuckRunning)).toEqual({ status: 'failed', error_code: 'RUN_LOST' });
    // 与普通失败一样计入连续失败轮数，并释放目标上的锁
    expect((await db.query('SELECT consecutive_failures, last_status, lock_run_id FROM collection_targets WHERE id = $1', [targetE])).rows[0]).toEqual({ consecutive_failures: 1, last_status: 'failed', lock_run_id: null });
    expect((await db.query('SELECT consecutive_failures FROM collection_targets WHERE id = $1', [targetD])).rows[0].consecutive_failures).toBe(1);

    // 被判为失败之后，迟到的队列重试不会再执行
    const exec = fakeExecutor(() => report({}));
    expect(await runCollection(runnerDeps(db, exec, NOW), stuckRunning, { finalAttempt: true })).toMatchObject({ status: 'failed', code: 'RUN_LOST' });
    expect(exec.calls).toHaveLength(0);

    // 再扫一遍：没有新的动作
    expect(await recoverLostRuns({ db, baseUrl: '', log: silentLog, sshTimeoutMs: 5000, maxAttempts: 3, now: () => NOW }, { ...queue, getJob: async (id) => (id === waitingRetry ? jobs.get(id) : job(id, 'waiting')) }))
      .toEqual({ requeued: [], failed: [] });
  });

  it('采集刚开始的几条语句（加锁等）出错同样记为失败，不会让运行永远停在 queued', async () => {
    const runId = (await createAdhocBatch(db, 'manual', [targetA], null)).runIds[0]!;
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          const sql = String(args[0]);
          if (sql.includes('SET lock_run_id = $1, lock_expires_at') && calls++ === 0) return Promise.reject(new Error('connection terminated'));
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as Db;
    const outcome = await runCollection({ ...runnerDeps(db, fakeExecutor(() => report({})), NOW), db: flaky }, runId, { finalAttempt: true });
    expect(outcome).toMatchObject({ status: 'failed', code: 'INTERNAL' });
    expect((await db.query('SELECT status FROM collection_runs WHERE id = $1', [runId])).rows[0].status).toBe('failed');
  });
});

describe('账号额度（L3 / L8 / L9 / M4 / S2）', () => {
  const claude = { provider: 'claude-code', accountKey: 'acct-1', accountLabel: 'team@example.com', plan: 'max', servers: ['ai'] };
  const enable = (extra: object = {}) => db.query("INSERT INTO settings (key, value) VALUES ('limitAlert', $1)", [JSON.stringify({ enabled: true, remainingBelowPercent: 20, notifyAdmins: false, emails: ['zyt@example.com'], includeFiveHour: true, ...extra })]);
  const win = (key: string, used: number, resetsAt: string | null, minutes = 10080) => ({ key, label: 'x', windowMinutes: minutes, usedPercent: used, resetsAt });

  it('服务商不给刷新时间：按时间桶去重（长窗口按周、短窗口按天），而不是一辈子只提醒一次', async () => {
    await enable();
    expect(isoWeekKey('2026-09-20')).toBe('2026-W38');
    expect(isoWeekKey('2026-09-21')).toBe('2026-W39');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    const d = (now: string) => limitsDeps(fakeExecutor(() => report({})), { now: () => at(now) });
    const windows = [win('five_hour', 90, null, 300), win('seven_day', 90, null)];
    expect(await evaluateLimitAlerts(d('2026-09-19 14:00'), claude, windows, 'ai')).toBe(2);
    expect(await evaluateLimitAlerts(d('2026-09-19 18:00'), claude, windows, 'ai')).toBe(0);
    expect(await evaluateLimitAlerts(d('2026-09-20 09:00'), claude, windows, 'ai')).toBe(1); // 新的一天：5 小时窗口重新计；周窗口仍是同一周
    expect(await evaluateLimitAlerts(d('2026-09-21 09:00'), claude, windows, 'ai')).toBe(2); // 周一：新的一周
    expect((await db.query("SELECT period_key FROM alert_events WHERE period_type = 'seven_day' ORDER BY created_at")).rows.map((r) => r.period_key)).toEqual(['week:2026-W38', 'week:2026-W39']);
  });

  it('刷新时间在 10 分钟取整边界附近抖动，不会被当成新周期重复提醒', async () => {
    await enable();
    const d = limitsDeps(fakeExecutor(() => report({})));
    expect(await evaluateLimitAlerts(d, claude, [win('seven_day', 90, '2099-09-22T10:04:59.000Z')], 'ai')).toBe(1); // 取整到 10:00
    expect(await evaluateLimitAlerts(d, claude, [win('seven_day', 92, '2099-09-22T10:05:01.000Z')], 'ai')).toBe(0); // 取整到 10:10，仍是同一周期
    expect(await evaluateLimitAlerts(d, claude, [win('seven_day', 92, '2099-09-22T10:40:00.000Z')], 'ai')).toBe(1);
    expect(sameLimitCycle('2099-09-22T10:00:00.000Z', 'week:2099-W39', 'week:2099-W39', NOW)).toBe(true); // 上次记下的刷新时间还没到
    expect(sameLimitCycle('week:2026-W38', '2026-09-22T10:00:00.000Z', 'week:2026-W38', NOW)).toBe(true);
    expect(sameLimitCycle('week:2026-W37', '2026-09-22T10:00:00.000Z', 'week:2026-W38', NOW)).toBe(false);
  });

  it('两个窗口报了同一个 key（旧版脚本下 Codex 的两个长窗口）：整理成唯一的 key，各自提醒', async () => {
    await enable();
    const dup = [win('seven_day', 95, '2099-09-22T10:00:00.000Z', 1440), win('seven_day', 91, '2099-09-25T10:00:00.000Z', 10080)];
    expect(normalizeWindows(dup).map((w) => [w.key, w.label])).toEqual([['seven_day', '1 天'], ['seven_day_2', '每周']]);
    expect(normalizeWindows([win('Bad Key!', 1, 'not-a-date', 300), win('five_hour', 1, null, 300)]).map((w) => [w.key, w.label, w.resetsAt])).toEqual([['window_1', '5 小时', null], ['five_hour', '5 小时 · 2', null]]);
    expect(await evaluateLimitAlerts(limitsDeps(fakeExecutor(() => report({}))), { ...claude, provider: 'codex' }, dup, 'ai')).toBe(2);
    expect((await events(db)).length).toBe(2);
  });

  it('远端回报的账号名、套餐名、窗口名不原样进邮件：不像邮箱的账号名不显示，窗口名按 key 取，控制字符去掉', async () => {
    await enable();
    expect(cleanAccountLabel('team@example.com')).toBe('team@example.com');
    expect(cleanAccountLabel('x@example.com\r\nBcc: evil@example.org')).toBeNull();
    expect(cleanAccountLabel('点这里 http://evil.example 重新登录')).toBeNull();
    const evil = { ...claude, accountLabel: '紧急：请到 http://evil.example 重新登录\r\nBcc: evil@example.org', plan: 'max\n\n伪造的正文' };
    await evaluateLimitAlerts(limitsDeps(fakeExecutor(() => report({}))), evil, [{ ...win('seven_day', 90, '2099-09-22T10:00:00.000Z'), label: '伪造\n的窗口名' }], 'ai');
    const mail = (await outbox(db))[0];
    expect(mail.subject).toBe('[额度提醒] Claude Code 每周额度仅剩 10%（已用 90%）');
    expect(mail.body_text).not.toMatch(/evil|伪造|Bcc/);
    expect((await db.query('SELECT rule_name FROM alert_events')).rows[0].rule_name).toBe('Claude Code 每周额度剩余不足 20%');
    // 模板自身也兜底：每个外部字符串只占一行
    const rendered = renderLimitAlert({ providerLabel: 'Claude Code', accountLabel: 'a@b.c\nX-Injected: 1', plan: null, windowLabel: '每周\n第二行', usedPercent: 90, thresholdRemaining: 20, resetsAt: null, others: [], fetchedAt: NOW, serverName: 'ai\nzz', timezone: 'UTC', baseUrl: '' });
    expect(rendered.subject).not.toContain('\n');
    expect(rendered.text.split('\n').some((l) => l.startsWith('X-Injected'))).toBe(false);
  });

  it('一份损坏的 SSH 凭据只影响用它的目标；全部成员失败时优先记录“还活着”的错误，而不是最后一台的令牌过期', async () => {
    await markHealthy();
    const broken = (await db.query("INSERT INTO credentials (name, ciphertext, iv, auth_tag, public_fingerprint, key_type) VALUES ('broken', '\\x00', '\\x00', '\\x00', 'SHA256:b', 'ssh-ed25519') RETURNING id")).rows[0].id;
    const serverC = await addServer(db, 'server-c', broken);
    await addTarget(db, serverC, zhangsan, '/home/c/.claude');
    await markHealthy();
    // 先被问到的那台报瞬时错误，后一台报令牌过期
    const seen: string[] = [];
    const tracking: RemoteExecutor = { exec: async (t, command) => {
      if (command.includes('--identity')) return reply({ status: 'ok', accountKey: 'acct-1', accountLabel: 'team@example.com' });
      seen.push(t.host);
      return reply(seen.length === 1 ? { status: 'error', code: 'LIMITS_UNAVAILABLE', message: '服务商返回 503' } : { status: 'error', code: 'TOKEN_EXPIRED', message: '登录令牌已过期' });
    } };
    const outcomes = await refreshAccountLimits(limitsDeps(tracking));
    expect(seen).toHaveLength(2); // server-c 的凭据解不开：被跳过，A、B 照常查询
    expect(outcomes).toEqual([expect.objectContaining({ ok: false, code: 'LIMITS_UNAVAILABLE' })]); // 先失败的是瞬时错误，后一台令牌过期：记前者
    const view = await latestAccountLimits(db);
    expect(view.hidden).toEqual([]);
    expect(view.limits[0]!.lastError).toMatchObject({ code: 'LIMITS_UNAVAILABLE' });
  });

  it('同一账号的成员多于单轮上限时逐轮轮换，排在后面的也会被用到；采集配置关闭了账号查询的服务器不算故障', async () => {
    const members = Array.from({ length: 12 }, (_, i) => i);
    expect(pickMembers(members, 8, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pickMembers(members, 8, 7)).toEqual([0, 1, 9, 10, 11, 2, 3, 4]);
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((turn) => pickMembers(members, 8, turn))).size).toBe(12);
    expect(pickMembers([1, 2, 3], 8, 5)).toEqual([1, 2, 3]);

    await markHealthy();
    const executor: RemoteExecutor = { exec: async () => reply({ status: 'error', code: 'ACCOUNT_QUERIES_DISABLED' }) };
    expect(await refreshAccountLimits(limitsDeps(executor))).toEqual([]);
    expect(await latestAccountLimits(db)).toMatchObject({ limits: [], unidentified: [], checked: true });
  });

  it('整轮刷新有总时限：到点后不再发起远程调用，也不改动上一轮的结果；同名调度任务在进程内互斥', async () => {
    await markHealthy();
    await db.query("UPDATE collection_targets SET account_key = 'acct-1', account_label = 'team@example.com'");
    let calls = 0;
    const executor: RemoteExecutor = { exec: async () => { calls++; return reply({ status: 'ok', accountKey: 'acct-2' }); } };
    expect(await refreshAccountLimits(limitsDeps(executor, { deadlineMs: 0 }))).toEqual([]);
    expect(calls).toBe(0);
    expect((await db.query('SELECT DISTINCT account_key FROM collection_targets')).rows).toEqual([{ account_key: 'acct-1' }]);

    const exclusive = createExclusive();
    let release!: () => void;
    let runs = 0;
    const slow = () => new Promise<string>((resolve) => { runs++; release = () => resolve('done'); });
    const firstRun = exclusive.run('limits', slow);
    expect(await exclusive.run('limits', slow)).toBe(SKIPPED); // 上一轮还在跑：立即返回
    expect(await exclusive.run('tick', async () => 'tick')).toBe('tick'); // 不同名的任务互不影响
    release();
    expect(await firstRun).toBe('done');
    expect(runs).toBe(1);

    // coalesce：被跳过的那次合并到当前这轮之后补跑一遍
    runs = 0;
    const coalesced = exclusive.run('tick', slow, { coalesce: true });
    expect(await exclusive.run('tick', slow, { coalesce: true })).toBe(SKIPPED);
    expect(await exclusive.run('tick', slow, { coalesce: true })).toBe(SKIPPED);
    release();
    await new Promise((r) => setTimeout(r, 5));
    release();
    await coalesced;
    expect(runs).toBe(2);
    expect(exclusive.isRunning('tick')).toBe(false);
  });
});

describe('发件箱并发与租约', () => {
  const seed = (n: number) => db.query("INSERT INTO email_outbox (message_id, to_addrs, subject, body_text) SELECT '<m-' || i || '@x>', '{a@example.com}', 's', 'b' FROM generate_series(1, $1) i", [n]);

  it('多个邮件 Worker 同时处理：每封只发一次', async () => {
    await seed(30);
    const sent: string[] = [];
    const sender = { send: async (m: { messageId: string }) => { await new Promise((r) => setTimeout(r, 2)); sent.push(m.messageId); } };
    const results = await Promise.all([1, 2, 3, 4].map(() => processOutbox(db, sender, { maxAttempts: 3, log: silentLog })));
    expect(results.reduce((a, r) => a + r.sent, 0)).toBe(30);
    expect(new Set(sent).size).toBe(30);
    expect(sent).toHaveLength(30);
    expect((await db.query("SELECT count(*)::int AS n FROM email_outbox WHERE status = 'sent' AND attempts = 1")).rows[0].n).toBe(30);
  });

  it('发送中途崩溃留下的 sending：租约过期后被重新领取；租约未到期的不动', async () => {
    await seed(2);
    await db.query("UPDATE email_outbox SET status = 'sending', attempts = 1, locked_until = now() - interval '1 minute' WHERE message_id = '<m-1@x>'");
    await db.query("UPDATE email_outbox SET status = 'sending', attempts = 1, locked_until = now() + interval '4 minutes' WHERE message_id = '<m-2@x>'");
    const sent: string[] = [];
    expect(await processOutbox(db, { send: async (m) => { sent.push(m.messageId); } }, { maxAttempts: 3, log: silentLog })).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent).toEqual(['<m-1@x>']); // 同一个 Message-ID 重发
    expect((await db.query('SELECT message_id, status, attempts FROM email_outbox ORDER BY message_id')).rows).toEqual([
      { message_id: '<m-1@x>', status: 'sent', attempts: 2 }, { message_id: '<m-2@x>', status: 'sending', attempts: 1 },
    ]);
  });

  it('发送拖过了租约、别的 Worker 已接手并发出：迟到的失败不会把它改回 pending 造成重复投递', async () => {
    await seed(1);
    const sender = { send: async () => {
      await db.query("UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, locked_until = NULL"); // 另一个 Worker 接手并发送成功
      throw new Error('SMTP 连接超时');
    } };
    expect(await processOutbox(db, sender, { maxAttempts: 3, log: silentLog })).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect((await db.query('SELECT status FROM email_outbox')).rows[0].status).toBe('sent');
  });
});
