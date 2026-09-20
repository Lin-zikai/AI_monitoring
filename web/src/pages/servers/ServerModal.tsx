import { App, Form, Input, InputNumber, Modal, Radio, Select, Switch } from 'antd';
import { useLayoutEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { FormRow } from '../../components/common';
import { useIsMobile } from '../../responsive';
import { validateQuietly } from '../../form';
import type { Credential, Filters, Server } from '../../types';
import { passphraseRules, PRIVATE_KEY_RULES, PrivateKeyInput } from './PrivateKeyInput';
import { showOnboardResult, userOptions, withProgressModal, type OnboardResult } from './shared';

interface ServerForm { name: string; host: string; port: number; sshUsername: string; credentialId: string; collectCommand: string; enabled: boolean }
type ServerFormValues = ServerForm & { userId?: string; credentialName?: string; privateKey?: string; passphrase?: string };

export function ServerModal({ editing, credentials, users, intervalHours, onClose, onSaved, onCredentialCreated }: {
  editing: Server | 'new' | null; credentials: Credential[]; users: Filters['users']; intervalHours?: number;
  onClose: () => void; /** collecting：本次保存可能启动了首次采集，列表需要跟进刷新 */ onSaved: (collecting: boolean) => void; onCredentialCreated: () => void;
}) {
  const [form] = Form.useForm<ServerFormValues>();
  const [saving, setSaving] = useState(false);
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();

  // 凭据来源：选已有的，或直接在这里录入新密钥（先创建凭据，再创建/更新服务器）
  const [credMode, setCredMode] = useState<'existing' | 'new'>('existing');
  const usable = credentials.filter((c) => !c.revokedAt);

  // 打开的那一刻（首帧绘制之前）就填好初值：不会闪一下上一次的内容，也不会覆盖用户刚开始输入的字
  useLayoutEffect(() => {
    if (editing === null) return;
    form.resetFields();
    form.setFieldsValue(editing === 'new'
      ? { port: 22, collectCommand: 'ccusage-collect', enabled: true }
      : { name: editing.name, host: editing.host, port: editing.port, sshUsername: editing.sshUsername, credentialId: editing.credentialId ?? undefined, collectCommand: editing.collectCommand, enabled: editing.enabled });
    setCredMode(editing === 'new' && usable.length === 0 ? 'new' : 'existing');
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 无论保存还是取消，关闭时都清空表单：粘贴过的私钥不在表单存储里留存
  const close = () => { form.resetFields(); onClose(); };

  const submit = async () => {
    const v = await validateQuietly(form);
    if (!v) return;
    setSaving(true);
    try {
      if (editing === 'new') {
        // 一步接入：后台自动信任指纹、检查/安装采集组件、创建 Claude Code 与 Codex 目标并启动首次采集
        const r = await withProgressModal(modal, `正在接入 ${v.name}…`, '连接服务器、检查采集组件（没有则自动安装）并启动首次采集，通常需要几秒到几分钟，请不要关闭页面。', () => api.post<OnboardResult>('/servers/onboard', {
          name: v.name, host: v.host, port: v.port, sshUsername: v.sshUsername, userId: v.userId,
          ...(credMode === 'new'
            ? { privateKey: v.privateKey, ...(v.passphrase ? { passphrase: v.passphrase } : {}), ...(v.credentialName?.trim() ? { credentialName: v.credentialName.trim() } : {}) }
            : { credentialId: v.credentialId }),
        }));
        close(); onSaved(true); onCredentialCreated();
        showOnboardResult(modal, r, { ok: `“${v.name}”已接入，首次采集已开始`, failed: `“${v.name}”已保存，但接入没有完成` }, intervalHours);
        return;
      }
      let credentialId = v.credentialId;
      if (credMode === 'new') {
        const created = await api.post<{ id: string; publicFingerprint: string }>('/credentials', {
          name: v.credentialName?.trim() || `${v.name} 密钥`, privateKey: v.privateKey, ...(v.passphrase ? { passphrase: v.passphrase } : {}),
        });
        credentialId = created.id;
        // 密钥已入库：立刻切回“已有凭据”并清掉明文，后续步骤失败重试时不会重复创建
        form.setFieldsValue({ credentialId, privateKey: undefined, passphrase: undefined, credentialName: undefined });
        setCredMode('existing');
        onCredentialCreated();
        message.success(`密钥已加密保存，公钥指纹 ${created.publicFingerprint}`);
      }
      if (editing) {
        const res = await api.patch<{ hostKeyReset: boolean }>(`/servers/${editing.id}`, { name: v.name, host: v.host, port: v.port, sshUsername: v.sshUsername, credentialId, collectCommand: v.collectCommand, enabled: v.enabled });
        if (res.hostKeyReset) message.warning('地址或端口已变更，原主机指纹已作废；请在“更多 → 重新接入”里重新记录');
        else message.success('已保存');
      }
      close();
      onSaved(false);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing === 'new' ? '添加服务器' : '编辑服务器'} open={editing !== null} onOk={submit} confirmLoading={saving} onCancel={close} destroyOnHidden width={640}>
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input maxLength={100} placeholder="例如：gpu-a" /></Form.Item>
        <FormRow>
          <Form.Item name="host" label="服务器地址" rules={[{ required: true, message: '请输入主机名或 IP' }]} style={{ width: 300 }}><Input placeholder="10.0.0.12 或 host.example.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Form.Item>
          <Form.Item name="port" label="SSH 端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} precision={0} inputMode="numeric" /></Form.Item>
        </FormRow>
        {editing === 'new' && (
          <Form.Item name="userId" label="归属用户" rules={[{ required: true, message: '请选择这台服务器上的用量归属给谁' }]}
            extra="该 SSH 账户下的 Claude Code 与 Codex 用量都会记到这个人名下。还没有这个人？先到“用户列表”新增。">
            <Select showSearch optionFilterProp="label" placeholder="选择用户" options={userOptions(users)} />
          </Form.Item>
        )}
        <Form.Item name="sshUsername" label="SSH 登录用户名" rules={[{ required: true, message: '请输入用户名' }]}><Input maxLength={32} placeholder="collector" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Form.Item>
        <Form.Item label="SSH 密钥" required style={{ marginBottom: 8 }}>
          <Radio.Group value={credMode} onChange={(e) => setCredMode(e.target.value)} optionType="button" buttonStyle="solid" size={isMobile ? 'middle' : 'small'}
            options={[{ value: 'new', label: '录入新密钥' }, { value: 'existing', label: `选择已有凭据（${usable.length}）`, disabled: usable.length === 0 }]} />
        </Form.Item>
        {credMode === 'existing' ? (
          <Form.Item name="credentialId" rules={[{ required: true, message: '请选择凭据，或改为“录入新密钥”' }]}>
            <Select placeholder="选择凭据" options={credentials.map((c) => ({ value: c.id, label: `${c.name}（${c.keyType}）${c.revokedAt ? ' · 已撤销' : ''}`, disabled: Boolean(c.revokedAt) }))} />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="privateKey" rules={PRIVATE_KEY_RULES} style={{ marginBottom: 12 }}
              extra="提交后加密保存并自动出现在“凭据”页，可供其他服务器复用；之后只显示名称与指纹，无法再查看明文。">
              <PrivateKeyInput />
            </Form.Item>
            <FormRow>
              <Form.Item name="passphrase" label="私钥口令（如有）" dependencies={['privateKey']} rules={passphraseRules} style={{ width: 280 }}><Input.Password autoComplete="new-password" /></Form.Item>
              <Form.Item name="credentialName" label="凭据名称（可选）" style={{ width: 280 }}><Input maxLength={100} placeholder="默认：服务器名称 + “密钥”" /></Form.Item>
            </FormRow>
          </>
        )}
        {editing !== 'new' && (
          <>
            <Form.Item name="collectCommand" label="远端采集命令" tooltip="预装在服务器上的受限采集脚本：命令名或绝对路径。平台只会以白名单参数调用它，不会执行其他命令。" rules={[{ required: true }]}>
              <Input placeholder="ccusage-collect" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </Form.Item>
            <Form.Item name="enabled" label="启用采集" valuePropName="checked"><Switch /></Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
