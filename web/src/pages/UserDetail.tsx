import { Alert, Card, Col, Descriptions, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { RankBarChart, StackedTrendChart, type ChartMetric } from '../components/charts';
import { BudgetBar, CostCell, EmailStatusTag, FilterBar, PageTitle, StatCard, TokenCell } from '../components/common';
import { alertMetricLabel, alertPeriodLabel, fmtCost, fmtFull, fmtMetricValue, fmtTime, fmtTokens, num } from '../format';
import { useFetch } from '../hooks';
import { DAYS_OPTIONS, METRIC_OPTIONS } from '../options';
import { useIsMobile } from '../responsive';
import type { UserAlert, UserDetail, UserSource } from '../types';

/** 来源状态标签；桌面端“待核查”的解释放在 Tooltip 里，手机上标签本身已足够（详情在服务器管理页） */
function sourceStatus(s: UserSource, withTooltip: boolean) {
  const flagged = <Tag color="warning">待核查</Tag>;
  return (
    <>
      {!s.enabled ? <Tag>已停用</Tag> : s.stale
        ? <Tag color={s.lastStatus === 'failed' ? 'error' : 'warning'}>{s.lastStatus === 'failed' ? '采集失败 · 数据过期' : s.lastSuccessAt ? '数据过期' : '尚未采集'}</Tag>
        : <Tag color="success">正常</Tag>}
      {s.flagged && (withTooltip ? <Tooltip title="该来源有保留的历史值或异常减少标记（多为远端日志被清理），需管理员核查">{flagged}</Tooltip> : flagged)}
    </>
  );
}

/** 换用户（/users/A → /users/B）时整页重新挂载：不会把 A 的数字、图表和筛选状态带到 B 名下 */
export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <UserDetailView key={id} id={id ?? ''} />;
}

