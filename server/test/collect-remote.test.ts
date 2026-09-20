import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 远端采集脚本（remote/ccusage-collect.mjs）：纯函数直接 import 测；权限、超时、开关等行为通过真实执行脚本来测（ccusage 用替身）。

const COLLECTOR = fileURLToPath(new URL('../../remote/ccusage-collect.mjs', import.meta.url));

interface Envelope { status: string; code?: string; message?: string; accountKey?: string | null; accountLabel?: string | null; [k: string]: unknown }

let work: string;
let home: string;
let dataDir: string;

function runCollector(args: string[], config: object, env: Record<string, string> = {}): Promise<{ envelope: Envelope; ms: number }> {
  const configPath = join(work, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [COLLECTOR, ...args], { env: { PATH: process.env.PATH, HOME: home, CCUSAGE_COLLECT_CONFIG: configPath, ...env }, timeout: 60_000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ envelope: JSON.parse(stdout) as Envelope, ms: Date.now() - started });
    });
  });
}

const usageArgs = (dir: string) => ['--source', 'claude-code', '--dir', dir, '--since', '20260917', '--until', '20260919', '--timezone', 'Asia/Shanghai'];

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'usage-monitor-remote-'));
  home = join(work, 'home', 'zhangsan');
  dataDir = join(home, '.claude');
  mkdirSync(join(dataDir, 'projects', 'demo'), { recursive: true });
  writeFileSync(join(dataDir, 'projects', 'demo', 's.jsonl'), '{}\n');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'team@example.com' } }));
});

afterAll(() => {
  try { chmodSync(join(work, 'locked'), 0o755); } catch { /* 没建过 */ }
  rmSync(work, { recursive: true, force: true });
});

describe('额度接口应答的解析（纯函数）', () => {
  it('Codex：两个窗口归到同一类时 key 仍然唯一，显示名按时长区分', async () => {
    const { codexWindows, claudeWindows } = await import(/* @vite-ignore */ COLLECTOR) as {
      codexWindows(json: unknown, now?: number): Array<{ key: string; label: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: string | null }>;
      claudeWindows(json: unknown): Array<{ key: string; label: string; usedPercent: number | null }>;
    };
    const now = Date.parse('2026-09-19T06:00:00Z');
    expect(codexWindows({ rate_limit: { primary_window: { used_percent: 12.34, limit_window_seconds: 18000, reset_after_seconds: 600 }, secondary_window: { used_percent: 91, limit_window_seconds: 604800, reset_at: 1790000000 } } }, now)).toEqual([
      { key: 'five_hour', label: '5 小时', windowMinutes: 300, usedPercent: 12.3, resetsAt: '2026-09-19T06:10:00.000Z' },
      { key: 'seven_day', label: '每周', windowMinutes: 10080, usedPercent: 91, resetsAt: new Date(1790000000 * 1000).toISOString() },
    ]);
    // 1 天 + 7 天：旧版本里两个都叫 seven_day，提醒的去重键会相互覆盖
    const long = codexWindows({ rate_limits: { primary: { used_percent: 50, window_minutes: 1440 }, secondary: { used_percent: 60, window_minutes: 10080 } } }, now);
    expect(long.map((w) => [w.key, w.label])).toEqual([['seven_day', '1 天'], ['seven_day_10080m', '每周']]);
    const sameLength = codexWindows({ rate_limit: { primary: { used_percent: 1, window_minutes: 300 }, secondary: { used_percent: 2, window_minutes: 300 } } }, now);
    expect(sameLength.map((w) => [w.key, w.label])).toEqual([['five_hour', '5 小时'], ['five_hour_300m', '5 小时 · 2']]);
    expect(codexWindows({ rate_limit: { primary: null, secondary: { used_percent: 250 } } }, now)).toEqual([{ key: 'seven_day', label: '每周', windowMinutes: null, usedPercent: 100, resetsAt: null }]);
    expect(codexWindows({}, now)).toEqual([]);

    expect(claudeWindows({ five_hour: { utilization: 41.26, resets_at: '2026-09-19T10:00:00Z' }, seven_day_opus: { utilization: 3 } }).map((w) => [w.key, w.label, w.usedPercent]))
      .toEqual([['five_hour', '5 小时', 41.3], ['seven_day_opus', '每周 · Opus', 3]]);
  });

  it('import 脚本不会触发一次采集（只有直接执行时才运行 main）', async () => {
    const mod = await import(/* @vite-ignore */ COLLECTOR) as { dirAllowed(dir: string, patterns: unknown): boolean; probePath(p: string): string };
    expect(mod.dirAllowed('/home/zhangsan/.claude', ['/home/*/.claude'])).toBe(true);
    expect(mod.dirAllowed('/home/zhangsan/other', ['/home/*/.claude'])).toBe(false);
    expect(mod.dirAllowed('/home/zhangsan/.claude', 'not-an-array')).toBe(false);
    expect(mod.probePath(dataDir)).toBe('dir');
    expect(mod.probePath(join(work, 'nope'))).toBe('missing');
  });
});

