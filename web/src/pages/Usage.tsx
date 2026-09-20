import { Alert, Card, DatePicker, Segmented, Select, Table, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { RankBarChart, StackedTrendChart, type ChartMetric } from '../components/charts';
import { CostCell, FilterBar, PageTitle, TokenCell } from '../components/common';
import { useStatsToday } from '../components/Layout';
import { fmtTokens, num } from '../format';
import { useFetch } from '../hooks';
import { METRIC_OPTIONS } from '../options';
import { useIsMobile } from '../responsive';
import type { Dimension, Filters, UsageLeader, UsageResponse, UsageRow } from '../types';

const DIM_LABEL: Record<Dimension, string> = { date: '日期', user: '用户', server: '服务器', model: '模型', source: '数据源', team: '团队' };

/** 快捷范围都以统计时区的“今天”为终点（不是浏览器本地日期），并随 meta.today 跨天更新 */
const presetsFor = (today: string): Array<{ label: string; value: [Dayjs, Dayjs] }> => {
  const t = dayjs(today);
  return [
    { label: '今天', value: [t, t] },
    { label: '近 7 天', value: [t.subtract(6, 'day'), t] },
    { label: '近 30 天', value: [t.subtract(29, 'day'), t] },
    { label: '近 90 天', value: [t.subtract(89, 'day'), t] },
    { label: '本月至今', value: [t.startOf('month'), t] },
  ];
};

/** 用量最多的 3 个用户：每人一行，名字可点进用户详情 */
function Leaders({ list }: { list?: UsageLeader[] }) {
  if (!list || list.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <div style={{ lineHeight: 1.6 }}>
      {list.map((l, i) => (
        <div key={l.userId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, whiteSpace: 'nowrap' }}>
          <span><Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>{i + 1}</Typography.Text><Link to={`/users/${l.userId}`}>{l.name}</Link></span>
          <Typography.Text type="secondary">{fmtTokens(l.tokens)}</Typography.Text>
        </div>
      ))}
    </div>
  );
}

