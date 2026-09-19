import { Alert, App, Button, Card, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { EmailStatusTag, PageTitle } from '../components/common';
import { fmtMetricValue, fmtTime, METRIC_LABEL, PERIOD_LABEL } from '../format';
import { useFetch } from '../hooks';
import type { AlertEvent, EmailStatus, Filters } from '../types';

export function AlertEventsPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const { message } = App.useApp();
  const [userId, setUserId] = useState<string>();
  const [kind, setKind] = useState<'usage' | 'collection_failure'>();
  const [emailStatus, setEmailStatus] = useState<EmailStatus>();
  const filters = useFetch(() => (isAdmin ? api.get<Filters>('/stats/filters') : Promise.resolve(undefined)), [isAdmin]);
  const events = useFetch(() => api.get<{ events: AlertEvent[] }>('/alerts/events', { userId, kind, emailStatus, limit: 300 }), [userId, kind, emailStatus]);

  const retry = (e: AlertEvent) => api.post(`/alerts/outbox/${e.outboxId}/retry`)
    .then(() => { message.success('已重新排队发送'); events.reload(); })
    .catch((err) => { message.error(errorMessage(err)); });

  return (
    <>
      <PageTitle title={isAdmin ? '告警记录' : '我的告警'} extra={<Button onClick={events.reload} loading={events.loading}>刷新</Button>} />
      {isAdmin && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Space wrap>
            <Select allowClear showSearch optionFilterProp="label" placeholder="用户" style={{ width: 180 }} value={userId} onChange={setUserId}
              options={filters.data?.users.map((u) => ({ value: u.id, label: u.name }))} />
            <Select allowClear placeholder="类型" style={{ width: 150 }} value={kind} onChange={setKind}
              options={[{ value: 'usage', label: '用量告警' }, { value: 'collection_failure', label: '采集失败' }]} />
            <Select allowClear placeholder="邮件状态" style={{ width: 150 }} value={emailStatus} onChange={setEmailStatus}
              options={[{ value: 'pending', label: '待发送' }, { value: 'sending', label: '发送中' }, { value: 'sent', label: '已发送' }, { value: 'failed', label: '发送失败' }]} />
          </Space>
        </Card>
      )}
      {events.error && <Alert type="error" showIcon title={events.error} style={{ marginBottom: 16 }} />}
      <Table<AlertEvent>
        size="middle" rowKey="id" loading={events.loading} dataSource={events.data?.events ?? []} scroll={{ x: 1200 }}
        pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: '没有告警记录' }}
        columns={[
          { title: '触发时间', width: 150, render: (_v, e) => fmtTime(e.createdAt) },
          { title: '类型', width: 100, render: (_v, e) => (e.kind === 'usage' ? <Tag color="orange">用量告警</Tag> : <Tag color="red">采集失败</Tag>) },
          {
            title: isAdmin ? '用户 / 来源' : '来源', render: (_v, e) => (e.kind === 'usage'
              ? (isAdmin && e.userId ? <Link to={`/users/${e.userId}`}>{e.userName}</Link> : e.userName ?? '—')
              : <>{e.serverName ?? '（来源已删除）'}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.dataDir}</Typography.Text></div></>),
          },
          { title: '规则', render: (_v, e) => (e.kind === 'usage' ? <>{e.ruleName}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.periodType && PERIOD_LABEL[e.periodType]}{e.metric && METRIC_LABEL[e.metric]}{e.metric === 'budget_pct' ? ` · ${e.tier}% 档` : ''}</Typography.Text></div></> : '连续采集失败') },
          { title: '统计周期', dataIndex: 'periodKey', render: (v: string | null) => v ?? '—' },
          { title: '触发值', align: 'right', render: (_v, e) => fmtMetricValue(e.metric, e.observedValue) },
          { title: '阈值', align: 'right', render: (_v, e) => fmtMetricValue(e.metric, e.thresholdValue) },
          {
            title: '数据状态', render: (_v, e) => (e.kind !== 'usage' ? '—' : e.incomplete
              ? <Tooltip title={`触发时部分来源尚未更新，数据截至 ${fmtTime(e.dataAsOf)}；实际用量可能更高`}><Tag color="warning">不完整</Tag></Tooltip>
              : <Tooltip title={`数据截至 ${fmtTime(e.dataAsOf)}`}><Tag>完整</Tag></Tooltip>),
          },
          {
            title: '邮件状态', render: (_v, e) => (
              <Space size={4} orientation="vertical">
                <span><EmailStatusTag status={e.emailStatus} note={e.emailNote} />{e.emailStatus === 'sent' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(e.emailSentAt)}</Typography.Text>}</span>
                {!e.emailStatus && e.emailNote && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.emailNote}</Typography.Text>}
                {isAdmin && e.emailTo && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.emailTo.join('、')}</Typography.Text>}
              </Space>
            ),
          },
          ...(isAdmin ? [{
            title: '失败原因', width: 220, render: (_v: unknown, e: AlertEvent) => (e.emailError
              ? <Typography.Paragraph type="danger" ellipsis={{ rows: 2, tooltip: e.emailError }} style={{ margin: 0, fontSize: 12 }}>第 {e.emailAttempts} 次：{e.emailError}</Typography.Paragraph>
              : '—'),
          }, {
            title: '操作', width: 80, fixed: 'right' as const, render: (_v: unknown, e: AlertEvent) => (e.emailStatus === 'failed' && e.outboxId ? <Button type="link" size="small" onClick={() => void retry(e)}>重试</Button> : null),
          }] : []),
        ]}
      />
    </>
  );
}
