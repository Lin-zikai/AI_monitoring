#!/usr/bin/env bash
# 不依赖 Docker 的本机运行方式（演示/试用）：嵌入式 PostgreSQL + 本地 redis-server + API/采集/邮件三个进程。
#   scripts/local-run.sh start|stop|status
# 数据、密钥与日志都在 .local-run/（已被 git 忽略）。正式部署请用 docker compose + HTTPS。
# redis-server 取自 REDIS_SERVER_BIN、.local-run/bin/redis-server 或 PATH。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local-run"
PORT="${PORT:-3000}"; PG_PORT="${PG_PORT:-54320}"; REDIS_PORT="${REDIS_PORT:-6391}"
mkdir -p "$RUN/logs" "$RUN/pids"

running() { [ -f "$RUN/pids/$1" ] && kill -0 "$(cat "$RUN/pids/$1")" 2>/dev/null; }
launch() { local name=$1; shift; running "$name" && return 0; nohup "$@" > "$RUN/logs/$name.log" 2>&1 & echo $! > "$RUN/pids/$name"; }
wait_for() { for _ in $(seq 1 60); do grep -q "$2" "$RUN/logs/$1.log" 2>/dev/null && return 0; sleep 1; done; echo "$1 启动超时，见 $RUN/logs/$1.log" >&2; exit 1; }

case "${1:-start}" in
start)
  if [ ! -f "$RUN/env" ]; then
    umask 077
    { echo "PG_PASSWORD=$(openssl rand -hex 16)"; echo "MASTER_KEY=$(openssl rand -base64 32)"; echo "JWT_SECRET=$(openssl rand -hex 32)"
      echo "ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}"; echo "ADMIN_PASSWORD=$(openssl rand -base64 15)"; } > "$RUN/env"
  fi
  set -a; . "$RUN/env"; set +a
  REDIS_BIN="${REDIS_SERVER_BIN:-$([ -x "$RUN/bin/redis-server" ] && echo "$RUN/bin/redis-server" || command -v redis-server || true)}"
  [ -n "$REDIS_BIN" ] || { echo "找不到 redis-server（设置 REDIS_SERVER_BIN）" >&2; exit 1; }

  [ -d "$ROOT/server/node_modules" ] || (cd "$ROOT/server" && npm ci)
  [ -d "$ROOT/web/node_modules" ] || (cd "$ROOT/web" && npm ci)
  (cd "$ROOT/server" && npm run build >/dev/null)
  (cd "$ROOT/web" && npm run build >/dev/null)

  launch postgres node "$ROOT/scripts/local-pg.mjs" "$RUN/pgdata" "$PG_PORT" "$PG_PASSWORD"
  wait_for postgres 'postgres ready'
  launch redis "$REDIS_BIN" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$RUN" --appendonly yes --maxmemory-policy noeviction
  sleep 1

  export DATABASE_URL="postgres://usage:$PG_PASSWORD@127.0.0.1:$PG_PORT/usage" REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
  export API_HOST="${API_HOST:-0.0.0.0}" API_PORT="$PORT" WEB_DIST="$ROOT/web/dist"
  export COOKIE_SECURE="${COOKIE_SECURE:-false}" PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://$(hostname -I | awk '{print $1}'):$PORT}"
  cd "$ROOT/server"
  launch api node dist/main-api.js;             wait_for api 'Server listening'
  launch collector node dist/main-collector.js; wait_for collector '采集 Worker 已启动'
  launch mailer node dist/main-mailer.js;       wait_for mailer '邮件 Worker 已启动'
  echo "已启动：$PUBLIC_BASE_URL"
  echo "管理员：$ADMIN_EMAIL  初始密码见 $RUN/env（登录后请修改）"
  ;;
stop)
  for name in mailer collector api redis postgres; do
    running "$name" && kill "$(cat "$RUN/pids/$name")" && echo "已停止 $name"; rm -f "$RUN/pids/$name"
  done
  ;;
status)
  for name in postgres redis api collector mailer; do running "$name" && echo "$name: 运行中 (pid $(cat "$RUN/pids/$name"))" || echo "$name: 未运行"; done
  ;;
*) echo "用法: $0 start|stop|status" >&2; exit 1 ;;
esac
