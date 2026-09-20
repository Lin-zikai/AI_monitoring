import { Button, Card, Col, Empty, Pagination, Progress, Row, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { Fragment, useState, type Key, type ReactNode } from 'react';
import { budgetPct, fmtCost, fmtFull, fmtTokens, num, UNKNOWN } from '../format';
import { useIsMobile } from '../responsive';
import type { EmailStatus, NumLike } from '../types';

/** 统计卡：大号数字用缩写，悬停（触屏上点按）给出完整数值。手机上一行两张：字号随数值长度收小，保证金额不换行、不被截断。 */
export function StatCard({ label, value, full, hint, loading }: { label: string; value: string; full?: string; hint?: ReactNode; loading?: boolean }) {
  const isMobile = useIsMobile();
  const hasFull = Boolean(full && full !== value);
  return (
    <Card size="small" loading={loading} style={isMobile ? { height: '100%' } : undefined} styles={{ body: { padding: isMobile ? 12 : 16 } }}>
      <Typography.Text type="secondary" style={isMobile ? { fontSize: 12, display: 'block' } : undefined}>{label}</Typography.Text>
      <div style={isMobile
        ? { fontSize: value.length > 12 ? 15 : value.length > 9 ? 17 : 22, fontWeight: 600, lineHeight: '30px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
        : { fontSize: 28, fontWeight: 600, lineHeight: 1.3 }}>
        {/* 手机上让数字可聚焦、点按即开：触屏没有悬停 */}
        <Tooltip title={hasFull ? full : undefined} trigger={isMobile ? 'focus' : undefined}><span tabIndex={hasFull && isMobile ? 0 : undefined}>{value}</span></Tooltip>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: isMobile ? 'block' : undefined }}>{hint ?? ' '}</Typography.Text>
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
export function BudgetBar({ cost, budget, compact }: { cost: NumLike | undefined; budget: number | null | undefined; /** 窄位置（手机表格单元格、卡片）：不设最小宽度 */ compact?: boolean }) {
  const pct = budgetPct(cost, budget);
  if (pct === null) return <Typography.Text type="secondary" style={compact ? { fontSize: 12 } : undefined}>{budget ? UNKNOWN : '未设预算'}</Typography.Text>;
  const color = pct >= 100 ? '#d03b3b' : pct >= 80 ? '#fab219' : '#2a78d6';
  return (
    <Tooltip title={`${fmtCost(cost)} / ${fmtCost(budget)}（估算费用）`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: compact ? 0 : 140 }}>
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
  const isMobile = useIsMobile();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: isMobile ? 8 : 12, marginBottom: isMobile ? 12 : 16 }}>
      <Typography.Title level={4} style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', ...(isMobile ? { fontSize: 18 } : {}) }}>{title}</Typography.Title>
      {/* 手机上操作区单独占一行 */}
      <div style={isMobile && extra ? { width: '100%' } : undefined}>{extra}</div>
    </div>
  );
}

export interface FilterBarItem { key: string; node: ReactNode; /** 手机上占半行（默认整行） */ half?: boolean }

/** 筛选 / 工具栏：桌面端横向排开（放不下自动换行）；手机上变成整行 / 半行的堆叠控件，宽度由 global.css 的 .filter-bar-mobile 撑满 */
export function FilterBar({ items }: { items: Array<FilterBarItem | false | null | undefined> }) {
  const isMobile = useIsMobile();
  const shown = items.filter((i): i is FilterBarItem => Boolean(i));
  if (!isMobile) return <Space wrap>{shown.map((i) => <Fragment key={i.key}>{i.node}</Fragment>)}</Space>;
  return (
    <Row gutter={[8, 8]} className="filter-bar-mobile">
      {shown.map((i) => <Col key={i.key} span={i.half ? 12 : 24}>{i.node}</Col>)}
    </Row>
  );
}

/** 纵排表单里并排的两三个表单项：桌面端横排，手机上各占一行 */
export function FormRow({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  if (isMobile) return <>{children}</>;
  return <Space size={16} align="start" style={{ display: 'flex' }}>{children}</Space>;
}

/** 手机卡片里的长文本（错误堆栈、失败原因）：保留换行、任意位置可折行，超过 6 行先折叠，点“展开”看全文 */
export function LongText({ children, danger }: { children: string; danger?: boolean }) {
  return (
    <Typography.Paragraph type={danger ? 'danger' : 'secondary'} className="wrap-anywhere" style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}
      ellipsis={{ rows: 6, expandable: 'collapsible', symbol: (expanded: boolean) => (expanded ? '收起' : '展开全文') }}>
      {children}
    </Typography.Paragraph>
  );
}

export interface CardField { label: string; value: ReactNode; /** 值较长：标签在上、值另起一行 */ block?: boolean }

/** “标签：值”列表，卡片列表里用 */
export function CardFields({ fields }: { fields: Array<CardField | false | null | undefined> }) {
  const shown = fields.filter((f): f is CardField => Boolean(f));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {shown.map((f) => (
        <div key={f.label} style={f.block ? undefined : { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <Typography.Text type="secondary" style={{ flex: 'none', fontSize: 13 }}>{f.label}</Typography.Text>
          <div className="wrap-anywhere" style={f.block ? { marginTop: 2 } : { minWidth: 0, textAlign: 'right' }}>{f.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * 手机上代替宽表格的卡片列表：每条记录一张卡片（标题 + 状态标签、字段、操作按钮行）。
 * 操作按钮用默认尺寸（手机主题下 40px 高），次要操作收进“更多”下拉。
 */
export function MobileCards<T>({ items, rowKey, loading, emptyText, pageSize, title, tags, fields, actions, footer }: {
  items: T[]; rowKey: (item: T) => Key; loading?: boolean; emptyText?: ReactNode; pageSize?: number;
  title: (item: T) => ReactNode; tags?: (item: T) => ReactNode; fields: (item: T) => Array<CardField | false | null | undefined>;
  actions?: (item: T) => ReactNode; footer?: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(1);
  const pages = pageSize ? Math.max(1, Math.ceil(items.length / pageSize)) : 1;
  const current = Math.min(page, pages);
  const shown = pageSize ? items.slice((current - 1) * pageSize, current * pageSize) : items;
  return (
    <Spin spinning={Boolean(loading)}>
      {shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '加载中…' : emptyText ?? '暂无数据'} style={{ padding: '32px 0' }} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {shown.map((item) => {
          const acts = actions?.(item);
          return (
          <Card key={rowKey(item)} size="small" styles={{ body: { padding: 12 } }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, marginBottom: 8 }}>
              <div className="wrap-anywhere" style={{ fontWeight: 600, fontSize: 15, minWidth: 0 }}>{title(item)}</div>
              {tags?.(item)}
            </div>
            <CardFields fields={fields(item)} />
            {acts && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{acts}</div>}
            {footer?.(item)}
          </Card>
          );
        })}
      </div>
      {pageSize && pages > 1 && <Pagination simple current={current} pageSize={pageSize} total={items.length} onChange={setPage} style={{ marginTop: 12, justifyContent: 'center' }} />}
    </Spin>
  );
}

/** 列表底部的“加载更多”：上一页取满时才出现 */
export function LoadMore({ hasMore, loading, count, onClick }: { hasMore: boolean; loading: boolean; count: number; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div style={{ textAlign: 'center', marginTop: 12 }}>
      <Button onClick={onClick} loading={loading}>加载更多</Button>
      <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>已加载 {count} 条</Typography.Text>
    </div>
  );
}
