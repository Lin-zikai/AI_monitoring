import type { BillCategory, BillCurrency, BillSummary } from '../../types';

export const CATEGORY_LABEL: Record<BillCategory, string> = { vpn: 'VPN', 'claude-code': 'Claude Code', codex: 'Codex' };
export const CURRENCY_NAME: Record<BillCurrency, string> = { CNY: '人民币', USD: '美元' };

/** 按“1 美元 = usdCny 元”换算；同币种原样返回 */
export function convert(amount: number, from: BillCurrency, to: BillCurrency, usdCny: number): number {
  if (from === to) return amount;
  return from === 'USD' ? amount * usdCny : amount / usdCny;
}

/** localStorage 只是“记住上次的选择”：隐私模式 / 被禁用时读写都可能抛错，页面照常工作 */
export function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
export function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 记不住就算了 */ }
}

export interface MonthRow {
  month: string;
  /** 各类别当月实付（已换算成显示币种）；没有账单为 null */
  paid: Record<BillCategory, number | null>;
  total: number | null;
  count: number;
  /** 用到了汇率换算（有账单的原币种与显示币种不同） */
  converted: boolean;
  /** ccusage 估算的 Claude Code + Codex 同期用量价值；没有用量记录为 null */
  estimated: number | null;
  /** 订阅省下 = 按量估算 − AI 实付；当月没有 AI 账单时不算 */
  saved: number | null;
}

export interface YearStats { rows: MonthRow[]; totals: MonthRow; billMonths: number }

const sumOrNull = (values: Array<number | null>): number | null => (values.every((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0));

/** 把汇总接口的 12 个月换算成显示币种，并给出全年合计 */
export function yearStats(summary: BillSummary, display: BillCurrency): YearStats {
  const rows = summary.months.map((m): MonthRow => {
    const paid: MonthRow['paid'] = { vpn: null, 'claude-code': null, codex: null };
    let count = 0;
    let converted = false;
    for (const item of m.items) {
      paid[item.category] = (paid[item.category] ?? 0) + convert(item.amount, item.currency, display, summary.usdCny);
      count += item.count;
      if (item.currency !== display) converted = true;
    }
    const estimatedUsd = sumOrNull([m.estimatedUsd['claude-code'], m.estimatedUsd.codex]);
    const estimated = estimatedUsd === null ? null : convert(estimatedUsd, 'USD', display, summary.usdCny);
    const aiPaid = sumOrNull([paid['claude-code'], paid.codex]);
    return { month: m.month, paid, total: sumOrNull([paid.vpn, paid['claude-code'], paid.codex]), count, converted, estimated, saved: aiPaid === null || estimated === null ? null : estimated - aiPaid };
  });
  const col = (pick: (r: MonthRow) => number | null) => sumOrNull(rows.map(pick));
  const totals: MonthRow = {
    month: String(summary.year),
    paid: { vpn: col((r) => r.paid.vpn), 'claude-code': col((r) => r.paid['claude-code']), codex: col((r) => r.paid.codex) },
    total: col((r) => r.total), count: rows.reduce((a, r) => a + r.count, 0), converted: rows.some((r) => r.converted),
    estimated: col((r) => r.estimated), saved: col((r) => r.saved),
  };
  return { rows, totals, billMonths: rows.filter((r) => r.total !== null).length };
}
