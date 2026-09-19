import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Row, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { fmtTime } from '../format';
import { useFetch } from '../hooks';

interface LimitWindow { key: string; label: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: string | null }
interface AccountLimit {
  provider: string; plan: string | null; windows: LimitWindow[]; fetchedAt: string | null; serverName: string | null;
  lastError: { code: string; message: string; at: string } | null;
}

const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

// 状态色只用于量表本身，并始终配图标与文字；数值与说明用正文色
const LEVELS = [
  { min: 90, color: '#d03b3b', text: '即将用尽', icon: <CloseCircleFilled /> },
  { min: 70, color: '#c98a00', text: '偏高', icon: <ExclamationCircleFilled /> },
  { min: 0, color: '#2a78d6', text: '充足', icon: <CheckCircleFilled /> },
];
const levelOf = (pct: number) => LEVELS.find((l) => pct >= l.min)!;

function remaining(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '刷新时间未知';
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return '已到刷新时间，等待下次查询更新';
  const minutes = Math.ceil(ms / 60_000);
  const d = Math.floor(minutes / 1440); const h = Math.floor((minutes % 1440) / 60); const m = minutes % 60;
  return `${d ? `${d} 天 ` : ''}${d || h ? `${h} 小时 ` : ''}${d ? '' : `${m} 分钟`}后刷新`.replace(/\s+后/, '后');
}

function Meter({ w, now }: { w: LimitWindow; now: number }) {
  const known = w.usedPercent !== null;
  const pct = w.usedPercent ?? 0;
  // 窗口已过刷新时间：上一份读数不再代表当前窗口
  const stale = w.resetsAt !== null && new Date(w.resetsAt).getTime() <= now;
  const level = levelOf(pct);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <Typography.Text strong>{w.label}额度</Typography.Text>
        <Space size={6}>
          {known && !stale && <span style={{ color: level.color, fontSize: 12 }}>{level.icon} <Typography.Text style={{ fontSize: 12 }}>{level.text}</Typography.Text></span>}
          <Typography.Text style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{known ? `${pct}%` : '未知'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>已用</Typography.Text>
        </Space>
      </div>
      <Tooltip title={known ? `已用 ${pct}%，剩余 ${Math.round((100 - pct) * 10) / 10}%` : undefined}>
        <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined} aria-label={`${w.label}额度已用比例`}
          style={{ height: 10, borderRadius: 5, background: '#eef0f3', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, minWidth: known && pct > 0 ? 4 : 0, height: '100%', borderRadius: 5, background: stale ? '#b9bec7' : level.color, transition: 'width .3s' }} />
        </div>
      </Tooltip>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {remaining(w.resetsAt, now)}{w.resetsAt && !stale ? `（${fmtTime(w.resetsAt)}）` : ''}
      </Typography.Text>
    </div>
  );
}

/** 账号额度：服务商侧 5 小时 / 周额度的已用比例与刷新时间。目前所有用户与服务器共用同一个账号。 */
export function AccountLimitsCard() {
  const { message } = App.useApp();
  const { data, loading, reload } = useFetch(() => api.get<{ limits: AccountLimit[] }>('/limits'), []);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // 倒计时每 30 秒走一格；每 2 分钟重新读取平台上的最新快照（平台每 10 分钟向服务商查询一次）
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reload, 120_000); return () => clearInterval(t); }, [reload]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<{ outcomes: Array<{ provider: string; ok: boolean; message?: string }> }>('/limits/refresh');
      const failed = r.outcomes.filter((o) => !o.ok);
      if (failed.length) message.warning(failed.map((o) => `${PROVIDER_LABEL[o.provider] ?? o.provider}：${o.message}`).join('；'));
      else message.success('已更新');
      reload(); setNow(Date.now());
    } catch (err) { message.error(errorMessage(err)); } finally { setRefreshing(false); }
  };

  return (
    <Card
      size="small" style={{ marginBottom: 16 }}
      title={<Space size={8}>账号额度<Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>所有用户与服务器共用同一个账号 · 每 10 分钟自动查询</Typography.Text></Space>}
      extra={<Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={refresh}>立即查询</Button>}
    >
      {loading && !data ? <Skeleton active paragraph={{ rows: 3 }} /> : (
        <Row gutter={[32, 8]}>
          {(data?.limits ?? []).map((a) => (
            <Col key={a.provider} xs={24} md={12}>
              <Space size={8} style={{ marginBottom: 10 }}>
                <Typography.Text strong style={{ fontSize: 15 }}>{PROVIDER_LABEL[a.provider] ?? a.provider}</Typography.Text>
                {a.plan && <Tag>{a.plan}</Tag>}
              </Space>
              {a.windows.length === 0
                ? <Alert type="info" showIcon title={a.lastError?.message ?? '还没有查询到额度'} description={a.lastError ? undefined : '添加服务器并完成首次采集后，点“立即查询”。'} />
                : a.windows.map((w) => <Meter key={w.key} w={w} now={now} />)}
              {a.windows.length > 0 && !a.windows.some((w) => w.key === 'five_hour') && (
                <div style={{ marginBottom: 10 }}><Typography.Text type="secondary" style={{ fontSize: 12 }}>服务商目前没有给这个账号设置 5 小时窗口，只有上面的周额度。</Typography.Text></div>
              )}
              {a.windows.length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  数据更新于 {fmtTime(a.fetchedAt)}{a.serverName ? ` · 经 ${a.serverName} 查询` : ''}
                  {a.lastError && <Tooltip title={a.lastError.message}><span style={{ color: '#c98a00' }}> · 最近一次查询失败（{fmtTime(a.lastError.at)}），显示的是上一次的结果</span></Tooltip>}
                </Typography.Text>
              )}
            </Col>
          ))}
        </Row>
      )}
    </Card>
  );
}
