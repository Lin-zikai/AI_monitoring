// 远程命令参数的白名单校验。所有进入 SSH 命令行的值都必须先通过这里，禁止拼接任意远程命令。

const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._@+\-/]*$/;
const SSH_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/i;
const COMMAND_NAME = /^[A-Za-z0-9._-]+$/;
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export const isValidHost = (host: string) => HOSTNAME.test(host) || (host.includes(':') && IPV6.test(host));
export const isValidSshUsername = (name: string) => SSH_USERNAME.test(name);
export const isSafeTimezoneArg = (tz: string) => TIMEZONE.test(tz);

/** 绝对路径，字符集受限（无空格与 shell 元字符），不允许 .. 段。 */
export function isSafeAbsolutePath(path: string): boolean {
  if (path.length > 512 || !SAFE_PATH.test(path)) return false;
  return !path.split('/').some((seg) => seg === '..' || seg === '.');
}

/** 远端采集命令：裸命令名（依赖 PATH / forced command）或安全的绝对路径。 */
export function isValidCollectCommand(cmd: string): boolean {
  return cmd.startsWith('/') ? isSafeAbsolutePath(cmd) && !cmd.endsWith('/') : COMMAND_NAME.test(cmd);
}
