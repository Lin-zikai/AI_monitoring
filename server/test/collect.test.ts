import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { latestAccountLimits, refreshAccountLimits } from '../src/collect/limits.js';
import { runCollection } from '../src/collect/runner.js';
import { createAdhocBatch, ensureSlotBatch } from '../src/collect/scheduler.js';
import type { Db } from '../src/db/pool.js';
import { processOutbox } from '../src/mail/outbox.js';
import type { OutgoingMail } from '../src/mail/transport.js';
import { addRule, addServer, addTarget, addUser, at, collect, createTestDb, events, fakeExecutor, outbox, remoteError, report, runnerDeps, seedBase, silentLog, userTotals } from './helpers.js';

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
  await db.query('TRUNCATE users, credentials, servers, collection_batches, alert_rules, alert_events, email_outbox, settings, account_limit_snapshots CASCADE');
  ({ credentialId } = await seedBase(db));
  zhangsan = await addUser(db, 'zhangsan', { budget: 500 });
  serverA = await addServer(db, 'server-a', credentialId);
  serverB = await addServer(db, 'server-b', credentialId);
  targetA = await addTarget(db, serverA, zhangsan, '/home/zhangsan/.claude');
  targetB = await addTarget(db, serverB, zhangsan, '/home/developer/.claude');
});

const NOW = at('2026-09-19 14:00');
const opus = (tokens: number, cost: number) => ({ model: 'claude-opus-5', input: tokens, cost });

describe('跨服务器汇总与防重复', () => {
  it('同一用户在两台服务器上的用量正确合并（Linux 用户名不同也不影响）', async () => {
    const exec = fakeExecutor((req) => report(req.host === 'server-a.internal'
      ? { '2026-09-19': [opus(1000, 1.5)] }
      : { '2026-09-19': [opus(500, 0.75), { model: 'claude-sonnet-5', output: 200, cost: 0.1 }] }));
    await collect(db, exec, targetA, NOW);
    await collect(db, exec, targetB, NOW);
    expect(await userTotals(db, zhangsan, '2026-09-19', '2026-09-19')).toEqual({ tokens: 1700, cost: 2.35 });
  });

  it('相同数据重复采集多次，总量不增长', async () => {
    const exec = fakeExecutor(() => report({ '2026-09-18': [opus(300, 0.3)], '2026-09-19': [opus(1000, 1.5)] }));
    for (let i = 0; i < 4; i++) expect((await collect(db, exec, targetA, NOW)).status).toBe('success');
    expect(await userTotals(db, zhangsan, '2026-09-01', '2026-09-30')).toEqual({ tokens: 1300, cost: 1.8 });
    expect((await db.query('SELECT count(*)::int AS n FROM usage_daily')).rows[0].n).toBe(2);
  });

  it('当天用量增长时覆盖为新快照，并清理已失效的模型维度行', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1000, 1), { model: 'old-model', input: 5 }] })), targetA, NOW);
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(2500, 2.5)] })), targetA, at('2026-09-19 16:00'));
    const rows = (await db.query('SELECT model, total_tokens FROM usage_daily')).rows;
    expect(rows).toEqual([{ model: 'claude-opus-5', total_tokens: 2500 }]);
  });

  it('首次接入回填历史范围，之后只重算最近几天', async () => {
    const exec = fakeExecutor(() => report({}));
    await collect(db, exec, targetA, NOW);
    await collect(db, exec, targetA, at('2026-09-19 16:00'));
    expect(exec.calls.map((c) => c.since)).toEqual(['2026-06-21', '2026-09-16']);
  });
});

