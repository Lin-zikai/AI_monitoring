import { DownOutlined, FolderOpenOutlined, HistoryOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert, App, Badge, Button, Checkbox, DatePicker, Descriptions, Drawer, Dropdown, Form, Input, InputNumber, Modal, Radio, Select, Space,
  Switch, Table, Tabs, Tag, Tooltip, Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useRef, useState, type DragEvent } from 'react';
import { api, ApiError, errorMessage } from '../api';
import { PageTitle, RUN_STATUS } from '../components/common';
import { useMeta } from '../components/Layout';
import { fmtFull, fmtTime } from '../format';
import { useFetch } from '../hooks';
import type { Credential, Filters, Run, Server, Target } from '../types';

const { Text, Paragraph } = Typography;

// ---------------------------------------------------------------- 凭据

const INSTALL_NOTE = '平台会用这台服务器的 SSH 账户登录，只在其家目录的 ~/.local/share/usage-monitor/ 下放置采集脚本与配置，不需要 root，不改动系统目录。ccusage 始终使用最新版：每次采集都通过 npx --yes ccusage@latest 运行，有新版本时自动确认更新后再取数；远端已装过的 ccusage 不会被改动，只在取不到最新版时作为后备。要求该密钥在远端有普通 shell 权限。';

/** 数据源的显示名与家目录下的默认目录名 */
const SOURCE_META: Record<string, { label: string; dir: string }> = { 'claude-code': { label: 'Claude Code', dir: '.claude' }, codex: { label: 'Codex', dir: '.codex' } };
const sourceLabel = (s: string) => SOURCE_META[s]?.label ?? s;

/** 从自动安装登记的采集命令反推远端家目录；否则按惯例猜 /home/<用户名> */
function guessHome(server: Server): string {
  const m = /^(\/.+)\/\.local\/share\/usage-monitor\/ccusage-collect$/.exec(server.collectCommand);
  return m ? m[1]! : server.sshUsername === 'root' ? '/root' : `/home/${server.sshUsername}`;
}

const CCUSAGE_MODE_TEXT: Record<string, string> = { latest: '每次采集自动更新到最新版（npx --yes ccusage@latest）', reused: '远端取不到最新版，已改用远端已安装的 ccusage', installed: '远端取不到最新版且没有已装的 ccusage，已安装一份固定版本' };

const MAX_KEY_FILE_BYTES = 20_000;

/** 私钥是否带口令保护（只看明文头部，不涉及密钥内容）。 */
function isEncryptedKey(text: string | undefined): boolean {
  if (!text) return false;
  if (/Proc-Type:\s*4,ENCRYPTED|BEGIN ENCRYPTED PRIVATE KEY/.test(text)) return true; // 传统 PEM / PKCS#8
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/.exec(text);
  if (!m) return false;
  try {
    // openssh-key-v1：magic(15 字节) + string ciphername；未加密时为 "none"
    const head = atob(m[1]!.replace(/\s+/g, '').slice(0, 64));
    const len = head.charCodeAt(18);
    return head.slice(19, 19 + len) !== 'none';
  } catch {
    return false;
  }
}

/** 私钥带口令保护时，口令必填 */
const passphraseRules = [({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
  validator: async (_: unknown, value: string | undefined) => {
    if (isEncryptedKey(getFieldValue('privateKey') as string | undefined) && !value) throw new Error('这把私钥有口令保护，请填写口令');
  },
})];

/** 私钥输入：可直接粘贴，也可把密钥文件拖进来或点按钮选择。文件只在浏览器内读取成文本，不会单独上传。 */
function PrivateKeyInput({ value, onChange, onFileName }: { value?: string; onChange?: (v: string) => void; onFileName?: (name: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const { message } = App.useApp();

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_KEY_FILE_BYTES) return void message.error('文件过大，不像是 SSH 私钥');
    const text = (await file.text()).replace(/\r\n/g, '\n');
    if (/^(ssh-|ecdsa-|sk-)\S+ AAAA/.test(text.trim())) return void message.error(`“${file.name}”是公钥文件，请选择不带 .pub 后缀的私钥文件`);
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return void message.error(`“${file.name}”不是 OpenSSH / PEM 格式的私钥`);
    onChange?.(text);
    onFileName?.(file.name);
    message.success(`已读取 ${file.name}`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); // 否则浏览器会直接打开被拖入的文件
    setDragging(false);
    void loadFile(e.dataTransfer.files[0]);
  };

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <Input.TextArea
        value={value} onChange={(e) => onChange?.(e.target.value)} rows={8} spellCheck={false} autoComplete="off"
        placeholder={'在此粘贴私钥内容，或把私钥文件（如 id_ed25519）拖到这里\n-----BEGIN OPENSSH PRIVATE KEY-----'}
        style={{ fontFamily: 'monospace', fontSize: 12, ...(dragging ? { borderColor: '#2a78d6', borderStyle: 'dashed' } : {}) }}
      />
      {dragging && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(42,120,214,0.08)', borderRadius: 6, pointerEvents: 'none', color: '#2a78d6', fontWeight: 500 }}>
          松开以读取私钥文件
        </div>
      )}
      {isEncryptedKey(value) && (
        <Alert type="warning" showIcon style={{ marginTop: 8 }} title="这把私钥有口令保护：请在下方“私钥口令”中填写口令，否则无法解析。平台采集是无人值守的，建议为采集单独生成一把不带口令的专用密钥。" />
      )}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => picker.current?.click()}>选择文件</Button>
        <Text type="secondary" style={{ fontSize: 12 }}>文件只在浏览器内读取，随表单一起提交</Text>
        <input ref={picker} type="file" style={{ display: 'none' }} onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
}