export function UsagePage() {
  const today = useStatsToday();
  const presets = useMemo(() => presetsFor(today), [today]);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs(today).subtract(29, 'day'), dayjs(today)]);
  const [userId, setUserId] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [model, setModel] = useState<string>();
  const [team, setTeam] = useState<string>();
  const [primary, setPrimary] = useState<Dimension>('date');
  const [secondary, setSecondary] = useState<Dimension | 'none'>('none');
  const [metric, setMetric] = useState<ChartMetric>('tokens');
  const isMobile = useIsMobile();

  const filters = useFetch(() => api.get<Filters>('/stats/filters'), []);
  const from = range[0].format('YYYY-MM-DD');
  const to = range[1].format('YYYY-MM-DD');
  const dims = [primary, ...(secondary !== 'none' && secondary !== primary ? [secondary] : [])];
  const groupBy = dims.join(',');
  const usage = useFetch(
    () => api.get<UsageResponse>('/stats/usage', { from, to, userId, serverId, model, team, groupBy }),
    [from, to, userId, serverId, model, team, groupBy],
    { keepPrevious: true }, // 响应自带 from / to / groupBy，加载期间沿用上一份结果不会张冠李戴
  );

  const rawRows = usage.data?.rows;
  const valueOf = (r: UsageRow) => (metric === 'cost' ? r.costUsd : num(r.totalTokens));
  // 图表与数据保持同一帧：用响应里的 groupBy，而不是尚未返回结果的新选择
  const shown = usage.data?.groupBy ?? dims;
  const byDate = shown[0] === 'date';
  // 按日期分组时最近的日期排在最前面（同一天内用量大的在前）；图表自己按日期铺 x 轴，不受这里的顺序影响
  const rows = useMemo(() => {
    const list = rawRows ?? [];
    return byDate ? [...list].sort((a, b) => (a.key0 < b.key0 ? 1 : a.key0 > b.key0 ? -1 : (num(b.totalTokens) ?? -1) - (num(a.totalTokens) ?? -1))) : list;
  }, [rawRows, byDate]);
  const showLeaders = Boolean(usage.data?.leaders);
  const anchorHint = byDate ? '该行日期' : `${usage.data?.to ?? to}（范围的最后一天）`;

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
  // 当前范围正好等于某个快捷范围时，手机上的下拉框显示它的名字；否则显示“自定义范围”
  const presetIndex = presets.findIndex((p) => p.value[0].isSame(range[0], 'day') && p.value[1].isSame(range[1], 'day'));

  return (
    <>
      <PageTitle title="用量分析" />
      <Card size="small" style={{ marginBottom: isMobile ? 12 : 16 }}>
        <FilterBar items={[
          // RangePicker 的双月面板在手机上放不下：改成“快捷范围 + 起 / 止两个单日期”，输入框只读，不弹软键盘
          ...(isMobile
            ? [
              { key: 'preset', node: <Select aria-label="快捷范围" value={presetIndex >= 0 ? presetIndex : undefined} placeholder="自定义范围" onChange={(i: number) => setRange(presets[i]!.value)} options={presets.map((p, i) => ({ value: i, label: p.label }))} /> },
              { key: 'from', half: true, node: <DatePicker aria-label="开始日期" inputReadOnly allowClear={false} placement="bottomLeft" value={range[0]} onChange={(d) => { if (d) setRange([d, d.isAfter(range[1]) ? d : range[1]]); }} disabledDate={(d) => d.isAfter(dayjs(today), 'day')} /> },
              { key: 'to', half: true, node: <DatePicker aria-label="结束日期" inputReadOnly allowClear={false} placement="bottomRight" value={range[1]} onChange={(d) => { if (d) setRange([d.isBefore(range[0]) ? d : range[0], d]); }} disabledDate={(d) => d.isAfter(dayjs(today), 'day')} /> },
            ]
            : [{ key: 'range', node: <DatePicker.RangePicker value={range} onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }} allowClear={false} presets={presets} /> }]),
          { key: 'user', half: true, node: <Select allowClear showSearch optionFilterProp="label" placeholder="用户" style={{ width: 160 }} value={userId} onChange={setUserId}
            options={filters.data?.users.map((u) => ({ value: u.id, label: u.name }))} /> },
          { key: 'server', half: true, node: <Select allowClear showSearch optionFilterProp="label" placeholder="服务器" style={{ width: 160 }} value={serverId} onChange={setServerId}
            options={filters.data?.servers.map((s) => ({ value: s.id, label: s.name }))} /> },
          { key: 'model', half: true, node: <Select allowClear showSearch placeholder="模型" style={{ width: 220 }} value={model} onChange={setModel}
            options={filters.data?.models.map((m) => ({ value: m, label: m }))} /> },
          { key: 'team', half: true, node: <Select allowClear placeholder="团队" style={{ width: 140 }} value={team} onChange={setTeam}
            options={filters.data?.teams.map((t) => ({ value: t, label: t }))} /> },
          !isMobile && { key: 'groupLabel', node: <span>分组：</span> },
          { key: 'primary', half: true, node: <Select aria-label="分组维度" style={{ width: 110 }} value={primary} onChange={setPrimary} options={isMobile ? dimOptions.map((d) => ({ ...d, label: `按${d.label}分组` })) : dimOptions} /> },
          { key: 'secondary', half: true, node: <Select aria-label="细分维度" style={{ width: 130 }} value={secondary} onChange={setSecondary}
            options={[{ value: 'none', label: '不细分' }, ...dimOptions.filter((d) => d.value !== primary && d.value !== 'date').map((d) => ({ ...d, label: `再按${d.label}` }))]} /> },
          { key: 'metric', node: <Segmented value={metric} onChange={(v) => setMetric(v as ChartMetric)} options={METRIC_OPTIONS} /> },
        ]} />
      </Card>
      {usage.error && <Alert type="error" showIcon title={usage.error} style={{ marginBottom: 16 }} />}

      <Card size="small" style={{ marginBottom: isMobile ? 12 : 16 }}
        title={`${byDate ? '按日趋势' : `按${DIM_LABEL[shown[0]!]}排名（前 15）`} · ${metric === 'cost' ? '估算费用' : 'Token'}`}>
        {usage.data && (byDate
          ? <StackedTrendChart points={trendPoints} from={usage.data.from} to={usage.data.to} metric={metric} namespace={shown[1] ?? 'total'} />
          : <RankBarChart items={rankItems} metric={metric} max={15} />)}
      </Card>

      {/* 手机：表格贴着卡片边缘铺满，给三列多留出 24px */}
      <Card size="small" title="明细" styles={isMobile ? { body: { padding: 0 } } : undefined}>
        <Table<UsageRow>
          size="small" loading={usage.loading} dataSource={rows} rowKey={(r) => `${r.key0}|${r.key1 ?? ''}`}
          // 手机：按内容宽度横向滚动，首列固定在左侧；“用量最多”两列放进展开行
          scroll={{ x: isMobile ? 'max-content' : 820 }}
          expandable={isMobile && showLeaders ? {
            expandedRowRender: (r) => (
              <div style={{ display: 'grid', gap: 8 }}>
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>近 7 天用量最多</Typography.Text><Leaders list={r.top7} /></div>
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>近 1 天用量最多</Typography.Text><Leaders list={r.top1} /></div>
              </div>
            ),
          } : undefined}
          pagination={isMobile ? { pageSize: 50, simple: true, showSizeChanger: false } : { pageSize: 50, showSizeChanger: true, showTotal: (n) => `共 ${n} 行` }}
          columns={[
            // 手机：第二个维度并到首列下面（小字），Token 与费用两列不用横向滚动就能看到
            {
              title: isMobile && shown[1] ? `${DIM_LABEL[shown[0]!]} / ${DIM_LABEL[shown[1]]}` : DIM_LABEL[shown[0]!], fixed: isMobile ? 'left' as const : undefined,
              render: (_v, r) => (
                <div className={isMobile ? 'wrap-anywhere' : undefined} style={isMobile ? { maxWidth: 120 } : undefined}>
                  {r.label0 || '未分组'} {r.flagged && <Tag color="warning" title="含保留的历史值或异常减少标记，需核查">待核查</Tag>}
                  {isMobile && shown[1] && <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{r.label1 || '未分组'}</div>}
                </div>
              ),
            },
            ...(shown[1] && !isMobile ? [{ title: DIM_LABEL[shown[1]], render: (_v: unknown, r: UsageRow) => r.label1 || '未分组' }] : []),
            { title: '总 Token', align: 'right' as const, render: (_v, r) => <TokenCell value={r.totalTokens} />, sorter: (a, b) => (num(a.totalTokens) ?? -1) - (num(b.totalTokens) ?? -1) },
            { title: '估算费用', align: 'right' as const, render: (_v, r) => <CostCell value={r.costUsd} />, sorter: (a, b) => (a.costUsd ?? -1) - (b.costUsd ?? -1) },
            ...(showLeaders && !isMobile ? [
              { title: <span title={`截至${anchorHint}的 7 天内，用量最多的 3 个用户`}>近 7 天用量最多</span>, width: 210, render: (_v: unknown, r: UsageRow) => <Leaders list={r.top7} /> },
              { title: <span title={`${anchorHint}当天用量最多的 3 个用户`}>近 1 天用量最多</span>, width: 210, render: (_v: unknown, r: UsageRow) => <Leaders list={r.top1} /> },
            ] : []),
          ]}
        />
      </Card>
    </>
  );
}