describe('失败、空结果与数据完整性', () => {
  it('采集失败时保留上次成功数据，并区分目录缺失与“确实没有用量”', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1000, 1)] })), targetA, NOW);

    const failed = await collect(db, fakeExecutor(() => { throw remoteError('DIR_MISSING', '数据目录不存在'); }), targetA, at('2026-09-19 16:00'));
    expect(failed).toMatchObject({ status: 'failed', code: 'DIR_MISSING', retryable: false });
    expect((await userTotals(db, zhangsan, '2026-09-19', '2026-09-19')).tokens).toBe(1000);
    const t = (await db.query('SELECT last_status, last_error_code, consecutive_failures, last_success_at FROM collection_targets WHERE id = $1', [targetA])).rows[0];
    expect(t).toMatchObject({ last_status: 'failed', last_error_code: 'DIR_MISSING', consecutive_failures: 1, last_success_at: NOW });

    // 真正的空结果是一次成功采集
    expect((await collect(db, fakeExecutor(() => report({})), targetB, NOW)).status).toBe('success');
  });

  it('远端日志被清理后不把历史统计清零，标记后等待核查；管理员确认后才覆盖', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-17': [opus(700, 0.7)], '2026-09-18': [opus(900, 0.9)] })), targetA, NOW);
    // 9-17 的日志被整体清理，9-18 只剩一部分
    const cleaned = fakeExecutor(() => report({ '2026-09-18': [opus(100, 0.1)] }));
    await collect(db, cleaned, targetA, at('2026-09-19 16:00'));

    const rows = (await db.query('SELECT usage_date, total_tokens, integrity FROM usage_daily ORDER BY usage_date')).rows;
    expect(rows).toEqual([
      { usage_date: '2026-09-17', total_tokens: 700, integrity: 'retained' },
      { usage_date: '2026-09-18', total_tokens: 900, integrity: 'decrease_flagged' },
    ]);
    const run = (await db.query('SELECT anomalies FROM collection_runs ORDER BY created_at DESC LIMIT 1')).rows[0];
    expect(run.anomalies.map((a: { kind: string }) => a.kind).sort()).toEqual(['decrease', 'missing']);

    await collect(db, cleaned, targetA, at('2026-09-19 18:00'), { acceptDecrease: true });
    expect((await db.query('SELECT usage_date, total_tokens FROM usage_daily')).rows).toEqual([{ usage_date: '2026-09-18', total_tokens: 100 }]);
  });

  it('自动创建的目标：目录不存在视为“未使用”，不算失败也不告警；目录出现后仍回填历史', async () => {
    await db.query('UPDATE collection_targets SET missing_ok = true WHERE id = $1', [targetA]);
    const missing = fakeExecutor(() => { throw remoteError('DIR_MISSING', '数据目录不存在'); });
    for (const t of ['2026-09-19 10:00', '2026-09-19 12:00', '2026-09-19 14:00']) expect((await collect(db, missing, targetA, at(t))).status).toBe('success');
    const t = (await db.query('SELECT last_status, last_error_code, consecutive_failures, initialized_at FROM collection_targets WHERE id = $1', [targetA])).rows[0];
    expect(t).toEqual({ last_status: 'success', last_error_code: 'NO_DATA_DIR', consecutive_failures: 0, initialized_at: null });
    expect(await outbox(db)).toHaveLength(0);

    const appeared = fakeExecutor(() => report({ '2026-08-01': [opus(100, 0.1)], '2026-09-19': [opus(50, 0.05)] }));
    await collect(db, appeared, targetA, at('2026-09-19 16:00'));
    expect(appeared.calls[0]!.since).toBe('2026-06-21'); // 仍按首次接入回填
    expect((await userTotals(db, zhangsan, '2026-01-01', '2026-12-31')).tokens).toBe(150);
  });

  it('断连恢复后补齐缺失统计', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-05': [opus(100, 0.1)] })), targetA, at('2026-09-05 10:00'));
    const offline = fakeExecutor(() => { throw remoteError('CONNECT_TIMEOUT', 'SSH 连接超时', true); });
    await collect(db, offline, targetA, at('2026-09-10 10:00'));

    const back = fakeExecutor(() => report({ '2026-09-05': [opus(150, 0.15)], '2026-09-08': [opus(800, 0.8)], '2026-09-12': [opus(400, 0.4)], '2026-09-19': [opus(50, 0.05)] }));
    await collect(db, back, targetA, NOW);
    expect(back.calls[0]!.since).toBe('2026-09-04');
    expect((await userTotals(db, zhangsan, '2026-09-01', '2026-09-30')).tokens).toBe(1400);
  });

  it('来源切换边界之外的日期不入库，避免迁移后的日志被重复统计', async () => {
    await db.query("UPDATE collection_targets SET source_end_date = '2026-09-17' WHERE id = $1", [targetA]);
    await db.query("UPDATE collection_targets SET source_start_date = '2026-09-18' WHERE id = $1", [targetB]);
    const mirrored = fakeExecutor(() => report({ '2026-09-17': [opus(100, 0.1)], '2026-09-18': [opus(200, 0.2)] }));
    await collect(db, mirrored, targetA, NOW);
    await collect(db, mirrored, targetB, NOW);
    expect((await userTotals(db, zhangsan, '2026-09-01', '2026-09-30')).tokens).toBe(300);
  });

  it('绑定调整保留历史归属', async () => {
    const lisi = await addUser(db, 'lisi');
    await collect(db, fakeExecutor(() => report({ '2026-09-17': [opus(100, 0.1)] })), targetA, NOW);
    await db.query("INSERT INTO target_user_bindings (target_id, user_id, effective_from) VALUES ($1, $2, '2026-09-18')", [targetA, lisi]);
    await db.query('UPDATE collection_targets SET user_id = $2 WHERE id = $1', [targetA, lisi]);
    await collect(db, fakeExecutor(() => report({ '2026-09-17': [opus(120, 0.12)], '2026-09-18': [opus(300, 0.3)] })), targetA, at('2026-09-19 16:00'));
    expect((await userTotals(db, zhangsan, '2026-09-01', '2026-09-30')).tokens).toBe(120);
    expect((await userTotals(db, lisi, '2026-09-01', '2026-09-30')).tokens).toBe(300);
  });
});

