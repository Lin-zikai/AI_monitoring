import type { Tx } from '../db/pool.js';
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

export interface IngestResult { rowsWritten: number; replacedDates: string[]; userIds: string[]; anomalies: IngestAnomaly[] }

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
 */
export async function ingestSnapshot(tx: Tx, input: IngestInput): Promise<IngestResult> {
  const { targetId, source, since, until } = input;

  const bindings = (await tx.query<Binding>(
    'SELECT user_id, effective_from FROM target_user_bindings WHERE target_id = $1 ORDER BY effective_from', [targetId],
  )).rows;
  if (bindings.length === 0) throw new Error(`采集目标 ${targetId} 缺少用户绑定`);

  const existing = new Map<string, { total: number; integrity: string }>();
  const existingRes = await tx.query(
    `SELECT usage_date, COALESCE(sum(total_tokens), 0)::bigint AS total, min(integrity) AS integrity
       FROM usage_daily WHERE target_id = $1 AND source = $2 AND usage_date BETWEEN $3 AND $4
      GROUP BY usage_date`,
    [targetId, source, since, until],
  );
  for (const r of existingRes.rows) existing.set(r.usage_date, { total: Number(r.total), integrity: r.integrity });

  const incoming = new Map<string, UsageRow[]>();
  for (const row of input.rows) {
    if (row.date < since || row.date > until) continue;
    const list = incoming.get(row.date);
    list ? list.push(row) : incoming.set(row.date, [row]);
  }

  const anomalies: IngestAnomaly[] = [];
  const replaceDates: string[] = [];
  const flag = { retained: [] as string[], decrease_flagged: [] as string[] };

  for (const [date, old] of existing) {
    if (incoming.has(date)) continue;
    if (input.acceptDecrease) {
      replaceDates.push(date); // 无新行：删除即清空
    } else if (old.total > 0) {
      if (old.integrity === 'complete') anomalies.push({ date, kind: 'missing', previousTotal: old.total, newTotal: 0 });
      flag.retained.push(date);
    }
  }
  for (const [date, rows] of incoming) {
    const newTotal = rows.reduce((acc, r) => acc + (r.totalTokens ?? 0), 0);
    const old = existing.get(date);
    if (old && newTotal < old.total && !input.acceptDecrease) {
      if (old.integrity !== 'decrease_flagged') anomalies.push({ date, kind: 'decrease', previousTotal: old.total, newTotal });
      flag.decrease_flagged.push(date);
      continue;
    }
    replaceDates.push(date);
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

  return { rowsWritten, replacedDates: replaceDates.sort(), userIds: [...userIds], anomalies };
}
