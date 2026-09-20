import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { latestAccountLimits, refreshAccountLimits } from '../../collect/limits.js';
import { SOURCE_INFO, supportedSources } from '../../collect/adapter.js';
import { getGeneralSettings, type GeneralSettings } from '../../settings.js';
import { addDays, dateInTz, diffDays, monthKey, monthRange, nextSlot } from '../../util/time.js';
import type { RouteContext } from '../app.js';
import { currentUser, dateStr, HttpError, notFound, parse } from '../http.js';
import { idParam } from './users.js';

const DIMENSIONS = {
  date: { select: 'd.usage_date::text', label: 'd.usage_date::text' },
  user: { select: 'd.user_id::text', label: 'u.name' },
  server: { select: 'd.server_id::text', label: 's.name' },
  model: { select: 'd.model', label: 'd.model' },
  source: { select: 'd.source', label: 'd.source' },
  team: { select: "COALESCE(u.team, '')", label: "COALESCE(u.team, '未分组')" },
} as const;
type Dimension = keyof typeof DIMENSIONS;

/**
 * 不分组（或带 FILTER）的合计：范围内没有任何用量行 → 0（确实没用）；有行但数值全为 NULL → NULL（未知，前端显示“未知”）。
 * 裸 sum() 分不清这两种情况，空区间也会得到 NULL。
 */
const sumOrZero = (expr: string, filter?: string) => {
  const f = filter ? ` FILTER (WHERE ${filter})` : '';
  return `CASE WHEN count(*)${f} = 0 THEN 0 ELSE sum(${expr})${f} END`;
};
const MAX_USAGE_ROWS = 20_000;

// 分组查询里每个分组至少有一行，sum() 为 NULL 只可能是“全为 NULL”：前端据此显示“未知”而不是 0
const MEASURES = `sum(d.total_tokens)::bigint AS "totalTokens", sum(d.input_tokens)::bigint AS "inputTokens", sum(d.output_tokens)::bigint AS "outputTokens",
  sum(d.cache_creation_tokens)::bigint AS "cacheCreationTokens", sum(d.cache_read_tokens)::bigint AS "cacheReadTokens", sum(d.cost_usd)::float8 AS "costUsd"`;

const usageQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  userId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
  team: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  source: z.string().max(32).optional(),
  groupBy: z.string().default('date').transform((v) => v.split(',')).pipe(z.array(z.enum(['date', 'user', 'server', 'model', 'source', 'team'])).min(1).max(2)),
});

/** 普通用户只能看到自己的数据：在后台强制把查询范围收窄到本人。 */
function scopedUserId(req: FastifyRequest, requested?: string): string | null {
  const me = currentUser(req);
  if (me.role === 'admin') return requested ?? null;
  if (requested && requested !== me.id) throw new HttpError(403, '无权查看其他用户的用量');
  return me.id;
}

const staleBefore = (s: GeneralSettings, now: Date) => new Date(now.getTime() - 2 * s.collectIntervalHours * 3_600_000);

