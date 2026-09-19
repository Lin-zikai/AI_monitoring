import type { NumLike } from './types';

let displayTz = 'Asia/Shanghai';
export const setDisplayTz = (tz: string) => { displayTz = tz; };
export const getDisplayTz = () => displayTz;

export const UNKNOWN = '未知';

/** 后台聚合值可能是 number、数字字符串或 null（未知）。 */
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

export function fmtMetricValue(metric: 'tokens' | 'cost' | 'budget_pct' | null, v: number | null): string {
  if (v === null) return '—';
  return metric === 'tokens' ? fmtFull(v) : fmtCost(v);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
