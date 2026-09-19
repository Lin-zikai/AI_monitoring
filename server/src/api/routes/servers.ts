import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CollectError, collectEnvelope, parseEnvelope, SOURCE_INFO, supportedSources } from '../../collect/adapter.js';
import { buildCollectCommand } from '../../collect/command.js';
import { guessRemoteHome, installCollector } from '../../collect/install.js';
import { createAdhocBatch } from '../../collect/scheduler.js';
import { withTx } from '../../db/pool.js';
import { sanitizeError } from '../../logger.js';
import { seal, unseal } from '../../security/crypto.js';
import { isSafeAbsolutePath, isValidCollectCommand, isValidHost, isValidSshUsername } from '../../security/validate.js';
import { getGeneralSettings } from '../../settings.js';
import { describePrivateKey, type SshTarget } from '../../ssh/client.js';
import { dateInTz } from '../../util/time.js';
import type { RouteContext } from '../app.js';
import { audit, currentUser, HttpError, mapDbError, notFound, parse, parsePatch } from '../http.js';
import { idParam } from './users.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sshUsername = z.string().refine(isValidSshUsername, 'SSH 用户名不合法');

const credentialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  privateKey: z.string().min(50).max(20000),
  passphrase: z.string().max(500).optional(),
});

/** 一步接入：服务器信息 + 归属用户；密钥可选已有凭据，也可直接给出私钥 */
const onboardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().refine(isValidHost, '服务器地址不合法'),
  port: z.number().int().min(1).max(65535).default(22),
  sshUsername,
  userId: z.string().uuid(),
  credentialId: z.string().uuid().optional(),
  privateKey: z.string().min(50).max(20000).optional(),
  passphrase: z.string().max(500).optional(),
  credentialName: z.string().trim().min(1).max(100).optional(),
}).refine((b) => Boolean(b.credentialId) !== Boolean(b.privateKey), { message: '请选择已有凭据，或录入新密钥（二选一）', path: ['credentialId'] });

export interface OnboardStep { step: 'hostkey' | 'collector' | 'targets' | 'collect'; ok: boolean; message: string }

const serverSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().refine(isValidHost, '服务器地址不合法'),
  port: z.number().int().min(1).max(65535).default(22),
  sshUsername,
  credentialId: z.string().uuid(),
  collectCommand: z.string().refine(isValidCollectCommand, '采集命令只能是命令名或安全的绝对路径').default('ccusage-collect'),
  enabled: z.boolean().default(true),
});

const targetSchema = z.object({
  userId: z.string().uuid(),
  source: z.string().refine((s) => supportedSources().includes(s), '不支持的数据源').default('claude-code'),
  dataDir: z.string().refine(isSafeAbsolutePath, '数据目录必须是不含空格与特殊字符的绝对路径'),
  sshUsername: sshUsername.nullable().default(null),
  credentialId: z.string().uuid().nullable().default(null),
  sharedAccount: z.boolean().default(false),
  /** 远端目录不存在时视为“未使用”而不是采集失败 */
  missingOk: z.boolean().default(false),
  sourceStartDate: dateStr.nullable().default(null),
  sourceEndDate: dateStr.nullable().default(null),
  enabled: z.boolean().default(true),
});
const targetPatchSchema = targetSchema.omit({ userId: true, source: true }).partial();

const rebindSchema = z.object({
  userId: z.string().uuid(),
  /** 新归属从哪一天起生效；默认今天。此前的统计与告警保持原归属 */
  effectiveFrom: dateStr.optional(),
  /** 显式的历史重归属：把该目标的全部历史统计改归新用户 */
  reattributeHistory: z.boolean().default(false),
});