export async function statsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db } = ctx;
  const auth = { preHandler: ctx.authenticate };

  async function freshness(userId: string | null, settings: GeneralSettings, now: Date) {
    const row = (await db.query(
      `SELECT max(t.last_success_at) AS "lastSuccessAt", min(t.last_success_at) AS "oldestSuccessAt", count(*)::int AS targets,
              count(*) FILTER (WHERE t.last_status = 'failed' OR (t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR' AND (t.last_success_at IS NULL OR t.last_success_at < $2)))::int AS "staleTargets"
         FROM collection_targets t JOIN servers s ON s.id = t.server_id
        WHERE t.enabled AND s.enabled AND ($1::uuid IS NULL OR t.user_id = $1)`,
      [userId, staleBefore(settings, now)],
    )).rows[0];
    return {
      timezone: settings.timezone,
      intervalHours: settings.collectIntervalHours,
      today: dateInTz(now, settings.timezone),
      lastSuccessAt: row.lastSuccessAt,
      oldestSuccessAt: row.oldestSuccessAt,
      nextCollectionAt: nextSlot(now, settings.timezone, settings.collectIntervalHours),
      targets: row.targets,
      staleTargets: row.staleTargets,
      // 部分来源失联时保留已有统计并标记数据不完整，不显示成零使用量
      incomplete: row.staleTargets > 0,
    };
  }

  /** 某一天的用量排名：按数据源分列（Claude Code / Codex）并给出合计；返回当日全部有用量的用户，由前端按所选口径取前 10 */
  const dailyRanking = (date: string) => db.query(
    `SELECT u.id AS "userId", u.name, u.team,
            ${sumOrZero('d.total_tokens', "d.source = 'claude-code'")}::bigint AS "claudeTokens", ${sumOrZero('d.cost_usd', "d.source = 'claude-code'")}::float8 AS "claudeCost",
            ${sumOrZero('d.total_tokens', "d.source = 'codex'")}::bigint AS "codexTokens", ${sumOrZero('d.cost_usd', "d.source = 'codex'")}::float8 AS "codexCost",
            sum(d.total_tokens)::bigint AS "totalTokens", sum(d.cost_usd)::float8 AS "totalCost"
       FROM usage_daily d JOIN users u ON u.id = d.user_id WHERE d.usage_date = $1::date
      GROUP BY u.id ORDER BY "totalCost" DESC NULLS LAST, "totalTokens" DESC NULLS LAST LIMIT 500`,
    [date],
  );

  app.get('/stats/daily-ranking', { preHandler: ctx.requireAdmin }, async (req) => {
    const q = parse(z.object({ date: dateStr.optional() }), req.query);
    const settings = await getGeneralSettings(db);
    const today = dateInTz(new Date(), settings.timezone);
    const date = q.date ?? today;
    if (date > today) throw new HttpError(400, '不能选择未来的日期');
    const first = (await db.query('SELECT min(usage_date)::text AS d FROM usage_daily')).rows[0].d as string | null;
    return { date, today, earliest: first ?? today, rows: (await dailyRanking(date)).rows };
  });

  // ---- 账号额度（5 小时 / 周）：目前所有用户与服务器共用同一个账号，按数据源各展示一份 ----
  app.get('/limits', { preHandler: ctx.requireAdmin }, async () => latestAccountLimits(db));

  app.post('/limits/refresh', { preHandler: ctx.requireAdmin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const outcomes = await refreshAccountLimits({ db, executor: ctx.executor, masterKey: ctx.config.masterKey, log: req.log as unknown as Logger, baseUrl: ctx.config.publicBaseUrl, force: true });
    await ctx.queues.kickMail();
    return { outcomes, ...(await latestAccountLimits(db)) };
  });

  app.get('/meta', auth, async (req) => {
    const settings = await getGeneralSettings(db);
    return { ...(await freshness(scopedUserId(req), settings, new Date())), sources: supportedSources(), sourceInfo: SOURCE_INFO };
  });

  app.get('/stats/filters', auth, async (req) => {
    const userId = scopedUserId(req);
    const [users, servers, models, teams] = await Promise.all([
      db.query('SELECT id, name, team FROM users WHERE ($1::uuid IS NULL OR id = $1) ORDER BY name', [userId]),
      db.query('SELECT DISTINCT s.id, s.name FROM servers s JOIN collection_targets t ON t.server_id = s.id WHERE ($1::uuid IS NULL OR t.user_id = $1) ORDER BY s.name', [userId]),
      userId
        ? db.query('SELECT DISTINCT model FROM usage_daily WHERE user_id = $1 ORDER BY model', [userId]) // 走 (user_id, usage_date) 索引，只扫本人的行
        // 管理员视角：模型只有几十种、用量行却很多。沿 model 索引逐个跳到下一个不同的值（loose index scan），不做全表 DISTINCT
        : db.query(
          `WITH RECURSIVE m AS (
             (SELECT model FROM usage_daily ORDER BY model LIMIT 1)
             UNION ALL
             SELECT (SELECT d.model FROM usage_daily d WHERE d.model > m.model ORDER BY d.model LIMIT 1) FROM m WHERE m.model IS NOT NULL
           ) SELECT model FROM m WHERE model IS NOT NULL ORDER BY model`,
        ),
      db.query('SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND ($1::uuid IS NULL OR id = $1) ORDER BY team', [userId]),
    ]);
    return { users: users.rows, servers: servers.rows, models: models.rows.map((r) => r.model), teams: teams.rows.map((r) => r.team) };
  });

  app.get('/stats/usage', auth, async (req) => {
    const q = parse(usageQuery, req.query);
    const settings = await getGeneralSettings(db);
    const today = dateInTz(new Date(), settings.timezone);
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -29);
    if (from > to || diffDays(to, from) > 800) throw new HttpError(400, '日期范围不合法（最长 800 天）');
    const userId = scopedUserId(req, q.userId);
    if (currentUser(req).role !== 'admin' && q.groupBy.includes('user')) q.groupBy = q.groupBy.filter((g) => g !== 'user').concat('date').slice(0, 2) as Dimension[];

    const dims = [...new Set(q.groupBy)] as Dimension[];
    const selects = dims.map((d, i) => `${DIMENSIONS[d].select} AS key${i}, min(${DIMENSIONS[d].label}) AS label${i}`);
    const groups = dims.map((d) => DIMENSIONS[d].select);
    const res = await db.query(
      `SELECT ${selects.join(', ')}, ${MEASURES}, bool_or(d.integrity <> 'complete') AS flagged
         FROM usage_daily d JOIN users u ON u.id = d.user_id JOIN servers s ON s.id = d.server_id
        WHERE d.usage_date BETWEEN $1 AND $2
          AND ($3::uuid IS NULL OR d.user_id = $3) AND ($4::uuid IS NULL OR d.server_id = $4)
          AND ($5::text IS NULL OR d.model = $5) AND ($6::text IS NULL OR u.team = $6) AND ($7::text IS NULL OR d.source = $7)
        GROUP BY ${groups.join(', ')} ORDER BY ${dims[0] === 'date' ? 'key0' : '"costUsd" DESC NULLS LAST, key0'} LIMIT ${MAX_USAGE_ROWS + 1}`,
      [from, to, userId, q.serverId ?? null, q.model ?? null, q.team ?? null, q.source ?? null],
    );
    if (res.rows.length > MAX_USAGE_ROWS) throw new HttpError(400, `结果超过 ${MAX_USAGE_ROWS} 行，请缩小日期范围或减少分组维度`, 'TOO_MANY_ROWS');
    return { from, to, groupBy: dims, rows: res.rows };
  });

  app.get('/stats/overview', auth, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(180).default(30) }), req.query);
    const me = currentUser(req);
    const userId = scopedUserId(req);
    const settings = await getGeneralSettings(db);
    const now = new Date();
    const today = dateInTz(now, settings.timezone);
    const month = monthRange(monthKey(today));
    const trendFrom = addDays(today, -(q.days - 1));
    const scope = '($1::uuid IS NULL OR d.user_id = $1)';

    const [totals, trend, models, ranking, issues] = await Promise.all([
      db.query(
        `SELECT ${sumOrZero('d.total_tokens', 'd.usage_date = $2')}::bigint AS "todayTokens", ${sumOrZero('d.cost_usd', 'd.usage_date = $2')}::float8 AS "todayCost",
                ${sumOrZero('d.total_tokens')}::bigint AS "monthTokens", ${sumOrZero('d.cost_usd')}::float8 AS "monthCost",
                count(DISTINCT d.user_id) FILTER (WHERE d.usage_date = $2)::int AS "activeUsersToday", count(DISTINCT d.user_id)::int AS "activeUsersMonth"
           FROM usage_daily d WHERE ${scope} AND d.usage_date BETWEEN $3 AND $4`,
        [userId, today, month.first, month.last],
      ),
      db.query(
        `SELECT d.usage_date::text AS date, d.model, sum(d.total_tokens)::bigint AS "totalTokens", sum(d.cost_usd)::float8 AS "costUsd"
           FROM usage_daily d WHERE ${scope} AND d.usage_date BETWEEN $2 AND $3 GROUP BY 1, 2 ORDER BY 1`,
        [userId, trendFrom, today],
      ),
      db.query(
        `SELECT d.model, sum(d.total_tokens)::bigint AS "totalTokens", sum(d.cost_usd)::float8 AS "costUsd"
           FROM usage_daily d WHERE ${scope} AND d.usage_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 3 DESC NULLS LAST`,
        [userId, month.first, month.last],
      ),
      me.role === 'admin'
        ? db.query(
          `SELECT u.id AS "userId", u.name, u.team, u.monthly_budget_usd::float8 AS "monthlyBudgetUsd",
                  sum(d.total_tokens)::bigint AS "monthTokens", sum(d.cost_usd)::float8 AS "monthCost",
                  ${sumOrZero('d.total_tokens', 'd.usage_date = $1')}::bigint AS "todayTokens"
             FROM usage_daily d JOIN users u ON u.id = d.user_id WHERE d.usage_date BETWEEN $2 AND $3
            GROUP BY u.id ORDER BY "monthCost" DESC NULLS LAST, "monthTokens" DESC NULLS LAST LIMIT 10`,
          [today, month.first, month.last],
        )
        : Promise.resolve({ rows: [] }),
      db.query(
        `SELECT t.id AS "targetId", s.name AS "serverName", t.data_dir AS "dataDir", u.name AS "userName", t.last_status AS "lastStatus",
                t.last_error_code AS "lastErrorCode", t.last_error AS "lastError", t.last_success_at AS "lastSuccessAt", t.consecutive_failures AS "consecutiveFailures"
           FROM collection_targets t JOIN servers s ON s.id = t.server_id JOIN users u ON u.id = t.user_id
          WHERE t.enabled AND s.enabled AND ($1::uuid IS NULL OR t.user_id = $1)
            AND (t.last_status = 'failed' OR (t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR' AND (t.last_success_at IS NULL OR t.last_success_at < $2)))
          ORDER BY t.last_success_at NULLS FIRST LIMIT 50`,
        [userId, staleBefore(settings, now)],
      ),
    ]);

    return {
      freshness: await freshness(userId, settings, now),
      month: monthKey(today),
      totals: totals.rows[0],
      trend: { from: trendFrom, to: today, rows: trend.rows },
      models: models.rows,
      ranking: ranking.rows,
      // 普通用户只看到“我的来源有异常”，不暴露错误细节里的服务器信息
      issues: me.role === 'admin' ? issues.rows : issues.rows.map((i) => ({ targetId: i.targetId, serverName: i.serverName, lastSuccessAt: i.lastSuccessAt, lastStatus: i.lastStatus })),
    };
  });

  app.get('/stats/users/:id', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(400).default(30) }), req.query);
    const userId = scopedUserId(req, id)!;
    const me = currentUser(req);
    const user = (await db.query(
      'SELECT id, name, email, team, role, monthly_budget_usd::float8 AS "monthlyBudgetUsd", is_active AS "isActive" FROM users WHERE id = $1', [userId],
    )).rows[0];
    if (!user) throw notFound('用户');

    const settings = await getGeneralSettings(db);
    const now = new Date();
    const today = dateInTz(now, settings.timezone);
    const month = monthRange(monthKey(today));
    const trendFrom = addDays(today, -(q.days - 1));

    const [totals, trend, models, sources, alerts] = await Promise.all([
      db.query(
        `SELECT ${sumOrZero('total_tokens', 'usage_date = $2')}::bigint AS "todayTokens", ${sumOrZero('cost_usd', 'usage_date = $2')}::float8 AS "todayCost",
                ${sumOrZero('total_tokens')}::bigint AS "monthTokens", ${sumOrZero('cost_usd')}::float8 AS "monthCost"
           FROM usage_daily WHERE user_id = $1 AND usage_date BETWEEN $3 AND $4`,
        [userId, today, month.first, month.last],
      ),
      db.query(
        `SELECT d.usage_date::text AS date, d.server_id AS "serverId", min(s.name) AS "serverName", ${MEASURES}
           FROM usage_daily d JOIN servers s ON s.id = d.server_id
          WHERE d.user_id = $1 AND d.usage_date BETWEEN $2 AND $3 GROUP BY 1, 2 ORDER BY 1`,
        [userId, trendFrom, today],
      ),
      db.query(
        `SELECT d.model, ${MEASURES} FROM usage_daily d WHERE d.user_id = $1 AND d.usage_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY "costUsd" DESC NULLS LAST`,
        [userId, trendFrom, today],
      ),
      // 服务器贡献：按当前绑定列出来源，并附上区间内实际归属给该用户的用量
      db.query(
        `SELECT t.id AS "targetId", s.id AS "serverId", s.name AS "serverName", t.source, t.data_dir AS "dataDir", t.shared_account AS "sharedAccount",
                t.enabled AND s.enabled AS enabled, t.last_success_at AS "lastSuccessAt", t.last_status AS "lastStatus",
                (t.enabled AND s.enabled AND (t.last_status = 'failed' OR (t.last_error_code IS DISTINCT FROM 'NO_DATA_DIR' AND (t.last_success_at IS NULL OR t.last_success_at < $4)))) AS stale,
                x."totalTokens", x."costUsd", COALESCE(x.flagged, false) AS flagged
           FROM collection_targets t JOIN servers s ON s.id = t.server_id
           LEFT JOIN LATERAL (
             SELECT count(*) AS n, ${sumOrZero('d.total_tokens')}::bigint AS "totalTokens", ${sumOrZero('d.cost_usd')}::float8 AS "costUsd", bool_or(d.integrity <> 'complete') AS flagged
               FROM usage_daily d WHERE d.target_id = t.id AND d.user_id = $1 AND d.usage_date BETWEEN $2 AND $3) x ON true
          WHERE t.user_id = $1 OR x.n > 0 ORDER BY s.name, t.data_dir`,
        [userId, trendFrom, today, staleBefore(settings, now)],
      ),
      db.query(
        `SELECT e.id, e.rule_name AS "ruleName", e.metric, e.period_type AS "periodType", e.period_key AS "periodKey", e.tier::float8 AS tier,
                e.observed_value::float8 AS "observedValue", e.threshold_value::float8 AS "thresholdValue", e.incomplete, e.created_at AS "createdAt",
                o.status AS "emailStatus", e.email_note AS "emailNote"
           FROM alert_events e LEFT JOIN email_outbox o ON o.alert_event_id = e.id
          WHERE e.user_id = $1 AND e.kind = 'usage' ORDER BY e.created_at DESC LIMIT 50`,
        [userId],
      ),
    ]);

    return {
      user: me.role === 'admin' || me.id === userId ? user : undefined,
      freshness: await freshness(userId, settings, now),
      month: monthKey(today),
      totals: totals.rows[0],
      trend: { from: trendFrom, to: today, rows: trend.rows },
      models: models.rows,
      sources: sources.rows,
      alerts: alerts.rows,
    };
  });
}
