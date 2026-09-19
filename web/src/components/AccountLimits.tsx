import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Row, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { fmtTime } from '../format';
import { useFetch } from '../hooks';

interface LimitWindow { key: string; label: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: string | null }
interface AccountLimit {
  provider: string; accountKey: string; accountLabel: string | null; servers: string[]; plan: string | null; windows: LimitWindow[]; fetchedAt: string | null; serverName: string | null;
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

/** 把错误码翻译成管理员能直接采取行动的话 */
function limitErrorText(code: string, fallback: string): string {
  if (code === 'TOKEN_EXPIRED') {
    return /revoked|unauthorized/i.test(fallback)
      ? '登录已被服务商吊销：需要在这台服务器上重新登录（codex login / claude 里执行 /login）后才能查询额度。'
      : '登录令牌已过期：这台服务器近期没有使用该工具。下次使用时 CLI 会自动续期（平台不会替它续期），之后即可查到额度。';
  }
  if (code === 'NO_LOGIN') return '没有订阅账号的登录信息。';
  if (code === 'LIMITS_UNAVAILABLE') return `服务商接口暂时不可用${fallback ? `：${fallback}` : '。'}`;
  return fallback || code;
}

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

/** 账号额度：服务商侧 5 小时 / 周额度的已用比例与刷新时间；不同服务器登录不同账号时按账号分别显示 */
export function AccountLimitsCard() {
  const { message } = App.useApp();
  const { data, loading, reload } = useFetch(() => api.get<{ limits: AccountLimit[]; unidentified: Array<{ provider: string; serverName: string; dataDir: string; error: string }>; checked: boolean }>('/limits'), []);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // 倒计时每 30 秒走一格；每 2 分钟重新读取平台上的最新快照（平台每 10 分钟向服务商查询一次）
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reload, 120_000); return () => clearInterval(t); }, [reload]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<{ outcomes: Array<{ provider: string; accountLabel: string | null; ok: boolean; message?: string }> }>('/limits/refresh');
      const failed = r.outcomes.filter((o) => !o.ok);
      if (failed.length) message.warning(failed.map((o) => `${PROVIDER_LABEL[o.provider] ?? o.provider}${o.accountLabel ? ` ${o.accountLabel}` : ''}：${o.message}`).join('；'));
      else message.success('已更新');
      reload(); setNow(Date.now());
    } catch (err) { message.error(errorMessage(err)); } finally { setRefreshing(false); }
  };

  return (
    <Card
      size="small" style={{ marginBottom: 16 }}
      title={<Space size={8}>账号额度<Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>按各服务器实际登录的订阅账号分别显示 · 每 10 分钟自动查询</Typography.Text></Space>}
      extra={<Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={refresh}>立即查询</Button>}
    >
      {loading && !data ? <Skeleton active paragraph={{ rows: 3 }} /> : (
        <>
          {(data?.limits ?? []).length === 0 && (
            <Alert type="info" showIcon title={data?.checked ? '没有识别到订阅账号' : '还没有查询过账号额度'} description="添加服务器并完成首次采集后，点右上角“立即查询”。" />
          )}
          <Row gutter={[32, 16]}>
            {(data?.limits ?? []).map((a) => (
              <Col key={`${a.provider}:${a.accountKey}`} xs={24} md={12} xl={(data?.limits.length ?? 0) > 2 ? 8 : 12}>
                <div style={{ marginBottom: 10 }}>
                  <Space size={8} wrap>
                    <Typography.Text strong style={{ fontSize: 15 }}>{PROVIDER_LABEL[a.provider] ?? a.provider}</Typography.Text>
                    {a.plan && <Tag>{a.plan}</Tag>}
                    <Typography.Text copyable={a.accountLabel ? { text: a.accountLabel } : false}>{a.accountLabel ?? `账号 ${a.accountKey.slice(0, 8)}…`}</Typography.Text>
                  </Space>
                  <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>使用该账号的服务器：{a.servers.join('、')}</Typography.Text></div>
                </div>
                {a.windows.length === 0
                  ? <Alert type="warning" showIcon title={a.lastError ? limitErrorText(a.lastError.code, a.lastError.message) : '还没有查询到额度'} />
                  : a.windows.map((w) => <Meter key={w.key} w={w} now={now} />)}
                {a.windows.length > 0 && !a.windows.some((w) => w.key === 'five_hour') && (
                  <div style={{ marginBottom: 10 }}><Typography.Text type="secondary" style={{ fontSize: 12 }}>服务商目前没有给这个账号设置 5 小时窗口，只有上面的周额度。</Typography.Text></div>
                )}
                {a.windows.length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    数据更新于 {fmtTime(a.fetchedAt)}{a.serverName ? ` · 经 ${a.serverName} 查询` : ''}
                    {a.lastError && <Tooltip title={a.lastError.message}><span style={{ color: '#c98a00' }}> · 最近一次查询失败（{fmtTime(a.lastError.at)}）：{limitErrorText(a.lastError.code, a.lastError.message)}显示的是上一次的结果</span></Tooltip>}
                  </Typography.Text>
                )}
              </Col>
            ))}
          </Row>
          {(data?.unidentified ?? []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                以下来源识别不出登录的订阅账号（用 API Key 登录、未登录，或采集脚本版本过旧）：
                {data!.unidentified.map((u) => `${u.serverName}（${PROVIDER_LABEL[u.provider] ?? u.provider}）`).join('、')}
              </Typography.Text>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
