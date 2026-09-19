# 多用户用量监控平台（基于 ccusage）

按 [PROJECT_PLAN.md](PROJECT_PLAN.md) 实现：通过 SSH 定期采集多台服务器上的 ccusage 统计，按人跨服务器汇总，网页展示，并在超过阈值时发邮件提醒。

```
server/   后台 API + 采集 Worker + 邮件 Worker（Node.js 20 / TypeScript / Fastify / PostgreSQL / BullMQ）
web/      前端（React / TypeScript / Ant Design / ECharts）
remote/   部署到被采集服务器的受限采集脚本与安装脚本
deploy/   反向代理配置
docs/     部署运维文档、验收记录
```

## 快速开始（Docker Compose）

```bash
cp .env.example .env                       # 填写域名、数据库密码、JWT_SECRET、初始管理员
mkdir -p secrets && openssl rand -base64 32 > secrets/master_key && chmod 600 secrets/master_key
docker compose up -d --build
```

打开 `https://<SITE_DOMAIN>`，用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录，然后：

1. **系统设置**：配置 SMTP 并发送测试邮件。
2. **服务器管理 → 凭据**：录入采集用的 SSH 私钥（加密保存，之后只显示指纹）。
3. 被采集服务器上需要采集组件：密钥有 shell 权限时可在平台上一键“自动安装”；追求最小权限时，在服务器上执行 `remote/install.sh "<对应公钥>"` 并授予目录只读权限（两种方式的对比见 DEPLOY.md §3）。
4. **服务器管理**：添加服务器 → 扫描并核对主机指纹 → 测试连接 → 添加采集目标（绑定用户与数据目录）→ 测试目录 → 立即采集。
5. **告警规则**：配置每日/每月 Token、估算费用、月预算百分比等规则。

之后系统在统计时区（默认 Asia/Shanghai）每日 00:00、02:00、04:00…… 自动采集。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 不用 Docker 的本机运行（演示/试用）

```bash
scripts/local-run.sh start     # 嵌入式 PostgreSQL + 本地 redis-server + 三个进程，默认监听 0.0.0.0:3000
scripts/local-run.sh status
scripts/local-run.sh stop
```

数据、随机生成的密钥与初始管理员密码都在 `.local-run/`（已被 git 忽略，`env` 文件权限 600）。需要本机有 `redis-server`（或用 `REDIS_SERVER_BIN` 指定）。这种方式走明文 HTTP，登录密码与会话 Cookie 在网络上不加密，只适合可信内网试用；正式使用请走上面的 Docker Compose + HTTPS。

## 本地开发

需要本机有 PostgreSQL 与 Redis：

```bash
cd server && npm install
export DATABASE_URL=postgres://... REDIS_URL=redis://127.0.0.1:6379 \
       MASTER_KEY=$(openssl rand -base64 32) JWT_SECRET=$(openssl rand -hex 32) \
       COOKIE_SECURE=false ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=change-me-please
npm run dev:api & npm run dev:collector & npm run dev:mailer &

cd ../web && npm install && npm run dev     # http://localhost:5173，/api 代理到 :3000
```

测试（自带 embedded-postgres，无需 Docker 或外部数据库；不需要 Redis）：

```bash
cd server && npm test
```

## 关键设计（与方案的对应）

| 方案要求 | 实现位置 |
| --- | --- |
| 受限采集命令、禁止拼接远程命令（§4、§9） | `remote/ccusage-collect.mjs` 只接受白名单参数与白名单目录；`server/src/collect/command.ts` 对所有参数做字符集校验；`install.sh` 用 `command=…,restrict` 锁定密钥 |
| 主机指纹校验（§4、§9） | `server/src/ssh/client.ts`：未确认或不匹配即拒绝连接；改地址/端口后强制重新确认 |
| 每 2 小时调度、补采、不重复建批（§4.1） | `collect/scheduler.ts`：`scheduled_slot` 唯一；重启后只为最近时点补建一次，缺口由采集范围覆盖 |
| 同目标加锁、旧结果不覆盖新结果（§4.1、§13） | `collect/runner.ts`：带租约的目标锁，入库事务内复核租约 |
| 按日期重算、覆盖快照、不累加（§6） | `collect/ingest.ts`：以“目标+数据源+日期+模型”为唯一键，整日事务性替换 |
| 空结果 vs 目录缺失/权限异常（§6） | 远端脚本返回带错误码的信封；失败时保留上次成功数据 |
| 日志被清理不清零、异常减少打标（§6） | `ingest.ts` 的 `retained` / `decrease_flagged`；管理员可显式“接受减少并覆盖” |
| 来源切换边界（§6） | 采集目标的 `source_start_date` / `source_end_date` |
| 绑定调整保留历史归属（§11） | `target_user_bindings` 按生效日期归属；显式历史重归属需单独确认并写审计 |
| 告警每周期每档只一次、跨日跨月、回填不补发（§8.2） | `alerts/evaluate.ts`：`dedupe_key` 唯一；同时评估刚结束周期；回填只评估当前周期 |
| 告警与邮件任务同事务（§8.2） | 入库、告警记录、`email_outbox` 在同一事务；邮件 Worker 轮询发件箱，稳定 Message-ID |
| 数据不完整提示（§7、§8.2） | 邮件与页面均标注未更新的来源；失联不显示为零 |
| 凭据加密、不回显、审计、脱敏（§9） | AES-256-GCM（主密钥独立于数据库）；接口只返回指纹；`audit_logs`；日志 redact |
| 后台权限校验（§7） | 每个请求回库校验身份与角色；普通用户的统计查询被强制收窄到本人 |
| Token 大整数、费用定点数、未知≠零（§5） | `bigint` / `numeric(18,6)`；缺失字段为 `NULL`，前端显示“未知” |

## 已知边界

- 数据源支持 Claude Code 与 Codex；其他工具在 `server/src/collect/adapter.ts` 增加适配器，并在远端脚本的 `SOURCES` 中登记。
- 费用是 ccusage 的**估算费用**，不代表订阅实际扣费或官方剩余额度。
- 不提供实时告警：从用量变化到收到邮件最长约一个采集周期加处理耗时。
- 多人共用同一账户与目录时只能整体归属到一个平台用户（可标记“共享账户”）。
- 不支持跳板机（方案 §14 待确认项）；中央平台需能直连各服务器的 SSH 端口。
