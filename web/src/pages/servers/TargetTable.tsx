import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Badge, Button, Dropdown, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { api, errorMessage } from '../../api';
import { CardFields, LongText } from '../../components/common';
import { fmtTime } from '../../format';
import { useIsMobile } from '../../responsive';
import type { Meta, Server, Target } from '../../types';
import { sourceLabel } from './shared';

const { Text, Paragraph } = Typography;

export interface TargetActions {
  add(server: Server): void;
  collect(target: Target): void;
  test(target: Target): void;
  edit(server: Server, target: Target): void;
  rebind(target: Target): void;
  runs(server: Server, target: Target): void;
  toggle(target: Target): void;
  remove(target: Target): void;
  /** 目录已改正并重新排队采集（或中途失败）：刷新列表并跟进采集状态 */
  dirFixed(): void;
}

/** 远端用环境变量改了数据目录、而平台采集的不是那个目录：提示并一键改正 */
function DirHint({ t, onFixed, asButton }: { t: Target; onFixed: () => void; /** 手机卡片里：用正常尺寸的按钮代替小标签（标签只有 22px 高，不好点） */ asButton?: boolean }) {
  const { message, modal } = App.useApp();
  if (!t.dirHint) return null;
  const fix = () => modal.confirm({
    title: '改为采集实际使用的目录？', okText: '改用该目录并重新采集',
    content: <div><Paragraph>这个账户通过环境变量把 {t.source === 'codex' ? 'Codex（CODEX_HOME）' : 'Claude Code（CLAUDE_CONFIG_DIR）'} 的数据目录设成了：</Paragraph><Paragraph><Text code>{t.dirHint}</Text></Paragraph><Paragraph style={{ marginBottom: 0 }}>平台现在采集的是 <Text code>{t.dataDir}</Text>，很可能是一个已经不用的旧目录，用量和账号额度都会不准。</Paragraph></div>,
    onOk: async () => {
      let patched = false;
      try {
        await api.patch(`/targets/${t.id}`, { dataDir: t.dirHint });
        patched = true;
        await api.post(`/targets/${t.id}/collect`);
        message.success('已改用实际目录，并开始重新采集');
      } catch (err) {
        message.error(patched ? `目录已改用 ${t.dirHint}，但重新采集没有启动：${errorMessage(err)}。请稍后点“立即采集”。` : errorMessage(err));
      } finally {
        onFixed(); // 目录可能已经改了：无论后一步成败都刷新列表
      }
    },
  });
  if (asButton) return <Button onClick={fix}>改用该目录并重新采集</Button>;
  return (
    <Tooltip title={`实际使用的目录是 ${t.dirHint}，点击改正`}>
      {/* 用原生 button 包住 Tag：键盘可聚焦、回车 / 空格可触发 */}
      <button type="button" onClick={fix} style={{ border: 0, padding: 0, marginLeft: 8, background: 'none', cursor: 'pointer', font: 'inherit' }}>
        <Tag color="warning" style={{ marginInlineEnd: 0 }}>目录可能不对</Tag>
      </button>
    </Tooltip>
  );
}

function targetStatus(t: Target, withTooltip = true) {
  if (t.collecting) return <Badge status="processing" text="采集中" />;
  if (!t.enabled) return <Badge status="default" text="已停用" />;
  if (!withTooltip) {
    if (t.lastStatus === 'failed') return <Badge status="error" text={`失败 ×${t.consecutiveFailures}${t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''}`} />;
    if (t.lastErrorCode === 'NO_DATA_DIR') return <Badge status="default" text="未使用" />;
  }
  if (t.lastStatus === 'failed') return <Tooltip title={t.lastError}><Badge status="error" text={`失败 ×${t.consecutiveFailures}${t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''}`} /></Tooltip>;
  if (t.lastErrorCode === 'NO_DATA_DIR') return <Tooltip title="远端还没有这个目录：该账户尚未使用此工具。不算采集失败，平时不再连接采集，每天探测一次；目录出现后自动开始采集并回填历史。"><Badge status="default" text="未使用" /></Tooltip>;
  if (!t.initializedAt) return <Badge status="warning" text="待初始化" />;
  return <Badge status="success" text="正常" />;
}

/** 手机上的状态说明：桌面端放在 Tooltip 里的失败原因 / “未使用”解释，触屏上直接写在状态下面 */
function statusDetail(t: Target): string | null {
  if (t.collecting || !t.enabled) return null;
  if (t.lastStatus === 'failed') return t.lastError;
  if (t.lastErrorCode === 'NO_DATA_DIR') return '远端还没有这个目录：该账户尚未使用此工具。不算采集失败，平时不再连接采集，每天探测一次；目录出现后自动开始采集并回填历史。';
  return null;
}

/** “更多”菜单。手机上“采集记录”已是单独的按钮，“测试目录”收进菜单；桌面端相反 */
const targetMenu = (s: Server, t: Target, actions: TargetActions, withTest: boolean) => [
  ...(withTest ? [{ key: 'test', label: '测试目录', onClick: () => actions.test(t) }] : []),
  { key: 'edit', label: '编辑', onClick: () => actions.edit(s, t) },
  { key: 'rebind', label: '调整绑定', onClick: () => actions.rebind(t) },
  ...(withTest ? [] : [{ key: 'runs', label: '采集记录', onClick: () => actions.runs(s, t) }]),
  { key: 'toggle', label: t.enabled ? '停用' : '启用', onClick: () => actions.toggle(t) },
  { type: 'divider' as const },
  { key: 'delete', danger: true, label: '删除', onClick: () => actions.remove(t) },
];

