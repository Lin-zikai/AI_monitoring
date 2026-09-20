import { Empty } from 'antd';
import type { EChartsCoreOption } from 'echarts/core';
import { useMemo } from 'react';
import { compact, escapeHtml, fmtCost, fmtFull, fmtMoney, fmtMoneyCompact } from '../format';
import { useIsMobile } from '../responsive';
import { EChart } from './EChart';

// 图表规范（dataviz）：分类色按固定顺序分配、颜色跟随实体而非名次；超过 8 个系列折叠为“其他”；
// 单一 y 轴；网格与坐标轴用弱化的细实线；文字只用文字色；tooltip 一次列出该位置的全部系列。
// 该配色已用 validate_palette.js 在白色底面上校验通过（浅色 3 个槽位对比度 < 3:1，故每张图都配有明细表）。
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#898781';
const OTHER_KEY = '__other__';
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#ffffff' };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// 实体 → 色槽：幸存的系列保持原色，筛选变化不会让它们换色；本次渲染里已不存在的系列交还色槽，
// 这样新出现的系列总能拿到颜色（同一张图最多 8 个系列，色槽不会用尽），而不是永久落到“其他”的灰色上。
const slotRegistry = new Map<string, Map<string, number>>();
function colorsFor(namespace: string, keys: string[], palette: readonly string[] = SERIES_COLORS): string[] {
  let slots = slotRegistry.get(namespace);
  if (!slots) { slots = new Map(); slotRegistry.set(namespace, slots); }
  const present = new Set(keys);
  for (const k of [...slots.keys()]) if (!present.has(k)) slots.delete(k);
  return keys.map((key) => {
    if (key === OTHER_KEY) return OTHER_COLOR;
    let slot = slots.get(key);
    if (slot === undefined) {
      const used = new Set(slots.values());
      slot = palette.findIndex((_, i) => !used.has(i));
      if (slot < 0) return OTHER_COLOR; // 调用方保证系列数不超过色板长度，这里只是兜底
      slots.set(key, slot);
    }
    return palette[slot] ?? OTHER_COLOR;
  });
}

/** 色板里从第 start 个开始的 count 个颜色：并排的几张图各用一段，整体不重色（如 Claude Code 用前两个、Codex 用后两个） */
export const paletteSlice = (start: number, count: number): string[] => SERIES_COLORS.slice(start, start + count);
/** 同一色板换个起点：并排的图各自的头几个系列不撞色 */
export const paletteFrom = (start: number): string[] => [...SERIES_COLORS.slice(start), ...SERIES_COLORS.slice(0, start)];

export type ChartMetric = 'tokens' | 'cost';
const fmtValue = (metric: ChartMetric, v: number) => (metric === 'cost' ? fmtCost(v) : `${fmtFull(v)} Token`);
const axisFmt = (metric: ChartMetric) => (v: number) => (metric === 'cost' ? `$${compact(v)}` : compact(v));

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 1000; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// 触屏：点按 / 按住滑动显示 tooltip；confine 让它不超出图表容器（否则会把页面撑出横向滚动）；内容过长时在框内换行
const MOBILE_TOOLTIP = { confine: true, triggerOn: 'mousemove|click' as const, enterable: false, padding: 8, extraCssText: 'max-width:calc(100vw - 48px);white-space:normal;font-size:11px;line-height:1.5;' };

const baseAxisStyle = {
  axisLine: { lineStyle: { color: INK.axis } },
  axisTick: { show: false },
  axisLabel: { color: INK.muted, fontFamily: FONT },
  splitLine: { lineStyle: { color: INK.grid, type: 'solid' as const, width: 1 } },
};

export interface TrendPoint { date: string; seriesKey: string; seriesLabel: string; value: number | null }

/**
 * 按日堆叠柱状图（按模型 / 服务器等维度堆叠）。没有记录的日期按 0 处理；值为未知（null）的点留空。
 * topN：只画用量最多的 N 个系列，其余的不画、也不折叠成“其他”（tooltip 里的合计仍是全部系列之和）；
 * 不给 topN 时超过 8 个系列才把尾部折叠为“其他”。palette：这张图可用的颜色（默认整个分类色板）。
 */
