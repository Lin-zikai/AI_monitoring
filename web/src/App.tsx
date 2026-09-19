import { Spin } from 'antd';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { AppLayout } from './components/Layout';
import { AlertEventsPage } from './pages/AlertEvents';
import { AlertRulesPage } from './pages/AlertRules';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { ServersPage } from './pages/Servers';
import { SettingsPage } from './pages/Settings';
import { UsagePage } from './pages/Usage';
import { UserDetailPage } from './pages/UserDetail';
import { UsersPage } from './pages/Users';

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
