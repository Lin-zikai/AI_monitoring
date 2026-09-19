import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCodeAdapter, parseEnvelope } from '../src/collect/adapter.js';
import { buildCollectCommand } from '../src/collect/command.js';
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