describe('并发、重试与重启', () => {
  it('同一目标已有采集在进行时，新的运行被跳过而不是并发覆盖', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeExecutor(async () => { await gate; return report({ '2026-09-19': [opus(1000, 1)] }); });
    const first = collect(db, slow, targetA, NOW);
    await new Promise((r) => setTimeout(r, 200));
    const second = await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 0)] })), targetA, NOW);
    expect(second.status).toBe('skipped_locked');
    release();
    expect((await first).status).toBe('success');
    expect((await userTotals(db, zhangsan, '2026-09-19', '2026-09-19')).tokens).toBe(1000);
  });

  it('租约过期后被新运行接管，旧运行的结果不会覆盖新结果', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const oldRun = collect(db, fakeExecutor(async () => { await gate; return report({ '2026-09-19': [opus(111, 0.1)] }); }), targetA, NOW);
    await new Promise((r) => setTimeout(r, 200));
    // 模拟旧运行卡死、租约过期：两小时后的新运行接管并成功入库
    const later = at('2026-09-19 16:00');
    expect((await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(2000, 2)] })), targetA, later)).status).toBe('success');
    release();
    expect((await oldRun).status).toBe('stale');
    expect((await userTotals(db, zhangsan, '2026-09-19', '2026-09-19')).tokens).toBe(2000);
  });

  it('可重试错误在非最后一次尝试时不计入连续失败轮数；同一运行重试成功', async () => {
    const batch = await createAdhocBatch(db, 'manual', [targetA], null);
    const runId = batch.runIds[0]!;
    const flaky = fakeExecutor(() => { throw remoteError('CONNECT_TIMEOUT', '超时', true); });
    expect((await runCollection(runnerDeps(db, flaky, NOW), runId, { finalAttempt: false })).status).toBe('failed');
    expect((await db.query('SELECT consecutive_failures, lock_run_id FROM collection_targets WHERE id = $1', [targetA])).rows[0]).toEqual({ consecutive_failures: 0, lock_run_id: null });

    const ok = fakeExecutor(() => report({ '2026-09-19': [opus(10, 0.01)] }));
    expect((await runCollection(runnerDeps(db, ok, NOW), runId, { finalAttempt: false })).status).toBe('success');
    // 队列重复投递已成功的运行：不再执行
    await runCollection(runnerDeps(db, ok, NOW), runId, { finalAttempt: true });
    expect(ok.calls).toHaveLength(1);
    expect((await db.query('SELECT status, attempt FROM collection_runs WHERE id = $1', [runId])).rows[0]).toEqual({ status: 'success', attempt: 2 });
  });

  it('每个调度时点只创建一个批次；重启后只为最近时点补建一次', async () => {
    const onTime = await ensureSlotBatch(db, at('2026-09-19 14:00'));
    expect(onTime).toMatchObject({ kind: 'scheduled' });
    expect(onTime!.runIds).toHaveLength(2);
    expect(await ensureSlotBatch(db, at('2026-09-19 14:03'))).toBeNull(); // 另一个 Worker 实例或重复 tick

    // 停机到次日 09:30：遗漏了 16:00 … 08:00 共 9 个时点，只补建 08:00 这一个批次
    const catchup = await ensureSlotBatch(db, at('2026-09-20 09:30'));
    expect(catchup).toMatchObject({ kind: 'catchup' });
    const batches = (await db.query('SELECT kind, reconcile, scheduled_slot FROM collection_batches ORDER BY scheduled_slot')).rows;
    expect(batches).toEqual([
      { kind: 'scheduled', reconcile: true, scheduled_slot: at('2026-09-19 14:00') },
      { kind: 'catchup', reconcile: true, scheduled_slot: at('2026-09-20 08:00') }, // 当日首个批次顺带做长范围对账
    ]);
    expect((await ensureSlotBatch(db, at('2026-09-20 10:00')))!.kind).toBe('scheduled');
    expect((await db.query("SELECT reconcile FROM collection_batches WHERE scheduled_slot = $1", [at('2026-09-20 10:00')])).rows[0].reconcile).toBe(false);
  });

  it('停用的服务器不进入批次', async () => {
    await db.query('UPDATE servers SET enabled = false WHERE id = $1', [serverB]);
    expect((await ensureSlotBatch(db, NOW))!.runIds).toHaveLength(1);
  });
});

