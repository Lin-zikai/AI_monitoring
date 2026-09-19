import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const db = createPool(loadConfig().databaseUrl);
const applied = await migrate(db);
logger.info({ applied }, applied.length ? '迁移完成' : '无待执行迁移');
await db.end();
