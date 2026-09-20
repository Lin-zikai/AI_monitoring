import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Dropdown, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { LongText, MobileCards } from '../../components/common';
import { fmtTime } from '../../format';
import { useIsMobile } from '../../responsive';
import type { Meta, Server } from '../../types';
import { TargetTable, type TargetActions } from './TargetTable';

const { Text } = Typography;

export interface ServerActions {
  test(server: Server): void;
  edit(server: Server): void;
  hostKey(server: Server): void;
  reOnboard(server: Server): void;
  install(server: Server): void;
  toggle(server: Server): void;
  remove(server: Server): void;
}

export function ServerTable({ servers, loading, testing, sourceInfo, expandedKeys, onExpandedChange, actions, targetActions }: {
  servers: Server[]; loading: boolean; testing: ReadonlySet<string>; sourceInfo?: Meta['sourceInfo'];
  expandedKeys: string[]; onExpandedChange: (keys: string[]) => void; actions: ServerActions; targetActions: TargetActions;
}) {
  const isMobile = useIsMobile();
  const moreItems = (s: Server) => [
    { key: 'hostkey', label: '主机指纹', onClick: () => actions.hostKey(s) },
    { key: 'onboard', label: '重新接入', onClick: () => actions.reOnboard(s) },
    { key: 'install', label: '安装 / 更新采集组件', disabled: !s.hostKeyFingerprint, onClick: () => actions.install(s) },
    { key: 'toggle', label: s.enabled ? '停用' : '启用', onClick: () => actions.toggle(s) },
    { type: 'divider' as const },
    { key: 'delete', danger: true, label: '删除', onClick: () => actions.remove(s) },
  ];

  // 手机：一台服务器一张卡片，采集目标列在卡片里（可收起，与桌面端共用同一份展开状态）；最近错误完整写出来，不靠悬停
  if (isMobile) {
    return (
      <MobileCards<Server>
        items={servers} rowKey={(s) => s.id} loading={loading} emptyText="还没有服务器，点上方“添加服务器”开始"
        title={(s) => s.name}
        tags={(s) => {
          const bad = s.targets.filter((t) => t.enabled && t.lastStatus === 'failed').length;
          return (
            <>
              {!s.enabled && <Tag style={{ marginInlineEnd: 0 }}>已停用</Tag>}
              {bad > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>{bad} / {s.targets.length} 个目标失败</Tag>}
              {s.targets.some((t) => t.collecting) && <Tag color="processing" style={{ marginInlineEnd: 0 }}>采集中</Tag>}
            </>
          );
        }}
        fields={(s) => [
          { label: '地址', block: true, value: <Text code>{s.sshUsername}@{s.host}:{s.port}</Text> },
          { label: '凭据', value: s.credentialName ? <>{s.credentialName}{s.credentialRevoked && <Tag color="error" style={{ marginLeft: 6, marginInlineEnd: 0 }}>已撤销</Tag>}</> : <Text type="danger">未配置</Text> },
          { label: '主机指纹', value: s.hostKeyFingerprint ? <Tag color="success" style={{ marginInlineEnd: 0 }}>已确认</Tag> : <Button type="primary" ghost onClick={() => actions.hostKey(s)}>扫描并确认</Button> },
          { label: '最近连接成功', value: fmtTime(s.lastConnectOkAt) },
          s.lastError ? { label: '最近错误', block: true, value: <LongText danger>{s.lastError}</LongText> } : null,
        ]}
        actions={(s) => (
          <>
            <Button loading={testing.has(s.id)} disabled={!s.hostKeyFingerprint} onClick={() => actions.test(s)} style={{ flex: 1, paddingInline: 8 }}>测试连接</Button>
            <Button onClick={() => actions.edit(s)} style={{ flex: 1, paddingInline: 8 }}>编辑</Button>
            <Dropdown trigger={['click']} menu={{ items: moreItems(s) }}>
              <Button style={{ flex: 1, paddingInline: 8 }}>更多 <DownOutlined /></Button>
            </Dropdown>
          </>
        )}
        footer={(s) => {
          const open = expandedKeys.includes(s.id);
          return (
            <div style={{ marginTop: 12 }}>
              <Button type="text" block aria-expanded={open} onClick={() => onExpandedChange(open ? expandedKeys.filter((k) => k !== s.id) : [...expandedKeys, s.id])}
                style={{ justifyContent: 'space-between', paddingInline: 4, fontWeight: 600, borderTop: '1px solid #f0f0f0', borderRadius: 0 }}>
                <span>采集目标（{s.targets.length}）</span>
                <RightOutlined rotate={open ? 90 : 0} style={{ fontSize: 12 }} />
              </Button>
              {open && <TargetTable server={s} testing={testing} sourceInfo={sourceInfo} actions={targetActions} />}
            </div>
          );
        }}
      />
    );
  }

  return (
    <Table<Server>
      size="middle" rowKey="id" loading={loading} dataSource={servers} pagination={false} scroll={{ x: 1100 }}
      expandable={{
        expandedRowRender: (s) => <TargetTable server={s} testing={testing} sourceInfo={sourceInfo} actions={targetActions} />,
        expandedRowKeys: expandedKeys, onExpandedRowsChange: (keys) => onExpandedChange(keys.map(String)),
      }}
      columns={[
        { title: '名称', render: (_v, s) => <Space>{s.name}{!s.enabled && <Tag>已停用</Tag>}</Space> },
        { title: '地址', render: (_v, s) => <Text code>{s.sshUsername}@{s.host}:{s.port}</Text> },
        { title: '凭据', render: (_v, s) => (s.credentialName ? <>{s.credentialName}{s.credentialRevoked && <Tag color="error" style={{ marginLeft: 6 }}>已撤销</Tag>}</> : <Text type="danger">未配置</Text>) },
        {
          title: '主机指纹', render: (_v, s) => (s.hostKeyFingerprint
            ? <Tooltip title={s.hostKeyFingerprint}><Tag color="success">已确认</Tag></Tooltip>
            : <Button size="small" type="primary" ghost onClick={() => actions.hostKey(s)}>扫描并确认</Button>),
        },
        { title: '采集目标', render: (_v, s) => { const bad = s.targets.filter((t) => t.enabled && t.lastStatus === 'failed').length; return bad ? <Tag color="error">{bad} / {s.targets.length} 个失败</Tag> : `${s.targets.length} 个`; } },
        { title: '最近连接成功', render: (_v, s) => fmtTime(s.lastConnectOkAt) },
        { title: '最近错误', ellipsis: true, render: (_v, s) => (s.lastError ? <Text type="danger" title={s.lastError}>{s.lastError}</Text> : '—') },
        {
          title: '操作', width: 220, render: (_v, s) => (
            <Space size={4}>
              <Button type="link" size="small" loading={testing.has(s.id)} disabled={!s.hostKeyFingerprint} onClick={() => actions.test(s)}>测试连接</Button>
              <Button type="link" size="small" onClick={() => actions.edit(s)}>编辑</Button>
              <Dropdown menu={{ items: moreItems(s) }}>
                <Button type="link" size="small">更多 <DownOutlined /></Button>
              </Dropdown>
            </Space>
          ),
        },
      ]}
    />
  );
}
