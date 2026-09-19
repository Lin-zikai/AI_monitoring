import { App, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { api, errorMessage } from '../api';

export function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.post('/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      message.success('密码已修改');
      form.resetFields();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="修改密码" open={open} onOk={submit} confirmLoading={saving} onCancel={() => { form.resetFields(); onClose(); }} destroyOnHidden>
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 10, message: '密码至少 10 位' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm" label="确认新密码" dependencies={['newPassword']}
          rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({
            validator: (_, value) => (!value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致'))),
          })]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
