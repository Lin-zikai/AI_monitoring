import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidCollectCommand } from '../security/validate.js';
import type { RemoteExecutor, SshTarget } from '../ssh/client.js';
import { CollectError, collectEnvelope } from './adapter.js';

// 自动安装：通过 SSH 在远端账户的家目录下安装 Node（如缺）、固定版本 ccusage 与采集脚本，无需 root。
// 前提是该 SSH 密钥在远端有普通 shell 权限；被 forced command 限制的专用密钥无法（也不需要）走这条路。

export const CCUSAGE_VERSION = '20.0.23';
const NODE_VERSION = '20.18.1';
// 官方 SHASUMS256.txt 中的校验值；镜像站下载的包同样必须匹配
const NODE_SHA256 = {
  x64: '259e5a8bf2e15ecece65bd2a47153262eda71c0b2c9700d5e703ce4951572784',
  arm64: '73cd297378572e0bc9dfc187c5ec8cca8d43aee6a596c10ebea1ed5f9ec682b6',
};

const COLLECTOR_PATH = process.env.COLLECTOR_SCRIPT_PATH
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'remote', 'ccusage-collect.mjs');

/** 生成安装脚本。除 base64 编码的采集脚本与固定常量外不含任何外部输入。 */
export function buildInstallScript(opts: { ccusageSpec?: string } = {}): string {
  const collector = readFileSync(COLLECTOR_PATH).toString('base64');
  const spec = opts.ccusageSpec ?? `ccusage@${CCUSAGE_VERSION}`;
  return `set -eu
DIR="$HOME/.local/share/usage-monitor"
log() { echo "[install] $*" >&2; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 20 "$1"; else wget -qO- "$1"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'Number(process.versions.node.split(".")[0]) >= 20' 2>/dev/null)" = "true" ]; }

mkdir -p "$DIR"
NODE_BIN=""
for candidate in "$DIR/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && node_ok "$candidate" && [ -x "$(dirname "$candidate")/npm" ]; then NODE_BIN="$candidate"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ARCH=x64; SUM=${NODE_SHA256.x64} ;;
    Linux-aarch64|Linux-arm64) ARCH=arm64; SUM=${NODE_SHA256.arm64} ;;
    *) log "不支持的平台 $(uname -s)-$(uname -m)，请先手动安装 Node.js 20+"; exit 21 ;;
  esac
  FILE="node-v${NODE_VERSION}-linux-$ARCH.tar.gz"
  got=""
  for base in https://nodejs.org/dist https://cdn.npmmirror.com/binaries/node; do
    log "下载 $base/v${NODE_VERSION}/$FILE"
    if fetch "$base/v${NODE_VERSION}/$FILE" > "$DIR/$FILE" && [ "$(sha256 "$DIR/$FILE")" = "$SUM" ]; then got=1; break; fi
  done
  [ -n "$got" ] || { rm -f "$DIR/$FILE"; log "Node.js 下载失败或校验值不符（远端需要能访问外网）"; exit 22; }
  rm -rf "$DIR/node"; mkdir -p "$DIR/node"
  tar -xzf "$DIR/$FILE" -C "$DIR/node" --strip-components=1; rm -f "$DIR/$FILE"
  NODE_BIN="$DIR/node/bin/node"
  node_ok "$NODE_BIN" || { log "下载的 Node.js 无法在本机运行（系统 glibc 可能过旧）"; exit 23; }
fi
NODE_DIR="$(dirname "$NODE_BIN")"
log "使用 Node $("$NODE_BIN" --version)（$NODE_BIN）"

export PATH="$NODE_DIR:$PATH"
log "安装 ${spec}"
npm install --prefix "$DIR" --no-audit --no-fund --loglevel=error '${spec}' >&2 \\
  || npm install --prefix "$DIR" --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com '${spec}' >&2 \\
  || { log "ccusage 安装失败（远端需要能访问 npm 源）"; exit 24; }

printf '%s' '${collector}' | base64 -d > "$DIR/ccusage-collect.mjs"
# 该账户本身已有 shell 权限，目录白名单在这里不构成安全边界，放开为任意目录；实际可读范围由系统文件权限决定
cat > "$DIR/config.json" <<CONFIG
{ "allowedDirs": ["**"], "ccusageBin": "$DIR/node_modules/.bin/ccusage", "expectedCcusageVersion": "${CCUSAGE_VERSION}", "costMode": "auto", "offline": true }
CONFIG
cat > "$DIR/ccusage-collect" <<WRAPPER
#!/bin/sh
PATH="$NODE_DIR:\\$PATH" CCUSAGE_COLLECT_CONFIG="$DIR/config.json" exec "$NODE_BIN" "$DIR/ccusage-collect.mjs" "\\$@"
WRAPPER
chmod 755 "$DIR/ccusage-collect"

VERSION="$("$DIR/node_modules/.bin/ccusage" --version | "$NODE_BIN" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>console.log((/[0-9]+[.][0-9]+[.][0-9]+/.exec(s)||[""])[0]))')"
"$DIR/ccusage-collect" >/dev/null || { log "采集脚本自检失败"; exit 25; }
echo "RESULT $DIR/ccusage-collect $("$NODE_BIN" --version) $VERSION $HOME"
`;
}

export interface InstallResult { collectCommand: string; nodeVersion: string; ccusageVersion: string; defaultDataDir: string; log: string }

export async function installCollector(executor: RemoteExecutor, target: SshTarget, opts: { timeoutMs?: number; ccusageSpec?: string } = {}): Promise<InstallResult> {
  const result = await executor.exec(target, 'sh -s', opts.timeoutMs ?? 600_000, buildInstallScript(opts));
  const log = result.stderr.split('\n').filter((l) => l.trim()).slice(-15).join('\n');
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    let restricted = false;
    try { restricted = collectEnvelope.safeParse(JSON.parse(result.stdout)).success; } catch { /* 不是采集信封 */ }
    if (restricted) throw new CollectError('KEY_RESTRICTED', '这把密钥在远端被限制为只能运行采集脚本（forced command），说明采集组件已手工安装，无需也无法自动安装');
    throw new CollectError('INSTALL_FAILED', `自动安装失败（退出码 ${result.exitCode}）：${log || '远端没有输出，可能该账户没有 shell 权限'}`);
  }
  const [, collectCommand = '', nodeVersion = '', ccusageVersion = '', home = ''] = line.trim().split(' ');
  if (!isValidCollectCommand(collectCommand)) throw new CollectError('INSTALL_FAILED', '远端家目录路径包含不支持的字符，无法自动登记采集命令');
  if (ccusageVersion !== CCUSAGE_VERSION) throw new CollectError('INSTALL_FAILED', `安装到的 ccusage 版本为 ${ccusageVersion || '未知'}，要求 ${CCUSAGE_VERSION}`);
  return { collectCommand, nodeVersion, ccusageVersion, defaultDataDir: `${home}/.claude`, log };
}
