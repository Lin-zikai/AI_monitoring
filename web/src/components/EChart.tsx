import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

// 按需注册：本项目只用到柱状图
echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props { option: EChartsCoreOption; height?: number; ariaLabel?: string }

/** ECharts 的最小 React 包装：随容器尺寸自适应，卸载时释放实例。 */
export function EChart({ option, height = 320, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge：筛选条件变化导致系列增减时，不残留旧系列
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ width: '100%', height }} />;
}