describe('邮件告警', () => {
  it('超过阈值后创建告警与邮件；同一周期反复采集不会重复创建同一档位', async () => {
    await addRule(db, { metric: 'tokens', period: 'daily', tiers: [10_000_000] });
    const exec = fakeExecutor(() => report({ '2026-09-19': [opus(12_000_000, 40)] }));
    for (let i = 0; i < 3; i++) await collect(db, exec, targetA, NOW);
    expect(await events(db)).toHaveLength(1);
    const mails = await outbox(db);
    expect(mails).toHaveLength(1);
    expect(mails[0].to_addrs).toEqual(['admin@example.com']); // 只发管理员，不发给用户本人
    expect(mails[0].subject).toBe('[用量提醒] zhangsan 当日 Token 用量 12,000,000 Token，已超过 10,000,000 Token');
  });

  it('月预算 80% 与 100% 分别提醒；汇总用户所有来源', async () => {
    await addRule(db, { metric: 'budget_pct', period: 'monthly', tiers: [80, 100], notifyAdmins: true });
    await collect(db, fakeExecutor(() => report({ '2026-09-10': [opus(1, 300)] })), targetA, NOW);
    expect(await events(db)).toHaveLength(0);

    await collect(db, fakeExecutor(() => report({ '2026-09-12': [opus(1, 120)] })), targetB, NOW); // 两台合计 420 = 84%
    expect((await events(db)).map((e) => e.tier)).toEqual([80]);
    const mail = (await outbox(db))[0];
    expect(mail.subject).toBe('[用量提醒] zhangsan本月预算已达到 80%');
    expect(mail.body_text).toContain('本月估算费用：US$ 420.00');
    expect(mail.body_text).toContain('预算使用率：84%');
    expect(mail.body_text).toContain('数据更新时间：2026-09-19 14:00（Asia/Shanghai）');
    expect(mail.to_addrs).toEqual(['admin@example.com']);

    await collect(db, fakeExecutor(() => report({ '2026-09-12': [opus(1, 120)], '2026-09-19': [opus(1, 90)] })), targetB, at('2026-09-19 16:00'));
    expect((await events(db)).map((e) => e.tier)).toEqual([80, 100]);
    expect(await outbox(db)).toHaveLength(2);
  });

  it('一次评估同时跨过多个档位时只为最高档位发信', async () => {
    await addRule(db, { metric: 'budget_pct', period: 'monthly', tiers: [80, 100] });
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 600)] })), targetA, NOW);
    expect((await events(db)).map((e) => [e.tier, e.email_note])).toEqual([[80, '同次评估已触发更高档位，未单独发信'], [100, null]]);
    expect((await outbox(db)).map((m) => m.subject)).toEqual(['[用量提醒] zhangsan本月预算已达到 100%']);
  });

  it('跨日采集能识别刚结束一日的超限', async () => {
    await addRule(db, { metric: 'cost', period: 'daily', tiers: [50] });
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 45)] })), targetA, at('2026-09-19 22:00'));
    expect(await events(db)).toHaveLength(0);
    // 22:00–24:00 产生的用量在次日 00:00 的采集中才入库
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 58)], '2026-09-20': [opus(1, 0.01)] })), targetA, at('2026-09-20 00:00'));
    expect((await events(db)).map((e) => e.period_key)).toEqual(['2026-09-19']);
  });

  it('跨月采集能识别刚结束一月的超限', async () => {
    await addRule(db, { metric: 'tokens', period: 'monthly', tiers: [100_000_000] });
    await collect(db, fakeExecutor(() => report({ '2026-09-30': [opus(99_000_000, 1)] })), targetA, at('2026-09-30 22:00'));
    await collect(db, fakeExecutor(() => report({ '2026-09-30': [opus(101_000_000, 1)] })), targetA, at('2026-10-01 00:00'));
    expect((await events(db)).map((e) => e.period_key)).toEqual(['2026-09']);
  });

  it('首次历史回填不会集中发送历史告警，但当前周期照常评估', async () => {
    await addRule(db, { metric: 'cost', period: 'daily', tiers: [50] });
    await addRule(db, { metric: 'tokens', period: 'monthly', tiers: [1000] });
    const history = Object.fromEntries(['2026-07-03', '2026-08-15', '2026-09-18', '2026-09-19'].map((d) => [d, [opus(5000, 80)]]));
    await collect(db, fakeExecutor(() => report(history)), targetA, NOW);
    expect((await events(db)).map((e) => e.period_key).sort()).toEqual(['2026-09', '2026-09-19']);
  });

  it('新建规则不会为已结束的周期补发提醒', async () => {
    await collect(db, fakeExecutor(() => report({ '2026-09-18': [opus(1, 80)] })), targetA, at('2026-09-18 22:00'));
    await addRule(db, { metric: 'cost', period: 'daily', tiers: [50], createdAt: '2026-09-19T01:00:00Z' });
    await collect(db, fakeExecutor(() => report({ '2026-09-18': [opus(1, 80)] })), targetA, NOW);
    expect(await events(db)).toHaveLength(0);
  });

  it('其他来源尚未更新时，邮件注明数据不完整', async () => {
    await addRule(db, { metric: 'cost', period: 'daily', tiers: [50] });
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 60)] })), targetA, NOW); // targetB 从未成功
    expect((await events(db))[0].incomplete).toBe(true);
    const body = (await outbox(db))[0].body_text;
    expect(body).toContain('当前数据不完整');
    expect(body).toContain('server-b /home/developer/.claude（最近成功采集：从未成功）');
  });

  it('规则可额外指定收件邮箱；关闭“通知管理员”后只发给这些邮箱', async () => {
    await db.query("INSERT INTO alert_rules (name, metric, period, tiers, notify_admins, extra_emails, created_at) VALUES ('r', 'cost', 'daily', '{50}', false, '{Finance@Example.com}', '2020-01-01')");
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 60)] })), targetA, NOW);
    expect((await outbox(db)).map((m) => m.to_addrs)).toEqual([['finance@example.com']]);
  });

  it('按数据源设阈值 + 单独规则优先于全局：共享账户 Codex/Claude 任一超 200 才提醒，其他人合计超 100 就提醒', async () => {
    const chat = await addUser(db, '聊天');
    const chatClaude = await addTarget(db, serverA, chat, '/data/ai/.claude');
    const chatCodex = await addTarget(db, serverA, chat, '/data/ai/.codex');
    await db.query("UPDATE collection_targets SET source = 'codex' WHERE id = $1", [chatCodex]);
    const rule = (name: string, tier: number, scope: string, user: string | null, source: string | null) => db.query(
      `INSERT INTO alert_rules (name, metric, period, tiers, scope_type, scope_user_id, source, notify_admins, extra_emails, created_at)
       VALUES ($1, 'cost', 'daily', $2, $3, $4, $5, false, '{zyt@example.com}', '2020-01-01')`, [name, [tier], scope, user, source]);
    await rule('单用户日费用', 100, 'global', null, null);
    await rule('聊天 Claude 日费用', 200, 'user', chat, 'claude-code');
    await rule('聊天 Codex 日费用', 200, 'user', chat, 'codex');
    const codexReport = (cost: number) => ({ daily: [{ date: '2026-09-19', totalTokens: 10, costUSD: cost, models: { 'gpt-5': { totalTokens: 10 } } }] });

    // 聊天：Claude 150 + Codex 180 = 330，合计早已超过 100 和 200，但单项都没到 200，且全局的 100 不适用于它 → 不提醒
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 150)] })), chatClaude, NOW);
    await collect(db, fakeExecutor(() => codexReport(180)), chatCodex, NOW);
    expect(await outbox(db)).toHaveLength(0);

    // Codex 涨到 209.88 → 只触发 Codex 那条
    await collect(db, fakeExecutor(() => codexReport(209.88)), chatCodex, at('2026-09-19 16:00'));
    // 普通用户 zhangsan：合计 120 > 100 → 触发全局规则
    await collect(db, fakeExecutor(() => report({ '2026-09-19': [opus(1, 120)] })), targetA, at('2026-09-19 16:00'));

    const mails = await outbox(db);
    expect(mails.map((m) => [m.to_addrs, m.subject])).toEqual([
      [['zyt@example.com'], '[用量提醒] 聊天 当日 Codex 估算费用 US$ 209.88，已超过 US$ 200.00'],
      [['zyt@example.com'], '[用量提醒] zhangsan 当日估算费用 US$ 120.00，已超过 US$ 100.00'],
    ]);
    expect(mails[0].body_text).toContain('用户：聊天');
    expect(mails[0].body_text).toContain('数据范围：Codex');
    expect(mails[0].body_text).toContain('超出：US$ 9.88');
    expect((await db.query("SELECT source FROM alert_events WHERE user_id = $1", [chat])).rows).toEqual([{ source: 'codex' }]);
  });

  it('团队与用户范围的规则只作用于对应用户', async () => {
    const lisi = await addUser(db, 'lisi', { team: 'infra' });
    const targetC = await addTarget(db, serverA, lisi, '/home/lisi/.claude');
    await db.query("INSERT INTO alert_rules (name, metric, period, tiers, scope_type, scope_team, created_at) VALUES ('infra', 'cost', 'daily', '{10}', 'team', 'infra', '2020-01-01')");
    const exec = fakeExecutor(() => report({ '2026-09-19': [opus(1, 20)] }));
    await collect(db, exec, targetA, NOW);
    await collect(db, exec, targetC, NOW);
    expect((await db.query('SELECT user_id FROM alert_events')).rows).toEqual([{ user_id: lisi }]);
  });

  it('连续两轮采集失败通知管理员，每段连续失败只通知一次；恢复后重新计数', async () => {
    const offline = fakeExecutor(() => { throw remoteError('CONNECT_REFUSED', 'SSH 端口拒绝连接', true); });
    await collect(db, offline, targetA, at('2026-09-19 10:00'));
    expect(await outbox(db)).toHaveLength(0);
    await collect(db, offline, targetA, at('2026-09-19 12:00'));
    await collect(db, offline, targetA, at('2026-09-19 14:00'));
    const mails = await outbox(db);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_addrs: ['admin@example.com'], subject: '[采集异常] server-a 已连续 2 轮采集失败' });

    await collect(db, fakeExecutor(() => report({})), targetA, at('2026-09-19 16:00'));
    await collect(db, offline, targetA, at('2026-09-19 18:00'));
    await collect(db, offline, targetA, at('2026-09-19 20:00'));
    expect(await outbox(db)).toHaveLength(2);
  });
});

