import { formatUsd } from '../util/money.js';
import { SOURCE_INFO } from '../collect/adapter.js';
import { formatInTz } from '../util/time.js';

export interface IncompleteSource { server: string; dataDir: string; lastSuccessAt: string | null }

export interface UsageAlertMail {
  userId: string;
  userName: string;
  ruleName: string;
  /** 规则限定的数据源；null = 所有数据源合计 */
  source?: string | null;
  metric: 'tokens' | 'cost' | 'budget_pct';
  periodType: 'daily' | 'monthly';
  periodKey: string;
  tier: string;
  observed: string;
  threshold: string;
  budget: string | null;
  dataAsOf: Date;
  timezone: string;
  intervalHours: number;
  incomplete: IncompleteSource[];
  baseUrl: string;
}

const formatTokens = (v: string) => `${Number(v).toLocaleString('en-US')} Token`;
const periodLabel = (t: 'daily' | 'monthly') => (t === 'daily' ? '当日' : '本月');
const over = (observed: string, threshold: string) => Math.max(0, Number(observed) - Number(threshold));

export function renderUsageAlert(m: UsageAlertMail): { subject: string; text: string } {
  const lines = [`用户：${m.userName}`, `统计周期：${m.periodKey}`, `触发规则：${m.ruleName}`];
  let subject: string;
  const scope = m.source ? ` ${SOURCE_INFO[m.source]?.label ?? m.source} ` : '';
  if (m.metric === 'budget_pct') {
    const pct = m.budget && Number(m.budget) > 0 ? Math.floor((Number(m.observed) / Number(m.budget)) * 100) : 0;
    subject = `[用量提醒] ${m.userName}本月预算已达到 ${Number(m.tier)}%`;
    lines.push(`本月估算费用：${formatUsd(m.observed)}`, `月度预算：${formatUsd(m.budget)}`, `预算使用率：${pct}%`);
  } else if (m.metric === 'cost') {
    subject = `[用量提醒] ${m.userName} ${periodLabel(m.periodType)}${scope}估算费用 ${formatUsd(m.observed)}，已超过 ${formatUsd(m.threshold)}`;
    lines.push(`数据范围：${scope.trim() || '全部数据源合计'}`, `${periodLabel(m.periodType)}估算费用：${formatUsd(m.observed)}`, `阈值：${formatUsd(m.threshold)}`, `超出：${formatUsd(over(m.observed, m.threshold).toFixed(2))}`);
  } else {
    subject = `[用量提醒] ${m.userName} ${periodLabel(m.periodType)}${scope} Token 用量 ${formatTokens(m.observed)}，已超过 ${formatTokens(m.threshold)}`;
    lines.push(`数据范围：${scope.trim() || '全部数据源合计'}`, `${periodLabel(m.periodType)}累计：${formatTokens(m.observed)}`, `阈值：${formatTokens(m.threshold)}`, `超出：${formatTokens(String(Math.round(over(m.observed, m.threshold))))}`);
  }
  lines.push(`数据更新时间：${formatInTz(m.dataAsOf, m.timezone)}（${m.timezone}）`, `自动采集周期：每 ${m.intervalHours} 小时`);
  if (m.incomplete.length > 0) {
    lines.push('', '注意：以下来源尚未更新，当前数据不完整，实际用量可能更高：');
    for (const s of m.incomplete) {
      const at = s.lastSuccessAt ? formatInTz(new Date(s.lastSuccessAt), m.timezone) : '从未成功';
      lines.push(`  - ${s.server} ${s.dataDir}（最近成功采集：${at}）`);
    }
  }
  lines.push('', '费用为基于 ccusage 的估算费用，不代表实际扣费或官方剩余额度。', '', `查看详情：${m.baseUrl}/users/${m.userId}`);
  return { subject, text: lines.join('\n') };
}

export interface FailureAlertMail {
  serverName: string;
  host: string;
  dataDir: string;
  userName: string;
  consecutiveFailures: number;
  errorCode: string;
  errorMessage: string;
  lastSuccessAt: Date | null;
  timezone: string;
  baseUrl: string;
}

export function renderFailureAlert(m: FailureAlertMail): { subject: string; text: string } {
  return {
    subject: `[采集异常] ${m.serverName} 已连续 ${m.consecutiveFailures} 轮采集失败`,
    text: [
      `服务器：${m.serverName}（${m.host}）`,
      `采集目标：${m.dataDir}（用户 ${m.userName}）`,
      `连续失败轮数：${m.consecutiveFailures}`,
      `错误：${m.errorCode} ${m.errorMessage}`,
      `最近成功采集：${m.lastSuccessAt ? `${formatInTz(m.lastSuccessAt, m.timezone)}（${m.timezone}）` : '从未成功'}`,
      '',
      '已入库的历史统计会保留并标记为数据过期；恢复连接后将自动补采。',
      '',
      `查看详情：${m.baseUrl}/servers`,
    ].join('\n'),
  };
}

export interface LimitAlertMail {
  providerLabel: string; accountLabel?: string | null; servers?: string[]; plan: string | null; windowLabel: string; usedPercent: number; thresholdRemaining: number;
  resetsAt: Date | null; others: Array<{ label: string; usedPercent: number | null; resetsAt: Date | null }>;
  fetchedAt: Date; serverName: string | null; timezone: string; baseUrl: string;
}

export function renderLimitAlert(m: LimitAlertMail): { subject: string; text: string } {
  const remaining = Math.round((100 - m.usedPercent) * 10) / 10;
  const when = (d: Date | null) => (d ? `${formatInTz(d, m.timezone)}（${m.timezone}）` : '未知');
  const lines = [
    `账号：${m.providerLabel}${m.accountLabel ? ` ${m.accountLabel}` : ''}${m.plan ? `（${m.plan}）` : ''}`,
    ...(m.servers?.length ? [`使用该账号的服务器：${m.servers.join('、')}`] : []),
    `额度窗口：${m.windowLabel}`,
    `已用：${m.usedPercent}%`,
    `剩余：${remaining}%（低于提醒线 ${m.thresholdRemaining}%）`,
    `刷新时间：${when(m.resetsAt)}`,
  ];
  if (m.others.length > 0) {
    lines.push('', '该账号的其他额度窗口：');
    for (const o of m.others) lines.push(`  - ${o.label}：已用 ${o.usedPercent ?? '未知'}%，刷新时间 ${when(o.resetsAt)}`);
  }
  lines.push('', `数据查询于：${when(m.fetchedAt)}${m.serverName ? `，经 ${m.serverName}` : ''}`, '额度用尽后，使用该账号的所有服务器都会受影响。同一窗口在本次刷新周期内不会重复提醒。', '', `查看详情：${m.baseUrl}/`);
  return { subject: `[额度提醒] ${m.providerLabel}${m.accountLabel ? `（${m.accountLabel}）` : ''} ${m.windowLabel}额度仅剩 ${remaining}%（已用 ${m.usedPercent}%）`, text: lines.join('\n') };
}