export async function serverRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { db, config } = ctx;
  const admin = { preHandler: ctx.requireAdmin };

  function sealKey(credentialId: string, privateKey: string, passphrase?: string) {
    const info = describePrivateKey(privateKey, passphrase);
    return { info, sealed: seal(config.masterKey, JSON.stringify({ privateKey, passphrase }), `credential:${credentialId}`) };
  }

  // ---- 凭据：提交后只展示标识与指纹，任何接口都不回显明文 ----

  app.get('/credentials', admin, async () => {
    const res = await db.query(
      `SELECT c.id, c.name, c.kind, c.public_fingerprint AS "publicFingerprint", c.key_type AS "keyType",
              c.created_at AS "createdAt", c.rotated_at AS "rotatedAt", c.revoked_at AS "revokedAt",
              (SELECT count(*)::int FROM servers s WHERE s.credential_id = c.id)
                + (SELECT count(*)::int FROM collection_targets t WHERE t.credential_id = c.id) AS "usedBy"
         FROM credentials c ORDER BY c.name`,
    );
    return { credentials: res.rows };
  });

  app.post('/credentials', admin, async (req, reply) => {
    const body = parse(credentialSchema, req.body);
    const id = randomUUID();
    let prepared: ReturnType<typeof sealKey>;
    try {
      prepared = sealKey(id, body.privateKey, body.passphrase);
    } catch (err) {
      throw new HttpError(400, sanitizeError(err));
    }
    await db.query(
      'INSERT INTO credentials (id, name, ciphertext, iv, auth_tag, key_version, public_fingerprint, key_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, body.name, prepared.sealed.ciphertext, prepared.sealed.iv, prepared.sealed.authTag, config.masterKeyVersion, prepared.info.fingerprint, prepared.info.keyType],
    ).catch(mapDbError);
    await audit(db, req, 'credential.create', 'credential', id, { name: body.name, fingerprint: prepared.info.fingerprint });
    return reply.status(201).send({ id, publicFingerprint: prepared.info.fingerprint, keyType: prepared.info.keyType });
  });

  app.post('/credentials/:id/rotate', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(credentialSchema.omit({ name: true }), req.body);
    let prepared: ReturnType<typeof sealKey>;
    try {
      prepared = sealKey(id, body.privateKey, body.passphrase);
    } catch (err) {
      throw new HttpError(400, sanitizeError(err));
    }
    const res = await db.query(
      `UPDATE credentials SET ciphertext = $2, iv = $3, auth_tag = $4, key_version = $5, public_fingerprint = $6, key_type = $7,
              rotated_at = now(), revoked_at = NULL WHERE id = $1`,
      [id, prepared.sealed.ciphertext, prepared.sealed.iv, prepared.sealed.authTag, config.masterKeyVersion, prepared.info.fingerprint, prepared.info.keyType],
    );
    if (res.rowCount === 0) throw notFound('凭据');
    await audit(db, req, 'credential.rotate', 'credential', id, { fingerprint: prepared.info.fingerprint });
    return { publicFingerprint: prepared.info.fingerprint, keyType: prepared.info.keyType };
  });

  app.post('/credentials/:id/revoke', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await db.query('UPDATE credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (res.rowCount === 0) throw notFound('可撤销的凭据');
    await audit(db, req, 'credential.revoke', 'credential', id);
    return { ok: true };
  });

  app.delete('/credentials/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await db.query('DELETE FROM credentials WHERE id = $1', [id]).catch(mapDbError);
    if (res.rowCount === 0) throw notFound('凭据');
    await audit(db, req, 'credential.delete', 'credential', id);
    return { ok: true };
  });

  // ---- 服务器 ----

  app.get('/servers', admin, async () => {
    const servers = await db.query(
      `SELECT s.id, s.name, s.host, s.port, s.ssh_username AS "sshUsername", s.credential_id AS "credentialId", c.name AS "credentialName",
              (c.revoked_at IS NOT NULL) AS "credentialRevoked", s.host_key_fingerprint AS "hostKeyFingerprint",
              s.collect_command AS "collectCommand", s.default_user_id AS "defaultUserId", s.enabled, s.last_connect_ok_at AS "lastConnectOkAt", s.last_error AS "lastError"
         FROM servers s LEFT JOIN credentials c ON c.id = s.credential_id ORDER BY s.name`,
    );
    const targets = await db.query(
      `SELECT t.id, t.server_id AS "serverId", t.user_id AS "userId", u.name AS "userName", t.source, t.data_dir AS "dataDir",
              t.ssh_username AS "sshUsername", t.credential_id AS "credentialId", t.shared_account AS "sharedAccount",
              t.source_start_date AS "sourceStartDate", t.source_end_date AS "sourceEndDate", t.enabled,
              t.initialized_at AS "initializedAt", t.last_attempt_at AS "lastAttemptAt", t.last_success_at AS "lastSuccessAt",
              t.last_status AS "lastStatus", t.last_error_code AS "lastErrorCode", t.last_error AS "lastError",
              t.consecutive_failures AS "consecutiveFailures", t.missing_ok AS "missingOk",
              (t.lock_run_id IS NOT NULL AND t.lock_expires_at > now()) AS "collecting",
              EXISTS (SELECT 1 FROM usage_daily d WHERE d.target_id = t.id AND d.integrity <> 'complete') AS "hasFlaggedData"
         FROM collection_targets t JOIN users u ON u.id = t.user_id ORDER BY t.data_dir`,
    );
    return { servers: servers.rows.map((s) => ({ ...s, targets: targets.rows.filter((t) => t.serverId === s.id) })) };
  });

  app.post('/servers', admin, async (req, reply) => {
    const body = parse(serverSchema, req.body);
    const res = await db.query(
      'INSERT INTO servers (name, host, port, ssh_username, credential_id, collect_command, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [body.name, body.host, body.port, body.sshUsername, body.credentialId, body.collectCommand, body.enabled],
    ).catch(mapDbError);
    const id = res.rows[0].id as string;
    await audit(db, req, 'server.create', 'server', id, { name: body.name, host: body.host, port: body.port });
    return reply.status(201).send({ id });
  });

  app.patch('/servers/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parsePatch(serverSchema.partial(), req.body);
    const before = (await db.query('SELECT host, port FROM servers WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound('服务器');
    // 地址或端口变化后，旧的主机指纹不再可信，必须重新确认
    const endpointChanged = (body.host !== undefined && body.host !== before.host) || (body.port !== undefined && body.port !== before.port);
    await db.query(
      `UPDATE servers SET name = COALESCE($2, name), host = COALESCE($3, host), port = COALESCE($4, port), ssh_username = COALESCE($5, ssh_username),
              credential_id = COALESCE($6, credential_id), collect_command = COALESCE($7, collect_command), enabled = COALESCE($8, enabled),
              host_key_fingerprint = CASE WHEN $9 THEN NULL ELSE host_key_fingerprint END, updated_at = now()
        WHERE id = $1`,
      [id, body.name ?? null, body.host ?? null, body.port ?? null, body.sshUsername ?? null, body.credentialId ?? null, body.collectCommand ?? null, body.enabled ?? null, endpointChanged],
    ).catch(mapDbError);
    await audit(db, req, 'server.update', 'server', id, { ...body, hostKeyReset: endpointChanged });
    return { ok: true, hostKeyReset: endpointChanged };
  });

  app.delete('/servers/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { purge } = parse(z.object({ purge: z.enum(['true', 'false']).default('false') }), req.query);
    const usage = (await db.query('SELECT count(*)::int AS n FROM usage_daily WHERE server_id = $1', [id])).rows[0].n;
    if (usage > 0 && purge !== 'true') throw new HttpError(409, `该服务器已有 ${usage} 行历史统计；删除会一并清除。请改为停用，或带 purge=true 确认删除`, 'HAS_USAGE');
    const res = await db.query('DELETE FROM servers WHERE id = $1', [id]);
    if (res.rowCount === 0) throw notFound('服务器');
    await audit(db, req, 'server.delete', 'server', id, { purgedUsageRows: usage });
    return { ok: true };
  });

  app.post('/servers/:id/scan-host-key', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const server = (await db.query('SELECT host, port, host_key_fingerprint FROM servers WHERE id = $1', [id])).rows[0];
    if (!server) throw notFound('服务器');
    try {
      const fingerprint = await ctx.scanHostKey(server.host, server.port);
      return { fingerprint, confirmed: server.host_key_fingerprint, matches: server.host_key_fingerprint === fingerprint };
    } catch (err) {
      throw new HttpError(502, sanitizeError(err));
    }
  });

  app.post('/servers/:id/confirm-host-key', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, '指纹格式应为 SHA256:...') }), req.body);
    const res = await db.query('UPDATE servers SET host_key_fingerprint = $2, updated_at = now() WHERE id = $1', [id, body.fingerprint]);
    if (res.rowCount === 0) throw notFound('服务器');
    await audit(db, req, 'server.confirm_host_key', 'server', id, { fingerprint: body.fingerprint });
    return { ok: true };
  });

  async function loadSshTarget(serverId: string, targetId?: string): Promise<{ ssh: SshTarget; collectCommand: string; target?: { source: string; data_dir: string } }> {
    const row = (await db.query(
      `SELECT s.host, s.port, s.host_key_fingerprint, s.collect_command, COALESCE(t.ssh_username, s.ssh_username) AS username,
              t.source, t.data_dir, c.id AS credential_id, c.ciphertext, c.iv, c.auth_tag, c.revoked_at
         FROM servers s
         LEFT JOIN collection_targets t ON t.server_id = s.id AND t.id = $2
         LEFT JOIN credentials c ON c.id = COALESCE(t.credential_id, s.credential_id)
        WHERE s.id = $1`,
      [serverId, targetId ?? null],
    )).rows[0];
    if (!row || (targetId && !row.data_dir)) throw notFound(targetId ? '采集目标' : '服务器');
    if (!row.credential_id) throw new HttpError(400, '未配置 SSH 凭据');
    if (row.revoked_at) throw new HttpError(400, 'SSH 凭据已撤销');
    if (!row.host_key_fingerprint) throw new HttpError(400, '请先扫描并确认主机指纹');
    const secret = JSON.parse(unseal(config.masterKey, { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, `credential:${row.credential_id}`));
    return {
      ssh: { host: row.host, port: row.port, username: row.username, privateKey: secret.privateKey, passphrase: secret.passphrase, expectedHostFingerprint: row.host_key_fingerprint },
      collectCommand: row.collect_command,
      target: targetId ? { source: row.source, data_dir: row.data_dir } : undefined,
    };
  }

  /** 测试连接：验证指纹、认证，以及远端是否装有采集脚本（无参调用应返回 BAD_ARGS 信封）。 */
  app.post('/servers/:id/test', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { ssh, collectCommand } = await loadSshTarget(id);
    try {
      const result = await ctx.executor.exec(ssh, collectCommand, 30_000);
      let envelope: ReturnType<typeof collectEnvelope.safeParse> | undefined;
      try { envelope = collectEnvelope.safeParse(JSON.parse(result.stdout)); } catch { /* 非 JSON 输出 */ }
      if (!envelope?.success) return { ok: false, stage: 'collector', message: '已连接并通过认证，但远端还没有安装采集组件。可以点“自动安装采集组件”由平台通过 SSH 安装。' };
      await db.query('UPDATE servers SET last_connect_ok_at = now(), last_error = NULL WHERE id = $1', [id]);
      return { ok: true, collectorVersion: envelope.data.collectorVersion ?? null };
    } catch (err) {
      const message = sanitizeError(err);
      await db.query('UPDATE servers SET last_error = $2 WHERE id = $1', [id, message]);
      return { ok: false, stage: 'ssh', code: err instanceof CollectError ? err.code : 'ERROR', message };
    }
  });

  /** 自动安装采集组件：在远端账户家目录下安装 Node（如缺）、固定版本 ccusage 与采集脚本，并登记采集命令。 */
  app.post('/servers/:id/install-collector', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ mode: z.enum(['auto', 'latest', 'pinned']).default('latest') }), req.body ?? {});
    const { ssh } = await loadSshTarget(id);
    try {
      const result = await installCollector(ctx.executor, ssh, { mode: body.mode });
      await db.query('UPDATE servers SET collect_command = $2, last_connect_ok_at = now(), last_error = NULL, updated_at = now() WHERE id = $1', [id, result.collectCommand]);
      await audit(db, req, 'server.install_collector', 'server', id, { collectCommand: result.collectCommand, nodeVersion: result.nodeVersion, ccusageVersion: result.ccusageVersion, ccusageMode: result.ccusageMode, ccusagePath: result.ccusagePath });
      return { ok: true, ...result };
    } catch (err) {
      await audit(db, req, 'server.install_collector_failed', 'server', id, { message: sanitizeError(err) });
      return { ok: false, code: err instanceof CollectError ? err.code : 'ERROR', message: err instanceof Error ? err.message.slice(0, 1500) : String(err) };
    }
  });

  /**
   * 一步接入：自动信任首次见到的主机指纹 → 检查采集组件（没有则自动安装）→ 为默认用户创建各数据源的采集目标 → 启动首次采集。
   * 每一步的结果都返回给界面；任何一步失败，服务器记录保留，修正后可再次调用（幂等）。
   */
  async function onboardServer(req: Parameters<typeof audit>[1], serverId: string): Promise<{ ok: boolean; steps: OnboardStep[] }> {
    const steps: OnboardStep[] = [];
    const done = (step: OnboardStep['step'], ok: boolean, message: string) => { steps.push({ step, ok, message }); return ok; };
    const server = (await db.query('SELECT name, host, port, ssh_username, host_key_fingerprint, collect_command, default_user_id FROM servers WHERE id = $1', [serverId])).rows[0];
    if (!server) throw notFound('服务器');
    if (!server.default_user_id) throw new HttpError(400, '请先为这台服务器选择归属用户');

    // 1. 主机指纹：首次连接自动信任（等同于 ssh 首次连接时回答 yes）；之后指纹变化仍会被拒绝
    try {
      const fingerprint = await ctx.scanHostKey(server.host, server.port);
      if (!server.host_key_fingerprint) {
        await db.query('UPDATE servers SET host_key_fingerprint = $2, updated_at = now() WHERE id = $1', [serverId, fingerprint]);
        await audit(db, req, 'server.trust_host_key', 'server', serverId, { fingerprint, mode: 'trust-on-first-use' });
        done('hostkey', true, `已记录主机指纹 ${fingerprint}`);
      } else if (server.host_key_fingerprint !== fingerprint) {
        done('hostkey', false, `主机指纹与已记录的不一致（现为 ${fingerprint}）。如果服务器确实重装过，请在“更多 → 主机指纹”里重新确认`);
        return { ok: false, steps };
      } else done('hostkey', true, '主机指纹与已记录的一致');
    } catch (err) {
      done('hostkey', false, `连接不上 ${server.host}:${server.port}：${sanitizeError(err)}`);
      return { ok: false, steps };
    }

    // 2. 采集组件：已有就用，没有则经 SSH 自动安装
    let collectCommand: string = server.collect_command;
    let reportedHome: string | undefined; // 采集脚本应答里带的家目录（受限密钥的服务器无法从命令路径反推）
    try {
      const { ssh } = await loadSshTarget(serverId);
      const probe = await ctx.executor.exec(ssh, collectCommand, 30_000);
      let installed = false;
      try {
        const envelope = collectEnvelope.safeParse(JSON.parse(probe.stdout));
        installed = envelope.success;
        if (envelope.success && envelope.data.home && isSafeAbsolutePath(envelope.data.home)) reportedHome = envelope.data.home;
      } catch { /* 不是采集脚本的应答 */ }
      if (installed) done('collector', true, '采集组件已就绪');
      else {
        const result = await installCollector(ctx.executor, ssh);
        collectCommand = result.collectCommand;
        reportedHome = result.home;
        await db.query('UPDATE servers SET collect_command = $2, updated_at = now() WHERE id = $1', [serverId, collectCommand]);
        await audit(db, req, 'server.install_collector', 'server', serverId, { collectCommand, ccusageVersion: result.ccusageVersion, ccusageMode: result.ccusageMode });
        done('collector', true, `已安装采集组件（ccusage ${result.ccusageVersion}）`);
      }
      await db.query('UPDATE servers SET last_connect_ok_at = now(), last_error = NULL WHERE id = $1', [serverId]);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 600) : String(err);
      await db.query('UPDATE servers SET last_error = $2 WHERE id = $1', [serverId, message.slice(0, 500)]);
      done('collector', false, message);
      return { ok: false, steps };
    }

    // 3. 采集目标：每个数据源一个，目录取该账户家目录下的默认位置；目录不存在视为“未使用”，不算失败
    const home = reportedHome ?? guessRemoteHome(collectCommand, server.ssh_username);
    const targetIds = await withTx(db, async (tx) => {
      const ids: string[] = [];
      for (const source of supportedSources()) {
        const dataDir = `${home}/${SOURCE_INFO[source]?.defaultDirName ?? `.${source}`}`;
        const existing = (await tx.query('SELECT id FROM collection_targets WHERE server_id = $1 AND source = $2', [serverId, source])).rows[0];
        if (existing) { ids.push(existing.id); continue; }
        const created = (await tx.query(
          'INSERT INTO collection_targets (server_id, user_id, source, data_dir, missing_ok) VALUES ($1, $2, $3, $4, true) RETURNING id',
          [serverId, server.default_user_id, source, dataDir],
        )).rows[0];
        await tx.query("INSERT INTO target_user_bindings (target_id, user_id, effective_from) VALUES ($1, $2, '1970-01-01')", [created.id, server.default_user_id]);
        ids.push(created.id);
      }
      return ids;
    });
    done('targets', true, `采集 ${supportedSources().map((src) => SOURCE_INFO[src]?.label ?? src).join('、')}（目录位于 ${home}）`);

    // 4. 首次采集
    const idle = (await db.query(
      'SELECT id FROM collection_targets WHERE id = ANY($1::uuid[]) AND enabled AND NOT (lock_run_id IS NOT NULL AND lock_expires_at > now())', [targetIds],
    )).rows.map((r) => r.id as string);
    if (idle.length > 0) {
      const batch = await createAdhocBatch(db, 'init', idle, currentUser(req).id);
      await ctx.queues.enqueueRuns(batch.runIds);
    }
    done('collect', true, '首次采集已开始，稍后刷新即可看到数据');
    return { ok: true, steps };
  }

  app.post('/servers/onboard', admin, async (req, reply) => {
    const body = parse(onboardSchema, req.body);
    let credentialId = body.credentialId;
    let prepared: ReturnType<typeof sealKey> | undefined;
    if (body.privateKey) {
      credentialId = randomUUID();
      try {
        prepared = sealKey(credentialId, body.privateKey, body.passphrase);
      } catch (err) {
        throw new HttpError(400, sanitizeError(err));
      }
    }
    // 凭据与服务器同事务创建：名称冲突等错误不会留下半截数据
    const serverId = await withTx(db, async (tx) => {
      if (prepared) {
        await tx.query(
          'INSERT INTO credentials (id, name, ciphertext, iv, auth_tag, key_version, public_fingerprint, key_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [credentialId, body.credentialName ?? `${body.name} 密钥`, prepared.sealed.ciphertext, prepared.sealed.iv, prepared.sealed.authTag, config.masterKeyVersion, prepared.info.fingerprint, prepared.info.keyType],
        );
      }
      const res = await tx.query(
        'INSERT INTO servers (name, host, port, ssh_username, credential_id, default_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [body.name, body.host, body.port, body.sshUsername, credentialId, body.userId],
      );
      return res.rows[0].id as string;
    }).catch(mapDbError);
    await audit(db, req, 'server.create', 'server', serverId, { name: body.name, host: body.host, port: body.port, userId: body.userId, newCredential: Boolean(prepared) });
    return reply.status(201).send({ id: serverId, ...(await onboardServer(req, serverId)) });
  });

  /** 重新执行接入流程（修正问题后重试，或给旧服务器补上默认采集目标） */
  app.post('/servers/:id/onboard', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ userId: z.string().uuid().optional() }), req.body ?? {});
    if (body.userId) await db.query('UPDATE servers SET default_user_id = $2 WHERE id = $1', [id, body.userId]).catch(mapDbError);
    return { id, ...(await onboardServer(req, id)) };
  });

  // ---- 采集目标 ----

  app.post('/servers/:id/targets', admin, async (req, reply) => {
    const { id: serverId } = parse(idParam, req.params);
    const body = parse(targetSchema, req.body);
    const targetId = await withTx(db, async (tx) => {
      const res = await tx.query(
        `INSERT INTO collection_targets (server_id, user_id, source, data_dir, ssh_username, credential_id, shared_account, source_start_date, source_end_date, enabled, missing_ok)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [serverId, body.userId, body.source, body.dataDir, body.sshUsername, body.credentialId, body.sharedAccount, body.sourceStartDate, body.sourceEndDate, body.enabled, body.missingOk],
      );
      await tx.query("INSERT INTO target_user_bindings (target_id, user_id, effective_from) VALUES ($1, $2, '1970-01-01')", [res.rows[0].id, body.userId]);
      return res.rows[0].id as string;
    }).catch(mapDbError);
    await audit(db, req, 'target.create', 'target', targetId, { serverId, userId: body.userId, dataDir: body.dataDir, source: body.source });
    return reply.status(201).send({ id: targetId });
  });

  app.patch('/targets/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parsePatch(targetPatchSchema, req.body);
    const has = (k: keyof typeof body) => Object.hasOwn(body, k);
    const res = await db.query(
      `UPDATE collection_targets SET
              data_dir = CASE WHEN $2 THEN $3 ELSE data_dir END,
              ssh_username = CASE WHEN $4 THEN $5 ELSE ssh_username END,
              credential_id = CASE WHEN $6 THEN $7::uuid ELSE credential_id END,
              shared_account = COALESCE($8, shared_account),
              source_start_date = CASE WHEN $9 THEN $10::date ELSE source_start_date END,
              source_end_date = CASE WHEN $11 THEN $12::date ELSE source_end_date END,
              enabled = COALESCE($13, enabled), missing_ok = COALESCE($14, missing_ok), updated_at = now()
        WHERE id = $1`,
      [id, has('dataDir'), body.dataDir ?? null, has('sshUsername'), body.sshUsername ?? null, has('credentialId'), body.credentialId ?? null,
        body.sharedAccount ?? null, has('sourceStartDate'), body.sourceStartDate ?? null, has('sourceEndDate'), body.sourceEndDate ?? null, body.enabled ?? null, body.missingOk ?? null],
    ).catch(mapDbError);
    if (res.rowCount === 0) throw notFound('采集目标');
    await audit(db, req, 'target.update', 'target', id, body);
    return { ok: true };
  });

  /** 调整用户绑定：默认从生效日起归新用户并保留历史归属；reattributeHistory 为显式的历史重归属。 */
  app.post('/targets/:id/rebind', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(rebindSchema, req.body);
    const settings = await getGeneralSettings(db);
    const effectiveFrom = body.reattributeHistory ? '1970-01-01' : body.effectiveFrom ?? dateInTz(new Date(), settings.timezone);
    const moved = await withTx(db, async (tx) => {
      const target = (await tx.query('SELECT user_id FROM collection_targets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw notFound('采集目标');
      await tx.query('DELETE FROM target_user_bindings WHERE target_id = $1 AND effective_from >= $2', [id, effectiveFrom]);
      await tx.query('INSERT INTO target_user_bindings (target_id, user_id, effective_from) VALUES ($1, $2, $3)', [id, body.userId, effectiveFrom]);
      await tx.query('UPDATE collection_targets SET user_id = $2, updated_at = now() WHERE id = $1', [id, body.userId]);
      const res = await tx.query('UPDATE usage_daily SET user_id = $2 WHERE target_id = $1 AND usage_date >= $3 AND user_id <> $2', [id, body.userId, effectiveFrom]);
      return { previousUserId: target.user_id as string, rows: res.rowCount ?? 0 };
    }).catch(mapDbError);
    await audit(db, req, 'target.rebind', 'target', id, { ...body, effectiveFrom, previousUserId: moved.previousUserId, reattributedRows: moved.rows });
    return { ok: true, effectiveFrom, reattributedRows: moved.rows };
  });

  app.delete('/targets/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { purge } = parse(z.object({ purge: z.enum(['true', 'false']).default('false') }), req.query);
    const usage = (await db.query('SELECT count(*)::int AS n FROM usage_daily WHERE target_id = $1', [id])).rows[0].n;
    if (usage > 0 && purge !== 'true') throw new HttpError(409, `该目标已有 ${usage} 行历史统计；删除会一并清除。请改为停用，或带 purge=true 确认删除`, 'HAS_USAGE');
    const res = await db.query('DELETE FROM collection_targets WHERE id = $1', [id]);
    if (res.rowCount === 0) throw notFound('采集目标');
    await audit(db, req, 'target.delete', 'target', id, { purgedUsageRows: usage });
    return { ok: true };
  });

  /** 测试目录读取权限：对当天执行一次真实采集命令，但不入库。 */
  app.post('/targets/:id/test', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const serverId = (await db.query('SELECT server_id FROM collection_targets WHERE id = $1', [id])).rows[0]?.server_id;
    if (!serverId) throw notFound('采集目标');
    const { ssh, collectCommand, target } = await loadSshTarget(serverId, id);
    const settings = await getGeneralSettings(db);
    const today = dateInTz(new Date(), settings.timezone);
    const request = { source: target!.source, dir: target!.data_dir, since: today, until: today, timezone: settings.timezone };
    try {
      const result = await ctx.executor.exec(ssh, buildCollectCommand(collectCommand, request), config.sshTimeoutMs);
      const envelope = parseEnvelope(result.stdout, request);
      return { ok: true, ccusageVersion: envelope.ccusageVersion ?? null, logFiles: envelope.logFiles ?? null };
    } catch (err) {
      return { ok: false, code: err instanceof CollectError ? err.code : 'ERROR', message: sanitizeError(err) };
    }
  });

  // ---- 手动采集与运行记录 ----

  const collectBody = z.object({ acceptDecrease: z.boolean().default(false) });

  app.post('/targets/:id/collect', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(collectBody, req.body ?? {});
    const target = (await db.query(
      `SELECT t.enabled AND s.enabled AS active, (t.lock_run_id IS NOT NULL AND t.lock_expires_at > now()) AS collecting
         FROM collection_targets t JOIN servers s ON s.id = t.server_id WHERE t.id = $1`, [id],
    )).rows[0];
    if (!target) throw notFound('采集目标');
    if (!target.active) throw new HttpError(409, '服务器或采集目标已停用');
    if (target.collecting) throw new HttpError(409, '该目标正在采集中，请稍后再试', 'COLLECTING');
    const batch = await createAdhocBatch(db, 'manual', [id], currentUser(req).id);
    await ctx.queues.enqueueRuns(batch.runIds, { acceptDecrease: body.acceptDecrease });
    await audit(db, req, 'target.collect', 'target', id, { acceptDecrease: body.acceptDecrease, runIds: batch.runIds });
    return reply.status(202).send({ batchId: batch.batchId, runIds: batch.runIds });
  });

  app.post('/collection/run-all', admin, async (req, reply) => {
    const ids = (await db.query(
      `SELECT t.id FROM collection_targets t JOIN servers s ON s.id = t.server_id
        WHERE t.enabled AND s.enabled AND NOT (t.lock_run_id IS NOT NULL AND t.lock_expires_at > now())`,
    )).rows.map((r) => r.id as string);
    if (ids.length === 0) throw new HttpError(409, '没有可采集的目标');
    const batch = await createAdhocBatch(db, 'manual', ids, currentUser(req).id);
    await ctx.queues.enqueueRuns(batch.runIds);
    await audit(db, req, 'collection.run_all', 'batch', batch.batchId, { targets: ids.length });
    return reply.status(202).send({ batchId: batch.batchId, runs: batch.runIds.length });
  });

  app.get('/collection/runs', admin, async (req) => {
    const q = parse(z.object({ targetId: z.string().uuid().optional(), status: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const res = await db.query(
      `SELECT r.id, r.batch_id AS "batchId", r.target_id AS "targetId", s.name AS "serverName", t.data_dir AS "dataDir", u.name AS "userName",
              r.trigger, r.status, r.attempt, r.range_since AS "rangeSince", r.range_until AS "rangeUntil",
              r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.error_code AS "errorCode", r.error_message AS "errorMessage",
              r.rows_written AS "rowsWritten", r.anomalies, r.ccusage_version AS "ccusageVersion", r.created_at AS "createdAt"
         FROM collection_runs r
         JOIN collection_targets t ON t.id = r.target_id JOIN servers s ON s.id = t.server_id JOIN users u ON u.id = t.user_id
        WHERE ($1::uuid IS NULL OR r.target_id = $1) AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC LIMIT $3`,
      [q.targetId ?? null, q.status ?? null, q.limit],
    );
    return { runs: res.rows };
  });
}
