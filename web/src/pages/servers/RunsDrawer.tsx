import { Alert, Button, Drawer, Space, Table, Tag, Typography } from 'antd';
import { api } from '../../api';
import { LoadMore, LongText, MobileCards, RUN_STATUS } from '../../components/common';
import { fmtFull, fmtTime } from '../../format';
import { usePagedFetch } from '../../hooks';
import { drawerSize, useIsMobile } from '../../responsive';
import type { Anomaly, Run } from '../../types';

const { Text } = Typography;

const PAGE_SIZE = 100;
const TRIGGER_LABEL: Record<string, string> = { scheduled: '定时', catchup: '补采', manual: '手动', init: '初始化' };

const anomalyText = (a: Anomaly) => `${a.date} ${a.kind === 'missing' ? '远端已无该日记录（疑似日志被清理）' : '用量异常减少'}：已入库 ${fmtFull(a.previousTotal)} → 新结果 ${fmtFull(a.newTotal)} Token，已保留旧值并标记待核查`;
const statusTag = (r: Run, flush = false) => { const s = RUN_STATUS[r.status] ?? { color: 'default', text: r.status }; return <Tag color={s.color} style={flush ? { marginInlineEnd: 0 } : undefined}>{s.text}</Tag>; };

export type RunsDrawerState = { targetId?: string; title: string } | null;

export function RunsDrawer({ state, onClose }: { state: RunsDrawerState; onClose: () => void }) {
  const open = state !== null;
  const targetId = state?.targetId;
  const isMobile = useIsMobile();
  const runs = usePagedFetch<Run>(
    (offset, limit) => (open ? api.get<{ runs: Run[] }>('/collection/runs', { targetId, limit, offset }).then((r) => r.runs) : Promise.resolve([])),
    [open, targetId], PAGE_SIZE, (r) => r.id,
  );
  return (
    <Drawer title={<span className="wrap-anywhere" style={{ whiteSpace: 'normal' }}>{state?.title}</span>} open={open} onClose={onClose} size={drawerSize(isMobile, 980)} extra={<Button onClick={runs.reload} loading={runs.loading}>刷新</Button>} destroyOnHidden>
      {runs.error && <Alert type="error" showIcon title={runs.error} style={{ marginBottom: 12 }} />}
      {isMobile ? (
        // 手机：一次运行一张卡片，错误信息与待核查项直接列在卡片里（桌面端在展开行里）
        <MobileCards<Run>
          items={runs.items} rowKey={(r) => r.id} loading={runs.loading} pageSize={20} emptyText="还没有采集记录"
          title={(r) => fmtTime(r.createdAt, true)}
          tags={(r) => <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>{r.anomalies.length > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{r.anomalies.length} 项待核查</Tag>}{statusTag(r, true)}</span>}
          fields={(r) => [
            !targetId && { label: '来源', block: true, value: <>{r.serverName}<div><Text type="secondary" style={{ fontSize: 12 }}>{r.dataDir} · {r.userName}</Text></div></> },
            { label: '触发', value: `${TRIGGER_LABEL[r.trigger] ?? r.trigger} · 第 ${r.attempt} 次尝试` },
            { label: '采集范围', value: r.rangeSince ? `${r.rangeSince} ~ ${r.rangeUntil}` : '—' },
            { label: '写入行数 · ccusage', value: `${r.rowsWritten ?? '—'} · ${r.ccusageVersion ?? '—'}` },
            { label: '完成时间', value: fmtTime(r.finishedAt, true) },
            Boolean(r.errorMessage) && { label: '错误', block: true, value: <LongText danger>{`${r.errorCode}：${r.errorMessage}`}</LongText> },
            r.anomalies.length > 0 && { label: '待核查', block: true, value: <Space orientation="vertical" size={4}>{r.anomalies.map((a) => <Text key={`${a.date}${a.kind}`} type="warning" style={{ fontSize: 12 }}>{anomalyText(a)}</Text>)}</Space> },
          ]}
        />
      ) : (
      <Table<Run>
        size="small" rowKey="id" loading={runs.loading} dataSource={runs.items} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 900 }}
        expandable={{
          rowExpandable: (r) => Boolean(r.errorMessage) || r.anomalies.length > 0,
          expandedRowRender: (r) => (
            <Space orientation="vertical" size={4}>
              {r.errorMessage && <Text type="danger">{r.errorCode}：{r.errorMessage}</Text>}
              {r.anomalies.map((a) => (
                <Text key={`${a.date}${a.kind}`} type="warning">{anomalyText(a)}</Text>
              ))}
            </Space>
          ),
        }}
        columns={[
          { title: '创建时间', render: (_v, r) => fmtTime(r.createdAt, true) },
          ...(targetId ? [] : [{ title: '来源', render: (_v: unknown, r: Run) => <>{r.serverName}<div><Text type="secondary" style={{ fontSize: 12 }}>{r.dataDir} · {r.userName}</Text></div></> }]),
          { title: '触发', dataIndex: 'trigger', render: (v: string) => TRIGGER_LABEL[v] ?? v },
          { title: '状态', render: (_v, r) => statusTag(r) },
          { title: '尝试', dataIndex: 'attempt', align: 'right' },
          { title: '采集范围', render: (_v, r) => (r.rangeSince ? `${r.rangeSince} ~ ${r.rangeUntil}` : '—') },
          { title: '写入行数', dataIndex: 'rowsWritten', align: 'right', render: (v: number | null) => v ?? '—' },
          { title: '异常', render: (_v, r) => (r.anomalies.length ? <Tag color="warning">{r.anomalies.length} 项待核查</Tag> : r.errorCode ? <Text type="danger">{r.errorCode}</Text> : '—') },
          { title: 'ccusage', dataIndex: 'ccusageVersion', render: (v: string | null) => v ?? '—' },
          { title: '完成时间', render: (_v, r) => fmtTime(r.finishedAt, true) },
        ]}
      />
      )}
      <LoadMore hasMore={runs.hasMore} loading={runs.loadingMore} count={runs.items.length} onClick={runs.loadMore} />
    </Drawer>
  );
}
