import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import type { RemoteExecutor } from '../src/collect/runner.js';
import type { Db } from '../src/db/pool.js';
import { unseal } from '../src/security/crypto.js';
import { hashPassword } from '../src/security/password.js';
import { rotateMasterKey } from '../src/security/rotate.js';
import { addServer, addUser, createTestDb, fakeQueues, masterKey, seedBase } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let adminCookie: string;
let serverId: string;
const PASSWORD = 'a-long-password-1';
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const MANAGED = '/home/collector/.local/share/usage-monitor/ccusage-collect';
const installModes: string[] = [];

// 远端：`sh -s` 是安装脚本（记录它用的 MODE）；其余命令按采集组件的空闲探测应答
const executor: RemoteExecutor = {
  async exec(_t, command, _timeout, stdin) {
    if (command === 'sh -s') {
      installModes.push(/^MODE=(\w+)$/m.exec(stdin ?? '')?.[1] ?? '?');
      return { stdout: `RESULT ${MANAGED} v20.18.1 20.0.23 /home/collector installed /x/ccusage\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: JSON.stringify({ schema: 1, status: 'error', code: 'BAD_ARGS', message: 'usage' }), stderr: '', exitCode: 2 };
  },
};

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
const send = (method: 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, headers: { cookie: adminCookie }, payload });
const serverRow = async () => (await get('/api/servers')).json().servers.find((s: { id: string }) => s.id === serverId);

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  const { credentialId } = await seedBase(db);
  const owner = await addUser(db, 'zhangsan');
  await db.query('UPDATE users SET password_hash = $1', [await hashPassword(PASSWORD)]);
  serverId = await addServer(db, 'server-a', credentialId);
  await db.query('UPDATE servers SET default_user_id = $2 WHERE id = $1', [serverId, owner]);
  app = await buildApp({
    db, logger: false, queues: fakeQueues(), executor,
    config: { jwtSecret: 'x'.repeat(40), cookieSecure: false, masterKey, masterKeyVersion: 1, publicBaseUrl: 'https://usage.example.com', webDist: undefined, sshTimeoutMs: 5000 },
    scanHostKey: async () => FINGERPRINT,
    smtpSenderFactory: async () => null,
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: PASSWORD } });
  adminCookie = String(res.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app.close();
  await drop();
});

describe('安装方式按服务器记录', () => {
  it('新服务器默认 latest；指定 pinned 后入库，之后不带 mode 重装沿用 pinned', async () => {
    expect((await serverRow()).installMode).toBe('latest');

    expect((await send('POST', `/api/servers/${serverId}/install-collector`, { mode: 'pinned' })).json()).toMatchObject({ ok: true, collectCommand: MANAGED });
    expect(await serverRow()).toMatchObject({ installMode: 'pinned', collectCommand: MANAGED });

    expect((await send('POST', `/api/servers/${serverId}/install-collector`)).json().ok).toBe(true);
    expect(installModes).toEqual(['pinned', 'pinned']);
    expect((await serverRow()).installMode).toBe('pinned');

    const audits = (await db.query("SELECT detail FROM audit_logs WHERE action = 'server.install_collector' AND entity_id = $1", [serverId])).rows;
    expect(audits.map((a) => a.detail.installMode)).toEqual(['pinned', 'pinned']);
  });
});

describe('改过地址的服务器不再自动信任指纹', () => {
  it('首次接入自动信任；改地址后必须人工确认新指纹，确认后才能重新接入', async () => {
    await db.query('UPDATE servers SET host_key_fingerprint = NULL WHERE id = $1', [serverId]);
    const first = (await send('POST', `/api/servers/${serverId}/onboard`)).json();
    expect(first.steps[0]).toMatchObject({ step: 'hostkey', ok: true });
    expect((await serverRow()).hostKeyFingerprint).toBe(FINGERPRINT);

    expect((await send('PATCH', `/api/servers/${serverId}`, { host: '10.0.0.77' })).json().hostKeyReset).toBe(true);
    const blocked = (await send('POST', `/api/servers/${serverId}/onboard`)).json();
    expect(blocked.ok).toBe(false);
    expect(blocked.steps).toEqual([expect.objectContaining({ step: 'hostkey', ok: false, message: expect.stringContaining('原指纹已作废') })]);
    expect((await serverRow()).hostKeyFingerprint).toBeNull();

    expect((await send('POST', `/api/servers/${serverId}/confirm-host-key`, { fingerprint: FINGERPRINT })).statusCode).toBe(200);
    expect((await send('POST', `/api/servers/${serverId}/onboard`)).json().steps[0]).toMatchObject({ step: 'hostkey', ok: true });
  });
});

describe('主密钥轮换', () => {
  const readCredential = async () => (await db.query('SELECT id, ciphertext, iv, auth_tag, key_version FROM credentials LIMIT 1')).rows[0];
  const open = (key: Buffer, r: { id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }) => unseal(key, { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, `credential:${r.id}`);

  it('凭据与 SMTP 密码换成新密钥加密；旧密钥不对时整体回滚', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings/smtp', headers: { cookie: adminCookie }, payload: { host: 'smtp.example.com', port: 587, secure: false, username: 'u', from: 'usage@example.com', password: 'smtp-secret' } })).statusCode).toBe(200);
    const before = await readCredential();
    const plain = open(masterKey, before);
    const newKey = randomBytes(32);

    await expect(rotateMasterKey(db, randomBytes(32), newKey, 2)).rejects.toThrow();
    expect(open(masterKey, await readCredential())).toBe(plain);

    expect(await rotateMasterKey(db, masterKey, newKey, 2)).toEqual({ credentials: 1, smtp: true });
    const after = await readCredential();
    expect(after.key_version).toBe(2);
    expect(open(newKey, after)).toBe(plain);
    expect(() => open(masterKey, after)).toThrow();
  });
});
