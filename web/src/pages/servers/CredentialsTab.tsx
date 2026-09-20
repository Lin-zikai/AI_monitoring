import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Dropdown, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { MobileCards } from '../../components/common';
import { validateQuietly } from '../../form';
import { fmtTime } from '../../format';
import { useIsMobile } from '../../responsive';
import type { Credential } from '../../types';
import { passphraseRules, PRIVATE_KEY_RULES, PrivateKeyInput } from './PrivateKeyInput';

const { Text } = Typography;

type CredentialMode = { kind: 'create' } | { kind: 'rotate'; credential: Credential } | null;

function CredentialModal({ mode, onClose, onSaved }: { mode: CredentialMode; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<{ name: string; privateKey: string; passphrase?: string }>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  const close = () => { form.resetFields(); onClose(); }; // 关闭即清空，私钥不在界面留存

  const submit = async () => {
    const v = await validateQuietly(form);
    if (!v) return;
    setSaving(true);
    try {
      const body = { privateKey: v.privateKey, ...(v.passphrase ? { passphrase: v.passphrase } : {}) };
      const res = mode?.kind === 'rotate'
        ? await api.post<{ publicFingerprint: string }>(`/credentials/${mode.credential.id}/rotate`, body)
        : await api.post<{ publicFingerprint: string }>('/credentials', { name: v.name, ...body });
      message.success(`已保存，公钥指纹 ${res.publicFingerprint}`);
      close();
      onSaved();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={mode?.kind === 'rotate' ? `轮换凭据“${mode.credential.name}”` : '新增 SSH 凭据'} open={mode !== null} onOk={submit} confirmLoading={saving} onCancel={close} destroyOnHidden width={640}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} title="私钥提交后会加密保存，之后任何界面和接口都只显示名称与公钥指纹，无法再次查看明文。请使用专用采集账户的密钥。" />
      <Form form={form} layout="vertical" autoComplete="off">
        {mode?.kind === 'create' && <Form.Item name="name" label="凭据名称" rules={[{ required: true, message: '请输入名称' }]}><Input maxLength={100} placeholder="例如：collector-ed25519" /></Form.Item>}
        <Form.Item name="privateKey" label="SSH 私钥（OpenSSH / PEM 格式）" rules={PRIVATE_KEY_RULES}>
          <PrivateKeyInput onFileName={(name) => { if (mode?.kind === 'create' && !form.getFieldValue('name')) form.setFieldValue('name', name); }} />
        </Form.Item>
        <Form.Item name="passphrase" label="私钥口令（如有）" dependencies={['privateKey']} rules={passphraseRules}><Input.Password autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>
  );
}

export function CredentialsTab({ credentials, loading, reload }: { credentials: Credential[]; loading: boolean; reload: () => void }) {
  const { message, modal } = App.useApp();
  const [mode, setMode] = useState<CredentialMode>(null);
  const isMobile = useIsMobile();

  const act = (title: string, content: string, run: () => Promise<unknown>, danger = true) => modal.confirm({
    title, content, okButtonProps: { danger }, onOk: () => run().then(() => { message.success('操作成功'); reload(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  const revoke = (c: Credential) => act(`撤销凭据“${c.name}”？`, '撤销后所有使用该凭据的采集会立即失败，直到轮换为新密钥。请同时在服务器上移除对应公钥。', () => api.post(`/credentials/${c.id}/revoke`));
  const remove = (c: Credential) => act(`删除凭据“${c.name}”？`, '仍被服务器或采集目标引用的凭据无法删除。', () => api.del(`/credentials/${c.id}`));

  return (
    <>
      <div style={{ marginBottom: 12 }}><Button icon={<PlusOutlined />} onClick={() => setMode({ kind: 'create' })} block={isMobile}>新增凭据</Button></div>
      {isMobile ? (
        <MobileCards<Credential>
          items={credentials} rowKey={(c) => c.id} loading={loading} emptyText="还没有凭据"
          title={(c) => c.name}
          tags={(c) => (c.revokedAt ? <Tag color="error" style={{ marginInlineEnd: 0 }}>已撤销</Tag> : <Tag color="success" style={{ marginInlineEnd: 0 }}>有效</Tag>)}
          fields={(c) => [
            { label: '公钥指纹', block: true, value: <Text code copyable style={{ fontSize: 12 }}>{c.publicFingerprint}</Text> },
            { label: '类型 · 引用数', value: `${c.keyType} · ${c.usedBy}` },
            { label: '创建', value: fmtTime(c.createdAt) },
            c.rotatedAt ? { label: '轮换', value: fmtTime(c.rotatedAt) } : null,
            c.revokedAt ? { label: '撤销', value: fmtTime(c.revokedAt) } : null,
          ]}
          actions={(c) => (
            <>
              <Button onClick={() => setMode({ kind: 'rotate', credential: c })} style={{ flex: 1 }}>轮换</Button>
              <Dropdown trigger={['click']} menu={{ items: [
                { key: 'revoke', danger: true, label: '撤销', disabled: Boolean(c.revokedAt), onClick: () => revoke(c) },
                { key: 'delete', danger: true, label: '删除', onClick: () => remove(c) },
              ] }}>
                <Button style={{ flex: 1 }}>更多 <DownOutlined /></Button>
              </Dropdown>
            </>
          )}
        />
      ) : (
      <Table<Credential>
        size="middle" rowKey="id" loading={loading} dataSource={credentials} pagination={false} scroll={{ x: 900 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '公钥指纹', render: (_v, c) => <Text code copyable style={{ fontSize: 12 }}>{c.publicFingerprint}</Text> },
          { title: '类型', dataIndex: 'keyType' },
          { title: '状态', render: (_v, c) => (c.revokedAt ? <Tag color="error">已撤销（{fmtTime(c.revokedAt)}）</Tag> : <Tag color="success">有效</Tag>) },
          { title: '引用数', dataIndex: 'usedBy', align: 'right' },
          { title: '创建 / 轮换', render: (_v, c) => <>{fmtTime(c.createdAt)}{c.rotatedAt && <div><Text type="secondary" style={{ fontSize: 12 }}>轮换于 {fmtTime(c.rotatedAt)}</Text></div>}</> },
          {
            title: '操作', width: 200, render: (_v, c) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => setMode({ kind: 'rotate', credential: c })}>轮换</Button>
                <Button type="link" size="small" danger disabled={Boolean(c.revokedAt)} onClick={() => revoke(c)}>撤销</Button>
                <Button type="link" size="small" danger onClick={() => remove(c)}>删除</Button>
              </Space>
            ),
          },
        ]}
      />
      )}
      <CredentialModal mode={mode} onClose={() => setMode(null)} onSaved={reload} />
    </>
  );
}
