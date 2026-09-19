import { CollectError, type CollectRequest } from './adapter.js';
import { isSafeAbsolutePath, isSafeTimezoneArg, isValidCollectCommand } from '../security/validate.js';
import { compactDate } from '../util/time.js';

const SOURCE = /^[a-z0-9-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 构造受限采集命令。所有参数都经白名单字符集校验，因此无需（也不使用）shell 引号，
 * 在 authorized_keys 的 forced command 模式下 SSH_ORIGINAL_COMMAND 也能按空白安全切分。
 */
export function buildCollectCommand(collectCommand: string, req: CollectRequest): string {
  if (!isValidCollectCommand(collectCommand)) throw new CollectError('BAD_ARGS', '采集命令名不合法');
  if (!SOURCE.test(req.source)) throw new CollectError('BAD_ARGS', '数据源名不合法');
  if (!isSafeAbsolutePath(req.dir)) throw new CollectError('BAD_ARGS', '数据目录不合法');
  if (!DATE.test(req.since) || !DATE.test(req.until) || req.since > req.until) throw new CollectError('BAD_ARGS', '采集日期范围不合法');
  if (!isSafeTimezoneArg(req.timezone)) throw new CollectError('BAD_ARGS', '时区不合法');
  return [
    collectCommand,
    '--source', req.source,
    '--dir', req.dir,
    '--since', compactDate(req.since),
    '--until', compactDate(req.until),
    '--timezone', req.timezone,
  ].join(' ');
}
