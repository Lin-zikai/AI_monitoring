import {
  AlertOutlined, BarChartOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, KeyOutlined, LogoutOutlined,
  SettingOutlined, TeamOutlined, UserOutlined, WarningFilled,
} from '@ant-design/icons';
import { Alert, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtTime, setDisplayTz } from '../format';
import type { Meta } from '../types';
import { PasswordModal } from './PasswordModal';

const { Header, Sider, Content } = Layout;

const MetaContext = createContext<{ meta: Meta | null; refreshMeta: () => void }>({ meta: null, refreshMeta: () => undefined });
export const useMeta = () => useContext(MetaContext);

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    let alive = true;
    const load = () => api.get<Meta>('/meta').then((m) => { if (alive) { setDisplayTz(m.timezone); setMeta(m); } }).catch(() => undefined);
    load();
    const timer = setInterval(load, 60_000); // 页面只展示最近一次入库结果，不会因打开网页触发采集
    return () => { alive = false; clearInterval(timer); };
  }, [tick]);

  const items = useMemo(() => (isAdmin
    ? [
      { key: '/', icon: <DashboardOutlined />, label: '总览仪表盘' },
      { key: '/usage', icon: <BarChartOutlined />, label: '用量分析' },
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

  return (
    <MetaContext.Provider value={ctx}>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider breakpoint="lg" collapsedWidth={0} theme="light" width={208} style={{ borderRight: '1px solid #f0f0f0' }}>
          <div style={{ padding: '18px 24px', fontWeight: 600, fontSize: 16 }}>用量监控平台</div>
          <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={(e) => navigate(e.key)} style={{ borderRight: 0 }} />
        </Sider>
        <Layout>
          <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, height: 'auto', minHeight: 56, lineHeight: 1.6, flexWrap: 'wrap', borderBottom: '1px solid #f0f0f0' }}>
            <Space size={24} wrap style={{ padding: '8px 0' }}>
              <Typography.Text type="secondary">最近成功更新：<Typography.Text strong>{meta ? (meta.lastSuccessAt ? fmtTime(meta.lastSuccessAt) : '尚无成功采集') : '…'}</Typography.Text></Typography.Text>
              <Typography.Text type="secondary">下次计划采集：<Typography.Text strong>{meta ? fmtTime(meta.nextCollectionAt) : '…'}</Typography.Text></Typography.Text>
              <Typography.Text type="secondary">统计时区：{meta?.timezone ?? '…'}（每 {meta?.intervalHours ?? '…'} 小时采集）</Typography.Text>
            </Space>
            <Dropdown
              menu={{
                items: [
                  { key: 'pwd', icon: <KeyOutlined />, label: '修改密码', onClick: () => setPwdOpen(true) },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => { void logout().then(() => navigate('/login')); } },
                ],
              }}
            >
              <Space style={{ cursor: 'pointer' }}><UserOutlined />{user?.name}{isAdmin ? '（管理员）' : ''}</Space>
            </Dropdown>
          </Header>
          {meta?.incomplete && (
            <Alert
              banner type="warning" showIcon icon={<WarningFilled />}
              title={<b>部分来源数据未更新，统计不完整</b>}
              description={`${meta.staleTargets} / ${meta.targets} 个采集来源超过两个采集周期未成功更新或最近一次采集失败。已入库的统计会保留，但实际用量可能更高；未达到阈值不代表完整数据下未超限。`}
            />
          )}
          <Content style={{ padding: 24 }}>
            <Outlet />
          </Content>
        </Layout>
      </Layout>
      <PasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </MetaContext.Provider>
  );
}
