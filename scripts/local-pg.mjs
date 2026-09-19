// 本地演示用：用 server 的 devDependency embedded-postgres 启动一个持久化的 PostgreSQL。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { default: EmbeddedPostgres } = await import(require.resolve('embedded-postgres'));

const [dir, port, password] = process.argv.slice(2);
const fresh = !existsSync(`${dir}/PG_VERSION`);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'usage', password, port: Number(port), persistent: true, onLog: () => {}, onError: (e) => console.error(String(e)) });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('usage');
console.log('postgres ready');
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
