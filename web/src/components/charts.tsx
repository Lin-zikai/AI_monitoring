import { Empty } from 'antd';
import type { EChartsCoreOption } from 'echarts/core';
import { useMemo } from 'react';
import { compact, escapeHtml, fmtCost, fmtFull } from '../format';
import { EChart } from './EChart';

// 图表规范（dataviz）：分类色按固定顺序分配、颜色跟随实体而非名次；超过 8 个系列折叠为“其他”；
// 单一 y 轴；网格与坐标轴用弱化的细实线；文字只用文字色；tooltip 一次列出该位置的全部系列。
// 该配色已用 validate_palette.js 在白色底面上校验通过（浅色 3 个槽位对比度 < 3:1，故每张图都配有明细表）。
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#898781';
const OTHER_KEY = '__other__';
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#ffffff' };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// 实体 → 色槽：首次出现时分配并在会话内保持，筛选变化不会让幸存系列换色
const slotRegistry = new Map<string, Map<string, number>>();
function colorFor(namespace: string, key: string): string {
  if (key === OTHER_KEY) return OTHER_COLOR;
  let slots = slotRegistry.get(namespace);
  if (!slots) { slots = new Map(); slotRegistry.set(namespace, slots); }
  let slot = slots.get(key);
  if (slot === undefined) {
    const used = new Set(slots.values());
    slot = SERIES_COLORS.findIndex((_, i) => !used.has(i));
    if (slot < 0) return OTHER_COLOR; // 8 个色槽用尽：不生成新色相
    slots.set(key, slot);
  }
  return SERIES_COLORS[slot]!;
}

export type ChartMetric = 'tokens' | 'cost';
const fmtValue = (metric: ChartMetric, v: number) => (metric === 'cost' ? fmtCost(v) : `${fmtFull(v)} Token`);
const axisFmt = (metric: ChartMetric) => (v: number) => (metric === 'cost' ? `$${compact(v)}` : compact(v));

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 1000; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const baseAxisStyle = {
  axisLine: { lineStyle: { color: INK.axis } },
  axisTick: { show: false },
  axisLabel: { color: INK.muted, fontFamily: FONT },
  splitLine: { lineStyle: { color: INK.grid, type: 'solid' as const, width: 1 } },
};

export interface TrendPoint { date: string; seriesKey: string; seriesLabel: string; value: number | null }

