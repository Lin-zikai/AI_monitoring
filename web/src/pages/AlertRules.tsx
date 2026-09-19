import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Checkbox, Form, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { PageTitle } from '../components/common';
import { fmtCost, fmtFull, METRIC_LABEL, PERIOD_LABEL } from '../format';
import { useFetch } from '../hooks';
import type { AlertRule, AlertRuleInput, Filters, Metric, Period, ScopeType } from '../types';

interface RuleForm {
  name: string; metric: Metric; period: Period; source: string; tiers: string[]; scopeType: ScopeType; scopeUserId?: string; scopeTeam?: string;
  notifyAdmins: boolean; extraEmails: string[]; enabled: boolean;
}

const SOURCE_OPTIONS = [{ value: 'claude-code', label: '仅 Claude Code' }, { value: 'codex', label: '仅 Codex' }];
const fmtTier = (metric: Metric, t: number) => (metric === 'budget_pct' ? `${t}%` : metric === 'cost' ? fmtCost(t) : `${fmtFull(t)} Token`);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AlertRulesPage() {
  const { message, modal } = App.useApp();
  const rules = useFetch(() => api.get<{ rules: AlertRule[] }>('/alerts/rules'), []);
  const filters = useFetch(() => api.get<Filters>('/stats/filters'), []);
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<RuleForm>();
  const metric = Form.useWatch('metric', form);
  const scopeType = Form.useWatch('scopeType', form);

  const open = (r: AlertRule | 'new') => {
    setEditing(r);
    form.resetFields();
    form.setFieldsValue(r === 'new'
      ? { metric: 'budget_pct', period: 'monthly', source: 'all', tiers: ['80', '100'], scopeType: 'global', notifyAdmins: true, extraEmails: [], enabled: true }
      : { ...r, source: r.source ?? 'all', tiers: r.tiers.map(String), scopeUserId: r.scopeUserId ?? undefined, scopeTeam: r.scopeTeam ?? undefined });
  };

  const submit = async () => {
    const v = await form.validateFields();
    const body: AlertRuleInput = {
      name: v.name.trim(), source: v.source === 'all' ? null : v.source, metric: v.metric, period: v.metric === 'budget_pct' ? 'monthly' : v.period, tiers: v.tiers.map(Number),
      scopeType: v.scopeType, scopeUserId: v.scopeType === 'user' ? v.scopeUserId ?? null : null, scopeTeam: v.scopeType === 'team' ? v.scopeTeam ?? null : null,
      notifyAdmins: v.notifyAdmins, extraEmails: v.extraEmails ?? [], enabled: v.enabled,
    };
    setSaving(true);
    try {
      if (editing === 'new') await api.post('/alerts/rules', body);
      else if (editing) await api.put(`/alerts/rules/${editing.id}`, body);
      message.success('已保存');
      setEditing(null);
      rules.reload();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const toggle = (r: AlertRule) => {
    const { id: _id, scopeUserName: _n, createdAt: _c, updatedAt: _u, ...input } = r;
    return api.put(`/alerts/rules/${r.id}`, { ...input, enabled: !r.enabled }).then(rules.reload).catch((e) => { message.error(errorMessage(e)); });
  };

  const remove = (r: AlertRule) => modal.confirm({
    title: `删除规则“${r.name}”？`, content: '已产生的告警记录会保留。', okText: '删除', okButtonProps: { danger: true },
    onOk: () => api.del(`/alerts/rules/${r.id}`).then(() => { message.success('已删除'); rules.reload(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  return (
    <>
      <PageTitle title="告警规则" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>新增规则</Button>} />
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        title="告警在每次采集成功入库后评估（含手动采集），正常情况下从用量变化到收到提醒最长约一个采集周期。每个统计周期的每个档位只提醒一次；第一版仅提醒，不会停用账户或终止任务。" />
      {rules.error && <Alert type="error" showIcon title={rules.error} style={{ marginBottom: 16 }} />}
      <Table<AlertRule>
        size="middle" rowKey="id" loading={rules.loading} dataSource={rules.data?.rules ?? []} pagination={false} scroll={{ x: 1000 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '指标', render: (_v, r) => <>{`${PERIOD_LABEL[r.period]}${METRIC_LABEL[r.metric]}`} {r.source && <Tag>{SOURCE_OPTIONS.find((o) => o.value === r.source)?.label ?? r.source}</Tag>}</> },
          { title: '阈值档位', render: (_v, r) => <Space size={4} wrap>{r.tiers.map((t) => <Tag key={t}>{fmtTier(r.metric, t)}</Tag>)}</Space> },
          { title: '适用范围', render: (_v, r) => (r.scopeType === 'global' ? '全部用户' : r.scopeType === 'team' ? `团队：${r.scopeTeam}` : `用户：${r.scopeUserName ?? r.scopeUserId}`) },
          {
            title: '收件人', render: (_v, r) => (
              <Space size={4} wrap>
                {r.notifyAdmins && <Tag>管理员</Tag>}
                {r.extraEmails.map((e) => <Tag key={e}>{e}</Tag>)}
              </Space>
            ),
          },
          { title: '启用', render: (_v, r) => <Switch size="small" checked={r.enabled} onChange={() => void toggle(r)} /> },
          { title: '操作', width: 120, render: (_v, r) => <Space size={4}><Button type="link" size="small" onClick={() => open(r)}>编辑</Button><Button type="link" size="small" danger onClick={() => remove(r)}>删除</Button></Space> },
        ]}
      />

      <Modal title={editing === 'new' ? '新增告警规则' : '编辑告警规则'} open={editing !== null} onOk={submit} confirmLoading={saving} onCancel={() => setEditing(null)} destroyOnHidden width={600}>
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入名称' }]}><Input maxLength={100} placeholder="例如：月度预算提醒" /></Form.Item>
          <Space size={16} align="start" style={{ display: 'flex' }}>
            <Form.Item name="metric" label="指标" style={{ width: 220 }}>
              <Select
                onChange={(m: Metric) => { if (m === 'budget_pct') form.setFieldsValue({ period: 'monthly' }); form.setFieldsValue({ tiers: m === 'budget_pct' ? ['80', '100'] : [] }); }}
                options={[{ value: 'tokens', label: 'Token 用量' }, { value: 'cost', label: '估算费用（US$）' }, { value: 'budget_pct', label: '月预算百分比' }]}
              />
            </Form.Item>
            <Form.Item name="period" label="统计周期">
              <Radio.Group disabled={metric === 'budget_pct'} options={[{ value: 'daily', label: '每日（自然日）' }, { value: 'monthly', label: '每月（自然月）' }]} />
            </Form.Item>
          </Space>
          <Form.Item name="source" label="数据范围" extra="选某一个数据源时，只统计该数据源的用量（例如只看 Codex 的日费用）。给某个用户单独设了规则后，同一指标和周期的全局 / 团队规则不再对他生效。">
            <Radio.Group options={[{ value: 'all', label: '全部数据源合计' }, ...SOURCE_OPTIONS]} />
          </Form.Item>
          <Form.Item
            name="tiers" label={`阈值档位（${metric === 'budget_pct' ? '百分比，如 80、100' : metric === 'cost' ? 'US$' : 'Token 数，如 10000000'}）`}
            extra={metric === 'budget_pct' ? '按用户各自的月预算计算；未设置月预算的用户不触发。输入后回车，可添加多个档位，每个档位分别提醒一次。' : '输入数值后回车，可添加多个档位，每个档位在每个周期分别提醒一次。'}
            rules={[{
              validator: (_r, value: string[] | undefined) => {
                if (!value?.length) return Promise.reject(new Error('至少填写一个阈值'));
                if (value.length > 10) return Promise.reject(new Error('最多 10 个档位'));
                for (const t of value) {
                  const n = Number(t);
                  if (!Number.isFinite(n) || n <= 0) return Promise.reject(new Error(`“${t}”不是有效的正数`));
                  if (metric === 'tokens' && !Number.isInteger(n)) return Promise.reject(new Error('Token 阈值必须为整数'));
                  if (metric === 'budget_pct' && n > 1000) return Promise.reject(new Error('百分比档位应为 1～1000'));
                }
                if (new Set(value.map(Number)).size !== value.length) return Promise.reject(new Error('档位不能重复'));
                return Promise.resolve();
              },
            }]}
          >
            <Select mode="tags" open={false} suffixIcon={null} tokenSeparators={[',', '，', ' ']} placeholder="输入数值后回车" />
          </Form.Item>
          <Form.Item name="scopeType" label="适用范围">
            <Radio.Group options={[{ value: 'global', label: '全部用户' }, { value: 'team', label: '指定团队' }, { value: 'user', label: '指定用户' }]} />
          </Form.Item>
          {scopeType === 'team' && (
            <Form.Item name="scopeTeam" label="团队" rules={[{ required: true, message: '请选择团队' }]}>
              <Select options={filters.data?.teams.map((t) => ({ value: t, label: t }))} placeholder="选择团队" />
            </Form.Item>
          )}
          {scopeType === 'user' && (
            <Form.Item name="scopeUserId" label="用户" rules={[{ required: true, message: '请选择用户' }]}>
              <Select showSearch optionFilterProp="label" options={filters.data?.users.map((u) => ({ value: u.id, label: u.name }))} placeholder="选择用户" />
            </Form.Item>
          )}
          <Form.Item label="收件人" required style={{ marginBottom: 8 }}>
            <Space size={24}>
              <Form.Item name="notifyAdmins" valuePropName="checked" noStyle><Checkbox>全部管理员</Checkbox></Form.Item>
            </Space>
          </Form.Item>
          <Form.Item name="extraEmails" label="额外收件邮箱"
            rules={[{ validator: (_r, v: string[] | undefined) => ((v ?? []).every((e) => EMAIL.test(e)) ? Promise.resolve() : Promise.reject(new Error('包含无效的邮箱地址'))) },
              ({ getFieldValue }) => ({ validator: (_r, v: string[] | undefined) => (getFieldValue('notifyAdmins') || (v ?? []).length > 0 ? Promise.resolve() : Promise.reject(new Error('至少需要一类收件人'))) })]}>
            <Select mode="tags" open={false} suffixIcon={null} tokenSeparators={[',', ';', ' ']} placeholder="输入邮箱后回车，可留空" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>费用均为基于 ccusage 的估算费用，不代表订阅实际扣费或官方剩余额度。</Typography.Text>
      </Modal>
    </>
  );
}
