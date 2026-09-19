import type { Tx } from '../db/pool.js';
import type { GeneralSettings } from '../settings.js';
import { fromMicros, toMicros } from '../util/money.js';
import { addDays, monthKey, monthRange, prevMonth, zonedHourToUtc } from '../util/time.js';
import { renderUsageAlert, type IncompleteSource } from './templates.js';

export interface EvaluateInput {
  userIds: string[];
  /** 本次入库覆盖的最早日期：决定是否需要回看刚结束的日/月周期 */
  touchedSince: string;
  today: string;
  now: Date;
  /** 首次历史回填：默认只评估当前周期，不为历史周期补发提醒 */
  isBackfill: boolean;
  settings: GeneralSettings;
  runId: string | null;
  baseUrl: string;
}

interface Period { type: 'daily' | 'monthly'; key: string; first: string; last: string; ended: boolean }

interface RuleRow {
  id: string; name: string; metric: 'tokens' | 'cost' | 'budget_pct'; period: 'daily' | 'monthly'; source: string | null; scope_type: 'global' | 'team' | 'user';
  tiers: string[]; notify_admins: boolean; extra_emails: string[]; created_at: Date;
}

export function periodsToEvaluate(today: string, touchedSince: string, includeEnded: boolean): Period[] {
  const month = monthKey(today);
  const periods: Period[] = [
    { type: 'daily', key: today, first: today, last: today, ended: false },
    { type: 'monthly', key: month, ...monthRange(month), ended: false },
  ];
  if (!includeEnded) return periods;
  // 跨日、跨月补采：午夜后的采集会更新上一日/上一月最后几小时的用量，需要同时评估刚结束的周期
  const yesterday = addDays(today, -1);
  if (touchedSince <= yesterday) periods.push({ type: 'daily', key: yesterday, first: yesterday, last: yesterday, ended: true });
  const lastMonth = monthRange(prevMonth(month));
  if (touchedSince <= lastMonth.last) periods.push({ type: 'monthly', key: prevMonth(month), ...lastMonth, ended: true });
  return periods;
}

export const messageIdFor = (eventId: string, baseUrl: string) => {
  let host = 'usage-monitor.local';
  try { host = new URL(baseUrl).hostname || host; } catch { /* 保持默认 */ }
  return `<alert-${eventId}@${host}>`;
};

