// 费用使用定点数：数据库 numeric(18,6)，进程内以“百万分之一”为单位的 BigInt 比较，避免浮点误差。

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function toMicros(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toFixed(6) : value.trim();
  if (!DECIMAL.test(s)) throw new Error(`无效的定点数: ${s}`);
  const negative = s.startsWith('-');
  const [int = '0', frac = ''] = s.replace('-', '').split('.');
  const micros = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
  return negative ? -micros : micros;
}

export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const s = `${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, '0')}`;
  return negative ? `-${s}` : s;
}

/** ccusage 输出的浮点费用 → 6 位定点字符串；缺失为 null（未知，不当作零）。 */
export function costToFixed(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const fixed = value.toFixed(6);
  return fixed === '-0.000000' ? '0.000000' : fixed;
}

export function formatUsd(value: string | number | null): string {
  if (value === null) return '未知';
  return `US$ ${Number(value).toFixed(2)}`;
}
