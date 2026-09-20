import type { Tx } from '../db/pool.js';
import { toMicros } from '../util/money.js';
import type { UsageRow } from './adapter.js';

export interface IngestInput {
  targetId: string;
  serverId: string;
  source: string;
  runId: string;
  since: string;
  until: string;
  rows: UsageRow[];
  timezone: string;
  costMode: string | null;
  priceVersion: string | null;
  parserVersion: string;
  collectedAt: Date;
  /** 管理员显式确认后，允许用更小的新值覆盖已入库的历史统计。 */
  acceptDecrease: boolean;
}

export interface IngestAnomaly { date: string; kind: 'missing' | 'decrease'; previousTotal: number; newTotal: number }

export interface IngestResult {
  rowsWritten: number; replacedDates: string[]; userIds: string[]; anomalies: IngestAnomaly[];
  /** 用量确实变多或新出现的日期（不含因统计时区变更而重新分桶的日期）：告警据此决定要补评估哪些已结束的周期 */
  changedDates: string[];
}

interface Binding { user_id: string; effective_from: string }

function userForDate(bindings: Binding[], date: string): string {
  let current = bindings[0]!;
  for (const b of bindings) if (b.effective_from <= date) current = b;
  return current.user_id;
}

/**
 * 按日期重算、覆盖更新统计快照（方案第 6 节）：
 * 以日期为单位事务性替换该目标的全部模型行，同一范围重复采集不会累加；
 * 已入库日期在新结果中消失或总量变小时（多为远端日志被清理），保留旧值并打标，不清零。
 *
 * 统计时区变更后，已入库的行是按旧时区分桶的，和新结果不能逐日比大小——同样的几个小时只是换了归属日：
 * - 新结果里有的日期：无条件整日替换（变小是重新分桶的正常结果，不是“数据减少”）；
 * - 新结果里没有的旧时区日期：先看整个范围的总量。新结果的总量不少于已入库的总量，说明远端日志完好，
 *   这一天的用量已经并入相邻日期，删掉旧行（留着就是重复统计）；总量反而变少，说明远端日志同时也被清理过，
 *   无法区分“并入了邻日”与“日志没了”，按既有的“日期缺失”处理：保留旧值、标记 retained 并记异常，
 *   由管理员核对后用“接受减少”清除。
 */
