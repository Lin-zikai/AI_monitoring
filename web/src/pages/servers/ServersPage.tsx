import { HistoryOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, App, Button, Radio, Space, Tabs, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { FilterBar, PageTitle } from '../../components/common';
import { useMeta } from '../../components/Layout';
import { useFetch, usePolling } from '../../hooks';
import { useIsMobile } from '../../responsive';
import type { Credential, Filters, InstallMode, Server, Target } from '../../types';
import { CollectModal } from './CollectModal';
import { CredentialsTab } from './CredentialsTab';
import { HostKeyModal } from './HostKeyModal';
import { RebindModal } from './RebindModal';
import { RunsDrawer, type RunsDrawerState } from './RunsDrawer';
import { ServerModal } from './ServerModal';
import { ServerTable, type ServerActions } from './ServerTable';
import { TargetModal, type TargetModalState } from './TargetModal';
import type { TargetActions } from './TargetTable';
import { showOnboardResult, withProgressModal, type OnboardResult } from './shared';

const { Text, Paragraph } = Typography;

const INSTALL_NOTE = '平台会用这台服务器的 SSH 账户登录，只在其家目录的 ~/.local/share/usage-monitor/ 下放置采集脚本与配置，不需要 root，不改动系统目录，远端已装过的 ccusage 不会被改动。要求该密钥在远端有普通 shell 权限。';
const INSTALL_MODE_OPTIONS: Array<{ value: InstallMode; label: string; hint: string }> = [
  { value: 'latest', label: '始终最新（默认）', hint: '每次采集都通过 npx --yes ccusage@latest 运行，新模型的价格及时更新；取不到最新版时退回远端已装的版本' },
  { value: 'pinned', label: '固定版本', hint: '安装平台核对过输出格式的固定版本，不随 npm 上的新发布变化；平台升级时才会更新' },
  { value: 'auto', label: '复用远端已装的', hint: '远端已经装过 ccusage 就直接用它，没有才安装固定版本' },
];
/** 安装结果的说明；选了“始终最新”却落到其他结果，说明远端当时取不到最新版 */
const ccusageModeText = (requested: InstallMode, actual: string | undefined): string => {
  if (actual === 'latest') return '每次采集自动更新到最新版（npx --yes ccusage@latest）';
  const fallback = requested === 'latest' ? '远端取不到最新版，' : '';
  return actual === 'reused' ? `${fallback}使用远端已安装的 ccusage` : `${fallback}已安装一份固定版本`;
};

interface InstallResult { ok: boolean; code?: string; message?: string; collectCommand?: string; nodeVersion?: string; ccusageVersion?: string; defaultDataDir?: string; ccusageMode?: string; ccusagePath?: string; versionMismatch?: boolean }

const POLL_MS = 5000;
/** 刚排队的采集可能几秒后才被 worker 领走，也可能在两次轮询之间就跑完：排队后至少跟进这么久 */
const QUEUED_GRACE_MS = 60_000;

export function ServersPage() {
  const { message, modal } = App.useApp();
  const { meta, refreshMeta } = useMeta();
  const isMobile = useIsMobile();
  const servers = useFetch(() => api.get<{ servers: Server[] }>('/servers'), []);
  const credentials = useFetch(() => api.get<{ credentials: Credential[] }>('/credentials'), []);
  const filters = useFetch(() => api.get<Filters>('/stats/filters'), []);

  const [serverModal, setServerModal] = useState<Server | 'new' | null>(null);
  const [hostKeyFor, setHostKeyFor] = useState<Server | null>(null);
  const [targetModal, setTargetModal] = useState<TargetModalState>(null);
  const [rebindFor, setRebindFor] = useState<Target | null>(null);
  const [collectFor, setCollectFor] = useState<Target | null>(null);
  const [runsFor, setRunsFor] = useState<RunsDrawerState>(null);
  // 正在测试的服务器 / 目标 id：可以同时测多个，各转各的圈
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const markTesting = (id: string, on: boolean) => setTesting((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });

  const list = servers.data?.servers ?? [];
  const creds = credentials.data?.credentials ?? [];
  const users = filters.data?.users ?? [];

  const reload = () => { servers.reload(); credentials.reload(); refreshMeta(); };

  // ---- 采集状态跟进：有目标在采集、或刚排过队时，每 5 秒静默刷新一次列表；都结束后停下并刷新页头的“最近成功更新”
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const anyCollecting = list.some((s) => s.targets.some((t) => t.collecting));
  const watching = anyCollecting || queuedAt !== null;
  usePolling(() => {
    if (queuedAt !== null && Date.now() - queuedAt > QUEUED_GRACE_MS) setQueuedAt(null);
    servers.reloadSilent();
  }, watching, POLL_MS);
  const wasWatching = useRef(false);
  useEffect(() => {
    if (wasWatching.current && !watching) refreshMeta();
    wasWatching.current = watching;
  }, [watching]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 刚触发了采集：刷新并开始跟进 */
  const reloadAndWatch = () => { setQueuedAt(Date.now()); reload(); };

  // ---- 展开行：默认全部收起（失败的目标数在收起的行上就能看到），要调整时再点开；
  //      只有在本页刚添加的服务器自动展开一次，方便看接入结果。其余完全听用户的
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const seenServers = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!servers.data) return;
    if (!seenServers.current) { seenServers.current = new Set(list.map((s) => s.id)); return; }
    const fresh = list.map((s) => s.id).filter((id) => !seenServers.current!.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seenServers.current.add(id);
    setExpandedKeys((prev) => [...prev, ...fresh]);
  }, [servers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const askInstall = (s: Server, title: string) => {
    // 选定的方式按服务器保存，之后平台自动升级采集脚本时沿用
    let mode: InstallMode = s.installMode;
    modal.confirm({
      title, width: 560, okText: '开始', cancelText: '稍后',
      content: (
        <div>
          <Paragraph>{INSTALL_NOTE}</Paragraph>
          <Text strong>ccusage 版本</Text>
          <Radio.Group defaultValue={mode} onChange={(e) => { mode = e.target.value as InstallMode; }} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {INSTALL_MODE_OPTIONS.map((o) => <Radio key={o.value} value={o.value}>{o.label}<br /><Text type="secondary" style={{ fontSize: 12 }}>{o.hint}</Text></Radio>)}
          </Radio.Group>
        </div>
      ),
      onOk: () => { void installCollector(s, mode); },
    });
  };

  const testServer = async (s: Server) => {
    markTesting(s.id, true);
    try {
      const r = await api.post<{ ok: boolean; stage?: 'ssh' | 'collector'; message?: string; code?: string; collectorVersion?: string | null }>(`/servers/${s.id}/test`);
      if (r.ok) message.success(`连接成功，采集脚本版本 ${r.collectorVersion ?? '未知'}`);
      else if (r.stage === 'collector') {
        // SSH 本身没问题，只是远端还没有采集脚本：直接给出自动安装入口
        askInstall(s, '已连接，但远端还没有采集脚本');
      } else modal.error({ title: '连接测试未通过', content: `${r.code ? `${r.code}：` : ''}${r.message ?? ''}` });
      servers.reload();
    } catch (err) { message.error(errorMessage(err)); } finally { markTesting(s.id, false); }
  };

  const installCollector = async (s: Server, mode: InstallMode) => {
    try {
      const r = await withProgressModal(modal, `正在 ${s.name} 上配置采集组件…`, '通过 SSH 执行，通常需要几秒到几分钟，请不要关闭页面。', () => api.post<InstallResult>(`/servers/${s.id}/install-collector`, { mode }));
      if (r.ok) {
        modal.success({
          title: '采集组件已就绪', width: 600,
          content: (
            <div>
              <Paragraph>{ccusageModeText(mode, r.ccusageMode)}：ccusage {r.ccusageVersion}{r.ccusageMode === 'reused' ? <>（<Text code>{r.ccusagePath}</Text>）</> : null}，Node {r.nodeVersion}。</Paragraph>
              {r.versionMismatch && <Paragraph type="warning">该版本与平台核对过输出格式的版本不同：可以正常采集，但估算费用的口径可能与其他服务器略有差异（每行统计都会记录当时的版本）。</Paragraph>}
              <Paragraph>采集命令已自动登记为 <Text code>{r.collectCommand}</Text></Paragraph>
              <Paragraph style={{ marginBottom: 0 }}>下一步：展开该服务器点“添加采集目标”，勾选要采集的数据源（Claude Code、Codex），目录会自动填好。</Paragraph>
            </div>
          ),
        });
      } else modal.error({ title: '未成功', width: 640, content: <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, margin: 0 }}>{`${r.code ? `${r.code}：` : ''}${r.message ?? ''}`}</pre> });
      servers.reload();
    } catch (err) { message.error(errorMessage(err)); }
  };

  /** 重新执行一步接入（修正问题后重试，或给早先添加的服务器补上默认采集目标） */
  const reOnboard = async (s: Server) => {
    if (!s.defaultUserId && s.targets.length === 0) return void message.warning('这台服务器还没有归属用户：请先“添加采集目标”，或删除后重新添加');
    try {
      const r = await withProgressModal(modal, `正在重新接入 ${s.name}…`, '通常需要几秒到几分钟，请不要关闭页面。', () => api.post<OnboardResult>(`/servers/${s.id}/onboard`, s.defaultUserId ? {} : { userId: s.targets[0]!.userId }));
      showOnboardResult(modal, r, { ok: '接入完成，采集已开始', failed: '接入没有完成' }, meta?.intervalHours);
      reloadAndWatch();
    } catch (err) { message.error(errorMessage(err)); }
  };

  const testTarget = async (t: Target) => {
    markTesting(t.id, true);
    try {
      const r = await api.post<{ ok: boolean; message?: string; code?: string; ccusageVersion?: string | null; logFiles?: number | null }>(`/targets/${t.id}/test`);
      if (r.ok) message.success(`目录可读：发现 ${r.logFiles ?? 0} 个日志文件，ccusage ${r.ccusageVersion ?? '版本未知'}`);
      else modal.error({ title: '目录测试未通过', content: `${r.code ? `${r.code}：` : ''}${r.message ?? ''}` });
    } catch (err) { message.error(errorMessage(err)); } finally { markTesting(t.id, false); }
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
    void api.patch(`/${kind}/${id}`, { enabled }).then(reload).catch((e) => { message.error(errorMessage(e)); });

  const runAll = () => modal.confirm({
    title: '对全部已启用目标立即采集？', content: '会创建一个手动批次，不改变常规调度时点。正在采集中的目标会被跳过。',
    onOk: () => api.post<{ runs: number }>('/collection/run-all').then((r) => { message.success(`已创建 ${r.runs} 个采集任务`); reloadAndWatch(); }).catch((e) => { message.error(errorMessage(e)); }),
  });

  const serverActions: ServerActions = {
    test: (s) => void testServer(s),
    edit: setServerModal,
    hostKey: setHostKeyFor,
    reOnboard: (s) => void reOnboard(s),
    install: (s) => askInstall(s, `在“${s.name}”上安装 / 更新采集组件`),
    toggle: (s) => toggle('servers', s.id, !s.enabled),
    remove: (s) => remove('servers', s.id, s.name),
  };
  const targetActions: TargetActions = {
    add: (s) => setTargetModal({ server: s, target: null }),
    collect: setCollectFor,
    test: (t) => void testTarget(t),
    edit: (s, t) => setTargetModal({ server: s, target: t }),
    rebind: setRebindFor,
    runs: (s, t) => setRunsFor({ targetId: t.id, title: `采集记录 · ${s.name} ${t.dataDir}` }),
    toggle: (t) => toggle('targets', t.id, !t.enabled),
    remove: (t) => remove('targets', t.id, t.dataDir),
    dirFixed: reloadAndWatch,
  };

  return (
    <>
      <PageTitle
        title="服务器管理"
        extra={isMobile ? (
          // 手机：四个按钮排成 2×2，各占半行
          <FilterBar items={[
            watching && { key: 'watching', node: <Text type="secondary" style={{ fontSize: 12 }}>采集进行中，列表每 {POLL_MS / 1000} 秒自动刷新</Text> },
            { key: 'add', half: true, node: <Button type="primary" icon={<PlusOutlined />} onClick={() => setServerModal('new')}>添加服务器</Button> },
            { key: 'runAll', half: true, node: <Button icon={<ThunderboltOutlined />} onClick={runAll}>全部立即采集</Button> },
            { key: 'runs', half: true, node: <Button icon={<HistoryOutlined />} onClick={() => setRunsFor({ title: '最近采集运行记录' })}>采集记录</Button> },
            { key: 'reload', half: true, node: <Button icon={<ReloadOutlined />} onClick={reload} loading={servers.loading}>刷新</Button> },
          ]} />
        ) : (
          <Space wrap>
            {watching && <Text type="secondary" style={{ fontSize: 12 }}>采集进行中，列表每 {POLL_MS / 1000} 秒自动刷新</Text>}
            <Button icon={<ReloadOutlined />} onClick={reload} loading={servers.loading}>刷新</Button>
            <Button icon={<HistoryOutlined />} onClick={() => setRunsFor({ title: '最近采集运行记录' })}>采集记录</Button>
            <Button icon={<ThunderboltOutlined />} onClick={runAll}>全部立即采集</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setServerModal('new')}>添加服务器</Button>
          </Space>
        )}
      />
      {(servers.error || credentials.error) && <Alert type="error" showIcon title={servers.error ?? credentials.error} style={{ marginBottom: 16 }} />}
      <Tabs
        items={[
          {
            key: 'servers', label: `服务器（${list.length}）`,
            children: <ServerTable servers={list} loading={servers.loading} testing={testing} sourceInfo={meta?.sourceInfo} expandedKeys={expandedKeys} onExpandedChange={setExpandedKeys} actions={serverActions} targetActions={targetActions} />,
          },
          { key: 'credentials', label: `凭据（${creds.length}）`, children: <CredentialsTab credentials={creds} loading={credentials.loading} reload={reload} /> },
        ]}
      />

      <ServerModal editing={serverModal} credentials={creds} users={users} intervalHours={meta?.intervalHours} onClose={() => setServerModal(null)} onSaved={(collecting) => (collecting ? reloadAndWatch() : reload())} onCredentialCreated={credentials.reload} />
      <HostKeyModal server={hostKeyFor} onClose={() => setHostKeyFor(null)} onSaved={reload} />
      <TargetModal state={targetModal} credentials={creds} users={users} sources={meta?.sources ?? []} sourceInfo={meta?.sourceInfo} onClose={() => setTargetModal(null)} onSaved={reload} />
      <RebindModal target={rebindFor} users={users} onClose={() => setRebindFor(null)} onSaved={reload} />
      <CollectModal target={collectFor} onClose={() => setCollectFor(null)} onDone={reloadAndWatch} />
      <RunsDrawer state={runsFor} onClose={() => setRunsFor(null)} />
    </>
  );
}
