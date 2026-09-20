// 统计时区下的日期运算。日期统一用 'YYYY-MM-DD' 字符串，时间点用 Date（UTC）。

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFmtCache.set(tz, fmt);
  }
  return fmt;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function localParts(at: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as unknown as LocalParts;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function dateInTz(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatInTz(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export const minDate = (a: string, b: string) => (a <= b ? a : b);
export const maxDate = (a: string, b: string) => (a >= b ? a : b);
export const compactDate = (date: string) => date.replaceAll('-', '');
export const monthKey = (date: string) => date.slice(0, 7);

export function monthRange(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${pad(last)}` };
}

export function prevMonth(month: string): string {
  return monthKey(addDays(`${month}-01`, -1));
}

/** ISO 8601 周编号，如 '2026-W38'：周一为一周之始，跨年的那一周按周四所在年份归属。 */
export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

/** 时区本地的整点时刻 → UTC 时间点（二次校正以覆盖夏令时切换）。 */
export function zonedHourToUtc(date: string, hour: number, tz: string): Date {
  const naive = Date.parse(`${date}T${pad(hour)}:00:00Z`);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  let t = naive - offsetAt(naive);
  t = naive - offsetAt(t);
  return new Date(t);
}

/** 调度时点：统计时区每日 00:00 起每 intervalHours 小时一个批次。 */
export function latestSlot(now: Date, tz: string, intervalHours: number): Date {
  const p = localParts(now, tz);
  const hour = Math.floor(p.hour / intervalHours) * intervalHours;
  return zonedHourToUtc(dateInTz(now, tz), hour, tz);
}

export function nextSlot(now: Date, tz: string, intervalHours: number): Date {
  const p = localParts(now, tz);
  const hour = (Math.floor(p.hour / intervalHours) + 1) * intervalHours;
  const today = dateInTz(now, tz);
  return hour >= 24 ? zonedHourToUtc(addDays(today, 1), 0, tz) : zonedHourToUtc(today, hour, tz);
}
