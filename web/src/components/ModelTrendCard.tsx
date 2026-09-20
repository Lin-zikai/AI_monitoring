import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Row, Segmented, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { num } from '../format';
import { useFetch } from '../hooks';
import { useIsMobile } from '../responsive';
import type { ModelTrend } from '../types';
import { paletteFrom, paletteSlice, StackedTrendChart, type ChartMetric } from './charts';

// 一周视图：两张图各只画用量最多的 2 个模型，Claude Code 用色板前两色、Codex 用后两色，整张卡片一共 4 种颜色。
// 30 / 90 天视图：画出全部模型，两张图从色板的不同位置起用，头几个模型不撞色。
const SOURCES = [
  { key: 'claude-code', label: 'Claude Code', week: paletteSlice(0, 2), all: paletteFrom(0) },
  { key: 'codex', label: 'Codex', week: paletteSlice(2, 2), all: paletteFrom(2) },
] as const;
const RANGE_OPTIONS = [{ label: '近 7 天', value: 7 }, { label: '30 天', value: 30 }, { label: '90 天', value: 90 }];

/** 总览仪表盘的用量趋势：Claude Code 与 Codex 各一张按模型堆叠的柱状图；默认近一周，右上角翻看前几周或切到 30 / 90 天 */
export function ModelTrendCard({ metric }: { metric: ChartMetric }) {
  const isMobile = useIsMobile();
  const [days, setDays] = useState(7);
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch(() => api.get<ModelTrend>('/stats/model-trend', { days, offset }), [days, offset], { keepPrevious: true });

  const week = (data?.days ?? days) === 7;
  const points = useMemo(() => Object.fromEntries(SOURCES.map((s) => [s.key, (data?.rows ?? []).filter((r) => r.source === s.key).map((r) => ({
    date: r.date, seriesKey: r.model, seriesLabel: r.model, value: metric === 'cost' ? r.costUsd : num(r.totalTokens),
  }))])), [data, metric]);

  const size = isMobile ? 'middle' as const : 'small' as const;
  const controls = (
    <Space size={8} wrap>
      {days === 7 && (
        <Space.Compact>
          <Button size={size} icon={<LeftOutlined />} aria-label="上一周" disabled={loading || !data || data.from <= data.earliest} onClick={() => setOffset((o) => o + 1)} />
          <Button size={size} disabled={offset === 0} onClick={() => setOffset(0)}>{data ? `${data.from.slice(5)} ~ ${data.to.slice(5)}` : '本周'}</Button>
          <Button size={size} icon={<RightOutlined />} aria-label="下一周" disabled={loading || offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 1))} />
        </Space.Compact>
      )}
      <Segmented size={size} value={days} options={RANGE_OPTIONS} onChange={(v) => { setDays(v as number); setOffset(0); }} />
    </Space>
  );

  return (
    <Card title={`用量趋势（${metric === 'cost' ? '估算费用' : 'Token'}）`} size="small" extra={isMobile ? undefined : controls}>
      {isMobile && <div style={{ marginBottom: 12 }}>{controls}</div>}
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} action={<Button size="small" onClick={reload}>重试</Button>} />}
      {data && (
        <Row gutter={isMobile ? [0, 16] : [24, 16]}>
          {SOURCES.map((s) => (
            // 一周只有 7 根柱子，两张图并排；30 / 90 天柱子多，上下排列各占整行
            <Col key={s.key} xs={24} md={week ? 12 : 24}>
              <Typography.Text strong>{s.label}</Typography.Text>
              <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{week ? '用量最多的 2 个模型' : '全部模型'}</Typography.Text>
              <StackedTrendChart
                points={points[s.key] ?? []} from={data.from} to={data.to} metric={metric} height={week ? 300 : 240}
                namespace={`trend:${week ? 'week' : 'all'}:${s.key}`} topN={week ? 2 : undefined} palette={week ? s.week : s.all}
                emptyText={`这段时间没有 ${s.label} 用量`} ariaLabel={`${s.label} 按日用量趋势`}
              />
            </Col>
          ))}
        </Row>
      )}
    </Card>
  );
}
