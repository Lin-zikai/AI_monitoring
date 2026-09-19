import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { periodsToEvaluate } from '../src/alerts/evaluate.js';
import { claudeCodeAdapter, CollectError, parseEnvelope } from '../src/collect/adapter.js';
import { buildCollectCommand } from '../src/collect/command.js';
import { computeRange } from '../src/collect/runner.js';
import { sanitizeError } from '../src/logger.js';
import { seal, unseal } from '../src/security/crypto.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';
import { isSafeAbsolutePath, isValidCollectCommand, isValidHost } from '../src/security/validate.js';
import { DEFAULT_GENERAL } from '../src/settings.js';
import { costToFixed, fromMicros, toMicros } from '../src/util/money.js';
import { addDays, dateInTz, latestSlot, monthRange, nextSlot, prevMonth, zonedHourToUtc } from '../src/util/time.js';
import { at, report } from './helpers.js';

const req = { source: 'claude-code', dir: '/home/zhangsan/.claude', since: '2026-09-17', until: '2026-09-19', timezone: 'Asia/Shanghai' };

describe('时间与调度时点', () => {
  it('按统计时区取自然日，跨 UTC 日界', () => {
    expect(dateInTz(new Date('2026-09-18T16:30:00Z'), 'Asia/Shanghai')).toBe('2026-09-19');
    expect(dateInTz(new Date('2026-09-18T15:59:00Z'), 'Asia/Shanghai')).toBe('2026-09-18');
  });

  it('每 2 小时一个时点：00:00、02:00、04:00……', () => {
    expect(latestSlot(at('2026-09-19 13:47'), 'Asia/Shanghai', 2)).toEqual(at('2026-09-19 12:00'));
    expect(nextSlot(at('2026-09-19 13:47'), 'Asia/Shanghai', 2)).toEqual(at('2026-09-19 14:00'));
    expect(latestSlot(at('2026-09-19 00:00'), 'Asia/Shanghai', 2)).toEqual(at('2026-09-19 00:00'));
    expect(nextSlot(at('2026-09-19 23:10'), 'Asia/Shanghai', 2)).toEqual(at('2026-09-20 00:00'));
  });

  it('夏令时时区的本地整点换算', () => {
    expect(zonedHourToUtc('2026-07-01', 2, 'America/New_York').toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(zonedHourToUtc('2026-01-15', 2, 'America/New_York').toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });

  it('日期与月份运算', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthRange('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(prevMonth('2026-01')).toBe('2025-12');
  });
});

describe('定点费用', () => {
  it('字符串与微单位互转不丢精度', () => {
    expect(toMicros('420.5')).toBe(420_500_000n);
    expect(fromMicros(toMicros('0.000001'))).toBe('0.000001');
    expect(toMicros('0.1') + toMicros('0.2')).toBe(toMicros('0.3'));
  });

  it('缺失费用为 null（未知），-0 归一为 0', () => {
    expect(costToFixed(undefined)).toBeNull();
    expect(costToFixed(-0)).toBe('0.000000');
    expect(costToFixed(1.08642875)).toBe('1.086429');
  });
});

describe('采集命令构造', () => {
  it('生成受限命令', () => {
    expect(buildCollectCommand('ccusage-collect', req)).toBe('ccusage-collect --source claude-code --dir /home/zhangsan/.claude --since 20260917 --until 20260919 --timezone Asia/Shanghai');
  });

  it.each([
    ['/home/u/.claude; rm -rf /'], ['/home/u/$(id)'], ['/home/u/a b'], ['/home/../etc'], ['relative/path'], ['/home/u/`id`'], ["/home/u/'x'"], ['/home/u/x\ny'],
  ])('拒绝可注入的目录 %j', (dir) => {
    expect(() => buildCollectCommand('ccusage-collect', { ...req, dir })).toThrow(CollectError);
    expect(isSafeAbsolutePath(dir)).toBe(false);
  });

  it('拒绝不合法的命令名、时区与日期', () => {
    expect(() => buildCollectCommand('ccusage-collect && id', req)).toThrow(CollectError);
    expect(() => buildCollectCommand('ccusage-collect', { ...req, timezone: 'Asia/Shanghai;id' })).toThrow(CollectError);
    expect(() => buildCollectCommand('ccusage-collect', { ...req, since: '2026-09-20' })).toThrow(CollectError);
    expect(isValidCollectCommand('/usr/local/bin/ccusage-collect')).toBe(true);
    expect(isValidHost('10.0.0.8')).toBe(true);
    expect(isValidHost('host name')).toBe(false);
    expect(isValidHost('-oProxyCommand=x')).toBe(false);
  });
});

describe('Claude Code 适配器', () => {
  it('解析 ccusage@20.0.23 的真实输出样本', () => {
    const sample = JSON.parse(readFileSync(new URL('./fixtures/ccusage-20.0.23-claude-daily.json', import.meta.url), 'utf8'));
    const rows = claudeCodeAdapter.parse(sample);
    expect(rows.length).toBeGreaterThan(0);
    const dayTotal = rows.filter((r) => r.date === sample.daily[0].date).reduce((a, r) => a + (r.totalTokens ?? 0), 0);
    expect(dayTotal).toBe(sample.daily[0].totalTokens);
    expect(rows[0]!.costUsd).toMatch(/^\d+\.\d{6}$/);
  });

  it('缺失字段保留为 null，不当作零', () => {
    const rows = claudeCodeAdapter.parse({ daily: [{ date: '2026-09-19', modelBreakdowns: [{ modelName: 'm', inputTokens: 5, outputTokens: 7 }] }] });
    expect(rows[0]).toMatchObject({ inputTokens: 5, cacheReadTokens: null, totalTokens: null, costUsd: null });
  });

  it('分模型合计与当日总量不一致时拒绝入库', () => {
    const bad = report({ '2026-09-19': [{ model: 'm', input: 10 }] }) as { daily: Array<{ totalTokens: number }> };
    bad.daily[0]!.totalTokens = 999;
    expect(() => claudeCodeAdapter.parse(bad)).toThrow(/不一致/);
  });

  it('结构不符时报 PARSE_FAILED', () => {
    expect(() => claudeCodeAdapter.parse({ days: [] })).toThrow(CollectError);
  });
});

describe('采集信封', () => {
  const ok = { schema: 1, status: 'ok', ...req, report: { daily: [] } };

  it('区分“确实没有用量”与目录缺失', () => {
    expect(parseEnvelope(JSON.stringify(ok), req).report).toEqual({ daily: [] });
    expect(() => parseEnvelope(JSON.stringify({ schema: 1, status: 'error', code: 'DIR_MISSING', message: '数据目录不存在' }), req))
      .toThrowError(expect.objectContaining({ code: 'DIR_MISSING', retryable: false }));
  });

  it('回显与请求不一致时拒绝', () => {
    expect(() => parseEnvelope(JSON.stringify({ ...ok, dir: '/home/other/.claude' }), req)).toThrowError(expect.objectContaining({ code: 'ECHO_MISMATCH' }));
  });

  it('非 JSON 输出可重试', () => {
    expect(() => parseEnvelope('Welcome to Ubuntu\n{', req)).toThrowError(expect.objectContaining({ code: 'BAD_OUTPUT', retryable: true }));
  });
});

describe('采集范围', () => {
  const base = { reconcile: false, source_start_date: null, source_end_date: null };
  const now = at('2026-09-19 14:00');

  it('首次接入回填历史；常规轮询只重算最近几天', () => {
    expect(computeRange({ ...base, initialized_at: null, last_success_at: null }, DEFAULT_GENERAL, now)).toEqual({ since: '2026-06-21', until: '2026-09-19' });
    expect(computeRange({ ...base, initialized_at: now, last_success_at: at('2026-09-19 12:00') }, DEFAULT_GENERAL, now)).toEqual({ since: '2026-09-16', until: '2026-09-19' });
  });

  it('断连恢复后一次覆盖整个缺口；对账批次用更长范围', () => {
    expect(computeRange({ ...base, initialized_at: now, last_success_at: at('2026-09-05 10:00') }, DEFAULT_GENERAL, now)!.since).toBe('2026-09-04');
    expect(computeRange({ ...base, reconcile: true, initialized_at: now, last_success_at: at('2026-09-19 12:00') }, DEFAULT_GENERAL, now)!.since).toBe('2026-08-15');
  });

  it('来源切换边界裁剪范围；边界之外不再采集', () => {
    expect(computeRange({ ...base, source_start_date: '2026-09-18', initialized_at: null, last_success_at: null }, DEFAULT_GENERAL, now)).toEqual({ since: '2026-09-18', until: '2026-09-19' });
    expect(computeRange({ ...base, source_end_date: '2026-08-31', initialized_at: now, last_success_at: now }, DEFAULT_GENERAL, now)).toBeNull();
  });
});

describe('告警评估周期', () => {
  it('午夜后的采集同时评估刚结束的一日', () => {
    const keys = periodsToEvaluate('2026-09-20', '2026-09-17', true).map((p) => p.key);
    expect(keys).toEqual(['2026-09-20', '2026-09', '2026-09-19']);
  });

  it('跨月时同时评估上一月；回填时只评估当前周期', () => {
    expect(periodsToEvaluate('2026-10-01', '2026-09-28', true).map((p) => p.key)).toEqual(['2026-10-01', '2026-10', '2026-09-30', '2026-09']);
    expect(periodsToEvaluate('2026-10-01', '2026-07-01', false).map((p) => p.key)).toEqual(['2026-10-01', '2026-10']);
  });
});

describe('凭据与密码', () => {
  it('AES-GCM 加解密，且密文绑定到具体凭据', () => {
    const key = randomBytes(32);
    const sealed = seal(key, 'secret', 'credential:a');
    expect(unseal(key, sealed, 'credential:a')).toBe('secret');
    expect(() => unseal(key, sealed, 'credential:b')).toThrow();
    expect(() => unseal(randomBytes(32), sealed, 'credential:a')).toThrow();
  });

  it('scrypt 密码哈希', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('错误信息中的私钥会被脱敏', () => {
    const msg = sanitizeError(new Error('bad key -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- end'));
    expect(msg).not.toContain('abc');
  });
});
