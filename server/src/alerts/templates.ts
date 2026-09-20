import { formatUsd, fromMicros, toMicros } from '../util/money.js';
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
  /** 周期已经结束（跨日 / 跨月或补采时评估的过去周期）：文案写明具体日期或月份，而不是“当日”“本月” */
  periodEnded?: boolean;
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
/** 进行中的周期说“当日 / 本月”；已结束的周期写明是哪一天、哪个月（补采时可能是好几天前） */
function periodLabel(m: Pick<UsageAlertMail, 'periodType' | 'periodKey' | 'periodEnded'>): string {
  if (!m.periodEnded) return m.periodType === 'daily' ? '当日' : '本月';
  if (m.periodType === 'daily') return m.periodKey;
  const [year, month] = m.periodKey.split('-');
  return `${year} 年 ${Number(month)} 月`;
}
// 金额与比例一律用定点整数运算：浮点下 1.15 / 1 * 100 会得到 114.99…，向下取整就成了 114%
const overMicros = (observed: string, threshold: string) => { const d = toMicros(observed) - toMicros(threshold); return d > 0n ? d : 0n; };

/** 预算使用率（向下取整的百分数）。 */
export function budgetPercent(observed: string, budget: string | null): number {
  if (budget === null) return 0;
  const b = toMicros(budget);
  return b > 0n ? Number((toMicros(observed) * 100n) / b) : 0;
}

/**
 * 邮件里出现的外部字符串（远端脚本的回报、远端用户可编辑的文件内容、远端命令的错误输出）：
 * 去掉控制字符与换行并截断，避免借此伪造邮件标题或正文里的其他行。
 */
export function oneLine(value: string, max: number): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function renderUsageAlert(m: UsageAlertMail): { subject: string; text: string } {
  const lines = [`用户：${m.userName}`, `统计周期：${m.periodKey}${m.periodEnded ? '（已结束）' : ''}`, `触发规则：${m.ruleName}`];
  let subject: string;
  const scope = m.source ? ` ${SOURCE_INFO[m.source]?.label ?? m.source} ` : '';
  const period = periodLabel(m);
  const gap = m.periodEnded && m.periodType === 'daily' ? ' ' : ''; // 日期后面接中文要空一格
  if (m.metric === 'budget_pct') {
    subject = `[用量提醒] ${m.userName}${m.periodEnded ? ` ${period}` : period}预算已达到 ${Number(m.tier)}%`;
    lines.push(`${period}估算费用：${formatUsd(m.observed)}`, `月度预算：${formatUsd(m.budget)}`, `预算使用率：${budgetPercent(m.observed, m.budget)}%`);
  } else if (m.metric === 'cost') {
    subject = `[用量提醒] ${m.userName} ${period}${scope || gap}估算费用 ${formatUsd(m.observed)}，已超过 ${formatUsd(m.threshold)}`;
    lines.push(`数据范围：${scope.trim() || '全部数据源合计'}`, `${period}${gap}估算费用：${formatUsd(m.observed)}`, `阈值：${formatUsd(m.threshold)}`, `超出：${formatUsd(fromMicros(overMicros(m.observed, m.threshold)))}`);
  } else {
    subject = `[用量提醒] ${m.userName} ${period}${scope} Token 用量 ${formatTokens(m.observed)}，已超过 ${formatTokens(m.threshold)}`;
    lines.push(`数据范围：${scope.trim() || '全部数据源合计'}`, `${period}${gap}累计：${formatTokens(m.observed)}`, `阈值：${formatTokens(m.threshold)}`, `超出：${formatTokens(String(overMicros(m.observed, m.threshold) / 1_000_000n))}`);
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
      `错误：${oneLine(m.errorCode, 64)} ${oneLine(m.errorMessage, 500)}`,
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

/** 账号标识、套餐名、窗口名都来自被采集服务器（调用方应已按白名单整理过）；这里再兜底一次，保证它们各自只占一行、长度有限 */
export function renderLimitAlert(input: LimitAlertMail): { subject: string; text: string } {
  const m: LimitAlertMail = {
    ...input,
    accountLabel: input.accountLabel ? oneLine(input.accountLabel, 120) || null : null,
    plan: input.plan ? oneLine(input.plan, 40) || null : null,
    windowLabel: oneLine(input.windowLabel, 32),
    servers: input.servers?.map((name) => oneLine(name, 80)),
    others: input.others.map((o) => ({ ...o, label: oneLine(o.label, 32) })),
    serverName: input.serverName ? oneLine(input.serverName, 80) : null,
  };
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
