import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

// 集成测试跑在真实的 PostgreSQL 上（embedded-postgres 自带二进制，无需 Docker）。
// 也可以设置 TEST_DATABASE_URL 指向已有实例（需要 CREATE DATABASE 权限）。

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('adminDatabaseUrl', process.env.TEST_DATABASE_URL);
    return async () => undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), 'usage-monitor-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'postgres', password: 'test', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  project.provide('adminDatabaseUrl', `postgres://postgres:test@127.0.0.1:${port}/postgres`);
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext { adminDatabaseUrl: string }
}
