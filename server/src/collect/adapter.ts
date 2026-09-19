import { z } from 'zod';
import { costToFixed, fromMicros, toMicros } from '../util/money.js';

/** 统一统计结构：一行 = 某日某模型。null 表示数据源未提供（未知），不等同于零。 */
export interface UsageRow {
  date: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
}

export interface SourceAdapter {
  source: string;
  parserVersion: string;
  /** 输入 Token 是否已包含缓存 Token；决定合计时能否把各字段直接相加。 */
  inputIncludesCache: boolean;
  parse(report: unknown): UsageRow[];
}

export class CollectError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message);
  }
}

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalTokens = tokenCount.nullish();

// 对照 ccusage@20.0.23 `claude daily --json --breakdown` 的实际输出核对过的字段
const claudeDailyReport = z.object({
  daily: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    inputTokens: optionalTokens,
    outputTokens: optionalTokens,
    cacheCreationTokens: optionalTokens,
    cacheReadTokens: optionalTokens,
    totalTokens: optionalTokens,
    totalCost: z.number().nullish(),
    modelBreakdowns: z.array(z.object({
      modelName: z.string().min(1).max(200),
      inputTokens: optionalTokens,
      outputTokens: optionalTokens,
      cacheCreationTokens: optionalTokens,
      cacheReadTokens: optionalTokens,
      cost: z.number().nullish(),
    })).nullish(),
  })),
});

const sumKnown = (values: Array<number | null>): number | null =>
  values.some((v) => v === null) ? null : (values as number[]).reduce((a, b) => a + b, 0);

