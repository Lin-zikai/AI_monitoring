import { Alert, App, Button, Descriptions, Modal, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useIsMobile } from '../../responsive';
import type { Server } from '../../types';

const { Text, Paragraph } = Typography;

interface ScanResult { serverId: string; fingerprint: string; confirmed: string | null; matches: boolean }

export function HostKeyModal({ server, onClose, onSaved }: { server: Server | null; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMobile = useIsMobile();
  // 每次扫描 / 开关对话框都换一个序号：慢的旧响应（例如上一台服务器的扫描）回来时直接丢弃，不会显示到当前对话框里
  const seq = useRef(0);
  const serverId = server?.id ?? null;

  const doScan = async (id: string) => {
    const mine = ++seq.current;
    setBusy(true); setError(null); setScan(null);
    try {
      const r = await api.post<Omit<ScanResult, 'serverId'>>(`/servers/${id}/scan-host-key`);
      if (mine === seq.current) setScan({ ...r, serverId: id });
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // 打开（或换了一台服务器）时清空并重新扫描；关闭时作废在途请求并清空
  useEffect(() => {
    seq.current++;
    setScan(null); setError(null); setBusy(false);
    if (serverId) void doScan(serverId);
  }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 指纹只能写回它被扫描出来的那台服务器
  const current = scan && scan.serverId === serverId ? scan : null;

  const confirm = async () => {
    if (!serverId || !current) return;
    const mine = ++seq.current;
    setBusy(true);
    try {
      await api.post(`/servers/${serverId}/confirm-host-key`, { fingerprint: current.fingerprint });
      message.success('主机指纹已确认');
      onSaved();
      if (mine === seq.current) onClose();
    } catch (err) { message.error(errorMessage(err)); } finally { if (mine === seq.current) setBusy(false); }
  };

  return (
    <Modal
      title={`主机指纹 · ${server?.name ?? ''}`} open={server !== null} onCancel={onClose} destroyOnHidden width={620}
      footer={[
        <Button key="rescan" onClick={() => serverId && doScan(serverId)} loading={busy}>重新扫描</Button>,
        <Button key="ok" type="primary" danger={Boolean(current?.confirmed && !current.matches)} disabled={!current || current.matches} loading={busy} onClick={confirm}>
          {current?.matches ? '指纹已确认' : '我已核对，确认此指纹'}
        </Button>,
      ]}
    >
      {error && <Alert type="error" showIcon title="扫描失败" description={error} />}
      {busy && !current && !error && <Paragraph type="secondary">正在连接 {server?.host}:{server?.port} 读取主机公钥…</Paragraph>}
      {current && (
        <>
          {/* 手机：标签在上、指纹在下（vertical），长指纹在格内换行 */}
          <Descriptions column={1} size="small" bordered layout={isMobile ? 'vertical' : 'horizontal'}>
            <Descriptions.Item label="扫描到的指纹"><Text code copyable className="wrap-anywhere">{current.fingerprint}</Text></Descriptions.Item>
            <Descriptions.Item label="已确认的指纹">{current.confirmed ? <Text code className="wrap-anywhere">{current.confirmed}</Text> : <Text type="secondary">尚未确认</Text>}</Descriptions.Item>
          </Descriptions>
          {current.matches
            ? <Alert style={{ marginTop: 16 }} type="success" showIcon title="与已确认的指纹一致" />
            : current.confirmed
              ? <Alert style={{ marginTop: 16 }} type="error" showIcon title="指纹与已确认的不一致！" description="可能是服务器重装或更换了主机密钥，也可能是中间人攻击。务必通过可信渠道核实后再确认。" />
              : <Alert style={{ marginTop: 16 }} type="warning" showIcon title="请通过可信渠道核对指纹" description={<>在服务器上执行 <Text code className="wrap-anywhere">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Text>（或对应算法的公钥文件），核对输出的 SHA256 指纹与上方一致后再确认。确认之后，采集时指纹不匹配会直接拒绝连接。</>} />}
        </>
      )}
    </Modal>
  );
}
