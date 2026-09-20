import { Alert, App, Button, Card, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { EmailStatusTag, FilterBar, LoadMore, LongText, MobileCards, PageTitle } from '../components/common';
import { useMeta } from '../components/Layout';
import { alertMetricLabel, alertPeriodLabel, fmtMetricValue, fmtTime } from '../format';
import { useFetch, usePagedFetch } from '../hooks';
import { useIsMobile } from '../responsive';
import type { AlertEvent, EmailStatus, Filters } from '../types';

const PAGE_SIZE = 200;

export function AlertEventsPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const { message } = App.useApp();
  const { meta } = useMeta();
  const isMobile = useIsMobile();
  const [userId, setUserId] = useState<string>();
  const [kind, setKind] = useState<'usage' | 'collection_failure' | 'account_limit'>();
  const [emailStatus, setEmailStatus] = useState<EmailStatus>();
  const filters = useFetch(() => (isAdmin ? api.get<Filters>('/stats/filters') : Promise.resolve(undefined)), [isAdmin]);
  const events = usePagedFetch(
    (offset, limit) => api.get<{ events: AlertEvent[] }>('/alerts/events', { userId, kind, emailStatus, limit, offset }).then((r) => r.events),
    [userId, kind, emailStatus], PAGE_SIZE, (e) => e.id,
  );

  const retry = (e: AlertEvent) => api.post(`/alerts/outbox/${e.outboxId}/retry`)
    .then(() => { message.success('已重新排队发送'); events.reload(); })
    .catch((err) => { message.error(errorMessage(err)); });

  // 表格（桌面）与卡片（手机）共用的单元格内容
  const kindTag = (e: AlertEvent) => (e.kind === 'usage' ? <Tag color="orange">用量告警</Tag> : e.kind === 'account_limit' ? <Tag color="gold">账号额度</Tag> : <Tag color="red">采集失败</Tag>);
  const sourceCell = (e: AlertEvent): ReactNode => (e.kind === 'usage'
    ? (isAdmin && e.userId ? <Link to={`/users/${e.userId}`}>{e.userName}</Link> : e.userName ?? '—')
    : e.kind === 'account_limit' ? '订阅账号'
    : <>{e.serverName ?? '（来源已删除）'}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.dataDir}</Typography.Text></div></>);
  const ruleCell = (e: AlertEvent): ReactNode => (e.kind === 'usage' ? <>{e.ruleName}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{alertPeriodLabel(e.periodType)}{alertMetricLabel(e.metric)}{e.metric === 'budget_pct' ? ` · ${e.tier}% 档` : ''}</Typography.Text></div></>
    : e.kind === 'account_limit' ? <>{e.ruleName}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{[e.source && (meta?.sourceInfo?.[e.source]?.label ?? e.source), e.periodType && `${alertPeriodLabel(e.periodType)}窗口`].filter(Boolean).join(' · ')}</Typography.Text></div></>
    : '连续采集失败');
  const periodText = (e: AlertEvent) => (e.kind === 'account_limit' ? (e.periodKey && e.periodKey !== 'unknown' ? `至 ${fmtTime(e.periodKey)} 刷新` : '—') : e.periodKey ?? '—');
  const emailCell = (e: AlertEvent) => (
    <Space size={4} orientation="vertical" align={isMobile ? 'end' : undefined}>
      <span><EmailStatusTag status={e.emailStatus} note={e.emailNote} />{e.emailStatus === 'sent' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(e.emailSentAt)}</Typography.Text>}</span>
      {!e.emailStatus && e.emailNote && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.emailNote}</Typography.Text>}
      {isAdmin && e.emailTo && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.emailTo.join('、')}</Typography.Text>}
    </Space>
  );

  return (
    <>
      <PageTitle title={isAdmin ? '告警记录' : '我的告警'} extra={<Button onClick={events.reload} loading={events.loading} block={isMobile}>刷新</Button>} />
      {isAdmin && (
        <Card size="small" style={{ marginBottom: isMobile ? 12 : 16 }}>
          <FilterBar items={[
            { key: 'user', node: <Select allowClear showSearch optionFilterProp="label" placeholder="用户" style={{ width: 180 }} value={userId} onChange={setUserId}
              options={filters.data?.users.map((u) => ({ value: u.id, label: u.name }))} /> },
            { key: 'kind', half: true, node: <Select allowClear placeholder="类型" style={{ width: 150 }} value={kind} onChange={setKind}
              options={[{ value: 'usage', label: '用量告警' }, { value: 'account_limit', label: '账号额度' }, { value: 'collection_failure', label: '采集失败' }]} /> },
            { key: 'email', half: true, node: <Select allowClear placeholder="邮件状态" style={{ width: 150 }} value={emailStatus} onChange={setEmailStatus}
              options={[{ value: 'pending', label: '待发送' }, { value: 'sending', label: '发送中' }, { value: 'sent', label: '已发送' }, { value: 'failed', label: '发送失败' }]} /> },
          ]} />
        </Card>
      )}
      {events.error && <Alert type="error" showIcon title={events.error} style={{ marginBottom: 16 }} />}
      {isMobile ? (
        // 手机：一条告警一张卡片。桌面端靠悬停查看的内容（数据截至时间、完整的失败原因）在这里直接写出来
        <MobileCards<AlertEvent>
          items={events.items} rowKey={(e) => e.id} loading={events.loading} pageSize={20} emptyText="没有告警记录"
          title={(e) => kindTag(e)}
          tags={(e) => <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>{fmtTime(e.createdAt)}</Typography.Text>}
          fields={(e) => {
            const valueMetric = e.kind === 'account_limit' ? 'limit_used_pct' : e.metric;
            return [
              { label: isAdmin ? '用户 / 来源' : '来源', value: sourceCell(e) },
              { label: '规则', value: ruleCell(e) },
              { label: '统计周期', value: periodText(e) },
              { label: '触发值 / 阈值', value: <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtMetricValue(valueMetric, e.observedValue)}</b> / {fmtMetricValue(valueMetric, e.thresholdValue)}</span> },
              e.kind === 'usage' && { label: '数据状态', value: <>{e.incomplete ? <Tag color="warning" style={{ marginInlineEnd: 0 }}>不完整</Tag> : <Tag style={{ marginInlineEnd: 0 }}>完整</Tag>}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>数据截至 {fmtTime(e.dataAsOf)}{e.incomplete ? '；实际用量可能更高' : ''}</Typography.Text></div></> },
              { label: '邮件', value: emailCell(e) },
              isAdmin && Boolean(e.emailError) && { label: '失败原因', block: true, value: <LongText danger>{`第 ${e.emailAttempts} 次：${e.emailError}`}</LongText> },
            ];
          }}
          actions={isAdmin ? (e) => (e.emailStatus === 'failed' && e.outboxId ? <Button onClick={() => void retry(e)} style={{ flex: 1 }}>重新发送邮件</Button> : null) : undefined}
        />
      ) : (
      <Table<AlertEvent>
        size="middle" rowKey="id" loading={events.loading} dataSource={events.items} scroll={{ x: 1200 }}
        pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: '没有告警记录' }}
        columns={[
          { title: '触发时间', width: 150, render: (_v, e) => fmtTime(e.createdAt) },
          { title: '类型', width: 100, render: (_v, e) => kindTag(e) },
          { title: isAdmin ? '用户 / 来源' : '来源', render: (_v, e) => sourceCell(e) },
          { title: '规则', render: (_v, e) => ruleCell(e) },
          { title: '统计周期', render: (_v, e) => periodText(e) },
          { title: '触发值', align: 'right', render: (_v, e) => fmtMetricValue(e.kind === 'account_limit' ? 'limit_used_pct' : e.metric, e.observedValue) },
          { title: '阈值', align: 'right', render: (_v, e) => fmtMetricValue(e.kind === 'account_limit' ? 'limit_used_pct' : e.metric, e.thresholdValue) },
          {
            title: '数据状态', render: (_v, e) => (e.kind !== 'usage' ? '—' : e.incomplete
              ? <Tooltip title={`触发时部分来源尚未更新，数据截至 ${fmtTime(e.dataAsOf)}；实际用量可能更高`}><Tag color="warning">不完整</Tag></Tooltip>
              : <Tooltip title={`数据截至 ${fmtTime(e.dataAsOf)}`}><Tag>完整</Tag></Tooltip>),
          },
          { title: '邮件状态', render: (_v, e) => emailCell(e) },
          ...(isAdmin ? [{
            title: '失败原因', width: 220, render: (_v: unknown, e: AlertEvent) => (e.emailError
              ? <Typography.Paragraph type="danger" ellipsis={{ rows: 2, tooltip: e.emailError }} style={{ margin: 0, fontSize: 12 }}>第 {e.emailAttempts} 次：{e.emailError}</Typography.Paragraph>
              : '—'),
          }, {
            title: '操作', width: 80, fixed: 'right' as const, render: (_v: unknown, e: AlertEvent) => (e.emailStatus === 'failed' && e.outboxId ? <Button type="link" size="small" onClick={() => void retry(e)}>重试</Button> : null),
          }] : []),
        ]}
      />
      )}
      <LoadMore hasMore={events.hasMore} loading={events.loadingMore} count={events.items.length} onClick={events.loadMore} />
    </>
  );
}
