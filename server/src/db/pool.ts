import pg from 'pg';
import { logger } from '../logger.js';

// int8 → number（Token 总量远小于 2^53；超出则保留字符串以免静默失真）
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
// date → 'YYYY-MM-DD' 字符串，避免被解析为本地时区的 Date
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export interface PoolOptions {
  /** 单条语句的执行上限（毫秒）；0 = 不限。默认取环境变量 DB_STATEMENT_TIMEOUT_MS，否则 60 秒 */
  statementTimeoutMs?: number;
  log?: { error(obj: unknown, msg: string): void };
}

function defaultStatementTimeout(): number {
  const n = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? '');
  return process.env.DB_STATEMENT_TIMEOUT_MS && Number.isInteger(n) && n >= 0 ? n : 60_000;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString, max: 10,
    connectionTimeoutMillis: 10_000, // 数据库不可达时尽快报错，而不是让请求一直挂着
    statement_timeout: opts.statementTimeoutMs ?? defaultStatementTimeout(), // 迁移在自己的会话里关闭该限制（见 migrate.ts）
  });
  // 空闲连接被服务端断开（数据库重启、网络抖动）会触发 'error'；没有监听器时 Node 会把它当作未捕获异常直接退出进程
  const log = opts.log ?? logger;
  pool.on('error', (err) => log.error({ err }, '数据库空闲连接出错（连接池会自动重建）'));
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