describe('采集脚本的行为', () => {
  const ccusage = (body: string) => {
    const file = join(work, `ccusage-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ccusage 20.0.23"; exit 0; fi\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('原型链上的名字不会被当成数据源', async () => {
    const config = { allowedDirs: ['**'], ccusageBin: ccusage('echo "{}"') };
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect((await runCollector(usageArgs(dataDir).map((a) => (a === 'claude-code' ? name : a)), config)).envelope).toMatchObject({ status: 'error', code: 'UNSUPPORTED_SOURCE' });
      expect((await runCollector(['--limits', name, '--dir', dataDir], config)).envelope).toMatchObject({ status: 'error', code: 'UNSUPPORTED_SOURCE' });
    }
  });

  it.skipIf(process.getuid?.() === 0)('没有权限访问的目录报 DIR_UNREADABLE，而不是 DIR_MISSING（否则会被当成“该用户没用过”）', async () => {
    const locked = join(work, 'locked');
    mkdirSync(join(locked, '.claude', 'projects'), { recursive: true });
    const config = { allowedDirs: ['**'], ccusageBin: ccusage('echo \'{"daily":[]}\'') };
    chmodSync(locked, 0o000);
    try {
      expect((await runCollector(usageArgs(join(locked, '.claude')), config)).envelope).toMatchObject({ status: 'error', code: 'DIR_UNREADABLE' });
      expect((await runCollector(['--identity', 'claude-code', '--dir', join(locked, '.claude')], config)).envelope).toMatchObject({ status: 'error', code: 'DIR_UNREADABLE' });
    } finally {
      chmodSync(locked, 0o755);
    }
    // projects/ 本身读不了：同样是权限问题，不是“确实没有用量”
    chmodSync(join(locked, '.claude', 'projects'), 0o000);
    try {
      expect((await runCollector(usageArgs(join(locked, '.claude')), config)).envelope).toMatchObject({ status: 'error', code: 'DIR_UNREADABLE' });
    } finally {
      chmodSync(join(locked, '.claude', 'projects'), 0o755);
    }
    expect((await runCollector(usageArgs(join(work, 'nobody', '.claude')), config)).envelope).toMatchObject({ status: 'error', code: 'DIR_MISSING' });
  });

  it('allowAccountQueries: false 时账号查询返回明确的“未开启”，用量采集不受影响', async () => {
    const config = { allowedDirs: ['**'], ccusageBin: ccusage('echo \'{"daily":[]}\''), allowAccountQueries: false };
    expect((await runCollector(['--identity', 'claude-code', '--dir', dataDir], config)).envelope).toMatchObject({ status: 'error', code: 'ACCOUNT_QUERIES_DISABLED' });
    expect((await runCollector(['--limits', 'claude-code', '--dir', dataDir], config)).envelope).toMatchObject({ status: 'error', code: 'ACCOUNT_QUERIES_DISABLED' });
    expect((await runCollector(usageArgs(dataDir), config)).envelope).toMatchObject({ status: 'ok', report: { daily: [] } });
  });

  it('数据目录同级的 ~/.claude.json 随数据目录一起放行；符号链接指到别处时只有白名单放行了那里才读', async () => {
    const identity = (allowedDirs: string[], dir = dataDir) => runCollector(['--identity', 'claude-code', '--dir', dir], { allowedDirs }).then((r) => r.envelope);
    expect(await identity(['**'])).toMatchObject({ status: 'ok', accountKey: 'uuid-1', accountLabel: 'team@example.com' }); // 平台自动安装的配置
    expect(await identity([join(work, 'home', '*', '.claude')])).toMatchObject({ status: 'ok', accountKey: 'uuid-1' }); // 手工部署：白名单里只有数据目录

    // 同级的 .claude.json 是指向别人文件的符号链接：白名单只放行了自己的那个路径，不跟过去读
    const other = join(work, 'home', 'lisi');
    mkdirSync(join(other, '.claude'), { recursive: true });
    symlinkSync(join(home, '.claude.json'), join(other, '.claude.json'));
    expect(await identity([join(other, '.claude'), join(other, '.claude.json')], join(other, '.claude'))).toMatchObject({ status: 'error', code: 'NO_LOGIN' });
  });

  it('ccusage 超时：报 CCUSAGE_TIMEOUT，并且连同它拉起的子进程一起终止', async () => {
    const pidFile = join(work, 'grandchild.pid');
    // 模拟 npx → node 的两层进程：外层脚本拉起一个长时间运行的子进程再等它
    const config = { allowedDirs: ['**'], ccusageBin: ccusage(`sleep 300 &\necho $! > ${pidFile}\nwait`), timeoutSeconds: 1 };
    const { envelope, ms } = await runCollector(usageArgs(dataDir), config);
    expect(envelope).toMatchObject({ status: 'error', code: 'CCUSAGE_TIMEOUT' });
    expect(ms).toBeLessThan(30_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow(); // 孙进程也已不在
  });

  it('总时限（totalTimeoutSeconds）约束所有步骤之和，保证在平台的 SSH 超时之前给出明确的错误码', async () => {
    const slowVersion = join(work, 'ccusage-slow-version');
    writeFileSync(slowVersion, '#!/bin/sh\nsleep 300\n');
    chmodSync(slowVersion, 0o755);
    const { envelope, ms } = await runCollector(usageArgs(dataDir), { allowedDirs: ['**'], ccusageBin: slowVersion, totalTimeoutSeconds: 20, timeoutSeconds: 100 });
    // 总时限取下限 20 秒，其中为后续步骤预留 30 秒 → --version 这一步立即判超时
    expect(envelope).toMatchObject({ status: 'error', code: 'CCUSAGE_TIMEOUT' });
    expect(ms).toBeLessThan(20_000);
  });
});
