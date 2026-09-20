import {
  AccountBookOutlined, AlertOutlined, BarChartOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, KeyOutlined, LogoutOutlined,
  MenuOutlined, SettingOutlined, TeamOutlined, UserOutlined, WarningFilled,
} from '@ant-design/icons';
import { Alert, Button, Drawer, Dropdown, Layout, Menu, Space, Spin, Typography } from 'antd';
import dayjs from 'dayjs';
import { createContext, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { fmtTime, setDisplayTz } from '../format';
import { useIsMobile, useNavCollapsed } from '../responsive';
import type { Meta } from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { PasswordModal } from './PasswordModal';

const { Header, Sider, Content } = Layout;
const pageSpin = <Spin size="large" style={{ display: 'block', marginTop: 120 }} />;

const MetaContext = createContext<{ meta: Meta | null; refreshMeta: () => void }>({ meta: null, refreshMeta: () => undefined });
export const useMeta = () => useContext(MetaContext);
/** 统计时区的“今天”（YYYY-MM-DD）。页面只在 meta 加载后渲染，浏览器本地日期只是兜底。 */
export const useStatsToday = () => useContext(MetaContext).meta?.today ?? dayjs().format('YYYY-MM-DD');

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const isAdmin = user?.role === 'admin';
  // < 992px：侧边菜单收进左侧抽屉；< 768px（手机）：页头只留标题与用户菜单，内容边距收窄
  const navCollapsed = useNavCollapsed();
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { if (!navCollapsed) setNavOpen(false); }, [navCollapsed]);

  useEffect(() => {
    let alive = true;
    // 先设置显示时区再 setMeta：页面要等 meta 到了才渲染，第一帧就用正确的时区格式化时间
    const load = () => api.get<Meta>('/meta')
      .then((m) => { if (alive) { setDisplayTz(m.timezone); setMeta(m); setMetaError(null); } })
      .catch((e) => { if (alive) setMetaError(errorMessage(e)); });
    load();
    const timer = setInterval(load, 60_000); // 页面只展示最近一次入库结果，不会因打开网页触发采集
    return () => { alive = false; clearInterval(timer); };
  }, [tick]);

  const items = useMemo(() => (isAdmin
    ? [
      { key: '/', icon: <DashboardOutlined />, label: '总览仪表盘' },
      { key: '/usage', icon: <BarChartOutlined />, label: '用量分析' },
      { key: '/ledger', icon: <AccountBookOutlined />, label: '账目明细' },
      { key: '/users', icon: <TeamOutlined />, label: '用户列表' },
      { key: '/servers', icon: <CloudServerOutlined />, label: '服务器管理' },
      { key: '/alerts/rules', icon: <AlertOutlined />, label: '告警规则' },
      { key: '/alerts/events', icon: <BellOutlined />, label: '告警记录' },
      { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
    ]
    : [
      { key: `/users/${user?.id}`, icon: <BarChartOutlined />, label: '我的用量' },
      { key: '/alerts/events', icon: <BellOutlined />, label: '我的告警' },
    ]), [isAdmin, user?.id]);

  const selected = useMemo(() => {
    const path = location.pathname;
    if (isAdmin && path.startsWith('/users/')) return '/users';
    return items.map((i) => i.key).filter((k) => (k === '/' ? path === '/' : path.startsWith(k))).sort((a, b) => b.length - a.length)[0] ?? '/';
  }, [items, location.pathname, isAdmin]);

  const ctx = useMemo(() => ({ meta, refreshMeta: () => setTick((t) => t + 1) }), [meta]);

  const menu = <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={(e) => { navigate(e.key); setNavOpen(false); }} style={{ borderRight: 0 }} />;
  const userMenu = {
    items: [
      { key: 'pwd', icon: <KeyOutlined />, label: '修改密码', onClick: () => setPwdOpen(true) },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => { void logout().then(() => navigate('/login')); } },
    ],
  };
  const freshness = (
    <>
      <Typography.Text type="secondary">最近成功更新：<Typography.Text strong>{meta ? (meta.lastSuccessAt ? fmtTime(meta.lastSuccessAt) : '尚无成功采集') : '…'}</Typography.Text></Typography.Text>
      <Typography.Text type="secondary">下次计划采集：<Typography.Text strong>{meta ? fmtTime(meta.nextCollectionAt) : '…'}</Typography.Text></Typography.Text>
      <Typography.Text type="secondary">统计时区：{meta?.timezone ?? '…'}（每 {meta?.intervalHours ?? '…'} 小时采集）</Typography.Text>
    </>
  );

  return (
    <MetaContext.Provider value={ctx}>
      <Layout className="full-height">
        {!navCollapsed && (
          <Sider theme="light" width={208} style={{ borderRight: '1px solid #f0f0f0' }}>
            <div style={{ padding: '18px 24px', fontWeight: 600, fontSize: 16 }}>用量监控平台</div>
            {menu}
          </Sider>
        )}
        <Layout>
          {navCollapsed ? (
            <Header className="app-header-mobile" style={{ background: '#fff', display: 'flex', alignItems: 'center', gap: 4, height: 'auto', minHeight: 52, lineHeight: 1.6, borderBottom: '1px solid #f0f0f0' }}>
              <Button type="text" size="large" icon={<MenuOutlined />} aria-label="打开导航菜单" aria-expanded={navOpen} onClick={() => setNavOpen(true)} style={{ width: 44, flex: 'none' }} />
              <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0, fontSize: 16 }}>用量监控平台</Typography.Text>
              {/* 触屏没有悬停：点按展开；按钮本身可聚焦，回车 / 空格同样可以打开 */}
              <Dropdown trigger={['click']} placement="bottomRight" menu={userMenu}>
                <Button type="text" size="large" icon={<UserOutlined />} aria-label={`账户菜单：${user?.name ?? ''}`} style={{ maxWidth: isMobile ? 140 : 260, flex: 'none' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.name}</span>
                </Button>
              </Dropdown>
            </Header>
          ) : (
            <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, height: 'auto', minHeight: 56, lineHeight: 1.6, flexWrap: 'wrap', borderBottom: '1px solid #f0f0f0' }}>
              <Space size={24} wrap style={{ padding: '8px 0' }}>{freshness}</Space>
              <Dropdown menu={userMenu}>
                <Button type="text" icon={<UserOutlined />}>{user?.name}{isAdmin ? '（管理员）' : ''}</Button>
              </Dropdown>
            </Header>
          )}
          {meta?.incomplete && (
            <Alert
              banner type="warning" showIcon icon={<WarningFilled />}
              title={<b>部分来源数据未更新，统计不完整</b>}
              style={isMobile ? { padding: '8px 12px', fontSize: 12 } : undefined}
              description={<span style={isMobile ? { fontSize: 12 } : undefined}>{`${meta.staleTargets} / ${meta.targets} 个采集来源超过两个采集周期未成功更新或最近一次采集失败。已入库的统计会保留，但实际用量可能更高；未达到阈值不代表完整数据下未超限。`}</span>}
            />
          )}
          <Content className={isMobile ? 'app-content-mobile' : undefined} style={{ padding: isMobile ? 12 : 24 }}>
            {navCollapsed && (
              <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginBottom: 12, fontSize: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近成功更新 <Typography.Text strong style={{ fontSize: 12 }}>{meta ? (meta.lastSuccessAt ? fmtTime(meta.lastSuccessAt) : '尚无') : '…'}</Typography.Text></Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>下次采集 <Typography.Text strong style={{ fontSize: 12 }}>{meta ? fmtTime(meta.nextCollectionAt) : '…'}</Typography.Text></Typography.Text>
              </div>
            )}
            {/* 时区、“今天”等都来自 meta：没拿到之前不渲染页面；时区变更时用 key 重新挂载页面，让已格式化的时间全部重算 */}
            {meta
              ? (
                <ErrorBoundary resetKey={location.pathname}>
                  <Suspense fallback={pageSpin}>
                    <div key={meta.timezone}><Outlet /></div>
                  </Suspense>
                </ErrorBoundary>
              )
              : metaError
                ? <Alert type="error" showIcon title="无法加载平台状态" description={metaError} action={<Button size="small" onClick={() => setTick((t) => t + 1)}>重试</Button>} />
                : pageSpin}
          </Content>
        </Layout>
      </Layout>
      {/* 手机 / 小平板的导航：与桌面端同一份菜单，选中后自动收起 */}
      <Drawer
        rootClassName="app-nav-drawer" placement="left" size={264} open={navCollapsed && navOpen} onClose={() => setNavOpen(false)}
        title="用量监控平台"
        footer={<div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>{freshness}<Typography.Text type="secondary">{user?.name}{isAdmin ? '（管理员）' : ''}</Typography.Text></div>}
      >
        {menu}
      </Drawer>
      <PasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </MetaContext.Provider>
  );
}