/** 手机：每个采集目标一个区块 —— 目录与标签、归属 / 数据源、状态（含失败原因）、最近成功时间，下面一行操作按钮 */
function TargetCards({ server: s, testing, sourceInfo, actions }: { server: Server; testing: ReadonlySet<string>; sourceInfo?: Meta['sourceInfo']; actions: TargetActions }) {
  return (
    <div>
      {s.targets.length === 0 && <Text type="secondary">尚未添加采集目标</Text>}
      {s.targets.map((t) => {
        const detail = statusDetail(t);
        return (
          <div key={t.id} style={{ padding: '12px 0', borderTop: '1px solid #f0f0f0' }}>
            <div className="wrap-anywhere" style={{ marginBottom: 6 }}>
              <Text code>{t.dataDir}</Text>
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, marginLeft: 4, verticalAlign: 'middle' }}>
                {t.sharedAccount && <Tag color="purple" style={{ marginInlineEnd: 0 }}>共享账户</Tag>}
                {t.hasFlaggedData && <Tag color="warning" style={{ marginInlineEnd: 0 }}>待核查</Tag>}
                {t.dirHint && <Tag color="warning" style={{ marginInlineEnd: 0 }}>目录可能不对</Tag>}
              </span>
            </div>
            <CardFields fields={[
              { label: '绑定用户 · 数据源', value: `${t.userName} · ${sourceLabel(t.source, sourceInfo)}` },
              { label: '状态', value: targetStatus(t, false) },
              detail ? { label: t.lastStatus === 'failed' ? '失败原因' : '说明', block: true, value: <LongText danger={t.lastStatus === 'failed'}>{detail}</LongText> } : null,
              t.dirHint ? { label: '实际使用的目录', block: true, value: <><Text code style={{ fontSize: 12 }}>{t.dirHint}</Text><div style={{ marginTop: 6 }}><DirHint t={t} onFixed={actions.dirFixed} asButton /></div></> } : null,
              { label: '最近成功采集', value: fmtTime(t.lastSuccessAt) },
              (t.sshUsername || t.credentialId) ? { label: 'SSH 登录', value: `${t.sshUsername ?? s.sshUsername} · 单独配置` } : null,
              (t.sourceStartDate || t.sourceEndDate) ? { label: '来源边界', value: `${t.sourceStartDate ?? '…'} ~ ${t.sourceEndDate ?? '…'}` } : null,
            ]} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button type="primary" ghost disabled={t.collecting || !t.enabled || !s.enabled} onClick={() => actions.collect(t)} style={{ flex: 1, paddingInline: 8 }}>立即采集</Button>
              <Button onClick={() => actions.runs(s, t)} style={{ flex: 1, paddingInline: 8 }}>采集记录</Button>
              <Dropdown trigger={['click']} menu={{ items: targetMenu(s, t, actions, true) }}>
                <Button loading={testing.has(t.id)} style={{ flex: 1, paddingInline: 8 }}>更多 <DownOutlined /></Button>
              </Dropdown>
            </div>
          </div>
        );
      })}
      <Button icon={<PlusOutlined />} onClick={() => actions.add(s)} block style={{ marginTop: s.targets.length ? 4 : 12 }}>添加采集目标</Button>
    </div>
  );
}

/** 某台服务器下的采集目标（服务器表格的展开行；手机上是服务器卡片里的列表） */
export function TargetTable(props: { server: Server; testing: ReadonlySet<string>; sourceInfo?: Meta['sourceInfo']; actions: TargetActions }) {
  const isMobile = useIsMobile();
  const { server: s, testing, sourceInfo, actions } = props;
  if (isMobile) return <TargetCards {...props} />;
  return (
    <Table<Target>
      size="small" rowKey="id" pagination={false} dataSource={s.targets} scroll={{ x: 1000 }}
      locale={{ emptyText: '尚未添加采集目标' }}
      footer={() => <Button size="small" icon={<PlusOutlined />} onClick={() => actions.add(s)}>添加采集目标</Button>}
      columns={[
        { title: '数据目录', render: (_v, t) => <Space size={4} wrap><Text code>{t.dataDir}</Text>{t.sharedAccount && <Tag color="purple">共享账户</Tag>}{t.hasFlaggedData && <Tooltip title="存在保留的历史值或异常减少标记，见采集记录"><Tag color="warning">待核查</Tag></Tooltip>}<DirHint t={t} onFixed={actions.dirFixed} /></Space> },
        { title: '绑定用户', dataIndex: 'userName' },
        { title: '数据源', dataIndex: 'source', render: (v: string) => sourceLabel(v, sourceInfo) },
        { title: 'SSH 登录', render: (_v, t) => (t.sshUsername || t.credentialId ? <Tooltip title="该目标覆盖了服务器级 SSH 登录"><Tag>{t.sshUsername ?? s.sshUsername} · 单独配置</Tag></Tooltip> : <Text type="secondary">同服务器</Text>) },
        { title: '来源边界', render: (_v, t) => (t.sourceStartDate || t.sourceEndDate ? `${t.sourceStartDate ?? '…'} ~ ${t.sourceEndDate ?? '…'}` : '—') },
        { title: '状态', render: (_v, t) => targetStatus(t) },
        { title: '最近成功采集', render: (_v, t) => fmtTime(t.lastSuccessAt) },
        {
          title: '操作', width: 250, render: (_v, t) => (
            <Space size={4}>
              <Button type="link" size="small" disabled={t.collecting || !t.enabled || !s.enabled} onClick={() => actions.collect(t)}>立即采集</Button>
              <Button type="link" size="small" loading={testing.has(t.id)} onClick={() => actions.test(t)}>测试目录</Button>
              <Dropdown menu={{ items: targetMenu(s, t, actions, false) }}>
                <Button type="link" size="small">更多 <DownOutlined /></Button>
              </Dropdown>
            </Space>
          ),
        },
      ]}
    />
  );
}
