import { Alert, Card, DatePicker, Segmented, Select, Space, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { RankBarChart, StackedTrendChart, type ChartMetric } from '../components/charts';
import { CostCell, PageTitle, TokenCell } from '../components/common';
import { num } from '../format';
import { useFetch } from '../hooks';
import type { Dimension, Filters, UsageResponse, UsageRow } from '../types';
import { METRIC_OPTIONS } from './Dashboard';

const DIM_LABEL: Record<Dimension, string> = { date: '日期', user: '用户', server: '服务器', model: '模型', source: '数据源', team: '团队' };
const PRESETS = [
  { label: '今天', value: [dayjs(), dayjs()] as [Dayjs, Dayjs] },
  { label: '近 7 天', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: '近 90 天', value: [dayjs().subtract(89, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: '本月至今', value: [dayjs().startOf('month'), dayjs()] as [Dayjs, Dayjs] },
];

export function UsagePage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, 'day'), dayjs()]);
  const [userId, setUserId] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [model, setModel] = useState<string>();
  const [team, setTeam] = useState<string>();
  const [primary, setPrimary] = useState<Dimension>('date');
  const [secondary, setSecondary] = useState<Dimension | 'none'>('model');
  const [metric, setMetric] = useState<ChartMetric>('tokens');

  const filters = useFetch(() => api.get<Filters>('/stats/filters'), []);
  const from = range[0].format('YYYY-MM-DD');
  const to = range[1].format('YYYY-MM-DD');
  const dims = [primary, ...(secondary !== 'none' && secondary !== primary ? [secondary] : [])];
  const groupBy = dims.join(',');
  const usage = useFetch(
    () => api.get<UsageResponse>('/stats/usage', { from, to, userId, serverId, model, team, groupBy }),
    [from, to, userId, serverId, model, team, groupBy],
  );

  const rows = usage.data?.rows ?? [];
  const valueOf = (r: UsageRow) => (metric === 'cost' ? r.costUsd : num(r.totalTokens));
  // 图表与数据保持同一帧：用响应里的 groupBy，而不是尚未返回结果的新选择
  const shown = usage.data?.groupBy ?? dims;
  const byDate = shown[0] === 'date';

  const trendPoints = useMemo(() => (byDate ? rows.map((r) => ({
    date: r.key0, seriesKey: r.key1 ?? 'total', seriesLabel: r.label1 ?? (metric === 'cost' ? '估算费用' : 'Token'), value: valueOf(r),
  })) : []), [rows, byDate, metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const rankItems = useMemo(() => {
    if (byDate) return [];
    const acc = new Map<string, { label: string; value: number | null }>();
    for (const r of rows) {
      const cur = acc.get(r.key0) ?? { label: r.label0 || '未分组', value: null };
      const v = valueOf(r);
      if (v !== null) cur.value = (cur.value ?? 0) + v;
      acc.set(r.key0, cur);
    }
    return [...acc.entries()].map(([key, v]) => ({ key, ...v }));
  }, [rows, byDate, metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const dimOptions = (Object.keys(DIM_LABEL) as Dimension[]).map((d) => ({ value: d, label: DIM_LABEL[d] }));

  return (
    <>
      <PageTitle title="用量分析" />
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <DatePicker.RangePicker value={range} onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }} allowClear={false} presets={PRESETS} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="用户" style={{ width: 160 }} value={userId} onChange={setUserId}
            options={filters.data?.users.map((u) => ({ value: u.id, label: u.name }))} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="服务器" style={{ width: 160 }} value={serverId} onChange={setServerId}
            options={filters.data?.servers.map((s) => ({ value: s.id, label: s.name }))} />
          <Select allowClear showSearch placeholder="模型" style={{ width: 220 }} value={model} onChange={setModel}
            options={filters.data?.models.map((m) => ({ value: m, label: m }))} />
          <Select allowClear placeholder="团队" style={{ width: 140 }} value={team} onChange={setTeam}
            options={filters.data?.teams.map((t) => ({ value: t, label: t }))} />
          <span>分组：</span>
          <Select style={{ width: 110 }} value={primary} onChange={setPrimary} options={dimOptions} />
          <Select style={{ width: 130 }} value={secondary} onChange={setSecondary}
            options={[{ value: 'none', label: '不细分' }, ...dimOptions.filter((d) => d.value !== primary && d.value !== 'date').map((d) => ({ ...d, label: `再按${d.label}` }))]} />
          <Segmented value={metric} onChange={(v) => setMetric(v as ChartMetric)} options={METRIC_OPTIONS} />
        </Space>
      </Card>
      {usage.error && <Alert type="error" showIcon title={usage.error} style={{ marginBottom: 16 }} />}

      <Card size="small" style={{ marginBottom: 16 }}
        title={`${byDate ? '按日趋势' : `按${DIM_LABEL[shown[0]!]}排名（前 15）`} · ${metric === 'cost' ? '估算费用' : 'Token'}`}>
        {usage.data && (byDate
          ? <StackedTrendChart points={trendPoints} from={usage.data.from} to={usage.data.to} metric={metric} namespace={shown[1] ?? 'total'} />
          : <RankBarChart items={rankItems} metric={metric} max={15} />)}
      </Card>

      <Card size="small" title="明细">
        <Table<UsageRow>
          size="small" loading={usage.loading} dataSource={rows} rowKey={(r) => `${r.key0}|${r.key1 ?? ''}`} scroll={{ x: 900 }}
          pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (n) => `共 ${n} 行` }}
          columns={[
            { title: DIM_LABEL[shown[0]!], render: (_v, r) => <>{r.label0 || '未分组'} {r.flagged && <Tag color="warning" title="含保留的历史值或异常减少标记，需核查">待核查</Tag>}</> },
            ...(shown[1] ? [{ title: DIM_LABEL[shown[1]], render: (_v: unknown, r: UsageRow) => r.label1 || '未分组' }] : []),
            { title: '总 Token', align: 'right' as const, render: (_v, r) => <TokenCell value={r.totalTokens} />, sorter: (a, b) => (num(a.totalTokens) ?? -1) - (num(b.totalTokens) ?? -1) },
            { title: '输入', align: 'right' as const, render: (_v, r) => <TokenCell value={r.inputTokens} /> },
            { title: '输出', align: 'right' as const, render: (_v, r) => <TokenCell value={r.outputTokens} /> },
            { title: '缓存写入', align: 'right' as const, render: (_v, r) => <TokenCell value={r.cacheCreationTokens} /> },
            { title: '缓存读取', align: 'right' as const, render: (_v, r) => <TokenCell value={r.cacheReadTokens} /> },
            { title: '估算费用', align: 'right' as const, render: (_v, r) => <CostCell value={r.costUsd} />, sorter: (a, b) => (a.costUsd ?? -1) - (b.costUsd ?? -1) },
          ]}
        />
      </Card>
    </>
  );
}
