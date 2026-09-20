import { Alert, App, Button, Card, Checkbox, Form, InputNumber, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useFetch } from '../hooks';
import { useIsMobile } from '../responsive';

interface LimitAlert { enabled: boolean; remainingBelowPercent: number; includeFiveHour: boolean; notifyAdmins: boolean; emails: string[] }

/** 账号额度提醒：Claude Code / Codex 共用账号的额度剩余不足时发邮件 */
export function LimitAlertCard() {
  const { message } = App.useApp();
  const [form] = Form.useForm<LimitAlert>();
  const { data, loading, error, reload } = useFetch(() => api.get<LimitAlert>('/settings/limit-alert'), []);
  const [saving, setSaving] = useState(false);
  const enabled = Form.useWatch('enabled', form);
  const isMobile = useIsMobile();
  useEffect(() => { if (data) form.setFieldsValue(data); }, [data, form]);

  const save = async (v: LimitAlert) => {
    setSaving(true);
    try { await api.put('/settings/limit-alert', { ...v, emails: v.emails ?? [] }); message.success('已保存'); reload(); } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const tight = isMobile ? { marginBottom: 8 } : undefined;
  const note = <Typography.Text type="secondary" style={{ fontSize: 12 }}>任一订阅账号（Claude Code / Codex）的额度快用完时发邮件；每个账号的同一窗口在一个刷新周期内只提醒一次</Typography.Text>;

  return (
    <Card size="small" title="账号额度提醒" style={{ marginBottom: 16 }} extra={isMobile ? undefined : note}>
      {/* 手机上说明文字放进正文，不和标题抢一行 */}
      {isMobile && <div style={{ marginBottom: 12 }}>{note}</div>}
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} title="提醒设置加载失败" description={error} action={<Button size="small" onClick={reload} loading={loading}>重试</Button>} />}
      <Form form={form} layout={isMobile ? 'vertical' : 'inline'} onFinish={save} disabled={!data} style={{ rowGap: 12 }}>
        {isMobile
          // 手机：开关与文字同一行，复选项之间收紧间距
          ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 40, marginBottom: 8 }}><span>启用</span><Form.Item name="enabled" valuePropName="checked" noStyle><Switch aria-label="启用账号额度提醒" /></Form.Item></div>
          : <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>}
        <Form.Item label="周额度剩余低于" style={isMobile ? { marginBottom: 12 } : undefined}>
          <Space size={4}><Form.Item name="remainingBelowPercent" noStyle rules={[{ required: true, message: '请输入比例' }]}><InputNumber min={1} max={99} precision={0} inputMode="numeric" style={{ width: isMobile ? 96 : 80 }} disabled={!enabled} /></Form.Item>% 时提醒</Space>
        </Form.Item>
        <Form.Item name="includeFiveHour" valuePropName="checked" tooltip="5 小时窗口几小时就刷新一次，默认不为它发邮件" style={tight}
          extra={isMobile ? '5 小时窗口几小时就刷新一次，默认不为它发邮件' : undefined}><Checkbox disabled={!enabled}>5 小时窗口也提醒</Checkbox></Form.Item>
        <Form.Item name="notifyAdmins" valuePropName="checked" style={tight}><Checkbox disabled={!enabled}>通知管理员</Checkbox></Form.Item>
        <Form.Item name="emails" label="收件邮箱" rules={[{ type: 'array', defaultField: { type: 'email', message: '邮箱格式不正确' } }]}>
          <Select mode="tags" open={false} tokenSeparators={[',', ' ', ';']} placeholder="输入邮箱后回车" style={{ minWidth: isMobile ? 0 : 280 }} disabled={!enabled} />
        </Form.Item>
        <Form.Item style={isMobile ? { marginBottom: 0 } : undefined}><Button type="primary" htmlType="submit" loading={saving} block={isMobile}>保存</Button></Form.Item>
      </Form>
    </Card>
  );
}