describe('账号额度', () => {
  const limitsReply = (body: object) => ({ stdout: JSON.stringify({ schema: 1, collectorVersion: '1.5.0', ...body }), stderr: '', exitCode: 0 });

  it('某台服务器令牌过期时换下一台；只保存百分比与刷新时间；失败晚于成功时给出提示', async () => {
    const usage = fakeExecutor(() => report({ '2026-09-19': [opus(1000, 1)] }));
    await collect(db, usage, targetA, NOW);
    await collect(db, usage, targetB, NOW);
    const asked: string[] = [];
    const executor = { exec: async (t: { host: string }, command: string) => {
      asked.push(`${t.host} ${command}`);
      if (command.includes('--limits codex')) return limitsReply({ status: 'error', code: 'NO_LOGIN', message: '没有登录信息' });
      return t.host === 'server-a.internal'
        ? limitsReply({ status: 'error', code: 'TOKEN_EXPIRED', message: '登录令牌已过期' })
        : limitsReply({ status: 'ok', plan: 'max', windows: [
          { key: 'five_hour', label: '5 小时', windowMinutes: 300, usedPercent: 37.5, resetsAt: '2026-09-19T21:30:00.000Z' },
          { key: 'seven_day', label: '每周', windowMinutes: 10080, usedPercent: 46, resetsAt: '2026-09-22T10:00:00.000Z' }] });
    } };
    const deps = { db, executor, masterKey: (await import('./helpers.js')).masterKey, log: silentLog };

    const outcomes = await refreshAccountLimits(deps);
    expect(outcomes.find((o) => o.provider === 'claude-code')).toMatchObject({ ok: true, serverName: 'server-b' });
    expect(asked.filter((a) => a.includes('claude-code'))).toEqual([
      'server-a.internal ccusage-collect --limits claude-code --dir /home/zhangsan/.claude',
      'server-b.internal ccusage-collect --limits claude-code --dir /home/developer/.claude',
    ]);

    const view = await latestAccountLimits(db);
    expect(view.find((v) => v.provider === 'claude-code')).toMatchObject({
      plan: 'max', serverName: 'server-b', lastError: null,
      windows: [{ key: 'five_hour', usedPercent: 37.5, resetsAt: '2026-09-19T21:30:00.000Z' }, { key: 'seven_day', usedPercent: 46 }],
    });
    // Codex 没有任何采集成功的目标 → 明确说明，而不是空白
    expect(view.find((v) => v.provider === 'codex')).toMatchObject({ windows: [], fetchedAt: null, lastError: { code: 'NO_SOURCE' } });
    expect(JSON.stringify((await db.query('SELECT * FROM account_limit_snapshots')).rows)).not.toMatch(/token|Bearer|test-key/i);
  });
});

