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
  2. 为每个被统计用户授予采集账户只读权限。用量统计只需要 projects/ 下的会话统计日志（Codex 为 ~/.codex/sessions/），
     不要对整个 ~/.claude 递归授权——里面的 .credentials.json 是该用户的登录令牌：
       setfacl -m u:${COLLECT_USER}:x /home/zhangsan
       setfacl -m u:${COLLECT_USER}:rx /home/zhangsan/.claude
       setfacl -R -m u:${COLLECT_USER}:rX /home/zhangsan/.claude/projects
       setfacl -R -d -m u:${COLLECT_USER}:rX /home/zhangsan/.claude/projects
  3. （可选）账号额度查询（5 小时 / 每周额度）需要读取登录令牌文件，默认关闭（config.json 的 "allowAccountQueries": false）。
     关闭时平台只是不显示这台服务器上账号的额度，用量采集不受影响。确实需要时再单独授权并改为 true：
       setfacl -m u:${COLLECT_USER}:r /home/zhangsan/.claude/.credentials.json   # Codex 为 ~/.codex/auth.json
       setfacl -m u:${COLLECT_USER}:r /home/zhangsan/.claude.json                # 识别登录的是哪个账号；并把 "/home/*/.claude.json" 加进 allowedDirs
     注意：CLI 续期令牌时会重写该文件，单文件的 ACL 可能随之丢失；采集账户因此能读到该用户的登录令牌，请自行权衡。
  4. 在平台“服务器管理”中添加本机（SSH 用户名 ${COLLECT_USER}），扫描并核对主机指纹：
       ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
MSG
