import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Badge, Button, Dropdown, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { validateQuietly } from '../form';
import { useAuth } from '../auth';
import { BudgetBar, CostCell, FormRow, MobileCards, PageTitle, TokenCell } from '../components/common';
import { num } from '../format';
import { useFetch } from '../hooks';
import { useIsMobile } from '../responsive';
import type { UserListItem, UserListResponse } from '../types';

interface UserForm { name: string; email?: string; role: 'admin' | 'user'; team?: string; monthlyBudgetUsd?: number | null; password?: string; isActive: boolean }

export function UsersPage() {
  const { user: me } = useAuth();
  const { message, modal } = App.useApp();
  const { data, loading, error, reload } = useFetch(() => api.get<UserListResponse>('/users'), []);
  const [editing, setEditing] = useState<UserListItem | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<UserForm>();
  const isMobile = useIsMobile();
  const isAdmin = Form.useWatch('role', form) === 'admin';
  const editingCanLogin = editing !== null && editing !== 'new' && editing.canLogin;
  // 邮箱即登录名：管理员、已设过密码（可登录）的账户必须有邮箱；已经填过邮箱的普通用户也要能看到并修改它。
  // 后台会拒绝把可登录账户的邮箱置空，所以这些情况下邮箱必须随表单一起提交，不能因为“不是管理员”就发 null。
  const emailRequired = isAdmin || editingCanLogin;
  const showEmail = emailRequired || (editing !== null && editing !== 'new' && Boolean(editing.email));

  const open = (u: UserListItem | 'new') => {
    setEditing(u);
    form.resetFields();
    form.setFieldsValue(u === 'new'
      ? { role: 'user', isActive: true }
      : { name: u.name, email: u.email ?? undefined, role: u.role, team: u.team ?? undefined, monthlyBudgetUsd: u.monthlyBudgetUsd, isActive: u.isActive });
  };

  const submit = async () => {
    const v = await validateQuietly(form);
    if (!v) return;
    const body = {
      // 只有邮箱栏确实为空（或没有显示）时才发 null
      name: v.name, email: v.email?.trim() ? v.email.trim() : null, role: v.role, team: v.team?.trim() ? v.team.trim() : null,
      monthlyBudgetUsd: v.monthlyBudgetUsd ?? null, ...(v.password ? { password: v.password } : {}),
    };
    setSaving(true);
    try {
      if (editing === 'new') await api.post('/users', body);
      else if (editing) await api.patch(`/users/${editing.id}`, { ...body, isActive: v.isActive });
      message.success('已保存');
      setEditing(null);
      reload();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = (u: UserListItem) => modal.confirm({
    title: u.isActive ? `停用用户“${u.name}”？` : `重新启用“${u.name}”？`,
    content: u.isActive ? '停用后该用户无法登录，也不再收到告警邮件；历史统计与归属保持不变。' : undefined,
    onOk: () => api.patch(`/users/${u.id}`, { isActive: !u.isActive }).then(reload).catch((e) => { message.error(errorMessage(e)); }),
  });

  const remove = (u: UserListItem) => modal.confirm({
    title: `删除用户“${u.name}”？`, okButtonProps: { danger: true }, okText: '删除',
    content: '已绑定采集目标或已有历史统计的用户无法删除，只能停用。',
    onOk: () => api.del(`/users/${u.id}`).then(() => { message.success('已删除'); reload(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  return (
    <>
      <PageTitle title="用户列表" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} block={isMobile}>新增用户</Button>} />
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      {isMobile ? (
        // 手机：一人一张卡片；编辑常用，停用 / 删除收进“更多”
        <MobileCards<UserListItem>
          items={data?.users ?? []} rowKey={(u) => u.id} loading={loading} pageSize={20} emptyText="还没有用户"
          title={(u) => <Link to={`/users/${u.id}`}>{u.name}</Link>}
          tags={(u) => <>{u.role === 'admin' && <Tag color="blue" style={{ marginInlineEnd: 0 }}>管理员</Tag>}{!u.isActive && <Tag style={{ marginInlineEnd: 0 }}>已停用</Tag>}</>}
          fields={(u) => [
            { label: '团队', value: u.team ?? <Typography.Text type="secondary">未分组</Typography.Text> },
            { label: '今日 / 本月 Token', value: <><TokenCell value={u.todayTokens} /> / <TokenCell value={u.monthTokens} /></> },
            { label: '本月估算费用', value: <CostCell value={u.monthCost} /> },
            { label: '预算使用率', value: <div style={{ width: 150, marginLeft: 'auto' }}><BudgetBar compact cost={u.monthCost} budget={u.monthlyBudgetUsd} /></div> },
            { label: '告警状态', value: u.monthAlerts > 0 ? <Badge status="error" text={`本周期已触发 ${u.monthAlerts} 次`} /> : <Badge status="success" text="正常" /> },
            { label: '采集来源', value: u.targetCount === 0 ? <Typography.Text type="secondary">未绑定</Typography.Text> : u.failingTargets > 0 ? <Tag color="error" style={{ marginInlineEnd: 0 }}>{u.failingTargets} / {u.targetCount} 个异常</Tag> : `${u.targetCount} 个` },
          ]}
          actions={(u) => (
            <>
              <Button onClick={() => open(u)} style={{ flex: 1 }}>编辑</Button>
              <Dropdown trigger={['click']} menu={{ items: [
                { key: 'toggle', label: u.isActive ? '停用' : '启用', disabled: u.id === me?.id, onClick: () => toggleActive(u) },
                { key: 'delete', label: '删除', danger: true, disabled: u.id === me?.id, onClick: () => remove(u) },
              ] }}>
                <Button style={{ flex: 1 }}>更多 <DownOutlined /></Button>
              </Dropdown>
            </>
          )}
        />
      ) : (
      <Table<UserListItem>
        size="middle" rowKey="id" loading={loading} dataSource={data?.users ?? []} scroll={{ x: 1200 }}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        columns={[
          { title: '姓名', fixed: 'left', render: (_v, u) => <Space style={{ whiteSpace: 'nowrap' }}><Link to={`/users/${u.id}`}>{u.name}</Link>{u.role === 'admin' && <Tag color="blue">管理员</Tag>}{!u.isActive && <Tag>已停用</Tag>}</Space> },
          { title: '团队', dataIndex: 'team', render: (v: string | null) => v ?? <Typography.Text type="secondary">未分组</Typography.Text> },
          { title: '今日 Token', align: 'right', render: (_v, u) => <TokenCell value={u.todayTokens} />, sorter: (a, b) => (num(a.todayTokens) ?? 0) - (num(b.todayTokens) ?? 0) },
          { title: '本月 Token', align: 'right', render: (_v, u) => <TokenCell value={u.monthTokens} />, sorter: (a, b) => (num(a.monthTokens) ?? 0) - (num(b.monthTokens) ?? 0) },
          { title: '本月估算费用', align: 'right', render: (_v, u) => <CostCell value={u.monthCost} />, sorter: (a, b) => (a.monthCost ?? -1) - (b.monthCost ?? -1) },
          { title: '预算使用率', width: 200, render: (_v, u) => <BudgetBar cost={u.monthCost} budget={u.monthlyBudgetUsd} /> },
          { title: '告警状态', render: (_v, u) => (u.monthAlerts > 0 ? <Badge status="error" text={`本周期已触发 ${u.monthAlerts} 次`} /> : <Badge status="success" text="正常" />) },
          {
            title: '采集来源', render: (_v, u) => (u.targetCount === 0
              ? <Typography.Text type="secondary">未绑定</Typography.Text>
              : u.failingTargets > 0 ? <Tag color="error">{u.failingTargets} / {u.targetCount} 个异常</Tag> : `${u.targetCount} 个`),
          },
          {
            title: '操作', fixed: 'right', width: 170, render: (_v, u) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => open(u)}>编辑</Button>
                <Button type="link" size="small" disabled={u.id === me?.id} onClick={() => toggleActive(u)}>{u.isActive ? '停用' : '启用'}</Button>
                <Button type="link" size="small" danger disabled={u.id === me?.id} onClick={() => remove(u)}>删除</Button>
              </Space>
            ),
          },
        ]}
      />
      )}

      <Modal title={editing === 'new' ? '新增用户' : '编辑用户'} open={editing !== null} onOk={submit} confirmLoading={saving} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input maxLength={100} /></Form.Item>
          <FormRow>
            <Form.Item name="team" label="所属团队" style={{ width: 200 }}><Input maxLength={100} placeholder="可留空" /></Form.Item>
            <Form.Item name="monthlyBudgetUsd" label="月预算（US$）" tooltip="用于“月预算百分比”告警规则；留空表示不设预算">
              <InputNumber min={0} max={1e9} precision={2} inputMode="decimal" style={{ width: 160 }} placeholder="不设预算" />
            </Form.Item>
          </FormRow>
          <Form.Item name="role" label="管理员账户" tooltip="只有管理员可以登录这个网页，告警邮件也只发给管理员" style={{ marginBottom: showEmail ? 16 : 24 }}
            getValueProps={(v) => ({ checked: v === 'admin' })} getValueFromEvent={(checked: boolean) => (checked ? 'admin' : 'user')}>
            <Switch checkedChildren="是" unCheckedChildren="否" disabled={editing !== 'new' && editing?.id === me?.id} />
          </Form.Item>
          {showEmail && (
            <Form.Item name="email" label="邮箱（登录名，也是告警收件地址）" normalize={(v?: string) => v?.trim()}
              rules={[{ required: emailRequired, message: isAdmin ? '管理员必须填写邮箱（邮箱即登录名）' : '该账户已设置登录密码，必须保留邮箱（邮箱即登录名）' }, { type: 'email', message: '邮箱格式不正确' }]}>
              <Input maxLength={320} inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </Form.Item>
          )}
          {isAdmin && (
            <Form.Item name="password" label={editingCanLogin ? '重置登录密码（留空则不修改）' : '登录密码'}
              rules={[{ required: !editingCanLogin, message: '请为管理员设置登录密码' }, { min: 10, message: '密码至少 10 位' }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
          {editing !== 'new' && (
            <Form.Item name="isActive" label="账户状态" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" disabled={editing?.id === me?.id} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
