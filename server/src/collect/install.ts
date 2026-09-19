import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidCollectCommand } from '../security/validate.js';
import type { RemoteExecutor, SshTarget } from '../ssh/client.js';
import { CollectError, collectEnvelope } from './adapter.js';

// 自动安装：通过 SSH 在远端账户的家目录下放置采集脚本；远端已有的 ccusage / Node 直接复用，缺少时才安装，无需 root。
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
export type InstallMode = 'auto' | 'latest' | 'pinned';

export function buildInstallScript(opts: { ccusageSpec?: string; mode?: InstallMode; latestSpec?: string } = {}): string {
  const mode = opts.mode ?? 'latest';
  const latestSpec = opts.latestSpec ?? 'ccusage@latest';
  const collector = readFileSync(COLLECTOR_PATH).toString('base64');
  const spec = opts.ccusageSpec ?? `ccusage@${CCUSAGE_VERSION}`;
  return `set -eu
MODE=${mode}
DIR="$HOME/.local/share/usage-monitor"
log() { echo "[install] $*" >&2; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 20 "$1"; else wget -qO- "$1"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'Number(process.versions.node.split(".")[0]) >= 20' 2>/dev/null)" = "true" ]; }

mkdir -p "$DIR"
login_which() { bash -lc "command -v $1" 2>/dev/null | tail -1 || true; } # 非交互 SSH 会话的 PATH 往往不含 nvm / npm 全局目录

# 1. 找远端已经装过的 ccusage：auto 模式直接复用；latest 模式把它作为取不到最新版时的后备
EXISTING=""
if [ "$MODE" != pinned ]; then
  for c in "$(command -v ccusage 2>/dev/null || true)" "$(login_which ccusage)" "$HOME/.npm-global/bin/ccusage" "$HOME/.local/bin/ccusage" \\
           "$HOME/.bun/bin/ccusage" "$HOME"/.nvm/versions/node/*/bin/ccusage /usr/local/bin/ccusage /usr/bin/ccusage; do
    if [ -n "$c" ] && [ -x "$c" ]; then EXISTING="$c"; break; fi
  done
fi
CC=""; CC_MODE=installed
if [ "$MODE" = auto ] && [ -n "$EXISTING" ]; then CC="$EXISTING"; CC_MODE=reused; fi

# 2. Node：优先用远端已有的（含 ccusage 同目录的），都不满足才下载
NODE_BIN=""
NODE_CANDIDATES="$DIR/node/bin/node
\${EXISTING:+$(dirname "$EXISTING")/node}
$(command -v node 2>/dev/null || true)
$(login_which node)"
for need_npx in 1 0; do
  # 先找带 npx 的（始终最新 / 安装都需要）；已有 ccusage 时退而求其次，接受不带 npx 的 Node
  [ "$need_npx" = 0 ] && [ -z "$EXISTING" ] && break
  while IFS= read -r candidate; do
    if [ -z "$NODE_BIN" ] && [ -n "$candidate" ] && node_ok "$candidate" && { [ "$need_npx" = 0 ] || [ -x "$(dirname "$candidate")/npx" ]; }; then NODE_BIN="$candidate"; fi
  done <<CANDIDATES
$NODE_CANDIDATES
CANDIDATES
  [ -n "$NODE_BIN" ] && break
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

version_of() { "$@" --version 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>console.log((/[0-9]+[.][0-9]+[.][0-9]+/.exec(s)||[""])[0]))'; }

VERSION=""
if [ "$MODE" = latest ] && [ -x "$NODE_DIR/npx" ]; then
  # 每次采集都经 npx --yes 运行：有新版本时自动确认更新，再取数
  log "使用 npx --yes ${latestSpec}（每次采集自动更新到最新版）"
  VERSION="$(version_of "$NODE_DIR/npx" --yes '${latestSpec}')"
  if [ -n "$VERSION" ]; then
    CC_MODE=latest; CC="$NODE_DIR/npx"; CC_DIR="\${EXISTING:+$(dirname "$EXISTING")}"; CC_DIR="\${CC_DIR:-$NODE_DIR}"
    cc() { "$NODE_DIR/npx" --yes '${latestSpec}' "$@"; }
    CC_JSON="\\"ccusageCommand\\": [\\"$NODE_DIR/npx\\", \\"--yes\\", \\"${latestSpec}\\"]\${EXISTING:+, \\"ccusageBin\\": \\"$EXISTING\\"}"
  else
    log "取不到最新版（远端可能访问不了 npm 源）"
  fi
fi
if [ -z "$VERSION" ]; then
  if [ -z "$CC" ] && [ -n "$EXISTING" ]; then CC="$EXISTING"; CC_MODE=reused; fi
  if [ -n "$CC" ]; then
    log "使用已安装的 ccusage：$CC"
  else
    log "安装 ${spec}"
    npm install --prefix "$DIR" --no-audit --no-fund --loglevel=error '${spec}' >&2 \\
      || npm install --prefix "$DIR" --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com '${spec}' >&2 \\
      || { log "ccusage 安装失败（远端需要能访问 npm 源）"; exit 24; }
    CC="$DIR/node_modules/.bin/ccusage"
  fi
  CC_DIR="$(dirname "$CC")"
  cc() { "$CC" "$@"; }
  CC_JSON="\\"ccusageBin\\": \\"$CC\\""
  VERSION="$(version_of "$CC")"
  [ -n "$VERSION" ] || { log "无法运行 ccusage：$CC"; exit 24; }
fi
# 采集依赖 ccusage claude daily --breakdown；较老的 ccusage 没有这个子命令
case "$(cc claude daily --help 2>&1 || true)" in
  *--breakdown*) ;;
  *) log "已安装的 ccusage $VERSION（$CC）不支持 claude daily --breakdown，平台要求 ${CCUSAGE_VERSION} 或更新的版本"; exit 26 ;;
esac
# 只有平台自己安装的固定版本才锁定版本号；复用或始终最新时，ccusage 升级后采集照常进行（版本随每次采集记录）
if [ "$CC_MODE" = installed ]; then EXPECT="\\"$VERSION\\""; else EXPECT=null; fi

printf '%s' '${collector}' | base64 -d > "$DIR/ccusage-collect.mjs"
# 该账户本身已有 shell 权限，目录白名单在这里不构成安全边界，放开为任意目录；实际可读范围由系统文件权限决定
cat > "$DIR/config.json" <<CONFIG
{ "allowedDirs": ["**"], $CC_JSON, "expectedCcusageVersion": $EXPECT, "costMode": "auto", "offline": true }
CONFIG
cat > "$DIR/ccusage-collect" <<WRAPPER
#!/bin/sh
PATH="$NODE_DIR:$CC_DIR:\\$PATH" CCUSAGE_COLLECT_CONFIG="$DIR/config.json" exec "$NODE_BIN" "$DIR/ccusage-collect.mjs" "\\$@"
WRAPPER
chmod 755 "$DIR/ccusage-collect"

"$DIR/ccusage-collect" >/dev/null || { log "采集脚本自检失败"; exit 25; }
echo "RESULT $DIR/ccusage-collect $("$NODE_BIN" --version) $VERSION $HOME $CC_MODE $CC"
`;
}

