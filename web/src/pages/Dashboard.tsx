import { Alert, Card, Col, DatePicker, Row, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { RankBarChart, StackedTrendChart, type ChartMetric } from '../components/charts';
import { BudgetBar, CostCell, PageTitle, StatCard, TokenCell } from '../components/common';
import { fmtCost, fmtFull, fmtTime, fmtTokens, num } from '../format';
import { useFetch } from '../hooks';
import type { Overview } from '../types';

export const METRIC_OPTIONS = [{ label: 'Token', value: 'tokens' }, { label: '估算费用', value: 'cost' }];
export const DAYS_OPTIONS = [{ label: '近 7 天', value: 7 }, { label: '近 30 天', value: 30 }, { label: '近 90 天', value: 90 }];

type RankBy = 'total' | 'claude' | 'codex';
const RANK_OPTIONS = [{ label: '合计费用', value: 'total' }, { label: 'Claude Code', value: 'claude' }, { label: 'Codex', value: 'codex' }];
type TodayRow = Overview['todayRanking'][number];
const RANK_KEYS: Record<RankBy, { cost: keyof TodayRow; tokens: keyof TodayRow }> = {
  total: { cost: 'totalCost', tokens: 'totalTokens' }, claude: { cost: 'claudeCost', tokens: 'claudeTokens' }, codex: { cost: 'codexCost', tokens: 'codexTokens' },
};

// 某个数据源当天没有任何记录时显示“—”（没有用量）；有记录但数值缺失才是“未知”
const SourceTokens = ({ value }: { value: TodayRow['claudeTokens'] }) => (value === null || value === undefined ? <Typography.Text type="secondary">—</Typography.Text> : <TokenCell value={value} />);
const SourceCost = ({ value, tokens }: { value: number | null; tokens: TodayRow['claudeTokens'] }) => (tokens === null || tokens === undefined ? <Typography.Text type="secondary">—</Typography.Text> : <CostCell value={value} />);

export function DashboardPage() {
  const [rankBy, setRankBy] = useState<RankBy>('total');
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<ChartMetric>('tokens');
  const { data, loading, error } = useFetch(() => api.get<Overview>('/stats/overview', { days }), [days]);

  // 排名卡片自带日期选择：默认今天（统计时区），可回看任意一天
  const [rankDate, setRankDate] = useState<string | undefined>(undefined);
  const daily = useFetch(() => api.get<{ date: string; today: string; earliest: string; rows: Overview['todayRanking'] }>('/stats/daily-ranking', { date: rankDate }), [rankDate]);
  const shownDate = daily.data?.date ?? rankDate ?? data?.freshness.today ?? '';
  const isToday = !daily.data || daily.data.date === daily.data.today;
  const todayAll = daily.data?.rows ?? [];
  // 按所选口径（合计 / Claude Code / Codex）排序取前 10：先比估算费用，再比 Token；该口径下没有用量的人不入榜
  const todayTop = useMemo(() => {
    const k = RANK_KEYS[rankBy];
    const val = (r: TodayRow, key: keyof TodayRow) => num(r[key] as TodayRow['totalTokens']) ?? -1;
    return todayAll.filter((r) => r[k.tokens] !== null || r[k.cost] !== null)
      .sort((a, b) => val(b, k.cost) - val(a, k.cost) || val(b, k.tokens) - val(a, k.tokens)).slice(0, 10);
  }, [todayAll, rankBy]);
  const todaySum = useMemo(() => {
    const add = (key: keyof TodayRow) => { const vals = todayAll.map((r) => num(r[key] as TodayRow['totalTokens'])).filter((v): v is number => v !== null); return vals.length ? vals.reduce((a, b) => a + b, 0) : null; };
    return { claudeTokens: add('claudeTokens'), claudeCost: add('claudeCost'), codexTokens: add('codexTokens'), codexCost: add('codexCost'), totalTokens: add('totalTokens'), totalCost: add('totalCost') };
  }, [todayAll]);

  const trendPoints = useMemo(() => (data?.trend.rows ?? []).map((r) => ({
    date: r.date, seriesKey: r.model, seriesLabel: r.model, value: metric === 'cost' ? r.costUsd : num(r.totalTokens),
  })), [data, metric]);
  const modelItems = useMemo(() => (data?.models ?? []).map((m) => ({ key: m.model, label: m.model, value: metric === 'cost' ? m.costUsd : num(m.totalTokens) })), [data, metric]);

  const t = data?.totals;
  const first = loading && !data;

  return (
    <>
      <PageTitle
        title="总览仪表盘"
        extra={(
          <Space wrap>
            <Select value={days} onChange={setDays} options={DAYS_OPTIONS} style={{ width: 110 }} />
            <Segmented value={metric} onChange={(v) => setMetric(v as ChartMetric)} options={METRIC_OPTIONS} />
          </Space>
        )}
      />
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><StatCard loading={first} label="今日 Token" value={fmtTokens(t?.todayTokens)} full={`${fmtFull(t?.todayTokens)} Token`} hint={`今日活跃用户 ${t?.activeUsersToday ?? 0} 人`} /></Col>
        <Col xs={12} lg={6}><StatCard loading={first} label="今日估算费用" value={fmtCost(t?.todayCost)} hint="基于 ccusage 估算，非实际扣费" /></Col>
        <Col xs={12} lg={6}><StatCard loading={first} label={`本月 Token（${data?.month ?? ''}）`} value={fmtTokens(t?.monthTokens)} full={`${fmtFull(t?.monthTokens)} Token`} hint={`本月活跃用户 ${t?.activeUsersMonth ?? 0} 人`} /></Col>
        <Col xs={12} lg={6}><StatCard loading={first} label="本月估算费用" value={fmtCost(t?.monthCost)} hint="基于 ccusage 估算，非实际扣费" /></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={16}>
          <Card title={`用量趋势 · 按模型堆叠（${metric === 'cost' ? '估算费用' : 'Token'}）`} size="small">
            {data && <StackedTrendChart points={trendPoints} from={data.trend.from} to={data.trend.to} metric={metric} namespace="model" />}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={`本月模型分布（${metric === 'cost' ? '估算费用' : 'Token'}）`} size="small">
            <RankBarChart items={modelItems} metric={metric} />
          </Card>
        </Col>
      </Row>

      <Card
        title={`${isToday ? '今日' : shownDate + ' '}用量排名 Top 10`} size="small" style={{ marginTop: 16 }}
        extra={<Space size={8} wrap>
          <Typography.Text type="secondary">日期</Typography.Text>
          <DatePicker
            size="small" allowClear={false} value={shownDate ? dayjs(shownDate) : null} style={{ width: 130 }}
            onChange={(d) => setRankDate(d ? d.format('YYYY-MM-DD') : undefined)}
            disabledDate={(d) => { const v = d.format('YYYY-MM-DD'); return Boolean(daily.data) && (v > daily.data!.today || v < daily.data!.earliest); }}
            presets={daily.data ? [0, 1, 2].map((n) => ({ label: ['今天', '昨天', '前天'][n]!, value: dayjs(daily.data!.today).subtract(n, 'day') })) : []}
          /><Typography.Text type="secondary">排名依据</Typography.Text><Segmented size="small" value={rankBy} onChange={(v) => setRankBy(v as RankBy)} options={RANK_OPTIONS} /></Space>}
      >
        <Table
          size="small" rowKey="userId" pagination={false} dataSource={todayTop} loading={daily.loading} scroll={{ x: 820 }}
          locale={{ emptyText: isToday ? '今日还没有用量' : '这一天没有用量记录' }}
          columns={[
            { title: '#', width: 40, render: (_v, _r, i) => i + 1 },
            { title: '用户', render: (_v, r) => <Link to={`/users/${r.userId}`}>{r.name}</Link> },
            { title: '团队', dataIndex: 'team', render: (v: string | null) => v ?? <Typography.Text type="secondary">未分组</Typography.Text> },
            { title: 'Claude Code', children: [
              { title: 'Token', align: 'right', render: (_v, r) => <SourceTokens value={r.claudeTokens} /> },
              { title: '估算费用', align: 'right', render: (_v, r) => <SourceCost value={r.claudeCost} tokens={r.claudeTokens} /> },
            ] },
            { title: 'Codex', children: [
              { title: 'Token', align: 'right', render: (_v, r) => <SourceTokens value={r.codexTokens} /> },
              { title: '估算费用', align: 'right', render: (_v, r) => <SourceCost value={r.codexCost} tokens={r.codexTokens} /> },
            ] },
            { title: '合计', children: [
              { title: 'Token', align: 'right', render: (_v, r) => <TokenCell value={r.totalTokens} /> },
              { title: '估算费用', align: 'right', render: (_v, r) => <Typography.Text strong><CostCell value={r.totalCost} /></Typography.Text> },
            ] },
          ]}
          summary={() => (todayAll.length === 0 ? null : (
            <Table.Summary.Row style={{ background: '#fafafa' }}>
              <Table.Summary.Cell index={0} colSpan={3}><Typography.Text strong>{isToday ? '今日' : '当日'}全员合计（{todayAll.length} 人）</Typography.Text></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right"><SourceTokens value={todaySum.claudeTokens} /></Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right"><SourceCost value={todaySum.claudeCost} tokens={todaySum.claudeTokens} /></Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right"><SourceTokens value={todaySum.codexTokens} /></Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right"><SourceCost value={todaySum.codexCost} tokens={todaySum.codexTokens} /></Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right"><TokenCell value={todaySum.totalTokens} /></Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right"><Typography.Text strong><CostCell value={todaySum.totalCost} /></Typography.Text></Table.Summary.Cell>
            </Table.Summary.Row>
          ))}
        />
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card title="本月用量排名 Top 10" size="small">
            <Table
              size="small" rowKey="userId" pagination={false} dataSource={data?.ranking ?? []} loading={first} scroll={{ x: 640 }}
              columns={[
                { title: '#', width: 40, render: (_v, _r, i) => i + 1 },
                { title: '用户', render: (_v, r) => <Link to={`/users/${r.userId}`}>{r.name}</Link> },
                { title: '团队', dataIndex: 'team', render: (v: string | null) => v ?? <Typography.Text type="secondary">未分组</Typography.Text> },
                { title: '今日 Token', align: 'right', render: (_v, r) => <TokenCell value={r.todayTokens} /> },
                { title: '本月 Token', align: 'right', render: (_v, r) => <TokenCell value={r.monthTokens} /> },
                { title: '本月估算费用', align: 'right', render: (_v, r) => <CostCell value={r.monthCost} /> },
                { title: '预算使用率', width: 200, render: (_v, r) => <BudgetBar cost={r.monthCost} budget={r.monthlyBudgetUsd} /> },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="采集异常" size="small" extra={<Link to="/servers">服务器管理</Link>}>
            <Table
              size="small" rowKey="targetId" pagination={false} dataSource={data?.issues ?? []} loading={first} scroll={{ x: 480 }}
              locale={{ emptyText: '所有来源均已按期更新' }}
              columns={[
                { title: '来源', render: (_v, r) => <><div>{r.serverName}</div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.dataDir} · {r.userName}</Typography.Text></> },
                {
                  title: '状态', render: (_v, r) => (r.lastStatus === 'failed'
                    ? <Tag color="error">连续失败 {r.consecutiveFailures ?? ''} 轮</Tag>
                    : r.lastSuccessAt ? <Tag color="warning">数据过期</Tag> : <Tag>尚未采集</Tag>),
                },
                { title: '最近成功', render: (_v, r) => fmtTime(r.lastSuccessAt) },
                { title: '错误', ellipsis: true, render: (_v, r) => (r.lastErrorCode ? <Typography.Text type="danger" title={r.lastError ?? ''}>{r.lastErrorCode}</Typography.Text> : '—') },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
