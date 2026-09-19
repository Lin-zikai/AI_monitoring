import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { CollectError } from '../collect/adapter.js';

const { Client, utils } = ssh2;

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  /** 形如 SHA256:xxxx；采集时必须提供，不匹配即拒绝连接。 */
  expectedHostFingerprint: string | null;
}

export interface ExecResult { stdout: string; stderr: string; exitCode: number | null }

/** 采集流程依赖的远程执行接口，测试中可替换。 */
export interface RemoteExecutor {
  /** stdin：写入远端命令标准输入的内容（用于把固定的安装脚本交给 `sh -s`） */
  exec(target: SshTarget, command: string, timeoutMs: number, stdin?: string): Promise<ExecResult>;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const hostKeyFingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

export function describePrivateKey(privateKey: string, passphrase?: string): { fingerprint: string; keyType: string } {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    if (/no passphrase given/i.test(parsed.message)) throw new Error('该私钥有口令保护，请在“私钥口令”中填写口令');
    if (/bad passphrase|integrity check failed/i.test(parsed.message)) throw new Error('私钥口令不正确');
    throw new Error('无法解析私钥：请粘贴完整的 OpenSSH / PEM 格式私钥（包含 BEGIN 与 END 两行）');
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || !key.isPrivateKey()) throw new Error('提供的内容不是私钥');
  return { fingerprint: hostKeyFingerprint(key.getPublicSSH()), keyType: key.type };
}

function mapSshError(err: Error & { level?: string; code?: string }): CollectError {
  if (err.level === 'client-authentication') return new CollectError('AUTH_FAILED', 'SSH 认证失败（用户名或私钥不被接受）');
  if (err.level === 'client-timeout' || err.code === 'ETIMEDOUT') return new CollectError('CONNECT_TIMEOUT', 'SSH 连接超时', true);
  if (err.code === 'ECONNREFUSED') return new CollectError('CONNECT_REFUSED', 'SSH 端口拒绝连接', true);
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return new CollectError('DNS_FAILED', '无法解析服务器地址', true);
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return new CollectError('UNREACHABLE', '服务器网络不可达', true);
  return new CollectError('SSH_ERROR', `SSH 错误: ${err.message}`, true);
}

export const sshExecutor: RemoteExecutor = {
  exec(target, command, timeoutMs, stdin) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      let hostKeyMismatch: string | undefined;
      const done = (err: Error | null, result?: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.end();
        err ? reject(err) : resolve(result!);
      };
      const timer = setTimeout(() => done(new CollectError('EXEC_TIMEOUT', '远端采集命令执行超时', true)), timeoutMs);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) return done(mapSshError(err));
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_OUTPUT_BYTES) return done(new CollectError('OUTPUT_TOO_LARGE', '远端输出超过大小上限'));
            out.push(chunk);
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            if (errOut.length < 512) errOut.push(chunk);
          });
          if (stdin !== undefined) stream.end(stdin);
          stream.on('close', (code: number | null) => {
            done(null, { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), exitCode: code });
          });
        });
      });
      conn.on('error', (err) => {
        done(hostKeyMismatch
          ? new CollectError('HOST_KEY_MISMATCH', `主机指纹不匹配（实际为 ${hostKeyMismatch}），已拒绝连接`)
          : mapSshError(err));
      });
      conn.on('close', () => done(new CollectError('SSH_CLOSED', 'SSH 连接被提前关闭', true)));

      if (!target.expectedHostFingerprint) return done(new CollectError('HOST_KEY_UNVERIFIED', '尚未确认服务器主机指纹'));
      conn.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
        readyTimeout: Math.min(timeoutMs, 20_000),
        keepaliveInterval: 10_000,
        hostVerifier: (key: Buffer) => {
          const actual = hostKeyFingerprint(key);
          if (actual === target.expectedHostFingerprint) return true;
          hostKeyMismatch = actual;
          return false;
        },
      });
    });
  },
};

/** 仅握手读取主机公钥指纹，不做认证；供管理员核对后确认。 */
export function scanHostKey(host: string, port: number, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fingerprint: string | undefined;
    const timer = setTimeout(() => { conn.destroy(); reject(new CollectError('CONNECT_TIMEOUT', 'SSH 连接超时')); }, timeoutMs);
    conn.on('error', (err) => {
      clearTimeout(timer);
      fingerprint ? resolve(fingerprint) : reject(mapSshError(err));
    });
    conn.connect({
      host, port, username: 'hostkey-scan', readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        fingerprint = hostKeyFingerprint(key);
        return false; // 拿到指纹即中止握手
      },
    });
  });
}
