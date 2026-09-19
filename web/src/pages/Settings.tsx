import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Table, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { PageTitle } from '../components/common';
import { useMeta } from '../components/Layout';
import { fmtTime } from '../format';
import { useFetch } from '../hooks';
import type { AuditLog, GeneralSettings, SmtpSettings } from '../types';

const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['Asia/Shanghai', 'UTC']; }
})();

function GeneralTab() {
  const { message } = App.useApp();
  const { refreshMeta } = useMeta();
  const { data, error } = useFetch(() => api.get<GeneralSettings>('/settings/general'), []);
  const [form] = Form.useForm<GeneralSettings>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) form.setFieldsValue(data); }, [data, form]);

  const save = async (v: GeneralSettings) => {
    setSaving(true);
    try {
      await api.put('/settings/general', v);
      message.success('已保存；采集周期或时区的变更会在下一个调度时点生效');
      refreshMeta();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const num = (min: number, max: number) => <InputNumber min={min} max={max} precision={0} style={{ width: 160 }} />;
  return (
    <Card size="small">
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" onFinish={save} style={{ maxWidth: 560 }} disabled={!data}>
        <Form.Item name="timezone" label="统计时区" extra="日、月统计与告警统一按该时区的自然日 / 自然月计算；修改后新采集的数据按新时区分日，历史数据不会自动重算。" rules={[{ required: true }]}>
          <Select showSearch options={TIMEZONES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        <Form.Item name="collectIntervalHours" label="采集周期" extra="从统计时区每日 00:00 起按该间隔调度。" rules={[{ required: true }]}>
          <Select style={{ width: 160 }} options={INTERVALS.map((h) => ({ value: h, label: `每 ${h} 小时` }))} />
        </Form.Item>
        <Form.Item name="lookbackDays" label="常规回看天数" extra="每次轮询重算当天及最近几天的统计（覆盖更新，不累加）。" rules={[{ required: true }]}>{num(1, 30)}</Form.Item>
        <Form.Item name="reconcileDays" label="对账天数" extra="每个自然日的首个批次按该范围对账，补齐延迟写入的记录。" rules={[{ required: true }]}>{num(1, 400)}</Form.Item>
        <Form.Item name="backfillDays" label="首次回填天数" extra="新采集目标首次接入时导入的历史范围。" rules={[{ required: true }]}>{num(1, 1500)}</Form.Item>
        <Form.Item name="backfillAlerts" label="首次回填时为历史周期发送告警" valuePropName="checked" extra="默认关闭，避免首次接入时集中发送过期提醒；当前周期的超限始终会提醒。">
          <Switch />
        </Form.Item>
        <Form.Item name="failureAlertThreshold" label="连续失败通知阈值（轮）" extra="某采集目标连续失败达到该轮数时通知管理员，每段连续失败只通知一次。" rules={[{ required: true }]}>{num(1, 100)}</Form.Item>
        <Form.Item name="retentionDays" label="统计数据保留天数" extra="0 表示永久保留。超过保留期的每日统计会被定期清理。" rules={[{ required: true }]}>{num(0, 10000)}</Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
      </Form>
    </Card>
  );
}

interface SmtpForm { host: string; port: number; secure: boolean; username?: string; from: string; password?: string; clearPassword?: boolean }

const SMTP_PRESETS = [{ label: '163 邮箱', host: 'smtp.163.com' }, { label: 'QQ 邮箱', host: 'smtp.qq.com' }, { label: '126 邮箱', host: 'smtp.126.com' }];

function SmtpTab() {
  const { message, modal } = App.useApp();
  const { user } = useAuth();
  const { data, error, reload } = useFetch(() => api.get<SmtpSettings>('/settings/smtp'), []);
  const [form] = Form.useForm<SmtpForm>();
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!data) return;
    form.setFieldsValue(data.configured ? { host: data.host, port: data.port, secure: data.secure, username: data.username, from: data.from } : { port: 587, secure: false });
  }, [data, form]);

  const save = async (v: SmtpForm) => {
    setSaving(true);
    try {
      // 密码留空 = 不修改；勾选“清除”才发送空字符串
      const password = v.clearPassword ? '' : v.password ? v.password : undefined;
      await api.put('/settings/smtp', { host: v.host.trim(), port: v.port, secure: v.secure, username: v.username?.trim() || undefined, from: v.from.trim(), ...(password !== undefined ? { password } : {}) });
      message.success('SMTP 设置已保存');
      form.setFieldsValue({ password: undefined, clearPassword: false });
      reload();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; message?: string }>('/settings/smtp/test', { to: testTo });
      if (r.ok) message.success(`测试邮件已发送至 ${testTo}`);
      else modal.error({ title: '测试邮件发送失败', content: r.message });
    } catch (err) { message.error(errorMessage(err)); } finally { setTesting(false); }
  };

  return (
    <Card size="small">
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      {data && !data.configured && (
        <Alert type={data.envFallback ? 'info' : 'warning'} showIcon style={{ marginBottom: 16 }}
          title={data.envFallback ? '当前使用环境变量中的 SMTP 配置；在此保存后将以这里的设置为准。' : '尚未配置 SMTP：告警邮件会保留在发件箱中，配置后自动发送。'} />
      )}
      <Form form={form} layout="vertical" onFinish={save} style={{ maxWidth: 560 }} autoComplete="off" disabled={!data}>
        <Form.Item label="快速预设" extra="点一下自动填好服务器、端口和加密方式；之后只需填邮箱地址和授权码。163 / QQ 邮箱的“密码”是客户端授权码（网页邮箱 设置 → POP3/SMTP/IMAP 里开启 SMTP 服务后生成），不是登录密码。">
          <Space>
            {SMTP_PRESETS.map((p) => (
              <Button key={p.label} size="small" onClick={() => form.setFieldsValue({ host: p.host, port: 465, secure: true })}>{p.label}</Button>
            ))}
          </Space>
        </Form.Item>
        <Form.Item label="邮箱地址" extra="填写后自动同步到下面的“用户名”和“发件人”。">
          <Input placeholder="yourname@163.com" autoComplete="off" onChange={(e) => { const v = e.target.value.trim(); form.setFieldsValue({ username: v, from: v ? `用量监控 <${v}>` : '' }); }} />
        </Form.Item>
        <Space size={16} align="start" style={{ display: 'flex' }}>
          <Form.Item name="host" label="SMTP 服务器" rules={[{ required: true, message: '请输入服务器地址' }]} style={{ width: 320 }}><Input placeholder="smtp.example.com" /></Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} precision={0} /></Form.Item>
        </Space>
        <Form.Item name="secure" label="隐式 TLS（通常为 465 端口）" valuePropName="checked" extra="关闭时使用 STARTTLS 并强制升级为加密连接，不会以明文投递。"><Switch /></Form.Item>
        <Form.Item name="username" label="用户名（可选）"><Input autoComplete="off" /></Form.Item>
        <Form.Item name="password" label="密码 / 授权码" extra={data?.hasPassword ? '已保存密码（不回显）。留空表示不修改。' : '留空表示不设置密码。'}>
          <Input.Password autoComplete="new-password" placeholder={data?.hasPassword ? '••••••••（留空不修改）' : ''} />
        </Form.Item>
        {data?.hasPassword && <Form.Item name="clearPassword" valuePropName="checked" label="清除已保存的密码"><Switch /></Form.Item>}
        <Form.Item name="from" label="发件人" rules={[{ required: true, message: '请输入发件人' }]}><Input placeholder="用量监控 <usage@example.com>" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
      </Form>
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #f0f0f0', maxWidth: 560 }}>
        <Typography.Paragraph type="secondary">发送测试邮件（使用已保存的设置）：</Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="收件邮箱" />
          <Button onClick={test} loading={testing} disabled={!testTo}>发送测试邮件</Button>
        </Space.Compact>
      </div>
    </Card>
  );
}