const MANAGED_COMMAND = /^(\/.+)\/\.local\/share\/usage-monitor\/ccusage-collect$/;

/** 远端账户的家目录：优先从自动安装登记的采集命令反推，否则按惯例猜测。 */
export function guessRemoteHome(collectCommand: string, sshUsername: string): string {
  return MANAGED_COMMAND.exec(collectCommand)?.[1] ?? (sshUsername === 'root' ? '/root' : `/home/${sshUsername}`);
}

export interface InstallResult {
  collectCommand: string; nodeVersion: string; ccusageVersion: string; home: string; defaultDataDir: string; log: string;
  /** reused：复用远端已安装的 ccusage；installed：安装了平台专用的固定版本；latest：每次采集经 npx --yes 自动更新 */
  ccusageMode: 'reused' | 'installed' | 'latest';
  ccusagePath: string;
  /** 复用的版本与平台核对过输出格式的版本不同：可以采集，但费用口径可能与其他服务器不一致 */
  versionMismatch: boolean;
}

export async function installCollector(executor: RemoteExecutor, target: SshTarget, opts: { timeoutMs?: number; ccusageSpec?: string; mode?: InstallMode; latestSpec?: string } = {}): Promise<InstallResult> {
  const result = await executor.exec(target, 'sh -s', opts.timeoutMs ?? 600_000, buildInstallScript(opts));
  const log = result.stderr.split('\n').filter((l) => l.trim()).slice(-15).join('\n');
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    let restricted = false;
    try { restricted = collectEnvelope.safeParse(JSON.parse(result.stdout)).success; } catch { /* 不是采集信封 */ }
    if (restricted) throw new CollectError('KEY_RESTRICTED', '这把密钥在远端被限制为只能运行采集脚本（forced command），说明采集组件已手工安装，无需也无法自动安装');
    if (result.exitCode === 26) throw new CollectError('CCUSAGE_INCOMPATIBLE', log.split('\n').pop()?.replace('[install] ', '') ?? '已安装的 ccusage 版本不兼容');
    throw new CollectError('INSTALL_FAILED', `自动安装失败（退出码 ${result.exitCode}）：${log || '远端没有输出，可能该账户没有 shell 权限'}`);
  }
  const [, collectCommand = '', nodeVersion = '', ccusageVersion = '', home = '', mode = '', ...rest] = line.trim().split(' ');
  const ccusagePath = rest.join(' ');
  if (!isValidCollectCommand(collectCommand)) throw new CollectError('INSTALL_FAILED', '远端家目录路径包含不支持的字符，无法自动登记采集命令');
  const ccusageMode = mode === 'reused' || mode === 'latest' ? mode : 'installed';
  if (ccusageMode === 'installed' && ccusageVersion !== CCUSAGE_VERSION) throw new CollectError('INSTALL_FAILED', `安装到的 ccusage 版本为 ${ccusageVersion || '未知'}，要求 ${CCUSAGE_VERSION}`);
  return { collectCommand, nodeVersion, ccusageVersion, home, defaultDataDir: `${home}/.claude`, log, ccusageMode, ccusagePath, versionMismatch: ccusageVersion !== CCUSAGE_VERSION };
}
