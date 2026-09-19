import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCodeAdapter, codexAdapter, parseEnvelope } from '../src/collect/adapter.js';
import { buildCollectCommand } from '../src/collect/command.js';
import { installCollector } from '../src/collect/install.js';
import { hostKeyFingerprint, scanHostKey, sshExecutor, type SshTarget } from '../src/ssh/client.js';
import { report } from './helpers.js';

// 端到端：真实的 SSH 协议 + 真实的远端采集脚本（remote/ccusage-collect.mjs），仅把 ccusage 换成输出固定 JSON 的替身。
// SSH 服务端以 forced command 方式运行：无论客户端发什么命令，都只执行采集脚本，参数经 SSH_ORIGINAL_COMMAND 传入。

const COLLECTOR = fileURLToPath(new URL('../../remote/ccusage-collect.mjs', import.meta.url));
const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
const clientKey = ssh2.utils.generateKeyPairSync('ed25519');
const clientPublic = ssh2.utils.parseKey(clientKey.public) as ssh2.ParsedKey;

let work: string;
let server: ssh2.Server;
let target: SshTarget;
let dataDir: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'usage-monitor-ssh-'));
  dataDir = join(work, 'home', 'zhangsan', '.claude');
  mkdirSync(join(dataDir, 'projects', 'demo'), { recursive: true });
  writeFileSync(join(dataDir, 'projects', 'demo', 'session.jsonl'), '{}\n');
  mkdirSync(join(work, 'home', 'empty', '.claude'), { recursive: true });

  const fakeCcusage = join(work, 'ccusage');
  const sample = JSON.stringify(report({ '2026-09-19': [{ model: 'claude-opus-5', input: 1200, output: 300, cost: 0.42 }] }));
  writeFileSync(fakeCcusage, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ccusage 20.0.23"; exit 0; fi\ncat <<'JSON'\n${sample}\nJSON\n`);
  chmodSync(fakeCcusage, 0o755);
  const configPath = join(work, 'config.json');
  writeFileSync(configPath, JSON.stringify({ allowedDirs: [join(work, 'home', '*', '.claude')], ccusageBin: fakeCcusage, expectedCcusageVersion: '20.0.23' }));

  server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      const ok = ctx.method === 'publickey' && ctx.key.algo === clientPublic.type && ctx.key.data.equals(clientPublic.getPublicSSH())
        && (!ctx.signature || clientPublic.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true);
      ok ? ctx.accept() : ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          execFile(process.execPath, [COLLECTOR], { env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: info.command, CCUSAGE_COLLECT_CONFIG: configPath } }, (err, stdout, stderr) => {
            stream.stderr.write(stderr);
            stream.write(stdout);
            stream.exit(err ? 1 : 0);
            stream.end();
          });
        });
      });
    });
    client.on('error', () => undefined);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const parsedHost = ssh2.utils.parseKey(hostKey.private) as ssh2.ParsedKey;
  target = { host: '127.0.0.1', port, username: 'collector', privateKey: clientKey.private, expectedHostFingerprint: hostKeyFingerprint(parsedHost.getPublicSSH()) };
});

afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

const request = (dir: string) => ({ source: 'claude-code', dir, since: '2026-09-17', until: '2026-09-19', timezone: 'Asia/Shanghai' });

describe('SSH 采集链路', () => {
  it('经 SSH 调用受限采集脚本并解析出统计行', async () => {
    const req = request(dataDir);
    const result = await sshExecutor.exec(target, buildCollectCommand('ccusage-collect', req), 20_000);
    const envelope = parseEnvelope(result.stdout, req);
    expect(envelope).toMatchObject({ ccusageVersion: '20.0.23', logFiles: 1, offline: true });
    expect(claudeCodeAdapter.parse(envelope.report)).toEqual([
      { date: '2026-09-19', model: 'claude-opus-5', inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 1500, costUsd: '0.420000' },
    ]);
  });

  it('空目录是成功的空结果；目录缺失与白名单外目录是明确的错误', async () => {
    const empty = request(join(work, 'home', 'empty', '.claude'));
    const ok = parseEnvelope((await sshExecutor.exec(target, buildCollectCommand('ccusage-collect', empty), 20_000)).stdout, empty);
    expect(ok.report).toEqual({ daily: [] });

    const missing = request(join(work, 'home', 'nobody', '.claude'));
    const missingOut = (await sshExecutor.exec(target, buildCollectCommand('ccusage-collect', missing), 20_000)).stdout;
    expect(() => parseEnvelope(missingOut, missing)).toThrowError(expect.objectContaining({ code: 'DIR_MISSING' }));

    const outside = request('/etc');
    const outsideOut = (await sshExecutor.exec(target, buildCollectCommand('ccusage-collect', outside), 20_000)).stdout;
    expect(() => parseEnvelope(outsideOut, outside)).toThrowError(expect.objectContaining({ code: 'DIR_NOT_ALLOWED' }));
  });

  it('远端脚本拒绝白名单之外的参数', async () => {
    const out = (await sshExecutor.exec(target, 'ccusage-collect --source claude-code --exec /bin/sh', 20_000)).stdout;
    expect(JSON.parse(out)).toMatchObject({ status: 'error', code: 'BAD_ARGS' });
  });

  it('主机指纹不匹配时拒绝连接；未确认指纹时不连接', async () => {
    await expect(sshExecutor.exec({ ...target, expectedHostFingerprint: `SHA256:${'B'.repeat(43)}` }, 'ccusage-collect', 10_000))
      .rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH', retryable: false });
    await expect(sshExecutor.exec({ ...target, expectedHostFingerprint: null }, 'ccusage-collect', 10_000)).rejects.toMatchObject({ code: 'HOST_KEY_UNVERIFIED' });
  });

  it('私钥不被接受时报认证失败', async () => {
    const other = ssh2.utils.generateKeyPairSync('ed25519');
    await expect(sshExecutor.exec({ ...target, privateKey: other.private }, 'ccusage-collect', 10_000)).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false });
  });

  it('扫描主机指纹供管理员核对', async () => {
    expect(await scanHostKey(target.host, target.port)).toBe(target.expectedHostFingerprint);
  });
});

