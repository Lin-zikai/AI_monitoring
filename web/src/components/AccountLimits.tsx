import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { fmtTime } from '../format';
import { useFetch } from '../hooks';
import { useIsMobile } from '../responsive';

interface LimitWindow { key: string; label: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: string | null }
interface AccountLimit {
  provider: string; accountKey: string; accountLabel: string | null; servers: string[]; plan: string | null; windows: LimitWindow[]; fetchedAt: string | null; serverName: string | null;
  lastError: { code: string; message: string; at: string } | null;
}

const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

// 状态色只用于量表本身，并始终配图标与文字；数值与说明用正文色
const LEVELS = [
  { min: 90, color: '#d03b3b', text: '即将用尽', icon: <CloseCircleFilled /> },
  { min: 70, color: '#c98a00', text: '偏高', icon: <ExclamationCircleFilled /> },
  { min: 0, color: '#2a78d6', text: '充足', icon: <CheckCircleFilled /> },
];
const levelOf = (pct: number) => LEVELS.find((l) => pct >= l.min) ?? LEVELS[LEVELS.length - 1]!;
/** 服务商偶尔会给出超过 100、负数或非数字的读数：量表只画 0～100 */
const clampPct = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.min(100, Math.max(0, v)));

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

/** 单行量表：窗口名 · 进度条 · 已用比例 · 状态 · 刷新倒计时 */
function Meter({ w, now, isMobile }: { w: LimitWindow; now: number; isMobile: boolean }) {
  const clamped = clampPct(w.usedPercent);
  const known = clamped !== null;
  const pct = clamped ?? 0;
  // 窗口已过刷新时间：上一份读数不再代表当前窗口
  const stale = w.resetsAt !== null && new Date(w.resetsAt).getTime() <= now;
  const level = levelOf(pct);
  // 手机：单列三行 —— 窗口名 + 已用比例 + 状态 / 进度条 / 刷新时间（完整显示，不截断、不依赖悬停）
  if (isMobile) {
    return (
      <div style={{ width: '100%', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Typography.Text style={{ flex: 'none' }}>{w.label}</Typography.Text>
          <Typography.Text style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{known ? `已用 ${pct}%` : '未知'}</Typography.Text>
          {known && !stale && <span style={{ color: level.color, fontSize: 12, marginLeft: 'auto' }}>{level.icon} <Typography.Text style={{ fontSize: 12 }}>{level.text}</Typography.Text></span>}
        </div>
        <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined} aria-label={`${w.label}额度已用比例`}
          style={{ height: 8, borderRadius: 4, background: '#eef0f3', overflow: 'hidden', margin: '4px 0' }}>
          <div style={{ width: `${pct}%`, minWidth: known && pct > 0 ? 4 : 0, height: '100%', borderRadius: 4, background: stale ? '#b9bec7' : level.color, transition: 'width .3s' }} />
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          {known ? `剩余 ${Math.round((100 - pct) * 10) / 10}% · ` : ''}{remaining(w.resetsAt, now)}{w.resetsAt && !stale ? `（${fmtTime(w.resetsAt)}）` : ''}
        </Typography.Text>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 380px', minWidth: 0 }}>
      <Typography.Text style={{ width: 48, flex: 'none' }}>{w.label}</Typography.Text>
      <Tooltip title={known ? `已用 ${pct}%，剩余 ${Math.round((100 - pct) * 10) / 10}%` : undefined}>
        <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined} aria-label={`${w.label}额度已用比例`}
          style={{ flex: '1 1 120px', minWidth: 80, maxWidth: 260, height: 8, borderRadius: 4, background: '#eef0f3', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, minWidth: known && pct > 0 ? 4 : 0, height: '100%', borderRadius: 4, background: stale ? '#b9bec7' : level.color, transition: 'width .3s' }} />
        </div>
      </Tooltip>
      <Typography.Text style={{ width: 84, flex: 'none', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{known ? `已用 ${pct}%` : '未知'}</Typography.Text>
      {known && !stale
        ? <span style={{ color: level.color, fontSize: 12, width: 72, flex: 'none' }}>{level.icon} <Typography.Text style={{ fontSize: 12 }}>{level.text}</Typography.Text></span>
        : <span style={{ width: 72, flex: 'none' }} />}
      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {remaining(w.resetsAt, now)}{w.resetsAt && !stale ? `（${fmtTime(w.resetsAt)}）` : ''}
      </Typography.Text>
    </div>
  );
}

/** 账号额度：服务商侧 5 小时 / 周额度的已用比例与刷新时间；不同服务器登录不同账号时按账号分别显示 */
export function AccountLimitsCard() {
  const { message } = App.useApp();
  const { data, loading, error, reload, reloadSilent } = useFetch(() => api.get<{ limits: AccountLimit[]; hidden: Array<{ provider: string; accountLabel: string | null; servers: string[]; code: string; message: string }>; unidentified: Array<{ provider: string; serverName: string; dataDir: string; error: string }>; checked: boolean }>('/limits'), []);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const isMobile = useIsMobile();

  // 倒计时每 30 秒走一格；每 2 分钟重新读取平台上的最新快照（平台每 10 分钟向服务商查询一次）
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(reloadSilent, 120_000); return () => clearInterval(t); }, [reloadSilent]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<{ outcomes: Array<{ provider: string; accountLabel: string | null; ok: boolean; message?: string }> }>('/limits/refresh');
      const failed = r.outcomes.filter((o) => !o.ok);
      if (failed.length) message.warning(failed.map((o) => `${providerLabel(o.provider)}${o.accountLabel ? ` ${o.accountLabel}` : ''}：${o.message}`).join('；'));
      else message.success('已更新');
      reload(); setNow(Date.now());
    } catch (err) { message.error(errorMessage(err)); } finally { setRefreshing(false); }
  };

  const limits = data?.limits ?? [];
  // 已知的数据源按固定顺序排在前面；后台新增、这里还没收录的数据源排在后面，用原始名称显示而不是被丢掉
  const providers = [...Object.keys(PROVIDER_LABEL), ...new Set(limits.map((a) => a.provider).filter((p) => !(p in PROVIDER_LABEL)))].filter((p) => limits.some((a) => a.provider === p));

  return (
    <Card
      size="small" style={{ marginBottom: isMobile ? 12 : 16 }}
      title={isMobile ? '账号额度' : <Space size={8}>账号额度<Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>按各服务器实际登录的订阅账号分别显示 · 每 10 分钟自动查询</Typography.Text></Space>}
      extra={<Button size={isMobile ? 'middle' : 'small'} icon={<ReloadOutlined />} loading={refreshing} onClick={refresh}>立即查询</Button>}
    >
      {isMobile && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>按各服务器实际登录的订阅账号分别显示 · 每 10 分钟自动查询</Typography.Paragraph>}
      {error && <Alert type="error" showIcon style={{ marginBottom: data ? 12 : 0 }} title="账号额度加载失败" description={error} action={<Button size="small" onClick={reload} loading={loading}>重试</Button>} />}
      {loading && !data ? <Skeleton active paragraph={{ rows: 3 }} /> : !data ? null : (
        <>
          {limits.length === 0 && (
            <Alert type="info" showIcon title={data?.checked ? '没有可显示的订阅账号' : '还没有查询过账号额度'} description="添加服务器并完成首次采集后，点右上角“立即查询”。" />
          )}
          {/* 竖排：数据源 → 邮箱 → 用量。账号再多也只是往下延伸 */}
          {providers.map((provider, pi) => (
            <div key={provider} style={{ marginTop: pi === 0 ? 0 : 16 }}>
              <Typography.Text strong style={{ fontSize: 15 }}>{providerLabel(provider)}</Typography.Text>
              {limits.filter((a) => a.provider === provider).map((a, ai) => (
                <div key={a.accountKey} style={{ padding: '10px 0', borderTop: ai === 0 ? 'none' : '1px solid #f0f0f0' }}>
                  <div className="wrap-anywhere" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, marginBottom: 6 }}>
                    <Typography.Text copyable={a.accountLabel ? { text: a.accountLabel } : false}>{a.accountLabel ?? `账号 ${a.accountKey.slice(0, 8)}…`}</Typography.Text>
                    {a.plan && <Tag style={{ marginInlineEnd: 0 }}>{a.plan}</Tag>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      服务器：{a.servers.join('、')} · 更新于 {fmtTime(a.fetchedAt)}
                      {a.lastError && (isMobile
                        // 触屏没有悬停：失败原因直接写出来
                        ? <span style={{ color: '#c98a00', display: 'block' }}>最近一次查询失败，显示的是上一次的结果：{limitErrorText(a.lastError.code, a.lastError.message)}</span>
                        : <Tooltip title={limitErrorText(a.lastError.code, a.lastError.message)}><span style={{ color: '#c98a00' }}> · 最近一次查询失败，显示的是上一次的结果</span></Tooltip>)}
                    </Typography.Text>
                  </div>
                  {a.windows.length === 0
                    ? <Typography.Text type="warning" style={{ fontSize: 12 }}>{a.lastError ? limitErrorText(a.lastError.code, a.lastError.message) : '还没有查询到额度'}</Typography.Text>
                    : <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 32, rowGap: isMobile ? 10 : 6 }}>{a.windows.map((w) => <Meter key={w.key} w={w} now={now} isMobile={isMobile} />)}</div>}
                </div>
              ))}
            </div>
          ))}
          {(data?.hidden ?? []).length > 0 && (() => {
            const details = data!.hidden.map((h, hi) => <div key={`${h.provider}:${h.accountLabel ?? ''}:${hi}`}>{providerLabel(h.provider)} · {h.accountLabel ?? '未知账号'}（{h.servers.join('、')}）：{limitErrorText(h.code, h.message)}</div>);
            const summary = `另有 ${data!.hidden.length} 个账号的登录已过期，查不到额度，未显示`;
            return (
              <div style={{ marginTop: 12 }}>
                {isMobile
                  // 触屏：用原生 details 展开，不依赖悬停
                  ? (
                    <details className="wrap-anywhere" style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                      <summary style={{ cursor: 'pointer', padding: '6px 0' }}>{summary}</summary>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 12 }}>{details}</div>
                    </details>
                  )
                  : (
                    <Tooltip title={<div>{details}</div>} styles={{ root: { maxWidth: 560 } }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help', borderBottom: '1px dashed #c0c4cc' }}>{summary}</Typography.Text>
                    </Tooltip>
                  )}
              </div>
            );
          })()}
          {(data?.unidentified ?? []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                以下来源识别不出登录的订阅账号（用 API Key 登录、未登录，或采集脚本版本过旧）：
                {data!.unidentified.map((u) => `${u.serverName}（${providerLabel(u.provider)}）`).join('、')}
              </Typography.Text>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