export async function ingestSnapshot(tx: Tx, input: IngestInput): Promise<IngestResult> {
  const { targetId, source, since, until } = input;

  const bindings = (await tx.query<Binding>(
    'SELECT user_id, effective_from FROM target_user_bindings WHERE target_id = $1 ORDER BY effective_from', [targetId],
  )).rows;
  if (bindings.length === 0) throw new Error(`采集目标 ${targetId} 缺少用户绑定`);

  const existing = new Map<string, { total: number; cost: bigint; integrity: string; otherTimezone: boolean }>();
  const existingRes = await tx.query(
    `SELECT usage_date, COALESCE(sum(total_tokens), 0)::bigint AS total, COALESCE(sum(cost_usd), 0)::text AS cost, min(integrity) AS integrity,
            bool_or(timezone <> $5) AS other_timezone
       FROM usage_daily WHERE target_id = $1 AND source = $2 AND usage_date BETWEEN $3 AND $4
      GROUP BY usage_date`,
    [targetId, source, since, until, input.timezone],
  );
  for (const r of existingRes.rows) existing.set(r.usage_date, { total: Number(r.total), cost: toMicros(r.cost), integrity: r.integrity, otherTimezone: r.other_timezone });

  const incoming = new Map<string, UsageRow[]>();
  for (const row of input.rows) {
    if (row.date < since || row.date > until) continue;
    const list = incoming.get(row.date);
    list ? list.push(row) : incoming.set(row.date, [row]);
  }

  const anomalies: IngestAnomaly[] = [];
  const replaceDates: string[] = [];
  const changedDates: string[] = [];
  const flag = { retained: [] as string[], decrease_flagged: [] as string[] };

  const dayTotal = (rows: UsageRow[]) => rows.reduce((acc, r) => acc + (r.totalTokens ?? 0), 0);
  const dayCost = (rows: UsageRow[]) => rows.reduce((acc, r) => acc + (r.costUsd === null ? 0n : toMicros(r.costUsd)), 0n);
  const sumOf = (totals: Iterable<number>) => { let n = 0; for (const t of totals) n += t; return n; };
  // 范围内总量守恒：重新分桶只会把用量挪到相邻日期，不会让整个范围的总量变少
  const rangeConserved = sumOf([...incoming.values()].map(dayTotal)) >= sumOf([...existing.values()].map((e) => e.total));

  for (const [date, old] of existing) {
    if (incoming.has(date)) continue;
    if (input.acceptDecrease || (old.otherTimezone && rangeConserved)) {
      replaceDates.push(date); // 无新行：删除即清空
    } else if (old.total > 0) {
      if (old.integrity === 'complete') anomalies.push({ date, kind: 'missing', previousTotal: old.total, newTotal: 0 });
      flag.retained.push(date);
    }
  }
  for (const [date, rows] of incoming) {
    const newTotal = dayTotal(rows);
    const old = existing.get(date);
    if (old && newTotal < old.total && !input.acceptDecrease && !old.otherTimezone) {
      if (old.integrity !== 'decrease_flagged') anomalies.push({ date, kind: 'decrease', previousTotal: old.total, newTotal });
      flag.decrease_flagged.push(date);
      continue;
    }
    replaceDates.push(date);
    if (!old?.otherTimezone && (!old || newTotal > old.total || dayCost(rows) > old.cost)) changedDates.push(date);
  }

  for (const [integrity, dates] of Object.entries(flag)) {
    if (dates.length === 0) continue;
    await tx.query(
      'UPDATE usage_daily SET integrity = $1 WHERE target_id = $2 AND source = $3 AND usage_date = ANY($4::date[])',
      [integrity, targetId, source, dates],
    );
  }

  const userIds = new Set<string>();
  let rowsWritten = 0;
  if (replaceDates.length > 0) {
    // 整日替换：同时清理该日期下已失效的模型维度行
    const removed = await tx.query(
      'DELETE FROM usage_daily WHERE target_id = $1 AND source = $2 AND usage_date = ANY($3::date[]) RETURNING user_id',
      [targetId, source, replaceDates],
    );
    for (const r of removed.rows) userIds.add(r.user_id);

    const rows = replaceDates.flatMap((d) => incoming.get(d) ?? []);
    if (rows.length > 0) {
      const owners = rows.map((r) => userForDate(bindings, r.date));
      owners.forEach((u) => userIds.add(u));
      await tx.query(
        `INSERT INTO usage_daily
           (target_id, server_id, source, run_id, timezone, cost_mode, price_version, parser_version, collected_at,
            user_id, usage_date, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd)
         SELECT $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text, $7::text, $8::text, $9::timestamptz, u.*
           FROM unnest($10::uuid[], $11::date[], $12::text[], $13::bigint[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::numeric[]) AS u`,
        [
          targetId, input.serverId, source, input.runId, input.timezone, input.costMode, input.priceVersion, input.parserVersion, input.collectedAt,
          owners, rows.map((r) => r.date), rows.map((r) => r.model),
          rows.map((r) => r.inputTokens), rows.map((r) => r.outputTokens), rows.map((r) => r.cacheCreationTokens),
          rows.map((r) => r.cacheReadTokens), rows.map((r) => r.totalTokens), rows.map((r) => r.costUsd),
        ],
      );
      rowsWritten = rows.length;
    }
  }

  return { rowsWritten, replacedDates: replaceDates.sort(), userIds: [...userIds], anomalies, changedDates: changedDates.sort() };
}
