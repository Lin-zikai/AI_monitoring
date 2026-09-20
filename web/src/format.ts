import type { AlertMetric, AlertPeriod, NumLike } from './types';

// 显示时区：Layout 在 /meta 返回后、渲染任何页面之前设置；时区变更时 Layout 会重新挂载页面，所以这里不需要是响应式的
let displayTz = 'Asia/Shanghai';
export const setDisplayTz = (tz: string) => { displayTz = tz; };

export const UNKNOWN = '未知';

/** 后台聚合值可能是 number、数字字符串或 null。0 就是 0（没有用量）；只有 null / 无法解析才是“未知”。 */
export function num(v: NumLike | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const trim = (s: string) => s.replace(/\.?0+$/, '');

/** 万/亿缩写；完整值请配合 fmtFull 放在 tooltip 里。 */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${trim((n / 1e8).toFixed(2))}亿`;
  if (abs >= 1e4) return `${trim((n / 1e4).toFixed(1))}万`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export const fmtTokens = (v: NumLike | undefined) => { const n = num(v); return n === null ? UNKNOWN : compact(n); };
export const fmtFull = (v: NumLike | undefined) => { const n = num(v); return n === null ? UNKNOWN : n.toLocaleString('en-US'); };
export const fmtCost = (v: NumLike | undefined) => {
  const n = num(v);
  return n === null ? UNKNOWN : `US$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export function fmtTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: displayTz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ''}`;
}

export function budgetPct(cost: NumLike | undefined, budget: number | null | undefined): number | null {
  const c = num(cost);
  if (c === null || !budget || budget <= 0) return null;
  return Math.floor((c / budget) * 100);
}

export const METRIC_LABEL = { tokens: 'Token 用量', cost: '估算费用', budget_pct: '月预算百分比' } as const;
export const PERIOD_LABEL = { daily: '每日', monthly: '每月' } as const;

// 告警记录里还会出现账号额度提醒的指标 / 窗口；未收录的值原样显示，不让页面崩掉
const ALERT_METRIC_LABEL: Record<string, string> = { ...METRIC_LABEL, limit_used_pct: '额度已用比例' };
const ALERT_PERIOD_LABEL: Record<string, string> = { ...PERIOD_LABEL, five_hour: '5 小时', weekly: '周' };
export const alertMetricLabel = (m: AlertMetric | null | undefined) => (m ? ALERT_METRIC_LABEL[m] ?? m : '');
// Codex 的额度窗口按时长区分，键形如 seven_day_10080m / five_hour_2：按前缀归到同一个名称下
const LIMIT_WINDOW_PREFIX: Array<[string, string]> = [['seven_day_opus', '周 · Opus'], ['seven_day_sonnet', '周 · Sonnet'], ['five_hour', '5 小时'], ['seven_day', '周'], ['weekly', '周']];
export const alertPeriodLabel = (p: AlertPeriod | null | undefined) => (p ? ALERT_PERIOD_LABEL[p] ?? LIMIT_WINDOW_PREFIX.find(([prefix]) => p.startsWith(prefix))?.[1] ?? p : '');

export function fmtMetricValue(metric: AlertMetric | null, v: number | null): string {
  if (v === null) return '—';
  if (metric === 'limit_used_pct') return `已用 ${v}%`;
  return metric === 'tokens' ? fmtFull(v) : fmtCost(v);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
