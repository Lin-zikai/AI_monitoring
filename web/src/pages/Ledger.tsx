import { SwapOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Col, DatePicker, InputNumber, Popover, Row, Segmented, Select, Space, Tabs, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { LEDGER_SERIES, MonthlyStackChart } from '../components/charts';
import { FilterBar, PageTitle, StatCard } from '../components/common';
import { useStatsToday } from '../components/Layout';
import { fmtMoney } from '../format';
import { useFetch } from '../hooks';
import { useIsMobile } from '../responsive';
import type { Bill, BillCategory, BillCurrency, BillSummary } from '../types';
import { BillList } from './ledger/BillList';
import { BillModal, type BillKind } from './ledger/BillModal';
import { MonthlyTable } from './ledger/MonthlyTable';
import { CATEGORY_LABEL, CURRENCY_NAME, readStored, writeStored, yearStats } from './ledger/money';

const DISPLAY_KEY = 'ledger.displayCurrency';

/** 账目设置：汇率与记账起始月份，点开后修改并保存。汇率只影响展示时的换算，账单本身按原币种保存 */
function RateControl({ usdCny, startMonth, onSaved }: { usdCny: number | undefined; startMonth: string | undefined; onSaved: () => void }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<number | null>(null);
  const [start, setStart] = useState<Dayjs | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (value === null || !start) return;
    setSaving(true);
    try {
      await api.put('/bills/settings', { usdCny: Math.round(value * 10000) / 10000, startMonth: start.format('YYYY-MM') });
      message.success('账目设置已保存');
      setOpen(false);
      onSaved();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };
  return (
    <Popover
      trigger="click" placement="bottomRight" open={open} onOpenChange={(o) => { setOpen(o); if (o) { setValue(usdCny ?? null); setStart(startMonth ? dayjs(`${startMonth}-01`) : null); } }}
      title="账目设置"
      content={(
        <div style={{ width: 252 }}>
          <InputNumber aria-label="1 美元折合人民币" prefix="1 美元 =" suffix="元" min={1} max={20} step={0.01} inputMode="decimal" value={value} onChange={setValue} onPressEnter={() => void save()} style={{ width: '100%' }} />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 12px' }}>只用于本页的金额换算；账单按录入时的币种保存，改汇率不会改动账单。</Typography.Paragraph>
          <DatePicker aria-label="记账起始月份" picker="month" allowClear={false} inputReadOnly value={start} onChange={setStart} prefix="起始月份" style={{ width: '100%' }} />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 12px' }}>从这个月开始统计：更早的月份不进统计表和图，也不能上传更早的账单。</Typography.Paragraph>
          <Button type="primary" block loading={saving} disabled={value === null || !start} onClick={() => void save()}>保存</Button>
        </div>
      )}
    >
      <Button icon={<SwapOutlined />} disabled={usdCny === undefined}>汇率 1 美元 = {usdCny ?? '…'} 元</Button>
    </Popover>
  );
}

export function LedgerPage() {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const today = useStatsToday();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [display, setDisplay] = useState<BillCurrency>(() => readStored(DISPLAY_KEY, ['CNY', 'USD'] as const, 'CNY'));
  const [tab, setTab] = useState<BillKind>('vpn');
  const [modal, setModal] = useState<{ kind: BillKind; editing: Bill | null } | null>(null);
  // 对话框关闭动画期间仍要知道它是哪一种，标题和表单才不会闪成另一种
  const [lastKind, setLastKind] = useState<BillKind>('vpn');

  const summary = useFetch(() => api.get<BillSummary>('/bills/summary', { year }), [year], { keepPrevious: true });
  const bills = useFetch(() => api.get<{ bills: Bill[] }>('/bills', { year }), [year]);
  const reloadAll = () => { summary.reload(); bills.reload(); };

  const usdCny = summary.data?.usdCny;
  // keepPrevious：切换年份的加载期间沿用上一年的 years / 汇率，但统计数字只认当前年份的响应
  const current = summary.data?.year === year ? summary.data : undefined;
  const stats = useMemo(() => (current ? yearStats(current, display) : null), [current, display]);
  const chartValues = useMemo(() => Object.fromEntries(LEDGER_SERIES.map((s) => [s.key, (stats?.rows ?? []).map((r) => r.paid[s.key] ?? 0)])) as Record<BillCategory, number[]>, [stats]);

  const years = useMemo(() => [...new Set([year, ...(summary.data?.years ?? [])])].sort((a, b) => b - a), [year, summary.data]);
  const all = bills.data?.bills ?? [];
  const vpnBills = all.filter((b) => b.category === 'vpn');
  const aiBills = all.filter((b) => b.category !== 'vpn');

  const openModal = (kind: BillKind, editing: Bill | null = null) => { setLastKind(kind); setModal({ kind, editing }); };
  const onSaved = (month: string) => {
    const savedKind = modal?.kind;
    setModal(null);
    if (savedKind) setTab(savedKind);
    const savedYear = Number(month.slice(0, 4));
    if (savedYear !== year) setYear(savedYear); // 账单记在别的年份：跳过去，让人看得到刚保存的这一笔
    else reloadAll();
  };
  const remove = (b: Bill) => api.del(`/bills/${b.id}`).then(() => { message.success('已删除'); reloadAll(); }).catch((e) => { message.error(errorMessage(e)); });

  /** 某类别（或全部）的笔数，以及是否用到了汇率换算 */
  const facts = (category?: BillCategory) => {
    const items = (current?.months ?? []).flatMap((m) => m.items).filter((i) => !category || i.category === category);
    return { count: items.reduce((a, i) => a + i.count, 0), converted: items.some((i) => i.currency !== display) };
  };
  // 提示保持一行以内（四张卡等高）；折算用的汇率在页头的“汇率”按钮和“月度统计”的说明里
  const cardHint = (category: BillCategory) => {
    const f = facts(category);
    if (f.count === 0) return '还没有账单';
    return `共 ${f.count} 笔${f.converted ? ' · 已按汇率折算' : ''}`;
  };
  const totalFacts = facts();
  const totalHint = !stats || totalFacts.count === 0 ? '还没有账单'
    : `月均 ${fmtMoney((stats.totals.total ?? 0) / Math.max(stats.billMonths, 1), display)} · 共 ${totalFacts.count} 笔${totalFacts.converted && !isMobile ? ' · 含汇率折算' : ''}`;
  const value = (v: number | null | undefined) => (stats ? fmtMoney(v ?? 0, display) : '—');

  return (
    <>
      <PageTitle title="账目明细" extra={(
        <FilterBar items={[
          { key: 'year', half: true, node: <Select aria-label="年份" value={year} onChange={setYear} style={{ width: 110 }} options={years.map((y) => ({ value: y, label: `${y} 年` }))} /> },
          { key: 'rate', half: true, node: <RateControl usdCny={usdCny} startMonth={summary.data?.startMonth} onSaved={summary.reload} /> },
          {
            key: 'currency', node: <Segmented<BillCurrency> aria-label="显示币种" value={display} onChange={(v) => { setDisplay(v); writeStored(DISPLAY_KEY, v); }}
              options={[{ value: 'CNY', label: '¥ 人民币' }, { value: 'USD', label: '$ 美元' }]} />,
          },
          { key: 'vpn', half: true, node: <Button type="primary" icon={<UploadOutlined />} onClick={() => openModal('vpn')}>上传 VPN 账单</Button> },
          { key: 'ai', half: true, node: <Button icon={<UploadOutlined />} onClick={() => openModal('ai')}>上传 AI 账单</Button> },
        ]} />
      )} />

      {summary.error && <Alert type="error" showIcon title="账目汇总加载失败" description={summary.error} action={<Button size="small" onClick={summary.reload}>重试</Button>} style={{ marginBottom: 16 }} />}

      <Row gutter={isMobile ? [8, 8] : [16, 16]} className="ledger-stats">
        <Col xs={12} lg={6}><StatCard label={`${year} 年合计`} value={value(stats?.totals.total)} hint={stats ? totalHint : undefined} loading={summary.loading && !stats} /></Col>
        {LEDGER_SERIES.map((s) => (
          <Col key={s.key} xs={12} lg={6}>
            <StatCard label={CATEGORY_LABEL[s.key]} value={value(stats?.totals.paid[s.key])} hint={stats ? cardHint(s.key) : undefined} loading={summary.loading && !stats} />
          </Col>
        ))}
      </Row>

      <Card size="small" title="每月支出" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>单位：{CURRENCY_NAME[display]}{usdCny ? ` · 按 1 美元 = ${usdCny} 元折算` : ''}</Typography.Text>} style={{ marginTop: isMobile ? 12 : 16 }} loading={summary.loading && !stats}>
        {/* 加载失败时不画“还没有账单”的空状态：上面的错误提示才是实情 */}
        {stats && <MonthlyStackChart year={year} months={current!.months.map((m) => m.month.slice(5))} values={chartValues} currency={display} />}
      </Card>

      <Card size="small" title="月度统计" style={{ marginTop: isMobile ? 12 : 16 }} styles={{ body: { padding: isMobile ? 0 : undefined } }}
        extra={isMobile ? undefined : <Typography.Text type="secondary" style={{ fontSize: 12 }}>“按量估算”来自 ccusage，仅供对照，不是实际扣费</Typography.Text>}>
        {(stats || !summary.error) && <MonthlyTable stats={stats} display={display} loading={summary.loading} />}
      </Card>

      <Card size="small" style={{ marginTop: isMobile ? 12 : 16 }} styles={{ body: { paddingTop: 4 } }}>
        <Tabs
          activeKey={tab} onChange={(k) => setTab(k as BillKind)}
          items={([['vpn', 'VPN 账单', vpnBills], ['ai', 'AI 账单', aiBills]] as const).map(([key, label, list]) => ({
            key, label: `${label}（${bills.data ? list.length : '…'}）`,
            children: bills.error
              ? <Alert type="error" showIcon title="账单列表加载失败" description={bills.error} action={<Button size="small" onClick={bills.reload}>重试</Button>} />
              : <BillList kind={key} bills={list} loading={bills.loading} display={display} usdCny={usdCny} onEdit={(b) => openModal(key, b)} onDelete={remove} />,
          }))}
        />
      </Card>

      <BillModal kind={modal?.kind ?? lastKind} editing={modal?.editing ?? null} startMonth={summary.data?.startMonth} open={modal !== null} onClose={() => setModal(null)} onSaved={onSaved} />
    </>
  );
}
