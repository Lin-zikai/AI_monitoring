import { readFileSync } from 'node:fs';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少环境变量 ${name}`);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`环境变量 ${name} 必须为整数`);
  return n;
}

/** 主加密密钥与数据库分离：来自环境变量或独立挂载的文件，32 字节 base64。 */
function loadMasterKey(): Buffer {
  const file = process.env.MASTER_KEY_FILE;
  const raw = file ? readFileSync(file, 'utf8').trim() : env('MASTER_KEY');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节的 base64 编码（openssl rand -base64 32）');
  return key;
}

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  masterKey: Buffer;
  masterKeyVersion: number;
  jwtSecret: string;
  cookieSecure: boolean;
  apiHost: string;
  apiPort: number;
  publicBaseUrl: string;
  webDist: string | undefined;
  collectConcurrency: number;
  collectMaxAttempts: number;
  sshTimeoutMs: number;
  mailMaxAttempts: number;
  bootstrapAdminEmail: string | undefined;
  bootstrapAdminPassword: string | undefined;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const jwtSecret = env('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET 至少 32 个字符');
  cached = {
    databaseUrl: env('DATABASE_URL'),
    redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    masterKey: loadMasterKey(),
    masterKeyVersion: intEnv('MASTER_KEY_VERSION', 1),
    jwtSecret,
    cookieSecure: env('COOKIE_SECURE', 'true') !== 'false',
    apiHost: env('API_HOST', '0.0.0.0'),
    apiPort: intEnv('API_PORT', 3000),
    publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    webDist: process.env.WEB_DIST || undefined,
    collectConcurrency: intEnv('COLLECT_CONCURRENCY', 4),
    collectMaxAttempts: intEnv('COLLECT_MAX_ATTEMPTS', 3),
    sshTimeoutMs: intEnv('SSH_TIMEOUT_MS', 120_000),
    mailMaxAttempts: intEnv('MAIL_MAX_ATTEMPTS', 5),
    bootstrapAdminEmail: process.env.ADMIN_EMAIL || undefined,
    bootstrapAdminPassword: process.env.ADMIN_PASSWORD || undefined,
  };
  return cached;
}
