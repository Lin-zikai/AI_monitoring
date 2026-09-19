import { Card, Progress, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { budgetPct, fmtCost, fmtFull, fmtTokens, num, UNKNOWN } from '../format';
import type { EmailStatus, NumLike } from '../types';

/** 统计卡：大号数字用缩写，悬停给出完整数值。 */
export function StatCard({ label, value, full, hint, loading }: { label: string; value: string; full?: string; hint?: ReactNode; loading?: boolean }) {
  return (
    <Card size="small" loading={loading} styles={{ body: { padding: 16 } }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.3 }}>
        <Tooltip title={full && full !== value ? full : undefined}><span>{value}</span></Tooltip>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint ?? ' '}</Typography.Text>
    </Card>
  );
}

export function TokenCell({ value }: { value: NumLike | undefined }) {
  const n = num(value);
  if (n === null) return <Typography.Text type="secondary">{UNKNOWN}</Typography.Text>;
  return <Tooltip title={`${fmtFull(n)} Token`}><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(n)}</span></Tooltip>;
}

export function CostCell({ value }: { value: NumLike | undefined }) {
  if (num(value) === null) return <Typography.Text type="secondary">{UNKNOWN}</Typography.Text>;
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCost(value)}</span>;
}

/** 预算使用率：进度条颜色表示严重程度，同时始终显示百分比文字（不只靠颜色）。 */
export function BudgetBar({ cost, budget }: { cost: NumLike | undefined; budget: number | null | undefined }) {
  const pct = budgetPct(cost, budget);
  if (pct === null) return <Typography.Text type="secondary">{budget ? UNKNOWN : '未设预算'}</Typography.Text>;
  const color = pct >= 100 ? '#d03b3b' : pct >= 80 ? '#fab219' : '#2a78d6';
  return (
    <Tooltip title={`${fmtCost(cost)} / ${fmtCost(budget)}（估算费用）`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
        <Progress percent={Math.min(pct, 100)} showInfo={false} strokeColor={color} size="small" style={{ flex: 1, margin: 0 }} />
        <span style={{ minWidth: 48, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{pct}%{pct >= 100 ? ' !' : ''}</span>
      </div>
    </Tooltip>
  );
}

const EMAIL_STATUS: Record<EmailStatus, { color: string; text: string }> = {
  pending: { color: 'default', text: '待发送' },
  sending: { color: 'processing', text: '发送中' },
  sent: { color: 'success', text: '已发送' },
  failed: { color: 'error', text: '发送失败' },
};

export function EmailStatusTag({ status, note }: { status: EmailStatus | null; note?: string | null }) {
  if (!status) return <Tooltip title={note ?? undefined}><Tag>未发信</Tag></Tooltip>;
  const s = EMAIL_STATUS[status];
  return <Tag color={s.color}>{s.text}</Tag>;
}

export const RUN_STATUS: Record<string, { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  running: { color: 'processing', text: '采集中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  skipped_locked: { color: 'warning', text: '已跳过（目标被占用）' },
  stale: { color: 'warning', text: '已过期（被新采集取代）' },
};

export function PageTitle({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{title}</Typography.Title>
      <div>{extra}</div>
    </div>
  );
}
