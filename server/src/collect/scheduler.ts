import { withTx, type Db, type Tx } from '../db/pool.js';
import { getGeneralSettings } from '../settings.js';
import { dateInTz, latestSlot, zonedHourToUtc } from '../util/time.js';

export interface CreatedBatch { batchId: string; kind: string; runIds: string[] }

const ON_TIME_WINDOW_MS = 10 * 60_000;

async function createRuns(tx: Tx, batchId: string, trigger: string, targetIds?: string[]): Promise<string[]> {
  const res = await tx.query(
    `INSERT INTO collection_runs (batch_id, target_id, trigger)
     SELECT $1, t.id, CASE WHEN t.initialized_at IS NULL THEN 'init' ELSE $2 END
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
      WHERE t.enabled AND s.enabled AND ($3::uuid[] IS NULL OR t.id = ANY($3::uuid[]))
     RETURNING id`,
    [batchId, trigger, targetIds ?? null],
  );
  await tx.query('UPDATE collection_batches SET target_count = $2 WHERE id = $1', [batchId, res.rowCount]);
  return res.rows.map((r) => r.id);
}

/**
 * 为当前调度时点创建采集批次（幂等：scheduled_slot 唯一）。
 * 服务重启后调用同一函数即可补采：只为最近一个时点建批，缺口由各目标按上次成功时间扩大采集范围覆盖，
 * 不为每个遗漏时点重复创建全量任务。
 */
export async function ensureSlotBatch(db: Db, now = new Date()): Promise<CreatedBatch | null> {
  const settings = await getGeneralSettings(db);
  const slot = latestSlot(now, settings.timezone, settings.collectIntervalHours);
  const kind = now.getTime() - slot.getTime() <= ON_TIME_WINDOW_MS ? 'scheduled' : 'catchup';
  const dayStart = zonedHourToUtc(dateInTz(now, settings.timezone), 0, settings.timezone);

  return withTx(db, async (tx) => {
    // 每个自然日的首个批次做一次较长范围的对账，补齐延迟写入的记录
    const reconciled = await tx.query('SELECT 1 FROM collection_batches WHERE reconcile AND scheduled_slot >= $1 LIMIT 1', [dayStart]);
    const batch = await tx.query(
      `INSERT INTO collection_batches (kind, scheduled_slot, reconcile) VALUES ($1, $2, $3)
       ON CONFLICT (scheduled_slot) DO NOTHING RETURNING id`,
      [kind, slot, reconciled.rowCount === 0],
    );
    const batchId = batch.rows[0]?.id as string | undefined;
    if (!batchId) return null;
    return { batchId, kind, runIds: await createRuns(tx, batchId, kind) };
  });
}

/** 手动或初始化采集：立即执行，不改变常规调度时点。 */
export async function createAdhocBatch(db: Db, kind: 'manual' | 'init', targetIds: string[], createdBy: string | null): Promise<CreatedBatch> {
  return withTx(db, async (tx) => {
    const batch = await tx.query('INSERT INTO collection_batches (kind, created_by) VALUES ($1, $2) RETURNING id', [kind, createdBy]);
    const batchId = batch.rows[0].id as string;
    return { batchId, kind, runIds: await createRuns(tx, batchId, kind, targetIds) };
  });
}

/** 已创建但未成功入队（如进程在两步之间崩溃）的运行，由调度 tick 重新入队；jobId = runId 保证不重复。 */
export async function findOrphanedRuns(db: Db, olderThanMs = 10 * 60_000): Promise<string[]> {
  const res = await db.query(
    "SELECT id FROM collection_runs WHERE status = 'queued' AND attempt = 0 AND created_at < now() - make_interval(secs => $1) AND created_at > now() - interval '1 day'",
    [olderThanMs / 1000],
  );
  return res.rows.map((r) => r.id);
}

export async function applyRetention(db: Db): Promise<{ usageDeleted: number }> {
  const settings = await getGeneralSettings(db);
  await db.query("DELETE FROM collection_runs WHERE created_at < now() - interval '180 days'");
  await db.query("DELETE FROM collection_batches b WHERE created_at < now() - interval '180 days' AND NOT EXISTS (SELECT 1 FROM collection_runs r WHERE r.batch_id = b.id)");
  if (settings.retentionDays <= 0) return { usageDeleted: 0 };
  const res = await db.query("DELETE FROM usage_daily WHERE usage_date < (now() AT TIME ZONE $1)::date - $2::int", [settings.timezone, settings.retentionDays]);
  return { usageDeleted: res.rowCount ?? 0 };
}
