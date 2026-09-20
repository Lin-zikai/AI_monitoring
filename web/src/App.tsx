import { Spin } from 'antd';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppLayout } from './components/Layout';
import { LoginPage } from './pages/Login';

// 页面按路由懒加载：登录页和外壳随首屏加载，其余页面（含 ECharts）用到时才下载
const AlertEventsPage = lazy(() => import('./pages/AlertEvents').then((m) => ({ default: m.AlertEventsPage })));
const AlertRulesPage = lazy(() => import('./pages/AlertRules').then((m) => ({ default: m.AlertRulesPage })));
const DashboardPage = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.DashboardPage })));
const ServersPage = lazy(() => import('./pages/servers/ServersPage').then((m) => ({ default: m.ServersPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const UsagePage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.UsagePage })));
const UserDetailPage = lazy(() => import('./pages/UserDetail').then((m) => ({ default: m.UserDetailPage })));
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })));

// 路由守卫只是体验层：真正的权限校验在后台 API。
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spin size="large" style={{ display: 'block', marginTop: 160 }} />;
  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to={user ? `/users/${user.id}` : '/login'} replace />;
  return <>{children}</>;
}

function Home() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to={`/users/${user!.id}`} replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Spin size="large" style={{ display: 'block', marginTop: 160 }} />}>
        <AppRoutes />
      </Suspense>
    </ErrorBoundary>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<Home />} />
        <Route path="/usage" element={<AdminOnly><UsagePage /></AdminOnly>} />
        <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="/users/:id" element={<UserDetailPage />} />
        <Route path="/servers" element={<AdminOnly><ServersPage /></AdminOnly>} />
        <Route path="/alerts/rules" element={<AdminOnly><AlertRulesPage /></AdminOnly>} />
        <Route path="/alerts/events" element={<AlertEventsPage />} />
        <Route path="/settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