function UserDetailView({ id }: { id: string }) {
  const { user: me } = useAuth();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<ChartMetric>('tokens');
  const isMobile = useIsMobile();
  const gutter: [number, number] = isMobile ? [12, 12] : [16, 16];
  const gap = isMobile ? 12 : 16;
  const { data, loading, error } = useFetch(() => api.get<UserDetail>(`/stats/users/${id}`, { days }), [id, days], { keepPrevious: true }); // 只有天数会变（换用户会重新挂载），响应自带趋势范围

  const trendPoints = useMemo(() => (data?.trend.rows ?? []).map((r) => ({
    date: r.date, seriesKey: r.serverId, seriesLabel: r.serverName, value: metric === 'cost' ? r.costUsd : num(r.totalTokens),
  })), [data, metric]);
  const modelItems = useMemo(() => (data?.models ?? []).map((m) => ({ key: m.model, label: m.model, value: metric === 'cost' ? m.costUsd : num(m.totalTokens) })), [data, metric]);

  const u = data?.user;
  const t = data?.totals;
  const first = loading && !data;
  const staleSources = data?.sources.filter((s) => s.stale) ?? [];
  const title = me?.id === id ? '我的用量' : `用户详情${u ? ` · ${u.name}` : ''}`;

  return (
    <>
      <PageTitle
        title={title}
        extra={(
          <FilterBar items={[
            { key: 'days', half: true, node: <Select value={days} onChange={setDays} options={DAYS_OPTIONS} style={{ width: 110 }} /> },
            { key: 'metric', half: true, node: <Segmented value={metric} onChange={(v) => setMetric(v as ChartMetric)} options={METRIC_OPTIONS} /> },
          ]} />
        )}
      />
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      {staleSources.length > 0 && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 16 }}
          title={`有 ${staleSources.length} 个来源数据过期，以下统计不完整`}
          description="过期来源的已入库统计会保留，但其最新用量尚未计入；实际用量可能更高。"
        />
      )}

      {u && (
        <Card size="small" style={{ marginBottom: gap }}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
            <Descriptions.Item label="姓名">{u.name}{!u.isActive && <Tag style={{ marginLeft: 8 }}>已停用</Tag>}</Descriptions.Item>
            {u.email && <Descriptions.Item label="登录邮箱"><span className="wrap-anywhere">{u.email}</span></Descriptions.Item>}
            <Descriptions.Item label="团队">{u.team ?? '未分组'}</Descriptions.Item>
            <Descriptions.Item label="月预算">{u.monthlyBudgetUsd === null ? '未设预算' : fmtCost(u.monthlyBudgetUsd)}</Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      <Row gutter={gutter}>
        <Col xs={12} lg={6}><StatCard loading={first} label={isMobile ? '今日 Token' : '今日 Token（全部服务器）'} value={fmtTokens(t?.todayTokens)} full={`${fmtFull(t?.todayTokens)} Token`} hint={isMobile ? '全部服务器合计' : undefined} /></Col>
        <Col xs={12} lg={6}><StatCard loading={first} label="今日估算费用" value={fmtCost(t?.todayCost)} hint="基于 ccusage 估算，非实际扣费" /></Col>
        <Col xs={12} lg={6}><StatCard loading={first} label={`本月 Token（${data?.month ?? ''}）`} value={fmtTokens(t?.monthTokens)} full={`${fmtFull(t?.monthTokens)} Token`} /></Col>
        <Col xs={12} lg={6}>
          <StatCard loading={first} label="本月估算费用" value={fmtCost(t?.monthCost)} hint={<BudgetBar compact={isMobile} cost={t?.monthCost} budget={u?.monthlyBudgetUsd} />} />
        </Col>
      </Row>

      <Row gutter={gutter} style={{ marginTop: gap }}>
        <Col xs={24} xl={16}>
          <Card size="small" title={`用量趋势 · 按服务器堆叠（${metric === 'cost' ? '估算费用' : 'Token'}）`}>
            {data && <StackedTrendChart points={trendPoints} from={data.trend.from} to={data.trend.to} metric={metric} namespace="server" />}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small" title={`模型分布 · 近 ${days} 天（${metric === 'cost' ? '估算费用' : 'Token'}）`}>
            <RankBarChart items={modelItems} metric={metric} />
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`服务器贡献 · 近 ${days} 天`} style={{ marginTop: gap }}>
        {/* 手机：两列 —— 来源（服务器、目录、状态、最近成功）与用量（Token / 费用），不需要横向滚动 */}
        <Table<UserSource>
          size="small" rowKey="targetId" pagination={false} dataSource={data?.sources ?? []} loading={first} scroll={isMobile ? undefined : { x: 860 }}
          locale={{ emptyText: '尚未绑定任何采集来源' }}
          columns={isMobile
            ? [
              {
                title: '来源', render: (_v, s) => (
                  <div className="wrap-anywhere">
                    {s.serverName}
                    <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.dataDir} · {s.source}</Typography.Text></div>
                    <Space size={4} wrap style={{ marginTop: 2 }}>{sourceStatus(s, false)}{s.sharedAccount && <Tag color="purple" style={{ marginInlineEnd: 0 }}>共享账户</Tag>}</Space>
                    <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>最近成功 {fmtTime(s.lastSuccessAt)}</Typography.Text></div>
                  </div>
                ),
              },
              { title: 'Token / 费用', align: 'right', render: (_v, s) => <><TokenCell value={s.totalTokens} /><div style={{ fontSize: 12 }}><CostCell value={s.costUsd} /></div></> },
            ]
            : [
              { title: '服务器', dataIndex: 'serverName' },
              { title: '数据目录', render: (_v, s) => <Space size={4}><Typography.Text code>{s.dataDir}</Typography.Text>{s.sharedAccount && <Tooltip title="多人共用同一账户与目录，无法区分到个人，整体归属为共享账户"><Tag color="purple">共享账户</Tag></Tooltip>}</Space> },
              { title: '数据源', dataIndex: 'source' },
              { title: 'Token', align: 'right', render: (_v, s) => <TokenCell value={s.totalTokens} /> },
              { title: '估算费用', align: 'right', render: (_v, s) => <CostCell value={s.costUsd} /> },
              { title: '来源状态', render: (_v, s) => <Space size={4} wrap>{sourceStatus(s, true)}</Space> },
              { title: '最近成功采集', render: (_v, s) => fmtTime(s.lastSuccessAt) },
            ]}
        />
      </Card>

      <Card size="small" title="告警历史" style={{ marginTop: gap }}>
        {/* 手机：两列 —— 告警（时间、规则、指标 / 周期、邮件状态）与数值（触发值 / 阈值） */}
        <Table<UserAlert>
          size="small" rowKey="id" dataSource={data?.alerts ?? []} loading={first} pagination={{ pageSize: 10, hideOnSinglePage: true, simple: isMobile }} scroll={isMobile ? undefined : { x: 860 }}
          locale={{ emptyText: '没有告警记录' }}
          columns={isMobile
            ? [
              {
                title: '告警', render: (_v, a) => (
                  <div className="wrap-anywhere">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(a.createdAt)}</Typography.Text>
                    <div>{a.ruleName ?? '—'}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.metric ? `${alertPeriodLabel(a.periodType)}${alertMetricLabel(a.metric)}` : ''}{a.metric === 'budget_pct' ? ` · ${a.tier}% 档` : ''}{a.periodKey ? ` · ${a.periodKey}` : ''}</Typography.Text>
                    <div style={{ marginTop: 2 }}><EmailStatusTag status={a.emailStatus} note={a.emailNote} />{a.incomplete && <Tag color="warning">触发时数据不完整</Tag>}</div>
                    {!a.emailStatus && a.emailNote && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.emailNote}</Typography.Text>}
                  </div>
                ),
              },
              { title: '触发值 / 阈值', align: 'right', render: (_v, a) => <><b>{fmtMetricValue(a.metric, a.observedValue)}</b><div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>阈值 {fmtMetricValue(a.metric, a.thresholdValue)}</div></> },
            ]
            : [
              { title: '触发时间', render: (_v, a) => fmtTime(a.createdAt) },
              { title: '规则', render: (_v, a) => a.ruleName ?? '—' },
              { title: '指标', render: (_v, a) => (a.metric ? `${alertPeriodLabel(a.periodType)}${alertMetricLabel(a.metric)}` : '—') },
              { title: '统计周期', dataIndex: 'periodKey' },
              { title: '档位', render: (_v, a) => (a.metric === 'budget_pct' ? `${a.tier}%` : '—') },
              { title: '触发值', align: 'right', render: (_v, a) => fmtMetricValue(a.metric, a.observedValue) },
              { title: '阈值', align: 'right', render: (_v, a) => fmtMetricValue(a.metric, a.thresholdValue) },
              { title: '数据', render: (_v, a) => (a.incomplete ? <Tag color="warning">触发时数据不完整</Tag> : <Tag>完整</Tag>) },
              { title: '邮件', render: (_v, a) => <EmailStatusTag status={a.emailStatus} note={a.emailNote} /> },
            ]}
        />
      </Card>
    </>
  );
}