/** 在入库事务内评估告警：告警记录与邮件任务同事务创建，dedupe_key 保证每周期每档位只创建一次。 */
export async function evaluateUsageAlerts(tx: Tx, input: EvaluateInput): Promise<number> {
  const { settings, now } = input;
  const periods = periodsToEvaluate(input.today, input.touchedSince, !input.isBackfill || settings.backfillAlerts);
  let created = 0;

  for (const userId of input.userIds) {
    const user = (await tx.query(
      'SELECT id, name, email, team, monthly_budget_usd::text AS budget, is_active FROM users WHERE id = $1', [userId],
    )).rows[0];
    if (!user) continue;

    const rules = (await tx.query<RuleRow>(
      `SELECT id, name, metric, period, source, scope_type, tiers::text[] AS tiers, notify_admins, extra_emails, created_at
         FROM alert_rules
        WHERE enabled AND (scope_type = 'global' OR (scope_type = 'team' AND scope_team = $2) OR (scope_type = 'user' AND scope_user_id = $1))`,
      [userId, user.team],
    )).rows;
    if (rules.length === 0) continue;

    let incomplete: IncompleteSource[] | undefined;
    const sums = new Map<string, { tokens: string; cost: string; asOf: Date | null }>();

    // 越具体的规则优先：同一指标 + 周期下，给某个用户单独设了规则，就不再对他套用团队/全局规则（团队规则同理优先于全局）
    const SPECIFICITY = { user: 2, team: 1, global: 0 } as const;
    const best = new Map<string, number>();
    for (const r of rules) best.set(`${r.metric}:${r.period}`, Math.max(best.get(`${r.metric}:${r.period}`) ?? 0, SPECIFICITY[r.scope_type]));
    const applicable = rules.filter((r) => SPECIFICITY[r.scope_type] === best.get(`${r.metric}:${r.period}`));

    for (const rule of applicable) {
      for (const period of periods.filter((p) => p.type === rule.period)) {
        // 已结束周期只对周期结束前就存在的规则评估，避免新建规则立刻为过去的周期发信
        if (period.ended && rule.created_at >= zonedHourToUtc(addDays(period.last, 1), 0, settings.timezone)) continue;

        const sumKey = `${period.key}|${rule.source ?? '*'}`;
        let sum = sums.get(sumKey);
        if (!sum) {
          const r = (await tx.query(
            `SELECT COALESCE(sum(total_tokens), 0)::text AS tokens, COALESCE(sum(cost_usd), 0)::text AS cost, max(collected_at) AS as_of
               FROM usage_daily WHERE user_id = $1 AND usage_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR source = $4)`,
            [userId, period.first, period.last, rule.source],
          )).rows[0];
          sum = { tokens: r.tokens, cost: r.cost, asOf: r.as_of };
          sums.set(sumKey, sum);
        }

        const observed = rule.metric === 'tokens' ? toMicros(sum.tokens) : toMicros(sum.cost);
        const budget = rule.metric === 'budget_pct' ? (user.budget as string | null) : null;
        if (rule.metric === 'budget_pct' && (budget === null || toMicros(budget) <= 0n)) continue;

        const crossed = rule.tiers
          .map((tier) => ({ tier, threshold: budget === null ? toMicros(tier) : (toMicros(budget) * toMicros(tier)) / 100_000_000n }))
          .filter((t) => observed >= t.threshold)
          .sort((a, b) => (a.threshold < b.threshold ? -1 : 1));
        if (crossed.length === 0) continue;

        incomplete ??= await findIncompleteSources(tx, userId, now, settings.collectIntervalHours);

        const inserted: Array<{ id: string; tier: string; threshold: bigint }> = [];
        for (const c of crossed) {
          const res = await tx.query(
            `INSERT INTO alert_events
               (kind, dedupe_key, rule_id, rule_name, user_id, metric, period_type, period_key, tier,
                observed_value, threshold_value, data_as_of, incomplete, incomplete_detail, run_id, source)
             VALUES ('usage', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
            [
              `usage:${userId}:${rule.id}:${period.key}:${Number(c.tier)}`, rule.id, rule.name, userId, rule.metric, period.type, period.key, c.tier,
              fromMicros(observed), fromMicros(c.threshold), sum.asOf ?? now, incomplete.length > 0, JSON.stringify(incomplete), input.runId, rule.source,
            ],
          );
          if (res.rows[0]) inserted.push({ id: res.rows[0].id, tier: c.tier, threshold: c.threshold });
        }
        if (inserted.length === 0) continue;
        created += inserted.length;

        // 一次评估同时跨过多个档位（如 80% 和 100%）时只为最高档位发信，低档位留痕
        const top = inserted[inserted.length - 1]!;
        for (const lower of inserted.slice(0, -1)) {
          await tx.query("UPDATE alert_events SET email_note = '同次评估已触发更高档位，未单独发信' WHERE id = $1", [lower.id]);
        }

        const recipients = await resolveRecipients(tx, rule);
        if (recipients.length === 0) {
          await tx.query("UPDATE alert_events SET email_note = '没有可用的收件人' WHERE id = $1", [top.id]);
          continue;
        }
        const mail = renderUsageAlert({
          userId, userName: user.name, ruleName: rule.name, source: rule.source, metric: rule.metric, periodType: period.type, periodKey: period.key,
          tier: top.tier, observed: rule.metric === 'tokens' ? sum.tokens : sum.cost,
          threshold: rule.metric === 'tokens' ? String(top.threshold / 1_000_000n) : fromMicros(top.threshold),
          budget, dataAsOf: sum.asOf ?? now, timezone: settings.timezone, intervalHours: settings.collectIntervalHours,
          incomplete, baseUrl: input.baseUrl,
        });
        await tx.query(
          'INSERT INTO email_outbox (alert_event_id, message_id, to_addrs, subject, body_text) VALUES ($1, $2, $3, $4, $5)',
          [top.id, messageIdFor(top.id, input.baseUrl), recipients, mail.subject, mail.text],
        );
      }
    }
  }
  return created;
}

/** 用户名下尚未按期更新的来源：超过两个采集周期没有成功，或最近一次失败。 */
export async function findIncompleteSources(tx: Tx, userId: string, now: Date, intervalHours: number): Promise<IncompleteSource[]> {
  const staleBefore = new Date(now.getTime() - 2 * intervalHours * 3_600_000);
  const res = await tx.query(
    `SELECT s.name AS server, t.data_dir, t.last_success_at
       FROM collection_targets t JOIN servers s ON s.id = t.server_id
      WHERE t.user_id = $1 AND t.enabled AND s.enabled
        AND (t.last_success_at IS NULL OR t.last_success_at < $2 OR t.last_status = 'failed')
      ORDER BY s.name, t.data_dir`,
    [userId, staleBefore],
  );
  return res.rows.map((r) => ({ server: r.server, dataDir: r.data_dir, lastSuccessAt: r.last_success_at?.toISOString() ?? null }));
}

export async function adminEmails(tx: Tx): Promise<string[]> {
  return (await tx.query("SELECT email FROM users WHERE role = 'admin' AND is_active AND email IS NOT NULL ORDER BY email")).rows.map((r) => r.email);
}

/** 收件人：管理员 + 规则里额外指定的邮箱。被统计的用户不登录网页，也不直接收告警邮件。 */
async function resolveRecipients(tx: Tx, rule: RuleRow): Promise<string[]> {
  const out = new Set<string>();
  if (rule.notify_admins) for (const e of await adminEmails(tx)) out.add(e.toLowerCase());
  for (const e of rule.extra_emails) out.add(e.toLowerCase());
  return [...out];
}