export const claudeCodeAdapter: SourceAdapter = {
  source: 'claude-code',
  parserVersion: 'claude-code/1',
  // ccusage 的 Claude 口径：inputTokens 不含缓存读写，总量 = 输入 + 输出 + 缓存写入 + 缓存读取
  inputIncludesCache: false,

  parse(report: unknown): UsageRow[] {
    const parsed = claudeDailyReport.safeParse(report);
    if (!parsed.success) {
      throw new CollectError('PARSE_FAILED', `ccusage 输出结构不符合预期: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    }
    const rows: UsageRow[] = [];
    const seenDates = new Set<string>();
    for (const day of parsed.data.daily) {
      if (seenDates.has(day.date)) throw new CollectError('PARSE_FAILED', `ccusage 输出中日期重复: ${day.date}`);
      seenDates.add(day.date);

      const breakdowns = day.modelBreakdowns ?? [];
      if (breakdowns.length === 0) {
        const parts = [day.inputTokens ?? null, day.outputTokens ?? null, day.cacheCreationTokens ?? null, day.cacheReadTokens ?? null];
        rows.push({
          date: day.date, model: 'unknown',
          inputTokens: parts[0]!, outputTokens: parts[1]!, cacheCreationTokens: parts[2]!, cacheReadTokens: parts[3]!,
          totalTokens: day.totalTokens ?? sumKnown(parts),
          costUsd: costToFixed(day.totalCost),
        });
        continue;
      }

      const models = new Set<string>();
      let modelTotal: number | null = 0;
      for (const b of breakdowns) {
        if (models.has(b.modelName)) throw new CollectError('PARSE_FAILED', `${day.date} 模型重复: ${b.modelName}`);
        models.add(b.modelName);
        const parts = [b.inputTokens ?? null, b.outputTokens ?? null, b.cacheCreationTokens ?? null, b.cacheReadTokens ?? null];
        const total = sumKnown(parts);
        modelTotal = modelTotal === null || total === null ? null : modelTotal + total;
        rows.push({
          date: day.date, model: b.modelName,
          inputTokens: parts[0]!, outputTokens: parts[1]!, cacheCreationTokens: parts[2]!, cacheReadTokens: parts[3]!,
          totalTokens: total,
          costUsd: costToFixed(b.cost),
        });
      }
      // 完整性校验：分模型合计必须与当日总量一致，否则视为不完整结果，不入库
      if (modelTotal !== null && typeof day.totalTokens === 'number' && modelTotal !== day.totalTokens) {
        throw new CollectError('PARSE_FAILED', `${day.date} 分模型合计 ${modelTotal} 与当日总量 ${day.totalTokens} 不一致`);
      }
    }
    return rows;
  },
};

// 对照 ccusage@20.0.23 `codex daily --json` 的实际输出核对过的字段：按模型是对象而非数组，费用只有日级 costUSD
const codexDailyReport = z.object({
  daily: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    totalTokens: optionalTokens,
    costUSD: z.number().nullish(),
    models: z.record(z.string().min(1).max(200), z.object({
      inputTokens: optionalTokens,
      outputTokens: optionalTokens,
      cacheCreationTokens: optionalTokens,
      cacheReadTokens: optionalTokens,
      reasoningOutputTokens: optionalTokens,
      totalTokens: optionalTokens,
    })).nullish(),
    inputTokens: optionalTokens,
    outputTokens: optionalTokens,
    cacheCreationTokens: optionalTokens,
    cacheReadTokens: optionalTokens,
  })),
});

/** 把日级费用按各模型 Token 占比分摊到行上（定点运算，余数归最大的一行），保证各行之和严格等于当日费用。 */
function apportionCost(dayCost: string | null, weights: number[]): Array<string | null> {
  if (dayCost === null) return weights.map(() => null);
  const total = toMicros(dayCost);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 1 || weightSum === 0) return weights.map((_, i) => (i === 0 ? fromMicros(total) : '0.000000'));
  const shares = weights.map((w) => (total * BigInt(w)) / BigInt(weightSum));
  const largest = weights.indexOf(Math.max(...weights));
  shares[largest] = shares[largest]! + (total - shares.reduce((a, b) => a + b, 0n));
  return shares.map(fromMicros);
}

export const codexAdapter: SourceAdapter = {
  source: 'codex',
  parserVersion: 'codex/1',
  // OpenAI 口径下输入 Token 可能已包含缓存命中部分：总量一律采用 ccusage 给出的 totalTokens，不把各字段自行相加
  inputIncludesCache: true,

  parse(report: unknown): UsageRow[] {
    const parsed = codexDailyReport.safeParse(report);
    if (!parsed.success) {
      throw new CollectError('PARSE_FAILED', `ccusage codex 输出结构不符合预期: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    }
    const rows: UsageRow[] = [];
    const seenDates = new Set<string>();
    for (const day of parsed.data.daily) {
      if (seenDates.has(day.date)) throw new CollectError('PARSE_FAILED', `ccusage 输出中日期重复: ${day.date}`);
      seenDates.add(day.date);
      const models = Object.entries(day.models ?? {});
      const dayCost = costToFixed(day.costUSD);
      if (models.length === 0) {
        rows.push({
          date: day.date, model: 'unknown', inputTokens: day.inputTokens ?? null, outputTokens: day.outputTokens ?? null,
          cacheCreationTokens: day.cacheCreationTokens ?? null, cacheReadTokens: day.cacheReadTokens ?? null, totalTokens: day.totalTokens ?? null, costUsd: dayCost,
        });
        continue;
      }
      const costs = apportionCost(dayCost, models.map(([, m]) => m.totalTokens ?? 0));
      let modelTotal: number | null = 0;
      models.forEach(([name, m], i) => {
        modelTotal = modelTotal === null || m.totalTokens == null ? null : modelTotal + m.totalTokens;
        rows.push({
          date: day.date, model: name, inputTokens: m.inputTokens ?? null, outputTokens: m.outputTokens ?? null,
          cacheCreationTokens: m.cacheCreationTokens ?? null, cacheReadTokens: m.cacheReadTokens ?? null, totalTokens: m.totalTokens ?? null, costUsd: costs[i]!,
        });
      });
      if (modelTotal !== null && typeof day.totalTokens === 'number' && modelTotal !== day.totalTokens) {
        throw new CollectError('PARSE_FAILED', `${day.date} 分模型合计 ${modelTotal} 与当日总量 ${day.totalTokens} 不一致`);
      }
    }
    return rows;
  },
};

const adapters = new Map<string, SourceAdapter>([[claudeCodeAdapter.source, claudeCodeAdapter], [codexAdapter.source, codexAdapter]]);

/** 各数据源在用户家目录下的默认数据目录名，以及界面上的显示名 */
export const SOURCE_INFO: Record<string, { label: string; defaultDirName: string }> = {
  'claude-code': { label: 'Claude Code', defaultDirName: '.claude' },
  codex: { label: 'Codex', defaultDirName: '.codex' },
};

export const supportedSources = () => [...adapters.keys()];

export function getAdapter(source: string): SourceAdapter {
  const adapter = adapters.get(source);
  if (!adapter) throw new CollectError('UNSUPPORTED_SOURCE', `不支持的数据源: ${source}`);
  return adapter;
}

/** 远端采集脚本（remote/ccusage-collect.mjs）的输出信封。 */
export const collectEnvelope = z.object({
  schema: z.literal(1),
  status: z.enum(['ok', 'error']),
  code: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
  collectorVersion: z.string().max(32).optional(),
  ccusageVersion: z.string().max(32).optional(),
  source: z.string().optional(),
  dir: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  timezone: z.string().optional(),
  costMode: z.string().max(32).optional(),
  offline: z.boolean().optional(),
  logFiles: z.number().int().nonnegative().optional(),
  report: z.unknown().optional(),
});
export type CollectEnvelope = z.infer<typeof collectEnvelope>;

// 远端错误码中值得退避重试的（瞬时故障）；目录缺失、权限、参数类错误重试无意义
const RETRYABLE_REMOTE_CODES = new Set(['CCUSAGE_FAILED', 'CCUSAGE_TIMEOUT']);

export interface CollectRequest { source: string; dir: string; since: string; until: string; timezone: string }

export function parseEnvelope(stdout: string, req: CollectRequest): CollectEnvelope & { status: 'ok' } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new CollectError('BAD_OUTPUT', '远端输出不是有效 JSON（可能未安装采集脚本，或登录 shell 输出了额外内容）', true);
  }
  const env = collectEnvelope.safeParse(json);
  if (!env.success) throw new CollectError('BAD_OUTPUT', '远端输出缺少采集信封字段');
  const e = env.data;
  if (e.status === 'error') {
    const code = e.code ?? 'REMOTE_ERROR';
    throw new CollectError(code, e.message ?? '远端采集失败', RETRYABLE_REMOTE_CODES.has(code));
  }
  // 回显必须与请求一致，防止错位的结果被入库到别的目标/范围
  if (e.source !== req.source || e.dir !== req.dir || e.since !== req.since || e.until !== req.until || e.timezone !== req.timezone) {
    throw new CollectError('ECHO_MISMATCH', '远端回显的采集参数与请求不一致');
  }
  return e as CollectEnvelope & { status: 'ok' };
}
