import { Button, Image, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { LEDGER_SERIES } from '../../components/charts';
import { MobileCards } from '../../components/common';
import { fmtMoney } from '../../format';
import { useIsMobile } from '../../responsive';
import type { Bill, BillCategory, BillCurrency } from '../../types';
import { attachmentUrl, type BillKind } from './BillModal';
import { CATEGORY_LABEL, convert } from './money';

const SERIES_COLOR = Object.fromEntries(LEDGER_SERIES.map((s) => [s.key, s.color])) as Record<BillCategory, string>;

/** 类别标记：色块与“每月支出”图里的系列同色，文字保持文字色 */
export function CategoryTag({ category }: { category: BillCategory }) {
  return (
    <Tag style={{ marginInlineEnd: 0 }}>
      <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: SERIES_COLOR[category] }} />
      {CATEGORY_LABEL[category]}
    </Tag>
  );
}

/** 金额按原币种显示；与显示币种不同时，下面再给一行按汇率折算的值 */
function Amount({ bill, display, usdCny, align }: { bill: Bill; display: BillCurrency; /** 汇率还没拿到（汇总接口失败）时不给折算值 */ usdCny: number | undefined; align: 'left' | 'right' }) {
  return (
    <div style={{ textAlign: align, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      <div>{fmtMoney(bill.amount, bill.currency)}</div>
      {bill.currency !== display && usdCny !== undefined && <Typography.Text type="secondary" style={{ fontSize: 12 }}>≈ {fmtMoney(convert(bill.amount, bill.currency, display, usdCny), display)}</Typography.Text>}
    </div>
  );
}

function Shots({ bill, size = 48 }: { bill: Bill; size?: number }) {
  if (bill.attachments.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Image.PreviewGroup>
      <Space size={6} wrap>
        {bill.attachments.map((a) => (
          <Image key={a.id} src={attachmentUrl(a.id)} alt={a.filename} width={size} height={size} style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #f0f0f0' }} />
        ))}
      </Space>
    </Image.PreviewGroup>
  );
}

const billName = (b: Bill) => `${b.month} 的${CATEGORY_LABEL[b.category]}账单${b.title ? `（${b.title}）` : ''}`;

export function BillList({ kind, bills, loading, display, usdCny, onEdit, onDelete }: {
  kind: BillKind; bills: Bill[]; loading: boolean; display: BillCurrency; usdCny: number | undefined; onEdit: (b: Bill) => void; onDelete: (b: Bill) => Promise<void>;
}) {
  const isMobile = useIsMobile();
  const emptyText = kind === 'vpn' ? '这一年还没有 VPN 账单' : '这一年还没有 AI 账单';
  const confirmProps = (b: Bill) => ({ title: `删除 ${billName(b)}？`, description: '截图会一并删除，无法恢复。', okText: '删除', okButtonProps: { danger: true }, onConfirm: () => onDelete(b) });

  if (isMobile) {
    return (
      <MobileCards<Bill>
        items={bills} rowKey={(b) => b.id} loading={loading} emptyText={emptyText} pageSize={12}
        title={(b) => b.month}
        tags={(b) => (kind === 'ai' ? <CategoryTag category={b.category} /> : null)}
        fields={(b) => [
          { label: '金额', value: <Amount bill={b} display={display} usdCny={usdCny} align="right" /> },
          b.title ? { label: '名称', value: b.title } : null,
          b.paidOn ? { label: '付款日期', value: b.paidOn } : null,
          b.note ? { label: '备注', block: true, value: <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>{b.note}</Typography.Text> } : null,
          b.attachments.length > 0 && { label: '截图', block: true, value: <Shots bill={b} size={56} /> },
        ]}
        actions={(b) => (
          <>
            <Button onClick={() => onEdit(b)} style={{ flex: 1 }}>编辑</Button>
            <Popconfirm {...confirmProps(b)}><Button danger style={{ flex: 1 }}>删除</Button></Popconfirm>
          </>
        )}
      />
    );
  }

  return (
    <Table<Bill>
      size="middle" rowKey="id" loading={loading} dataSource={bills} pagination={{ pageSize: 24, hideOnSinglePage: true }} scroll={{ x: 1080 }}
      locale={{ emptyText }}
      columns={[
        { title: '月份', dataIndex: 'month', width: 88 },
        ...(kind === 'ai' ? [{ title: '工具', width: 124, render: (_v: unknown, b: Bill) => <CategoryTag category={b.category} /> }] : []),
        { title: '名称', dataIndex: 'title', width: 190, render: (v: string | null) => (v ? <span className="wrap-anywhere">{v}</span> : <Typography.Text type="secondary">—</Typography.Text>) },
        { title: '金额', align: 'right', width: 136, render: (_v, b) => <Amount bill={b} display={display} usdCny={usdCny} align="right" /> },
        // 右对齐的金额紧挨着左对齐的日期会粘在一起：日期列左边多留一点
        { title: '付款日期', dataIndex: 'paidOn', width: 132, onCell: () => ({ style: { paddingInlineStart: 28 } }), onHeaderCell: () => ({ style: { paddingInlineStart: 28 } }), render: (v: string | null) => v ?? <Typography.Text type="secondary">—</Typography.Text> },
        {
          title: '备注', dataIndex: 'note', render: (v: string | null) => (v
            ? <Typography.Paragraph type="secondary" className="wrap-anywhere" style={{ margin: 0, maxWidth: 360 }} ellipsis={{ rows: 2, tooltip: { title: v, styles: { root: { maxWidth: 420 } } } }}>{v}</Typography.Paragraph>
            : <Typography.Text type="secondary">—</Typography.Text>),
        },
        { title: '截图', width: 232, render: (_v, b) => <Shots bill={b} /> },
        {
          title: '操作', width: 108, render: (_v, b) => (
            <Space size={4}>
              <Button type="link" size="small" onClick={() => onEdit(b)}>编辑</Button>
              <Popconfirm {...confirmProps(b)}><Button type="link" size="small" danger>删除</Button></Popconfirm>
            </Space>
          ),
        },
      ]}
    />
  );
}
