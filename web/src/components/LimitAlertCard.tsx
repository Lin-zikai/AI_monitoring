import { App, Button, Card, Checkbox, Form, InputNumber, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useFetch } from '../hooks';

interface LimitAlert { enabled: boolean; remainingBelowPercent: number; includeFiveHour: boolean; notifyAdmins: boolean; emails: string[] }

/** 账号额度提醒：Claude Code / Codex 共用账号的额度剩余不足时发邮件 */
export function LimitAlertCard() {
  const { message } = App.useApp();
  const [form] = Form.useForm<LimitAlert>();
  const { data, reload } = useFetch(() => api.get<LimitAlert>('/settings/limit-alert'), []);
  const [saving, setSaving] = useState(false);
  const enabled = Form.useWatch('enabled', form);
  useEffect(() => { if (data) form.setFieldsValue(data); }, [data, form]);

  const save = async (v: LimitAlert) => {
    setSaving(true);
    try { await api.put('/settings/limit-alert', { ...v, emails: v.emails ?? [] }); message.success('已保存'); reload(); } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <Card size="small" title="账号额度提醒" style={{ marginBottom: 16 }}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>Claude Code 或 Codex 共用账号的额度快用完时发邮件；同一窗口在一个刷新周期内只提醒一次</Typography.Text>}>
      <Form form={form} layout="inline" onFinish={save} disabled={!data} style={{ rowGap: 12 }}>
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="周额度剩余低于">
          <Space size={4}><Form.Item name="remainingBelowPercent" noStyle rules={[{ required: true, message: '请输入比例' }]}><InputNumber min={1} max={99} precision={0} style={{ width: 80 }} disabled={!enabled} /></Form.Item>% 时提醒</Space>
        </Form.Item>
        <Form.Item name="includeFiveHour" valuePropName="checked" tooltip="5 小时窗口几小时就刷新一次，默认不为它发邮件"><Checkbox disabled={!enabled}>5 小时窗口也提醒</Checkbox></Form.Item>
        <Form.Item name="notifyAdmins" valuePropName="checked"><Checkbox disabled={!enabled}>通知管理员</Checkbox></Form.Item>
        <Form.Item name="emails" label="收件邮箱" rules={[{ type: 'array', defaultField: { type: 'email', message: '邮箱格式不正确' } }]}>
          <Select mode="tags" open={false} tokenSeparators={[',', ' ', ';']} placeholder="输入邮箱后回车" style={{ minWidth: 280 }} disabled={!enabled} />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit" loading={saving}>保存</Button></Form.Item>
      </Form>
    </Card>
  );
}