function AuditTab() {
  const [entityType, setEntityType] = useState<string>();
  const { data, loading, error, reload } = useFetch(() => api.get<{ logs: AuditLog[] }>('/audit', { entityType, limit: 300 }), [entityType]);
  return (
    <Card size="small">
      <Space style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="对象类型" style={{ width: 180 }} value={entityType} onChange={setEntityType}
          options={[['user', '用户'], ['credential', '凭据'], ['server', '服务器'], ['target', '采集目标'], ['batch', '采集批次'], ['alert_rule', '告警规则'], ['email_outbox', '邮件'], ['settings', '系统设置']].map(([value, label]) => ({ value, label }))} />
        <Button onClick={reload} loading={loading}>刷新</Button>
      </Space>
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
      <Table<AuditLog>
        size="small" rowKey="id" loading={loading} dataSource={data?.logs ?? []} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 1000 }}
        expandable={{ expandedRowRender: (l) => <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(l.detail, null, 2)}</pre>, rowExpandable: (l) => Object.keys(l.detail ?? {}).length > 0 }}
        columns={[
          { title: '时间', width: 170, render: (_v, l) => fmtTime(l.createdAt, true) },
          { title: '操作人', dataIndex: 'actorEmail', render: (v: string | null) => v ?? '—' },
          { title: '操作', dataIndex: 'action', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '对象', render: (_v, l) => `${l.entityType}${l.entityId ? ` · ${l.entityId}` : ''}`, ellipsis: true },
          { title: 'IP', dataIndex: 'ip', width: 140, render: (v: string | null) => v ?? '—' },
        ]}
      />
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageTitle title="系统设置" />
      <Tabs
        destroyOnHidden
        items={[
          { key: 'general', label: '通用设置', children: <GeneralTab /> },
          { key: 'smtp', label: 'SMTP 邮件', children: <SmtpTab /> },
          { key: 'audit', label: '审计日志', children: <AuditTab /> },
        ]}
      />
    </>
  );
}