describe('自动安装采集组件', () => {
  let shellServer: ssh2.Server;
  let shellTarget: SshTarget;
  let home: string;
  let fakePkg: string;
  const installDir = () => join(home, '.local', 'share', 'usage-monitor');

  /** 假 ccusage：version 与是否支持 `claude daily --breakdown` 可控 */
  function writeFakeCcusage(file: string, version: string, modern = true): void {
    const sample = JSON.stringify(report({ '2026-09-19': [{ model: 'claude-opus-5', input: 10, cost: 0.01 }] }));
    const codexSample = readFileSync(new URL('./fixtures/ccusage-20.0.23-codex-daily.json', import.meta.url), 'utf8');
    writeFileSync(file, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('ccusage ${version}');
else if (a.includes('--help')) console.log(${modern} && a[0] === 'claude' ? 'OPTIONS: -b, --breakdown' : 'unknown command');
else console.log(a[0] === 'codex' ? ${JSON.stringify(codexSample)} : ${JSON.stringify(sample)});
`);
    chmodSync(file, 0o755);
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'usage-monitor-home-'));
    mkdirSync(join(home, '.claude', 'projects', 'demo'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'demo', 's.jsonl'), '{}\n');
    // 本地假 ccusage 包：安装过程不依赖外网
    fakePkg = join(home, 'fake-ccusage');
    mkdirSync(fakePkg);
    writeFileSync(join(fakePkg, 'package.json'), JSON.stringify({ name: 'ccusage', version: '20.0.23', bin: { ccusage: 'cli.js' } }));
    writeFakeCcusage(join(fakePkg, 'cli.js'), '20.0.23');

    // 一个有普通 shell 权限的账户：按客户端给的命令执行（含 `sh -s` + 标准输入）。PATH 里没有 ccusage。
    shellServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (ctx) => (ctx.method === 'publickey' && ctx.key.data.equals(clientPublic.getPublicSSH()) ? ctx.accept() : ctx.reject(['publickey'])));
      client.on('ready', () => client.on('session', (accept) => accept().on('exec', (acceptExec, _r, info) => {
        const stream = acceptExec();
        const child = spawn('sh', ['-c', info.command], { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home } });
        stream.pipe(child.stdin);
        child.stdout.on('data', (c) => stream.write(c));
        child.stderr.on('data', (c) => stream.stderr.write(c));
        child.on('close', (code) => { stream.exit(code ?? 1); stream.end(); });
      })));
      client.on('error', () => undefined);
    });
    const port = await new Promise<number>((resolve) => shellServer.listen(0, '127.0.0.1', () => resolve((shellServer.address() as { port: number }).port)));
    shellTarget = { ...target, port };
  });

  afterAll(() => {
    shellServer.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function collectWith(collectCommand: string) {
    const req = request(join(home, '.claude'));
    const out = await sshExecutor.exec(shellTarget, buildCollectCommand(collectCommand, req), 60_000);
    return parseEnvelope(out.stdout, req);
  }

  it('远端没有 ccusage 时安装固定版本并锁定版本号；重复安装幂等', async () => {
    const result = await installCollector(sshExecutor, shellTarget, { mode: 'auto', ccusageSpec: fakePkg, timeoutMs: 120_000 });
    expect(result).toMatchObject({ collectCommand: `${installDir()}/ccusage-collect`, ccusageMode: 'installed', ccusageVersion: '20.0.23', versionMismatch: false, defaultDataDir: `${home}/.claude` });
    expect(JSON.parse(readFileSync(join(installDir(), 'config.json'), 'utf8')).expectedCcusageVersion).toBe('20.0.23');

    const envelope = await collectWith(result.collectCommand);
    expect(envelope).toMatchObject({ collectorVersion: '1.3.0', ccusageVersion: '20.0.23' });
    expect(claudeCodeAdapter.parse(envelope.report)[0]).toMatchObject({ model: 'claude-opus-5', totalTokens: 10 });
    expect((await installCollector(sshExecutor, shellTarget, { mode: 'pinned', ccusageSpec: fakePkg, timeoutMs: 120_000 })).collectCommand).toBe(result.collectCommand);
  }, 240_000);

  it('远端已装过 ccusage 时直接复用、不重新安装，也不锁版本（用户自行升级后照常采集）', async () => {
    rmSync(installDir(), { recursive: true, force: true });
    mkdirSync(join(home, '.npm-global', 'bin'), { recursive: true });
    const existing = join(home, '.npm-global', 'bin', 'ccusage');
    writeFakeCcusage(existing, '20.1.0');

    const result = await installCollector(sshExecutor, shellTarget, { mode: 'auto', ccusageSpec: '/nonexistent/should-not-be-installed', timeoutMs: 120_000 });
    expect(result).toMatchObject({ ccusageMode: 'reused', ccusagePath: existing, ccusageVersion: '20.1.0', versionMismatch: true });
    expect(existsSync(join(installDir(), 'node_modules'))).toBe(false);
    expect(JSON.parse(readFileSync(join(installDir(), 'config.json'), 'utf8'))).toMatchObject({ ccusageBin: existing, expectedCcusageVersion: null });

    writeFakeCcusage(existing, '20.2.0'); // 用户自己升级了 ccusage
    expect((await collectWith(result.collectCommand)).ccusageVersion).toBe('20.2.0');
  }, 120_000);

  it('已装的 ccusage 过旧（没有 claude daily --breakdown）时不擅自覆盖，明确报告不兼容', async () => {
    writeFakeCcusage(join(home, '.npm-global', 'bin', 'ccusage'), '15.3.1', false);
    await expect(installCollector(sshExecutor, shellTarget, { mode: 'auto', timeoutMs: 120_000 })).rejects.toMatchObject({ code: 'CCUSAGE_INCOMPATIBLE', message: expect.stringContaining('15.3.1') });
  }, 120_000);

  it('默认模式：经 npx --yes 始终使用最新版；Claude Code 与 Codex 都能采集', async () => {
    const existing = join(home, '.npm-global', 'bin', 'ccusage');
    writeFakeCcusage(existing, '20.1.0');
    const result = await installCollector(sshExecutor, shellTarget, { latestSpec: fakePkg, timeoutMs: 180_000 });
    expect(result).toMatchObject({ ccusageMode: 'latest', ccusageVersion: '20.0.23' });
    const configPath = join(installDir(), 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.ccusageCommand.slice(1)).toEqual(['--yes', fakePkg]);
    expect(config).toMatchObject({ expectedCcusageVersion: null, ccusageBin: existing }); // 已装的那份留作后备
    expect((await collectWith(result.collectCommand)).ccusageVersion).toBe('20.0.23');

    mkdirSync(join(home, '.codex'), { recursive: true });
    const codexReq = { ...request(join(home, '.codex')), source: 'codex' };
    const codexOut = await sshExecutor.exec(shellTarget, buildCollectCommand(result.collectCommand, codexReq), 60_000);
    const rows = codexAdapter.parse(parseEnvelope(codexOut.stdout, codexReq).report);
    expect(rows).toEqual([expect.objectContaining({ model: 'gpt-5', totalTokens: 754, costUsd: '0.003200' })]);

    // 某一轮采集时取不到最新版（npm 源不可达）：退回已安装的那份，这一轮照常采到
    writeFileSync(configPath, JSON.stringify({ ...config, ccusageCommand: [config.ccusageCommand[0], '--yes', '/nonexistent/pkg'] }));
    expect((await collectWith(result.collectCommand)).ccusageVersion).toBe('20.1.0');
  }, 240_000);

  it('安装时就取不到最新版：自动改用远端已安装的 ccusage', async () => {
    const result = await installCollector(sshExecutor, shellTarget, { latestSpec: '/nonexistent/pkg', timeoutMs: 180_000 });
    expect(result).toMatchObject({ ccusageMode: 'reused', ccusageVersion: '20.1.0' });
  }, 240_000);

  it('密钥被 forced command 限制时给出明确说明，而不是笼统的失败', async () => {
    await expect(installCollector(sshExecutor, target, { timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'KEY_RESTRICTED' });
  });
});