describe('发件箱', () => {
  const seedMail = () => db.query("INSERT INTO email_outbox (message_id, to_addrs, subject, body_text) VALUES ('<alert-1@usage.example.com>', '{a@example.com}', 's', 'b')");

  it('发送成功后标记 sent，并使用稳定的 Message-ID', async () => {
    await seedMail();
    const sent: OutgoingMail[] = [];
    const result = await processOutbox(db, { send: async (m) => { sent.push(m); } }, { maxAttempts: 3, log: silentLog });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent[0]!.messageId).toBe('<alert-1@usage.example.com>');
    expect((await outbox(db))[0].status).toBe('sent');
    expect((await processOutbox(db, { send: async () => { throw new Error('不应再发送'); } }, { maxAttempts: 3, log: silentLog })).sent).toBe(0);
  });

  it('失败后退避重试，超过次数后标记最终失败', async () => {
    await seedMail();
    const failing = { send: async () => { throw new Error('SMTP 连接超时'); } };
    expect(await processOutbox(db, failing, { maxAttempts: 2, log: silentLog })).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect((await processOutbox(db, failing, { maxAttempts: 2, log: silentLog })).retried).toBe(0); // 退避期内不重发
    await db.query('UPDATE email_outbox SET next_attempt_at = now()');
    expect(await processOutbox(db, failing, { maxAttempts: 2, log: silentLog })).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect((await db.query('SELECT status, attempts, last_error FROM email_outbox')).rows[0]).toEqual({ status: 'failed', attempts: 2, last_error: 'SMTP 连接超时' });
  });
});
