import { Alert, Card, Col, Row, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
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

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<ChartMetric>('tokens');
  const { data, loading, error } = useFetch(() => api.get<Overview>('/stats/overview', { days }), [days]);

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
