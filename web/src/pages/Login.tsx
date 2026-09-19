import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 只接受站内路径，避免开放重定向
  const raw = params.get('redirect') ?? '/';
  const redirect = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login') ? raw : '/';

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', padding: 16 }}>
      <Card style={{ width: 380, maxWidth: '100%' }}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 4 }}>用量监控平台</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>基于 ccusage 的多用户用量统计与告警</Typography.Paragraph>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="email" label="邮箱" normalize={(v?: string) => v?.trim()} rules={[{ required: true, type: 'email', message: '请输入有效的邮箱' }]}>
            <Input prefix={<MailOutlined />} autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>登录</Button>
        </Form>
      </Card>
    </div>
  );
}