export function StackedTrendChart({ points, from, to, metric, namespace, height = 340, topN, palette, emptyText = '所选范围内没有用量记录', ariaLabel = '按日用量趋势' }: {
  points: TrendPoint[]; from: string; to: string; metric: ChartMetric; namespace: string; height?: number;
  topN?: number; palette?: readonly string[]; emptyText?: string; ariaLabel?: string;
}) {
  // 手机：图矮一些；图例移到底部并可左右翻页（不挤占绘图区上方）；边距收紧；tooltip 限制在图表容器内
  const isMobile = useIsMobile();
  const option = useMemo<EChartsCoreOption | null>(() => {
    if (points.length === 0) return null;
    const dates = datesBetween(from, to);
    const totals = new Map<string, { label: string; total: number }>();
    for (const p of points) {
      const t = totals.get(p.seriesKey) ?? { label: p.seriesLabel, total: 0 };
      t.total += p.value ?? 0;
      totals.set(p.seriesKey, t);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1].total - a[1].total);
    const colors = palette ?? SERIES_COLORS;
    const keep = topN ? ranked.slice(0, Math.min(topN, colors.length)) : ranked.length > colors.length ? ranked.slice(0, colors.length - 1) : ranked;
    const keepKeys = new Set(keep.map(([k]) => k));
    const seriesDefs = keep.map(([key, v]) => ({ key, label: v.label }));
    if (!topN && ranked.length > keep.length) seriesDefs.push({ key: OTHER_KEY, label: '其他' });

    // 每天全部系列的合计：只画前 N 个时，tooltip 里仍给出当天的真实总量
    const dayTotals = new Map<string, number>();
    const grid = new Map<string, Map<string, number | null>>();
    for (const p of points) {
      dayTotals.set(p.date, (dayTotals.get(p.date) ?? 0) + (p.value ?? 0));
      if (topN && !keepKeys.has(p.seriesKey)) continue;
      const key = keepKeys.has(p.seriesKey) ? p.seriesKey : OTHER_KEY;
      const row = grid.get(key) ?? new Map<string, number | null>();
      const prev = row.get(p.date);
      row.set(p.date, p.value === null ? (prev ?? null) : (prev ?? 0) + p.value);
      grid.set(key, row);
    }

    return {
      textStyle: { fontFamily: FONT },
      color: colorsFor(namespace, seriesDefs.map((s) => s.key), colors),
      // 单系列不需要图例，标题已说明内容
      legend: seriesDefs.length > 1
        ? (isMobile
          ? { type: 'scroll', bottom: 0, left: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12, pageIconSize: 12, pageButtonItemGap: 4, textStyle: { color: INK.secondary, fontSize: 11 }, pageTextStyle: { color: INK.muted, fontSize: 11 } }
          : { type: 'scroll', top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: INK.secondary } })
        : undefined,
      grid: isMobile
        ? { left: 4, right: 8, top: 12, bottom: seriesDefs.length > 1 ? 32 : 4, containLabel: true }
        : { left: 8, right: 16, top: seriesDefs.length > 1 ? 40 : 16, bottom: 8, containLabel: true },
      tooltip: {
        confine: true, // 并排的小图：tooltip 留在图表容器里，不盖到旁边的图或被卡片裁掉
        ...(isMobile ? MOBILE_TOOLTIP : {}),
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(11,11,11,0.04)' } },
        backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.10)', textStyle: { color: INK.primary, fontFamily: FONT, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (params as Array<{ axisValue: string; axisValueLabel: string; seriesName: string; value: number | string; color: string }>);
          if (!items.length) return '';
          const present = items.filter((i) => typeof i.value === 'number' && i.value > 0).sort((a, b) => Number(b.value) - Number(a.value));
          const total = topN ? (dayTotals.get(items[0]!.axisValue) ?? 0) : present.reduce((acc, i) => acc + Number(i.value), 0);
          const rows = present.map((i) =>
            `<div style="display:flex;justify-content:space-between;gap:24px"><span><span style="display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:${i.color}"></span><span style="color:${INK.secondary}">${escapeHtml(i.seriesName)}</span></span><b style="white-space:nowrap">${fmtValue(metric, Number(i.value))}</b></div>`);
          return `<div style="margin-bottom:4px;color:${INK.secondary}">${escapeHtml(items[0]!.axisValueLabel)}</div>`
            + `<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:4px"><span>${topN ? '当日合计' : '合计'}${metric === 'cost' ? '（估算）' : ''}</span><b style="white-space:nowrap">${fmtValue(metric, total)}</b></div>${rows.join('')}`;
        },
      },
      xAxis: { type: 'category', data: dates, ...baseAxisStyle, splitLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, ...(isMobile ? { fontSize: 10, hideOverlap: true, interval: 'auto' } : {}), ...(dates.length <= 10 ? { interval: 0 } : {}), formatter: (d: string) => d.slice(5) } },
      yAxis: { type: 'value', ...baseAxisStyle, ...(isMobile ? { splitNumber: 4 } : {}), axisLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, ...(isMobile ? { fontSize: 10 } : {}), formatter: axisFmt(metric) } },
      series: seriesDefs.map((s) => ({
        name: s.label, type: 'bar', stack: 'total', barMaxWidth: dates.length <= 10 ? 40 : 24,
        // 用底面色描边形成堆叠段之间的 2px 间隙
        itemStyle: { borderColor: INK.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
        data: dates.map((d) => { const v = grid.get(s.key)?.get(d); return v === null ? '-' : (v ?? 0); }),
      })),
    };
  }, [points, from, to, metric, namespace, isMobile, topN, palette]);

  if (!option) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} style={{ padding: '48px 0' }} />;
  return <EChart option={option} height={isMobile ? Math.min(height, 260) : height} ariaLabel={ariaLabel} />;
}

