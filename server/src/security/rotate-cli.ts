import { readFileSync } from 'node:fs';
import { createPool } from '../db/pool.js';
import { logger } from '../logger.js';
import { rotateMasterKey } from './rotate.js';

// 用法（先停掉 api / collector / mailer）：
//   DATABASE_URL=... OLD_MASTER_KEY_FILE=secrets/master_key NEW_MASTER_KEY_FILE=secrets/master_key.new node dist/security/rotate-cli.js
// 成功后用新密钥文件替换旧文件再启动服务；失败时数据库保持原样。

function readKey(name: string): Buffer {
  const file = process.env[name];
  if (!file) throw new Error(`缺少环境变量 ${name}`);
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${name} 必须是 32 字节的 base64 编码（openssl rand -base64 32）`);
  return key;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('缺少环境变量 DATABASE_URL');
const oldKey = readKey('OLD_MASTER_KEY_FILE');
const newKey = readKey('NEW_MASTER_KEY_FILE');
if (oldKey.equals(newKey)) throw new Error('新旧主密钥相同');

const db = createPool(databaseUrl);
try {
  const version = Number((await db.query('SELECT COALESCE(max(key_version), 0) + 1 AS v FROM credentials')).rows[0].v);
  const result = await rotateMasterKey(db, oldKey, newKey, version);
  logger.info({ ...result, keyVersion: version }, '主密钥轮换完成：请用新密钥文件替换旧文件后再启动服务');
} finally {
  await db.end();
}
