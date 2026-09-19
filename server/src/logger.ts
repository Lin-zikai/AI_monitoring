import { pino } from 'pino';

// 日志脱敏：私钥、口令、SMTP 密码、Cookie 一律不落日志
export const redactPaths = [
  'privateKey', 'passphrase', 'password', 'pass', 'smtpPassword',
  '*.privateKey', '*.passphrase', '*.password', '*.pass', '*.smtpPassword',
  'req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]',
];

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[已脱敏]' },
};

export const logger = pino(loggerOptions);

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** 错误信息入库/回显前的兜底脱敏与截断。 */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(PEM_BLOCK, '[已脱敏的私钥]').slice(0, 500);
}
