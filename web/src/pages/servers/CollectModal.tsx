import { Alert, App, Checkbox, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { Target } from '../../types';

const { Text, Paragraph } = Typography;

export function CollectModal({ target, onClose, onDone }: { target: Target | null; onClose: () => void; onDone: () => void }) {
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const { message, modal } = App.useApp();

  // 危险选项不跨目标保留：每次打开 / 关闭都回到未勾选
  useEffect(() => { setAccept(false); }, [target]);

  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/targets/${target.id}/collect`, { acceptDecrease: accept });
      message.success('已加入采集队列，列表会自动刷新采集状态');
      onClose(); onDone();
    } catch (err) { message.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const submit = () => {
    if (!accept) return void run();
    modal.confirm({
      title: '确认用更小的新值覆盖历史统计？', okText: '确认覆盖', okButtonProps: { danger: true },
      content: '正常情况下，远端日志被清理导致的“用量减少”会被忽略并保留已入库的历史值。勾选此项后，本次采集范围内的统计将以远端当前结果为准，消失的日期会被清空，且无法恢复。',
      onOk: run,
    });
  };

  return (
    <Modal title={<span className="wrap-anywhere">{`立即采集 · ${target?.dataDir ?? ''}`}</span>} open={target !== null} onOk={submit} okText="开始采集" confirmLoading={busy} onCancel={onClose} destroyOnHidden>
      <Paragraph>手动采集会立即执行，不改变常规调度时点；成功入库后同样会评估告警。{target && !target.initializedAt && <b>该目标尚未初始化，本次将回填历史数据（默认不触发历史周期的告警）。</b>}</Paragraph>
      {target?.hasFlaggedData && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="该目标存在“待核查”的统计（保留的历史值或异常减少标记）。核查确认远端数据正确后，可勾选下方选项覆盖。" />}
      <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)}><Text type="danger">接受用量减少并覆盖已入库的历史统计（危险）</Text></Checkbox>
    </Modal>
  );
}
