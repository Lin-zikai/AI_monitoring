import { InfoCircleOutlined } from '@ant-design/icons';
import { Table, Tooltip, Typography } from 'antd';
import { fmtMoney, fmtMoneyCompact } from '../../format';
import { useIsMobile } from '../../responsive';
import type { BillCurrency } from '../../types';
import type { MonthRow, YearStats } from './money';

const ESTIMATE_TIP = 'ccusage 按公开 API 价格估算的同期用量价值，不是实际扣费';
const SAVED_TIP = '按量估算 − 当月 Claude Code 与 Codex 的实付金额；只在当月有 AI 账单时计算';
const NONE = <Typography.Text type="secondary">—</Typography.Text>;
const NUM = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const;

const withTip = (title: string, tip: string) => <Tooltip title={tip}><span style={{ whiteSpace: 'nowrap' }}>{title} <InfoCircleOutlined style={{ color: '#898781', fontSize: 12 }} /></span></Tooltip>;

/** 月度统计：每个有账单或有估算用量的月份一行（新月份在前），底部是全年合计。手机上只留实付的几列，金额用紧凑写法 */
export function MonthlyTable({ stats, display, loading }: { stats: YearStats | null; display: BillCurrency; loading: boolean }) {
  const isMobile = useIsMobile();
  const rows = (stats?.rows ?? []).filter((r) => r.total !== null || r.estimated !== null).reverse();
  const money = (v: number | null, strong = false) => (v === null ? NONE
    : <span style={{ ...NUM, fontWeight: strong ? 600 : undefined }} title={isMobile ? fmtMoney(v, display) : undefined}>{isMobile ? fmtMoneyCompact(v, display) : fmtMoney(v, display)}</span>);
  const saved = (v: number | null) => (v === null ? NONE : <Typography.Text type={v > 0 ? 'success' : 'secondary'} style={NUM}>{fmtMoney(v, display)}</Typography.Text>);

  return (
    <Table<MonthRow>
      size={isMobile ? 'small' : 'middle'} rowKey="month" loading={loading} dataSource={rows} pagination={false}
      locale={{ emptyText: '这一年还没有账单，也没有用量估算' }}
      columns={[
        { title: '月份', dataIndex: 'month', width: isMobile ? 58 : 110, render: (m: string) => <span style={NUM}>{isMobile ? `${Number(m.slice(5))} 月` : m}</span> },
        { title: 'VPN', align: 'right', render: (_v, r) => money(r.paid.vpn) },
        { title: isMobile ? 'Claude' : 'Claude Code', align: 'right', render: (_v, r) => money(r.paid['claude-code']) },
        { title: 'Codex', align: 'right', render: (_v, r) => money(r.paid.codex) },
        { title: '合计', align: 'right', render: (_v, r) => money(r.total, true) },
        { title: withTip('按量估算（AI）', ESTIMATE_TIP), align: 'right', responsive: ['md'], render: (_v, r) => (r.estimated === null ? NONE : <Typography.Text type="secondary" style={NUM}>{fmtMoney(r.estimated, display)}</Typography.Text>) },
        { title: withTip('订阅省下', SAVED_TIP), align: 'right', responsive: ['md'], render: (_v, r) => saved(r.saved) },
      ]}
      summary={() => (stats && rows.length > 0 ? (
        <Table.Summary.Row style={{ background: '#fafafa' }}>
          <Table.Summary.Cell index={0}><Typography.Text strong style={{ whiteSpace: 'nowrap' }}>{isMobile ? '全年' : `${stats.totals.month} 全年`}</Typography.Text></Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right">{money(stats.totals.paid.vpn, true)}</Table.Summary.Cell>
          <Table.Summary.Cell index={2} align="right">{money(stats.totals.paid['claude-code'], true)}</Table.Summary.Cell>
          <Table.Summary.Cell index={3} align="right">{money(stats.totals.paid.codex, true)}</Table.Summary.Cell>
          <Table.Summary.Cell index={4} align="right">{money(stats.totals.total, true)}</Table.Summary.Cell>
          {!isMobile && <Table.Summary.Cell index={5} align="right">{stats.totals.estimated === null ? NONE : <Typography.Text type="secondary" style={NUM}>{fmtMoney(stats.totals.estimated, display)}</Typography.Text>}</Table.Summary.Cell>}
          {!isMobile && <Table.Summary.Cell index={6} align="right">{saved(stats.totals.saved)}</Table.Summary.Cell>}
        </Table.Summary.Row>
      ) : null)}
    />
  );
}