/** 账目明细的类别色：固定顺序、固定颜色（取自上面的分类色板，已用 validate_palette.js 校验，色觉障碍下可区分）；页面里的类别标记也用它 */
export const LEDGER_SERIES = [
  { key: 'vpn', label: 'VPN', color: '#4a3aa7' },
  { key: 'claude-code', label: 'Claude Code', color: '#2a78d6' },
  { key: 'codex', label: 'Codex', color: '#1baf7a' },
] as const;
export type LedgerSeriesKey = typeof LEDGER_SERIES[number]['key'];

/** 每月支出：一年 12 个月的堆叠柱状图。values 已换算成显示币种；某类别全年为 0 时仍保留图例，颜色与位置不变 */
export function MonthlyStackChart({ year, values, currency, height = 320 }: {
  year: number; values: Record<LedgerSeriesKey, number[]>; currency: 'CNY' | 'USD'; height?: number;
}) {
  const isMobile = useIsMobile();
  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!LEDGER_SERIES.some((s) => values[s.key].some((v) => v > 0))) return null;
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    return {
      textStyle: { fontFamily: FONT },
      color: LEDGER_SERIES.map((s) => s.color),
      legend: isMobile
        ? { bottom: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12, textStyle: { color: INK.secondary, fontSize: 11 } }
        : { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: INK.secondary } },
      grid: isMobile ? { left: 4, right: 8, top: 12, bottom: 32, containLabel: true } : { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      tooltip: {
        confine: true,
        ...(isMobile ? MOBILE_TOOLTIP : {}),
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(11,11,11,0.04)' } },
        backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.10)', textStyle: { color: INK.primary, fontFamily: FONT, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (params as Array<{ axisValue: string; seriesName: string; value: number; color: string }>);
          if (!items.length) return '';
          const present = items.filter((i) => i.value > 0); // 保持类别的固定顺序，不按金额重排
          const total = present.reduce((acc, i) => acc + i.value, 0);
          const rows = present.map((i) =>
            `<div style="display:flex;justify-content:space-between;gap:24px"><span><span style="display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:${i.color}"></span><span style="color:${INK.secondary}">${escapeHtml(i.seriesName)}</span></span><b style="white-space:nowrap">${fmtMoney(i.value, currency)}</b></div>`);
          return `<div style="margin-bottom:4px;color:${INK.secondary}">${year} 年 ${Number(items[0]!.axisValue)} 月</div>`
            + (present.length === 0 ? `<span style="color:${INK.muted}">没有账单</span>`
              : `<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:4px"><span>合计</span><b style="white-space:nowrap">${fmtMoney(total, currency)}</b></div>${rows.join('')}`);
        },
      },
      xAxis: { type: 'category', data: months, ...baseAxisStyle, splitLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, interval: 0, ...(isMobile ? { fontSize: 10 } : {}) } },
      yAxis: { type: 'value', ...baseAxisStyle, ...(isMobile ? { splitNumber: 4 } : {}), axisLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, ...(isMobile ? { fontSize: 10 } : {}), formatter: (v: number) => fmtMoneyCompact(v, currency) } },
      series: LEDGER_SERIES.map((s) => ({
        name: s.label, type: 'bar', stack: 'total', barMaxWidth: 40,
        itemStyle: { borderColor: INK.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
        data: values[s.key].map((v) => Math.round(v * 100) / 100),
      })),
    };
  }, [year, values, currency, isMobile]);

  if (!option) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${year} 年还没有账单`} style={{ padding: '48px 0' }} />;
  return <EChart option={option} height={isMobile ? Math.min(height, 260) : height} ariaLabel={`${year} 年每月支出`} />;
}

export interface RankItem { key: string; label: string; value: number | null }

/** 横向条形图：占比 / 排名。单一色相、无图例，数值标在条形末端。 */
export function RankBarChart({ items, metric, max = 10 }: { items: RankItem[]; metric: ChartMetric; max?: number }) {
  const isMobile = useIsMobile();
  const data = useMemo(() => items.filter((i) => i.value !== null && i.value > 0).sort((a, b) => b.value! - a.value!).slice(0, max), [items, max]);
  const option = useMemo<EChartsCoreOption>(() => ({
    textStyle: { fontFamily: FONT },
    grid: { left: isMobile ? 4 : 8, right: isMobile ? 56 : 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      ...(isMobile ? MOBILE_TOOLTIP : {}),
      trigger: 'item', backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.10)', textStyle: { color: INK.primary, fontFamily: FONT, fontSize: 12 },
      formatter: (p: unknown) => { const i = p as { name: string; value: number }; return `<span style="color:${INK.secondary}">${escapeHtml(i.name)}</span><br/><b>${fmtValue(metric, i.value)}</b>`; },
    },
    // 横向条形图常放在窄卡片里：减少刻度并隐藏重叠标签
    xAxis: { type: 'value', ...baseAxisStyle, splitNumber: 3, axisLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, hideOverlap: true, formatter: axisFmt(metric) } },
    yAxis: {
      type: 'category', inverse: true, data: data.map((d) => d.label), ...baseAxisStyle, splitLine: { show: false },
      // 手机上类目名（模型 / 主机名）最多占约三分之一宽度，超出截断；完整名称在 tooltip 里
      axisLabel: { color: INK.secondary, fontFamily: FONT, width: isMobile ? 132 : 150, overflow: 'truncate', ...(isMobile ? { fontSize: 10 } : {}) },
    },
    series: [{
      type: 'bar', barMaxWidth: 18, data: data.map((d) => d.value),
      itemStyle: { color: SERIES_COLORS[0], borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: INK.secondary, fontFamily: FONT, formatter: (p: { value: number }) => (metric === 'cost' ? `$${compact(p.value)}` : compact(p.value)) },
    }],
  }), [data, metric, isMobile]);

  if (data.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: '48px 0' }} />;
  return <EChart option={option} height={Math.max(isMobile ? 120 : 160, data.length * (isMobile ? 30 : 34) + 40)} ariaLabel="用量分布" />;
}