function CredentialModal({ mode, onClose, onSaved }: { mode: { kind: 'create' } | { kind: 'rotate'; credential: Credential } | null; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<{ name: string; privateKey: string; passphrase?: string }>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  const close = () => { form.resetFields(); onClose(); }; // 关闭即清空，私钥不在界面留存

  const submit = async () => {
    const v = await form.validateFields();
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
        <Form.Item name="privateKey" label="SSH 私钥（OpenSSH / PEM 格式）" rules={[{ required: true, min: 50, message: '请粘贴完整的私钥，或拖入私钥文件' }]}>
          <PrivateKeyInput onFileName={(name) => { if (mode?.kind === 'create' && !form.getFieldValue('name')) form.setFieldValue('name', name); }} />
        </Form.Item>
        <Form.Item name="passphrase" label="私钥口令（如有）" dependencies={['privateKey']} rules={passphraseRules}><Input.Password autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>
  );
}

function CredentialsTab({ credentials, loading, reload }: { credentials: Credential[]; loading: boolean; reload: () => void }) {
  const { message, modal } = App.useApp();
  const [mode, setMode] = useState<{ kind: 'create' } | { kind: 'rotate'; credential: Credential } | null>(null);

  const act = (title: string, content: string, run: () => Promise<unknown>, danger = true) => modal.confirm({
    title, content, okButtonProps: { danger }, onOk: () => run().then(() => { message.success('操作成功'); reload(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  return (
    <>
      <div style={{ marginBottom: 12 }}><Button icon={<PlusOutlined />} onClick={() => setMode({ kind: 'create' })}>新增凭据</Button></div>
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
                <Button type="link" size="small" danger disabled={Boolean(c.revokedAt)}
                  onClick={() => act(`撤销凭据“${c.name}”？`, '撤销后所有使用该凭据的采集会立即失败，直到轮换为新密钥。请同时在服务器上移除对应公钥。', () => api.post(`/credentials/${c.id}/revoke`))}>撤销</Button>
                <Button type="link" size="small" danger
                  onClick={() => act(`删除凭据“${c.name}”？`, '仍被服务器或采集目标引用的凭据无法删除。', () => api.del(`/credentials/${c.id}`))}>删除</Button>
              </Space>
            ),
          },
        ]}
      />
      <CredentialModal mode={mode} onClose={() => setMode(null)} onSaved={reload} />
    </>
  );
}

// ---------------------------------------------------------------- 服务器

interface ServerForm { name: string; host: string; port: number; sshUsername: string; credentialId: string; collectCommand: string; enabled: boolean }

type ServerFormValues = ServerForm & { userId?: string; credentialName?: string; privateKey?: string; passphrase?: string };

interface OnboardResult { id: string; ok: boolean; steps: Array<{ step: string; ok: boolean; message: string }> }
const STEP_LABEL: Record<string, string> = { hostkey: '主机指纹', collector: '采集组件', targets: '采集目标', collect: '首次采集' };

function ServerModal({ editing, credentials, users, onClose, onSaved, onCredentialCreated }: { editing: Server | 'new' | null; credentials: Credential[]; users: Filters['users']; onClose: () => void; onSaved: () => void; onCredentialCreated: () => void }) {
  const [form] = Form.useForm<ServerFormValues>();
  const [saving, setSaving] = useState(false);
  const { message, modal } = App.useApp();

  // 凭据来源：选已有的，或直接在这里录入新密钥（先创建凭据，再创建/更新服务器）
  const [credMode, setCredMode] = useState<'existing' | 'new'>('existing');
  const usable = credentials.filter((c) => !c.revokedAt);

  const showOnboardResult = (name: string, r: OnboardResult) => (r.ok ? modal.success : modal.warning)({
    title: r.ok ? `“${name}”已接入，首次采集已开始` : `“${name}”已保存，但接入没有完成`, width: 600,
    content: (
      <div>
        {r.steps.map((st) => (
          <Paragraph key={st.step} style={{ marginBottom: 6 }}>
            <Tag color={st.ok ? 'success' : 'error'}>{STEP_LABEL[st.step] ?? st.step}</Tag><span style={{ whiteSpace: 'pre-wrap' }}>{st.message}</span>
          </Paragraph>
        ))}
        <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
          {r.ok ? '之后每 2 小时自动采集。某个工具的目录在远端不存在时会显示“未使用”，不算失败。' : '解决问题后，在该服务器的“更多 → 重新接入”里重试即可，不需要重新填写。'}
        </Paragraph>
      </div>
    ),
  });

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (editing === 'new') {
        // 一步接入：后台自动信任指纹、检查/安装采集组件、创建 Claude Code 与 Codex 目标并启动首次采集
        const progress = modal.info({ title: `正在接入 ${v.name}…`, content: '连接服务器、检查采集组件（没有则自动安装）并启动首次采集，通常需要几秒到几分钟，请不要关闭页面。', okButtonProps: { loading: true, disabled: true }, okText: '进行中', keyboard: false, maskClosable: false });
        try {
          const r = await api.post<OnboardResult>('/servers/onboard', {
            name: v.name, host: v.host, port: v.port, sshUsername: v.sshUsername, userId: v.userId,
            ...(credMode === 'new'
              ? { privateKey: v.privateKey, ...(v.passphrase ? { passphrase: v.passphrase } : {}), ...(v.credentialName?.trim() ? { credentialName: v.credentialName.trim() } : {}) }
              : { credentialId: v.credentialId }),
          });
          progress.destroy();
          form.resetFields(); // 私钥不在界面留存
          onClose(); onSaved(); onCredentialCreated();
          showOnboardResult(v.name, r);
        } catch (err) { progress.destroy(); throw err; }
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
      onClose();
      onSaved();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const initial: Partial<ServerForm> = editing && editing !== 'new'
    ? { name: editing.name, host: editing.host, port: editing.port, sshUsername: editing.sshUsername, credentialId: editing.credentialId ?? undefined, collectCommand: editing.collectCommand, enabled: editing.enabled }
    : { port: 22, collectCommand: 'ccusage-collect', enabled: true };

  return (
    <Modal title={editing === 'new' ? '添加服务器' : '编辑服务器'} open={editing !== null} onOk={submit} confirmLoading={saving} onCancel={onClose} destroyOnHidden
      width={640} afterOpenChange={(o) => { if (o) { form.resetFields(); form.setFieldsValue(initial); setCredMode(editing === 'new' && usable.length === 0 ? 'new' : 'existing'); } }}>
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input maxLength={100} placeholder="例如：gpu-a" /></Form.Item>
        <Space size={16} align="start" style={{ display: 'flex' }}>
          <Form.Item name="host" label="服务器地址" rules={[{ required: true, message: '请输入主机名或 IP' }]} style={{ width: 300 }}><Input placeholder="10.0.0.12 或 host.example.com" /></Form.Item>
          <Form.Item name="port" label="SSH 端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} precision={0} /></Form.Item>
        </Space>
        {editing === 'new' && (
          <Form.Item name="userId" label="归属用户" rules={[{ required: true, message: '请选择这台服务器上的用量归属给谁' }]}
            extra="该 SSH 账户下的 Claude Code 与 Codex 用量都会记到这个人名下。还没有这个人？先到“用户列表”新增。">
            <Select showSearch optionFilterProp="label" placeholder="选择用户" options={users.map((u) => ({ value: u.id, label: u.team ? `${u.name}（${u.team}）` : u.name }))} />
          </Form.Item>
        )}
        <Form.Item name="sshUsername" label="SSH 登录用户名" rules={[{ required: true, message: '请输入用户名' }]}><Input maxLength={32} placeholder="collector" /></Form.Item>
        <Form.Item label="SSH 密钥" required style={{ marginBottom: 8 }}>
          <Radio.Group value={credMode} onChange={(e) => setCredMode(e.target.value)} optionType="button" buttonStyle="solid" size="small"
            options={[{ value: 'new', label: '录入新密钥' }, { value: 'existing', label: `选择已有凭据（${usable.length}）`, disabled: usable.length === 0 }]} />
        </Form.Item>
        {credMode === 'existing' ? (
          <Form.Item name="credentialId" rules={[{ required: true, message: '请选择凭据，或改为“录入新密钥”' }]}>
            <Select placeholder="选择凭据" options={credentials.map((c) => ({ value: c.id, label: `${c.name}（${c.keyType}）${c.revokedAt ? ' · 已撤销' : ''}`, disabled: Boolean(c.revokedAt) }))} />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="privateKey" rules={[{ required: true, min: 50, message: '请粘贴完整的私钥，或拖入私钥文件' }]} style={{ marginBottom: 12 }}
              extra="提交后加密保存并自动出现在“凭据”页，可供其他服务器复用；之后只显示名称与指纹，无法再查看明文。">
              <PrivateKeyInput />
            </Form.Item>
            <Space size={16} align="start" style={{ display: 'flex' }}>
              <Form.Item name="passphrase" label="私钥口令（如有）" dependencies={['privateKey']} rules={passphraseRules} style={{ width: 280 }}><Input.Password autoComplete="new-password" /></Form.Item>
              <Form.Item name="credentialName" label="凭据名称（可选）" style={{ width: 280 }}><Input maxLength={100} placeholder="默认：服务器名称 + “密钥”" /></Form.Item>
            </Space>
          </>
        )}
        {editing !== 'new' && (
          <>
            <Form.Item name="collectCommand" label="远端采集命令" tooltip="预装在服务器上的受限采集脚本：命令名或绝对路径。平台只会以白名单参数调用它，不会执行其他命令。" rules={[{ required: true }]}>
              <Input placeholder="ccusage-collect" />
            </Form.Item>
            <Form.Item name="enabled" label="启用采集" valuePropName="checked"><Switch /></Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}

function HostKeyModal({ server, onClose, onSaved }: { server: Server | null; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const [scan, setScan] = useState<{ fingerprint: string; confirmed: string | null; matches: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doScan = async (s: Server) => {
    setBusy(true); setError(null); setScan(null);
    try { setScan(await api.post(`/servers/${s.id}/scan-host-key`)); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!server || !scan) return;
    setBusy(true);
    try {
      await api.post(`/servers/${server.id}/confirm-host-key`, { fingerprint: scan.fingerprint });
      message.success('主机指纹已确认');
      onClose(); onSaved();
    } catch (err) { message.error(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`主机指纹 · ${server?.name ?? ''}`} open={server !== null} onCancel={onClose} destroyOnHidden width={620}
      afterOpenChange={(o) => { if (o && server) void doScan(server); else { setScan(null); setError(null); } }}
      footer={[
        <Button key="rescan" onClick={() => server && doScan(server)} loading={busy}>重新扫描</Button>,
        <Button key="ok" type="primary" danger={Boolean(scan?.confirmed && !scan.matches)} disabled={!scan || scan.matches} loading={busy} onClick={confirm}>
          {scan?.matches ? '指纹已确认' : '我已核对，确认此指纹'}
        </Button>,
      ]}
    >
      {error && <Alert type="error" showIcon title="扫描失败" description={error} />}
      {busy && !scan && !error && <Paragraph type="secondary">正在连接 {server?.host}:{server?.port} 读取主机公钥…</Paragraph>}
      {scan && (
        <>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="扫描到的指纹"><Text code copyable>{scan.fingerprint}</Text></Descriptions.Item>
            <Descriptions.Item label="已确认的指纹">{scan.confirmed ? <Text code>{scan.confirmed}</Text> : <Text type="secondary">尚未确认</Text>}</Descriptions.Item>
          </Descriptions>
          {scan.matches
            ? <Alert style={{ marginTop: 16 }} type="success" showIcon title="与已确认的指纹一致" />
            : scan.confirmed
              ? <Alert style={{ marginTop: 16 }} type="error" showIcon title="指纹与已确认的不一致！" description="可能是服务器重装或更换了主机密钥，也可能是中间人攻击。务必通过可信渠道核实后再确认。" />
              : <Alert style={{ marginTop: 16 }} type="warning" showIcon title="请通过可信渠道核对指纹" description={<>在服务器上执行 <Text code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Text>（或对应算法的公钥文件），核对输出的 SHA256 指纹与上方一致后再确认。确认之后，采集时指纹不匹配会直接拒绝连接。</>} />}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- 采集目标

interface TargetForm {
  userId: string; source: string; dataDir: string; missingOk: boolean; sources?: string[]; dirs?: Record<string, string>; sshUsername?: string; credentialId?: string; sharedAccount: boolean;
  sourceStartDate?: Dayjs | null; sourceEndDate?: Dayjs | null; enabled: boolean;
}

function TargetModal({ state, credentials, users, sources, onClose, onSaved }: {
  state: { server: Server; target: Target | null } | null; credentials: Credential[]; users: Filters['users']; sources: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [form] = Form.useForm<TargetForm>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const target = state?.target ?? null;

  const submit = async () => {
    if (!state) return;
    const v = await form.validateFields();
    const common = {
      sshUsername: v.sshUsername?.trim() || null, credentialId: v.credentialId ?? null, sharedAccount: v.sharedAccount, missingOk: v.missingOk,
      sourceStartDate: v.sourceStartDate ? v.sourceStartDate.format('YYYY-MM-DD') : null, sourceEndDate: v.sourceEndDate ? v.sourceEndDate.format('YYYY-MM-DD') : null, enabled: v.enabled,
    };
    setSaving(true);
    try {
      if (target) {
        await api.patch(`/targets/${target.id}`, { ...common, dataDir: v.dataDir.trim() });
        message.success('已保存');
      } else {
        // 每个勾选的数据源各建一个采集目标；其中一个失败不影响其他
        const failed: string[] = [];
        for (const source of v.sources ?? []) {
          try {
            await api.post(`/servers/${state.server.id}/targets`, { ...common, userId: v.userId, source, dataDir: (v.dirs?.[source] ?? '').trim() });
          } catch (err) { failed.push(`${sourceLabel(source)}：${errorMessage(err)}`); }
        }
        if (failed.length) { message.error(failed.join('；')); onSaved(); return; }
        message.success('采集目标已添加；可先“测试目录”，再“立即采集”完成首次历史回填');
      }
      onClose(); onSaved();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const available = sources.length ? sources : ['claude-code'];
  const home = state ? guessHome(state.server) : '';
  const picked: string[] = Form.useWatch('sources', form) ?? [];

  const initial: Partial<TargetForm> = target
    ? {
      userId: target.userId, source: target.source, dataDir: target.dataDir, sshUsername: target.sshUsername ?? undefined, credentialId: target.credentialId ?? undefined,
      sharedAccount: target.sharedAccount, missingOk: target.missingOk, sourceStartDate: target.sourceStartDate ? dayjs(target.sourceStartDate) : null,
      sourceEndDate: target.sourceEndDate ? dayjs(target.sourceEndDate) : null, enabled: target.enabled,
    }
    : {
      sources: available, dirs: Object.fromEntries(available.map((src) => [src, `${home}/${SOURCE_META[src]?.dir ?? `.${src}`}`])),
      sharedAccount: false, missingOk: true, enabled: true,
    };

  return (
    <Modal title={`${target ? '编辑' : '添加'}采集目标 · ${state?.server.name ?? ''}`} open={state !== null} onOk={submit} confirmLoading={saving} onCancel={onClose} destroyOnHidden width={600}
      afterOpenChange={(o) => { if (o) { form.resetFields(); form.setFieldsValue(initial); } }}>
      <Form form={form} layout="vertical" autoComplete="off">
        <Space size={16} align="start" style={{ display: 'flex' }}>
          <Form.Item name="userId" label="绑定用户" rules={[{ required: true, message: '请选择用户' }]} style={{ width: 260 }}
            extra={target ? '修改归属请使用“调整绑定”，以保留历史归属' : undefined}>
            <Select showSearch optionFilterProp="label" disabled={Boolean(target)} options={users.map((u) => ({ value: u.id, label: u.team ? `${u.name}（${u.team}）` : u.name }))} />
          </Form.Item>
          {target && <Form.Item label="数据源" style={{ width: 200 }}><Input disabled value={sourceLabel(target.source)} /></Form.Item>}
        </Space>
        {target ? (
          <Form.Item name="dataDir" label="数据目录（服务器上的绝对路径）"
            rules={[{ required: true, message: '请输入数据目录' }, { pattern: /^\/[A-Za-z0-9._@+\-/]*$/, message: '必须是不含空格与特殊字符的绝对路径' }]}>
            <Input style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="sources" label="数据源（可多选，每个数据源各建一个采集目标）" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个数据源' }]}>
              <Checkbox.Group options={available.map((src) => ({ value: src, label: sourceLabel(src) }))} />
            </Form.Item>
            {available.filter((src) => picked.includes(src)).map((src) => (
              <Form.Item key={src} name={['dirs', src]} label={`${sourceLabel(src)} 数据目录`} tooltip="服务器上的绝对路径；已按该 SSH 账户的家目录自动填写，采集别人的目录时请修改。"
                rules={[{ required: true, message: '请输入数据目录' }, { pattern: /^\/[A-Za-z0-9._@+\-/]*$/, message: '必须是不含空格与特殊字符的绝对路径' }]}>
                <Input style={{ fontFamily: 'monospace' }} />
              </Form.Item>
            ))}
          </>
        )}
        <Form.Item name="missingOk" valuePropName="checked" style={{ marginBottom: 8 }} extra="该账户还没用过这个工具时，远端不会有对应目录。勾选后这种情况显示为“未使用”，不算采集失败、不发告警。">
          <Checkbox>目录不存在时不算失败</Checkbox>
        </Form.Item>
        <Form.Item name="sharedAccount" valuePropName="checked" extra="多人共用同一账户和目录且记录无可靠身份字段时勾选：用量只能整体归属为共享账户。">
          <Checkbox>这是一个共享账户 / 共享目录</Checkbox>
        </Form.Item>
        <Space size={16} align="start" style={{ display: 'flex' }}>
          <Form.Item name="sshUsername" label="覆盖 SSH 用户名（可选）" tooltip="无法用专用采集账户集中授权时，为该目标单独指定登录用户" style={{ width: 220 }}><Input placeholder={`默认 ${state?.server.sshUsername ?? ''}`} maxLength={32} /></Form.Item>
          <Form.Item name="credentialId" label="覆盖 SSH 凭据（可选）" style={{ width: 300 }}>
            <Select allowClear placeholder="默认使用服务器凭据" options={credentials.map((c) => ({ value: c.id, label: c.name, disabled: Boolean(c.revokedAt) }))} />
          </Form.Item>
        </Space>
        <Space size={16} align="start" style={{ display: 'flex' }}>
          <Form.Item name="sourceStartDate" label="来源起始日期（可选）" tooltip="日志迁移时的来源切换边界：只入库该日期及之后的用量，避免与旧来源重复统计"><DatePicker /></Form.Item>
          <Form.Item name="sourceEndDate" label="来源截止日期（可选）" tooltip="只入库该日期及之前的用量"><DatePicker /></Form.Item>
        </Space>
        <Form.Item name="enabled" label="启用采集" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}

function RebindModal({ target, users, onClose, onSaved }: { target: Target | null; users: Filters['users']; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<{ userId: string; mode: 'from' | 'all'; effectiveFrom: Dayjs }>();
  const { message, modal } = App.useApp();
  const mode = Form.useWatch('mode', form);

  const submit = async () => {
    if (!target) return;
    const v = await form.validateFields();
    const all = v.mode === 'all';
    const userName = users.find((u) => u.id === v.userId)?.name ?? '';
    modal.confirm({
      title: all ? '确认重归属全部历史？' : '确认调整绑定？',
      okButtonProps: { danger: all },
      content: all
        ? `该目标（${target.dataDir}）的全部历史统计都会改归“${userName}”，原用户“${target.userName}”名下的这部分用量将消失。已发出的告警记录不会改变。此操作会写入审计日志。`
        : `自 ${v.effectiveFrom.format('YYYY-MM-DD')} 起的用量归属“${userName}”；此前的统计与告警仍归“${target.userName}”。`,
      onOk: async () => {
        try {
          const res = await api.post<{ reattributedRows: number; effectiveFrom: string }>(`/targets/${target.id}/rebind`,
            all ? { userId: v.userId, reattributeHistory: true } : { userId: v.userId, effectiveFrom: v.effectiveFrom.format('YYYY-MM-DD') });
          message.success(`绑定已调整，${res.reattributedRows} 行统计改归新用户`);
          onClose(); onSaved();
        } catch (err) { message.error(errorMessage(err)); }
      },
    });
  };

  return (
    <Modal title={`调整绑定 · ${target?.dataDir ?? ''}`} open={target !== null} onOk={submit} okText="下一步" onCancel={onClose} destroyOnHidden
      afterOpenChange={(o) => { if (o) { form.resetFields(); form.setFieldsValue({ mode: 'from', effectiveFrom: dayjs() }); } }}>
      <Paragraph type="secondary">当前归属：{target?.userName}。调整绑定不会静默改变已产生的统计：默认只影响生效日期之后的用量。</Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="userId" label="新的归属用户" rules={[{ required: true, message: '请选择用户' }]}>
          <Select showSearch optionFilterProp="label" options={users.filter((u) => u.id !== target?.userId).map((u) => ({ value: u.id, label: u.team ? `${u.name}（${u.team}）` : u.name }))} />
        </Form.Item>
        <Form.Item name="mode" label="生效方式">
          <Radio.Group>
            <Space orientation="vertical">
              <Radio value="from">从指定日期起生效（保留此前的历史归属）</Radio>
              <Radio value="all"><Text type="danger">显式历史重归属：全部历史统计改归新用户</Text></Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        {mode !== 'all' && <Form.Item name="effectiveFrom" label="生效日期" rules={[{ required: true, message: '请选择日期' }]}><DatePicker allowClear={false} /></Form.Item>}
      </Form>
    </Modal>
  );
}

function CollectModal({ target, onClose, onDone }: { target: Target | null; onClose: () => void; onDone: () => void }) {
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const { message, modal } = App.useApp();

  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/targets/${target.id}/collect`, { acceptDecrease: accept });
      message.success('已加入采集队列，结果入库后页面会显示新统计');
      onClose(); onDone();
    } catch (err) { message.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const submit = () => {
    if (!accept) return void run();
    modal.confirm({
      title: '确认用更小的新值覆盖历史统计？', okText: '确认覆盖', okButtonProps: { danger: true },
      content: '正常情况下，远端日志被清理导致的“用量减少”会被忽略并保留已入库的历史值。勾选此项后，本次采集范围内的统计将以远端当前结果为准，消失的日期会被清空，且无法恢复。',
      onOk: run,
    });
  };

  return (
    <Modal title={`立即采集 · ${target?.dataDir ?? ''}`} open={target !== null} onOk={submit} okText="开始采集" confirmLoading={busy} onCancel={onClose} destroyOnHidden
      afterOpenChange={(o) => { if (!o) setAccept(false); }}>
      <Paragraph>手动采集会立即执行，不改变常规调度时点；成功入库后同样会评估告警。{target && !target.initializedAt && <b>该目标尚未初始化，本次将回填历史数据（默认不触发历史周期的告警）。</b>}</Paragraph>
      {target?.hasFlaggedData && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="该目标存在“待核查”的统计（保留的历史值或异常减少）。核查确认远端数据正确后，可勾选下方选项覆盖。" />}
      <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)}><Text type="danger">接受用量减少并覆盖已入库的历史统计（危险）</Text></Checkbox>
    </Modal>
  );
}

function RunsDrawer({ state, onClose }: { state: { targetId?: string; title: string } | null; onClose: () => void }) {
  const open = state !== null;
  const { data, loading, reload } = useFetch(() => (open ? api.get<{ runs: Run[] }>('/collection/runs', { targetId: state.targetId, limit: 100 }) : Promise.resolve({ runs: [] })), [open, state?.targetId]);
  return (
    <Drawer title={state?.title} open={open} onClose={onClose} size={980} extra={<Button onClick={reload} loading={loading}>刷新</Button>} destroyOnHidden>
      <Table<Run>
        size="small" rowKey="id" loading={loading} dataSource={data?.runs ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 900 }}
        expandable={{
          rowExpandable: (r) => Boolean(r.errorMessage) || r.anomalies.length > 0,
          expandedRowRender: (r) => (
            <Space orientation="vertical" size={4}>
              {r.errorMessage && <Text type="danger">{r.errorCode}：{r.errorMessage}</Text>}
              {r.anomalies.map((a) => (
                <Text key={`${a.date}${a.kind}`} type="warning">
                  {a.date} {a.kind === 'missing' ? '远端已无该日记录（疑似日志被清理）' : '用量异常减少'}：已入库 {fmtFull(a.previousTotal)} → 新结果 {fmtFull(a.newTotal)} Token，已保留旧值并标记待核查
                </Text>
              ))}
            </Space>
          ),
        }}
        columns={[
          { title: '创建时间', render: (_v, r) => fmtTime(r.createdAt, true) },
          ...(state?.targetId ? [] : [{ title: '来源', render: (_v: unknown, r: Run) => <>{r.serverName}<div><Text type="secondary" style={{ fontSize: 12 }}>{r.dataDir} · {r.userName}</Text></div></> }]),
          { title: '触发', dataIndex: 'trigger', render: (v: string) => ({ scheduled: '定时', catchup: '补采', manual: '手动', init: '初始化' })[v] ?? v },
          { title: '状态', render: (_v, r) => { const s = RUN_STATUS[r.status] ?? { color: 'default', text: r.status }; return <Tag color={s.color}>{s.text}</Tag>; } },
          { title: '尝试', dataIndex: 'attempt', align: 'right' },
          { title: '采集范围', render: (_v, r) => (r.rangeSince ? `${r.rangeSince} ~ ${r.rangeUntil}` : '—') },
          { title: '写入行数', dataIndex: 'rowsWritten', align: 'right', render: (v: number | null) => v ?? '—' },
          { title: '异常', render: (_v, r) => (r.anomalies.length ? <Tag color="warning">{r.anomalies.length} 项待核查</Tag> : r.errorCode ? <Text type="danger">{r.errorCode}</Text> : '—') },
          { title: 'ccusage', dataIndex: 'ccusageVersion', render: (v: string | null) => v ?? '—' },
          { title: '完成时间', render: (_v, r) => fmtTime(r.finishedAt, true) },
        ]}
      />
    </Drawer>
  );
}

function targetStatus(t: Target) {
  if (t.collecting) return <Badge status="processing" text="采集中" />;
  if (!t.enabled) return <Badge status="default" text="已停用" />;
  if (t.lastStatus === 'failed') return <Tooltip title={t.lastError}><Badge status="error" text={`失败 ×${t.consecutiveFailures}${t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''}`} /></Tooltip>;
  if (t.lastErrorCode === 'NO_DATA_DIR') return <Tooltip title="远端还没有这个目录：该账户尚未使用此工具。不算采集失败；目录出现后会自动开始采集并回填历史。"><Badge status="default" text="未使用" /></Tooltip>;
  if (!t.initializedAt) return <Badge status="warning" text="待初始化" />;
  return <Badge status="success" text="正常" />;
}

// ---------------------------------------------------------------- 页面

export function ServersPage() {
  const { message, modal } = App.useApp();
  const { meta, refreshMeta } = useMeta();
  const servers = useFetch(() => api.get<{ servers: Server[] }>('/servers'), []);
  const credentials = useFetch(() => api.get<{ credentials: Credential[] }>('/credentials'), []);
  const filters = useFetch(() => api.get<Filters>('/stats/filters'), []);

  const [serverModal, setServerModal] = useState<Server | 'new' | null>(null);
  const [hostKeyFor, setHostKeyFor] = useState<Server | null>(null);
  const [targetModal, setTargetModal] = useState<{ server: Server; target: Target | null } | null>(null);
  const [rebindFor, setRebindFor] = useState<Target | null>(null);
  const [collectFor, setCollectFor] = useState<Target | null>(null);
  const [runsFor, setRunsFor] = useState<{ targetId?: string; title: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const reload = () => { servers.reload(); credentials.reload(); refreshMeta(); };
  const creds = credentials.data?.credentials ?? [];
  const users = filters.data?.users ?? [];

  const testServer = async (s: Server) => {
    setTesting(s.id);
    try {
      const r = await api.post<{ ok: boolean; stage?: 'ssh' | 'collector'; message?: string; code?: string; collectorVersion?: string | null }>(`/servers/${s.id}/test`);
      if (r.ok) message.success(`连接成功，采集脚本版本 ${r.collectorVersion ?? '未知'}`);
      else if (r.stage === 'collector') {
        // SSH 本身没问题，只是远端还没有采集脚本：直接给出自动安装入口
        askInstall(s, '已连接，但远端还没有采集脚本');
      } else modal.error({ title: '连接测试未通过', content: `${r.code ? `${r.code}：` : ''}${r.message ?? ''}` });
      servers.reload();
    } catch (err) { message.error(errorMessage(err)); } finally { setTesting(null); }
  };

  const installCollector = async (s: Server) => {
    const progress = modal.info({ title: `正在 ${s.name} 上配置采集组件…`, content: '通过 SSH 执行，通常需要几秒到几分钟，请不要关闭页面。', okButtonProps: { loading: true, disabled: true }, okText: '进行中', keyboard: false, maskClosable: false });
    try {
      const r = await api.post<{ ok: boolean; code?: string; message?: string; collectCommand?: string; nodeVersion?: string; ccusageVersion?: string; defaultDataDir?: string; ccusageMode?: string; ccusagePath?: string; versionMismatch?: boolean }>(`/servers/${s.id}/install-collector`);
      progress.destroy();
      if (r.ok) {
        modal.success({
          title: '采集组件已就绪', width: 600,
          content: (
            <div>
              <Paragraph>{CCUSAGE_MODE_TEXT[r.ccusageMode ?? ''] ?? ''}：ccusage {r.ccusageVersion}{r.ccusageMode === 'reused' ? <>（<Text code>{r.ccusagePath}</Text>）</> : null}，Node {r.nodeVersion}。</Paragraph>
              {r.versionMismatch && <Paragraph type="warning">该版本与平台核对过输出格式的版本不同：可以正常采集，但估算费用的口径可能与其他服务器略有差异（每行统计都会记录当时的版本）。</Paragraph>}
              <Paragraph>采集命令已自动登记为 <Text code>{r.collectCommand}</Text></Paragraph>
              <Paragraph style={{ marginBottom: 0 }}>下一步：展开该服务器点“添加采集目标”，勾选要采集的数据源（Claude Code、Codex），目录会自动填好。</Paragraph>
            </div>
          ),
        });
      } else modal.error({ title: '未成功', width: 640, content: <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{`${r.code ? `${r.code}：` : ''}${r.message ?? ''}`}</pre> });
      servers.reload();
    } catch (err) { progress.destroy(); message.error(errorMessage(err)); }
  };

  /** 重新执行一步接入（修正问题后重试，或给早先添加的服务器补上默认采集目标） */
  const reOnboard = async (s: Server) => {
    if (!s.defaultUserId && s.targets.length === 0) return void message.warning('这台服务器还没有归属用户：请先“添加采集目标”，或删除后重新添加');
    const progress = modal.info({ title: `正在重新接入 ${s.name}…`, content: '通常需要几秒到几分钟，请不要关闭页面。', okButtonProps: { loading: true, disabled: true }, okText: '进行中', keyboard: false, maskClosable: false });
    try {
      const r = await api.post<OnboardResult>(`/servers/${s.id}/onboard`, s.defaultUserId ? {} : { userId: s.targets[0]!.userId });
      progress.destroy();
      (r.ok ? modal.success : modal.warning)({ title: r.ok ? '接入完成，采集已开始' : '接入没有完成', width: 600, content: <div>{r.steps.map((st) => <Paragraph key={st.step} style={{ marginBottom: 6 }}><Tag color={st.ok ? 'success' : 'error'}>{STEP_LABEL[st.step] ?? st.step}</Tag>{st.message}</Paragraph>)}</div> });
      reload();
    } catch (err) { progress.destroy(); message.error(errorMessage(err)); }
  };

  const askInstall = (s: Server, title: string) => modal.confirm({ title, width: 560, okText: '开始', cancelText: '稍后', content: INSTALL_NOTE, onOk: () => { void installCollector(s); } });

  const testTarget = async (t: Target) => {
    setTesting(t.id);
    try {
      const r = await api.post<{ ok: boolean; message?: string; code?: string; ccusageVersion?: string | null; logFiles?: number | null }>(`/targets/${t.id}/test`);
      if (r.ok) message.success(`目录可读：发现 ${r.logFiles ?? 0} 个日志文件，ccusage ${r.ccusageVersion ?? '版本未知'}`);
      else modal.error({ title: '目录测试未通过', content: `${r.code ? `${r.code}：` : ''}${r.message ?? ''}` });
    } catch (err) { message.error(errorMessage(err)); } finally { setTesting(null); }
  };

  /** 删除：已有历史统计时后台返回 409 HAS_USAGE，二次确认后带 purge=true 重试。 */
  const remove = (kind: 'servers' | 'targets', id: string, label: string) => modal.confirm({
    title: `删除${kind === 'servers' ? '服务器' : '采集目标'}“${label}”？`, okText: '删除', okButtonProps: { danger: true },
    content: '如只是暂时不采集，建议改为停用。',
    onOk: async () => {
      try {
        await api.del(`/${kind}/${id}`);
        message.success('已删除'); reload();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'HAS_USAGE') {
          modal.confirm({
            title: '同时清除历史统计？', okText: '清除并删除', okButtonProps: { danger: true },
            content: <><Paragraph>{err.message}</Paragraph><Text type="danger">清除后这些用量会从所有用户的统计中消失，且无法恢复。</Text></>,
            onOk: () => api.del(`/${kind}/${id}`, { purge: true }).then(() => { message.success('已删除并清除历史统计'); reload(); }).catch((e) => { message.error(errorMessage(e)); }),
          });
        } else message.error(errorMessage(err));
      }
    },
  });

  const toggle = (kind: 'servers' | 'targets', id: string, enabled: boolean) =>
    api.patch(`/${kind}/${id}`, { enabled }).then(reload).catch((e) => { message.error(errorMessage(e)); });

  const runAll = () => modal.confirm({
    title: '对全部已启用目标立即采集？', content: '会创建一个手动批次，不改变常规调度时点。正在采集中的目标会被跳过。',
    onOk: () => api.post<{ runs: number }>('/collection/run-all').then((r) => { message.success(`已创建 ${r.runs} 个采集任务`); reload(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  const targetTable = (s: Server) => (
    <Table<Target>
      size="small" rowKey="id" pagination={false} dataSource={s.targets} scroll={{ x: 1000 }}
      locale={{ emptyText: '尚未添加采集目标' }}
      footer={() => <Button size="small" icon={<PlusOutlined />} onClick={() => setTargetModal({ server: s, target: null })}>添加采集目标</Button>}
      columns={[
        { title: '数据目录', render: (_v, t) => <Space size={4} wrap><Text code>{t.dataDir}</Text>{t.sharedAccount && <Tag color="purple">共享账户</Tag>}{t.hasFlaggedData && <Tooltip title="存在保留的历史值或异常减少标记，见采集记录"><Tag color="warning">待核查</Tag></Tooltip>}</Space> },
        { title: '绑定用户', dataIndex: 'userName' },
        { title: '数据源', dataIndex: 'source', render: (v: string) => sourceLabel(v) },
        { title: 'SSH 登录', render: (_v, t) => (t.sshUsername || t.credentialId ? <Tooltip title="该目标覆盖了服务器级 SSH 登录"><Tag>{t.sshUsername ?? s.sshUsername} · 单独配置</Tag></Tooltip> : <Text type="secondary">同服务器</Text>) },
        { title: '来源边界', render: (_v, t) => (t.sourceStartDate || t.sourceEndDate ? `${t.sourceStartDate ?? '…'} ~ ${t.sourceEndDate ?? '…'}` : '—') },
        { title: '状态', render: (_v, t) => targetStatus(t) },
        { title: '最近成功采集', render: (_v, t) => fmtTime(t.lastSuccessAt) },
        {
          title: '操作', width: 250, render: (_v, t) => (
            <Space size={4}>
              <Button type="link" size="small" disabled={t.collecting || !t.enabled || !s.enabled} onClick={() => setCollectFor(t)}>立即采集</Button>
              <Button type="link" size="small" loading={testing === t.id} onClick={() => testTarget(t)}>测试目录</Button>
              <Dropdown menu={{
                items: [
                  { key: 'edit', label: '编辑', onClick: () => setTargetModal({ server: s, target: t }) },
                  { key: 'rebind', label: '调整绑定', onClick: () => setRebindFor(t) },
                  { key: 'runs', label: '采集记录', onClick: () => setRunsFor({ targetId: t.id, title: `采集记录 · ${s.name} ${t.dataDir}` }) },
                  { key: 'toggle', label: t.enabled ? '停用' : '启用', onClick: () => void toggle('targets', t.id, !t.enabled) },
                  { type: 'divider' },
                  { key: 'delete', danger: true, label: '删除', onClick: () => remove('targets', t.id, t.dataDir) },
                ],
              }}>
                <Button type="link" size="small">更多 <DownOutlined /></Button>
              </Dropdown>
            </Space>
          ),
        },
      ]}
    />
  );

  const serverTable = (
    <Table<Server>
      size="middle" rowKey="id" loading={servers.loading} dataSource={servers.data?.servers ?? []} pagination={false} scroll={{ x: 1100 }}
      expandable={{ expandedRowRender: targetTable, defaultExpandAllRows: true }}
      columns={[
        { title: '名称', render: (_v, s) => <Space>{s.name}{!s.enabled && <Tag>已停用</Tag>}</Space> },
        { title: '地址', render: (_v, s) => <Text code>{s.sshUsername}@{s.host}:{s.port}</Text> },
        { title: '凭据', render: (_v, s) => (s.credentialName ? <>{s.credentialName}{s.credentialRevoked && <Tag color="error" style={{ marginLeft: 6 }}>已撤销</Tag>}</> : <Text type="danger">未配置</Text>) },
        {
          title: '主机指纹', render: (_v, s) => (s.hostKeyFingerprint
            ? <Tooltip title={s.hostKeyFingerprint}><Tag color="success">已确认</Tag></Tooltip>
            : <Button size="small" type="primary" ghost onClick={() => setHostKeyFor(s)}>扫描并确认</Button>),
        },
        { title: '采集目标', render: (_v, s) => { const bad = s.targets.filter((t) => t.enabled && t.lastStatus === 'failed').length; return bad ? <Tag color="error">{bad} / {s.targets.length} 个失败</Tag> : `${s.targets.length} 个`; } },
        { title: '最近连接成功', render: (_v, s) => fmtTime(s.lastConnectOkAt) },
        { title: '最近错误', ellipsis: true, render: (_v, s) => (s.lastError ? <Text type="danger" title={s.lastError}>{s.lastError}</Text> : '—') },
        {
          title: '操作', width: 220, render: (_v, s) => (
            <Space size={4}>
              <Button type="link" size="small" loading={testing === s.id} disabled={!s.hostKeyFingerprint} onClick={() => testServer(s)}>测试连接</Button>
              <Button type="link" size="small" onClick={() => setServerModal(s)}>编辑</Button>
              <Dropdown menu={{
                items: [
                  { key: 'hostkey', label: '主机指纹', onClick: () => setHostKeyFor(s) },
                  { key: 'onboard', label: '重新接入', onClick: () => void reOnboard(s) },
                  { key: 'install', label: '安装 / 更新采集组件', disabled: !s.hostKeyFingerprint, onClick: () => askInstall(s, `在“${s.name}”上安装 / 更新采集组件`) },
                  { key: 'toggle', label: s.enabled ? '停用' : '启用', onClick: () => void toggle('servers', s.id, !s.enabled) },
                  { type: 'divider' },
                  { key: 'delete', danger: true, label: '删除', onClick: () => remove('servers', s.id, s.name) },
                ],
              }}>
                <Button type="link" size="small">更多 <DownOutlined /></Button>
              </Dropdown>
            </Space>
          ),
        },
      ]}
    />
  );

  return (
    <>
      <PageTitle
        title="服务器管理"
        extra={(
          <Space wrap>
            <Button icon={<HistoryOutlined />} onClick={() => setRunsFor({ title: '最近采集运行记录' })}>采集记录</Button>
            <Button icon={<ThunderboltOutlined />} onClick={runAll}>全部立即采集</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setServerModal('new')}>添加服务器</Button>
          </Space>
        )}
      />
      {(servers.error || credentials.error) && <Alert type="error" showIcon title={servers.error ?? credentials.error} style={{ marginBottom: 16 }} />}
      <Tabs
        items={[
          { key: 'servers', label: `服务器（${servers.data?.servers.length ?? 0}）`, children: serverTable },
          { key: 'credentials', label: `凭据（${creds.length}）`, children: <CredentialsTab credentials={creds} loading={credentials.loading} reload={reload} /> },
        ]}
      />

      <ServerModal editing={serverModal} credentials={creds} users={users} onClose={() => setServerModal(null)} onSaved={reload} onCredentialCreated={credentials.reload} />
      <HostKeyModal server={hostKeyFor} onClose={() => setHostKeyFor(null)} onSaved={reload} />
      <TargetModal state={targetModal} credentials={creds} users={users} sources={meta?.sources ?? []} onClose={() => setTargetModal(null)} onSaved={reload} />
      <RebindModal target={rebindFor} users={users} onClose={() => setRebindFor(null)} onSaved={reload} />
      <CollectModal target={collectFor} onClose={() => setCollectFor(null)} onDone={reload} />
      <RunsDrawer state={runsFor} onClose={() => setRunsFor(null)} />
    </>
  );
}
