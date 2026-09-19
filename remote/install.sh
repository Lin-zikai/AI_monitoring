#!/usr/bin/env bash
# 在被采集服务器上以 root 执行：预装固定版本 ccusage、受限采集脚本和专用采集账户。
#   sudo ./install.sh "ssh-ed25519 AAAA... usage-monitor"     # 参数为中央平台采集凭据的公钥
# 需要已安装 Node.js >= 20。
set -euo pipefail

CCUSAGE_VERSION="${CCUSAGE_VERSION:-20.0.23}"
COLLECT_USER="${COLLECT_USER:-ccusage-collector}"
PUBKEY="${1:?用法: install.sh \"<采集公钥>\"}"
HERE="$(cd "$(dirname "$0")" && pwd)"

case "$PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;; *) echo "公钥格式不正确" >&2; exit 1 ;; esac
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "需要 Node.js >= 20" >&2; exit 1; }

npm install -g "ccusage@${CCUSAGE_VERSION}"
install -m 0755 "$HERE/ccusage-collect.mjs" /usr/local/bin/ccusage-collect

install -d -m 0755 /etc/ccusage-collect
if [ ! -f /etc/ccusage-collect/config.json ]; then
  sed -e "s|\"ccusageBin\": \".*\"|\"ccusageBin\": \"$(command -v ccusage)\"|" \
      -e "s|\"expectedCcusageVersion\": \".*\"|\"expectedCcusageVersion\": \"${CCUSAGE_VERSION}\"|" \
      "$HERE/config.example.json" > /etc/ccusage-collect/config.json
  chmod 0644 /etc/ccusage-collect/config.json
fi

id "$COLLECT_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh "$COLLECT_USER"
HOME_DIR="$(getent passwd "$COLLECT_USER" | cut -d: -f6)"
install -d -m 0700 -o "$COLLECT_USER" -g "$COLLECT_USER" "$HOME_DIR/.ssh"
# forced command + restrict：该密钥登录后只能执行采集脚本，不能开 shell、转发端口或执行其他命令
echo "command=\"/usr/local/bin/ccusage-collect\",restrict ${PUBKEY}" > "$HOME_DIR/.ssh/authorized_keys"
chown "$COLLECT_USER:$COLLECT_USER" "$HOME_DIR/.ssh/authorized_keys"
chmod 0600 "$HOME_DIR/.ssh/authorized_keys"

cat <<MSG

安装完成。接下来：
  1. 编辑 /etc/ccusage-collect/config.json 的 allowedDirs，只保留需要采集的目录。
  2. 为每个被统计用户的数据目录授予采集账户只读权限，例如：
       setfacl -m u:${COLLECT_USER}:x /home/zhangsan
       setfacl -R -m u:${COLLECT_USER}:rX /home/zhangsan/.claude
       setfacl -R -d -m u:${COLLECT_USER}:rX /home/zhangsan/.claude
  3. 在平台“服务器管理”中添加本机（SSH 用户名 ${COLLECT_USER}），扫描并核对主机指纹：
       ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
MSG
