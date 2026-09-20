import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api';
import { useAuth } from '../auth';
import { useIsMobile } from '../responsive';

/** 只接受站内路径，避免开放重定向：必须以单个 / 开头、不含反斜杠（浏览器会把 /\evil.com 当成 //evil.com），且解析后仍是本站 */
function safeRedirect(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.startsWith('/login')) return '/';
  try {
    return new URL(raw, location.origin).origin === location.origin ? raw : '/';
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useIsMobile();

  const redirect = safeRedirect(params.get('redirect'));

  if (!loading && user) return <Navigate to={redirect} replace />;

  const submit = async (v: { email: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(v.email, v.password);
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // 高度用 .full-height（100dvh，vh 兜底）：移动端地址栏收放时卡片保持居中；四周让出安全区
    <div className="full-height" style={{ boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', padding: 'max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))' }}>
      <Card style={{ width: 380, maxWidth: '100%' }} styles={isMobile ? { body: { padding: '24px 20px' } } : undefined}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 4, ...(isMobile ? { fontSize: 22 } : {}) }}>用量监控平台</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>基于 ccusage 的多用户用量统计与告警</Typography.Paragraph>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="email" label="邮箱" normalize={(v?: string) => v?.trim()} rules={[{ required: true, type: 'email', message: '请输入有效的邮箱' }]}>
            {/* 手机上不自动聚焦：一进页面就弹出软键盘会把卡片顶走 */}
            <Input prefix={<MailOutlined />} inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" autoFocus={!isMobile} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting} size={isMobile ? 'large' : undefined}>登录</Button>
        </Form>
      </Card>
    </div>
  );
}
