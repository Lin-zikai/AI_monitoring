import pg from 'pg';

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

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
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