/** 按日堆叠柱状图（按模型 / 服务器等维度堆叠）。没有记录的日期按 0 处理；值为未知（null）的点留空。 */
export function StackedTrendChart({ points, from, to, metric, namespace, height = 340 }: {
  points: TrendPoint[]; from: string; to: string; metric: ChartMetric; namespace: string; height?: number;
}) {
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
    const keep = ranked.length > 8 ? ranked.slice(0, 7) : ranked;
    const keepKeys = new Set(keep.map(([k]) => k));
    const seriesDefs = keep.map(([key, v]) => ({ key, label: v.label }));
    if (ranked.length > keep.length) seriesDefs.push({ key: OTHER_KEY, label: '其他' });

    const grid = new Map<string, Map<string, number | null>>();
    for (const p of points) {
      const key = keepKeys.has(p.seriesKey) ? p.seriesKey : OTHER_KEY;
      const row = grid.get(key) ?? new Map<string, number | null>();
      const prev = row.get(p.date);
      row.set(p.date, p.value === null ? (prev ?? null) : (prev ?? 0) + p.value);
      grid.set(key, row);
    }

    return {
      textStyle: { fontFamily: FONT },
      color: seriesDefs.map((s) => colorFor(namespace, s.key)),
      // 单系列不需要图例，标题已说明内容
      legend: seriesDefs.length > 1 ? { type: 'scroll', top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: INK.secondary } } : undefined,
      grid: { left: 8, right: 16, top: seriesDefs.length > 1 ? 40 : 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(11,11,11,0.04)' } },
        backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.10)', textStyle: { color: INK.primary, fontFamily: FONT, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (params as Array<{ axisValueLabel: string; seriesName: string; value: number | string; color: string }>);
          if (!items.length) return '';
          const present = items.filter((i) => typeof i.value === 'number' && i.value > 0).sort((a, b) => Number(b.value) - Number(a.value));
          const total = present.reduce((acc, i) => acc + Number(i.value), 0);
          const rows = present.map((i) =>
            `<div style="display:flex;justify-content:space-between;gap:24px"><span><span style="display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:${i.color}"></span><span style="color:${INK.secondary}">${escapeHtml(i.seriesName)}</span></span><b>${fmtValue(metric, Number(i.value))}</b></div>`);
          return `<div style="margin-bottom:4px;color:${INK.secondary}">${escapeHtml(items[0]!.axisValueLabel)}</div>`
            + `<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:4px"><span>合计${metric === 'cost' ? '（估算）' : ''}</span><b>${fmtValue(metric, total)}</b></div>${rows.join('')}`;
        },
      },
      xAxis: { type: 'category', data: dates, ...baseAxisStyle, splitLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, formatter: (d: string) => d.slice(5) } },
      yAxis: { type: 'value', ...baseAxisStyle, axisLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, formatter: axisFmt(metric) } },
      series: seriesDefs.map((s) => ({
        name: s.label, type: 'bar', stack: 'total', barMaxWidth: 24,
        // 用底面色描边形成堆叠段之间的 2px 间隙
        itemStyle: { borderColor: INK.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
        data: dates.map((d) => { const v = grid.get(s.key)?.get(d); return v === null ? '-' : (v ?? 0); }),
      })),
    };
  }, [points, from, to, metric, namespace]);

  if (!option) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围内没有用量记录" style={{ padding: '48px 0' }} />;
  return <EChart option={option} height={height} ariaLabel="按日用量趋势" />;
}

export interface RankItem { key: string; label: string; value: number | null }

/** 横向条形图：占比 / 排名。单一色相、无图例，数值标在条形末端。 */
export function RankBarChart({ items, metric, max = 10 }: { items: RankItem[]; metric: ChartMetric; max?: number }) {
  const data = useMemo(() => items.filter((i) => i.value !== null && i.value > 0).sort((a, b) => b.value! - a.value!).slice(0, max), [items, max]);
  const option = useMemo<EChartsCoreOption>(() => ({
    textStyle: { fontFamily: FONT },
    grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item', backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.10)', textStyle: { color: INK.primary, fontFamily: FONT, fontSize: 12 },
      formatter: (p: unknown) => { const i = p as { name: string; value: number }; return `<span style="color:${INK.secondary}">${escapeHtml(i.name)}</span><br/><b>${fmtValue(metric, i.value)}</b>`; },
    },
    // 横向条形图常放在窄卡片里：减少刻度并隐藏重叠标签
    xAxis: { type: 'value', ...baseAxisStyle, splitNumber: 3, axisLine: { show: false }, axisLabel: { ...baseAxisStyle.axisLabel, hideOverlap: true, formatter: axisFmt(metric) } },
    yAxis: {
      type: 'category', inverse: true, data: data.map((d) => d.label), ...baseAxisStyle, splitLine: { show: false },
      axisLabel: { color: INK.secondary, fontFamily: FONT, width: 150, overflow: 'truncate' },
    },
    series: [{
      type: 'bar', barMaxWidth: 18, data: data.map((d) => d.value),
      itemStyle: { color: SERIES_COLORS[0], borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: INK.secondary, fontFamily: FONT, formatter: (p: { value: number }) => (metric === 'cost' ? `$${compact(p.value)}` : compact(p.value)) },
    }],
  }), [data, metric]);

  if (data.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: '48px 0' }} />;
  return <EChart option={option} height={Math.max(160, data.length * 34 + 40)} ariaLabel="用量分布" />;
}
