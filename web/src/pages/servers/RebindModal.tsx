import { App, DatePicker, Form, Modal, Radio, Select, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useLayoutEffect } from 'react';
import { api, errorMessage } from '../../api';
import { useStatsToday } from '../../components/Layout';
import { validateQuietly } from '../../form';
import { useIsMobile } from '../../responsive';
import type { Filters, Target } from '../../types';
import { userOptions } from './shared';

const { Text, Paragraph } = Typography;

export function RebindModal({ target, users, onClose, onSaved }: { target: Target | null; users: Filters['users']; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<{ userId: string; mode: 'from' | 'all'; effectiveFrom: Dayjs }>();
  const { message, modal } = App.useApp();
  const mode = Form.useWatch('mode', form);
  const today = useStatsToday();
  const isMobile = useIsMobile();

  // 生效日期默认取统计时区的“今天”，而不是浏览器本地日期
  useLayoutEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({ mode: 'from', effectiveFrom: dayjs(today) });
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { form.resetFields(); onClose(); };

  const submit = async () => {
    if (!target) return;
    const v = await validateQuietly(form);
    if (!v) return;
    const all = v.mode === 'all';
    const userName = users.find((u) => u.id === v.userId)?.name ?? '';
    modal.confirm({
      title: all ? '确认重归属全部历史？' : '确认调整绑定？',
      okButtonProps: { danger: all },
      content: all
        ? `该目标（${target.dataDir}）的全部历史统计都会改归“${userName}”，原用户“${target.userName}”名下的这部分用量将消失。已发出的告警记录不会改变。此操作会写入审计日志。`
        : `自 ${v.effectiveFrom.format('YYYY-MM-DD')} 起的用量归属“${userName}”；此前的统计与告警仍归“${target.userName}”。`,
      onOk: async () => {
        try {
          const res = await api.post<{ reattributedRows: number; effectiveFrom: string }>(`/targets/${target.id}/rebind`,
            all ? { userId: v.userId, reattributeHistory: true } : { userId: v.userId, effectiveFrom: v.effectiveFrom.format('YYYY-MM-DD') });
          message.success(`绑定已调整，${res.reattributedRows} 行统计改归新用户`);
          close(); onSaved();
        } catch (err) { message.error(errorMessage(err)); }
      },
    });
  };

  return (
    <Modal title={<span className="wrap-anywhere">{`调整绑定 · ${target?.dataDir ?? ''}`}</span>} open={target !== null} onOk={submit} okText="下一步" onCancel={close} destroyOnHidden>
      <Paragraph type="secondary">当前归属：{target?.userName}。调整绑定不会静默改变已产生的统计：默认只影响生效日期之后的用量。</Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="userId" label="新的归属用户" rules={[{ required: true, message: '请选择用户' }]}>
          <Select showSearch optionFilterProp="label" options={userOptions(users.filter((u) => u.id !== target?.userId))} />
        </Form.Item>
        <Form.Item name="mode" label="生效方式">
          <Radio.Group>
            <Space orientation="vertical">
              <Radio value="from">从指定日期起生效（保留此前的历史归属）</Radio>
              <Radio value="all"><Text type="danger">显式历史重归属：全部历史统计改归新用户</Text></Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        {mode !== 'all' && <Form.Item name="effectiveFrom" label="生效日期" rules={[{ required: true, message: '请选择日期' }]}><DatePicker allowClear={false} inputReadOnly={isMobile} /></Form.Item>}
      </Form>
    </Modal>
  );
}
