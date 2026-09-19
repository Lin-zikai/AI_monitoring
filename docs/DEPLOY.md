# 部署与运维

## 1. 组件

| 容器 | 作用 | 可否多实例 |
| --- | --- | --- |
| `api` | 前端静态文件 + 后台 API；启动时执行数据库迁移、创建初始管理员 | 可以 |
| `collector` | 定时建批、SSH 采集、入库、评估告警 | 可以（批次按时点唯一，目标有锁） |
| `mailer` | 轮询发件箱发送邮件、失败退避重试 | 可以（`FOR UPDATE SKIP LOCKED`） |
| `postgres` | 全部业务数据；发件箱与告警记录的事实来源 | — |
| `redis` | BullMQ 队列与定时器；丢失后可重建，不含业务数据 | — |
| `caddy` | HTTPS 反向代理，自动证书 | — |

网页请求不会触发 SSH 采集，页面展示的是最近一次成功入库的结果。

## 2. 中央平台

```bash
cp .env.example .env
mkdir -p secrets && openssl rand -base64 32 > secrets/master_key && chmod 600 secrets/master_key
docker compose up -d --build
docker compose logs -f api collector mailer
```

- `secrets/master_key` 是 SSH 私钥与 SMTP 密码的主加密密钥，**不在数据库里，也不在 `.env` 里**。丢失后所有已保存的凭据无法解密，只能重新录入。
- 首次登录后修改管理员密码，并从 `.env` 删除 `ADMIN_PASSWORD`。
- 内网无公网证书时，把 `deploy/Caddyfile` 的站点块加上 `tls internal`，或挂载自有证书。

## 3. 被采集服务器

有两种接入方式：

| | 自动安装（省事） | 手工安装受限账户（更安全，方案推荐） |
| --- | --- | --- |
| 做法 | 平台上“添加服务器”并选好归属用户即可，其余全部自动（记录指纹、安装采集组件、创建 Claude Code / Codex 目标、首次采集）；失败后修正问题，点“更多 → 重新接入” | 按下文用 root 执行 `remote/install.sh` |
| 前提 | 该 SSH 密钥在远端有普通 shell 权限；远端能访问外网（nodejs.org / npm 源，或其国内镜像） | root 权限 |
| 装到哪里 | 该账户的 `~/.local/share/usage-monitor/`：采集脚本与配置（几百 KB）。远端已有的 Node.js 直接复用；缺少时才下载（校验 SHA256，约 100 MB） | `/usr/local/bin`、`/etc/ccusage-collect` |
| 密钥权限 | 密钥本身能登录 shell——密钥泄露等同于该账户泄露，建议仍使用专用账户与专用密钥 | 密钥被 `command="…",restrict` 锁定，只能运行采集脚本 |

自动安装后 ccusage **始终使用最新版**：每次采集都通过 `npx --yes ccusage@latest` 运行，有新版本时自动确认更新后再取数。远端已装过的 ccusage 不会被改动，只在取不到最新版（npm 源不可达）时作为后备；两者都没有时才装一份固定版本。不锁版本号，但平台会对每次结果做结构与合计校验（新版改了输出格式会失败并保留旧数据，而不是入库错误数据），并把 ccusage 版本随每行统计记录在 `price_version`。接口 `POST /api/servers/:id/install-collector` 仍接受 `{"mode": "auto" | "pinned"}`，用于需要复用已装版本或固定版本的场合。

数据源：Claude Code（默认目录 `~/.claude`）与 Codex（默认目录 `~/.codex`）。添加采集目标时可同时勾选，每个数据源各建一个目标。Codex 的总量采用 ccusage 给出的 `totalTokens`（OpenAI 口径下输入可能已含缓存命中，不自行相加）；ccusage 只给出 Codex 的日级费用，平台按各模型 Token 占比分摊到模型行，日合计保持精确。

主机指纹采用“首次连接自动信任”：第一次接入时记录指纹并写入审计日志，之后每次采集都会核对，不一致即拒绝连接（`HOST_KEY_MISMATCH`）；服务器确实重装过时，在“更多 → 主机指纹”里重新确认。对安全要求高的服务器，可在接入后用 `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` 核对平台记录的指纹。

下面是手工安装的步骤。

每台服务器执行一次（需要 root 与 Node.js ≥ 20）：

```bash
scp -r remote/ root@server-a:/tmp/usage-remote
ssh root@server-a 'cd /tmp/usage-remote && ./install.sh "ssh-ed25519 AAAA... usage-monitor"'
```

脚本会：安装固定版本 `ccusage@20.0.23`；安装 `/usr/local/bin/ccusage-collect`；创建专用账户 `ccusage-collector`；写入带 `command="…",restrict` 的 `authorized_keys`——该密钥登录后**只能**运行采集脚本。

然后：

1. 编辑 `/etc/ccusage-collect/config.json` 的 `allowedDirs`，只保留要采集的目录（支持 `*` 匹配单个路径段）。
2. 给采集账户授予只读权限：
   ```bash
   setfacl -m u:ccusage-collector:x /home/zhangsan
   setfacl -R -m u:ccusage-collector:rX /home/zhangsan/.claude
   setfacl -R -d -m u:ccusage-collector:rX /home/zhangsan/.claude   # 新文件自动继承
   ```
3. 记下主机指纹，供平台上核对：`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`

无法集中授权时，可以不建专用账户：把同一行 `command="…",restrict <公钥>` 加到用户自己的 `~/.ssh/authorized_keys`，并在平台的采集目标上覆盖 SSH 用户名（必要时覆盖凭据）。

### 没有 root 时：只采集自己的账户

`/etc/ccusage-collect/config.json` 写不了时，把脚本和配置放在自己的家目录，并在 forced command 里指明配置路径与 PATH（非交互 SSH 会话通常不加载 `.bashrc`）：

```bash
npm i -g ccusage@20.0.23
install -m 0755 remote/ccusage-collect.mjs ~/.local/bin/ccusage-collect
mkdir -p ~/.config/ccusage-collect    # config.json：allowedDirs 只放自己的 ~/.claude，ccusageBin 写绝对路径
echo 'command="PATH=<ccusage 所在目录>:/usr/bin:/bin CCUSAGE_COLLECT_CONFIG=<家目录>/.config/ccusage-collect/config.json /usr/bin/node <家目录>/.local/bin/ccusage-collect",restrict <公钥>' >> ~/.ssh/authorized_keys
```

平台上添加服务器时 SSH 用户名填自己的账户名，采集命令保持 `ccusage-collect`（forced command 下命令名只是占位）。

**隐私说明**：采集账户对会话日志有读权限（ccusage 需要读取它们），但采集脚本只向平台输出按日、按模型的 Token 与费用统计，不上传提示词、回答或会话内容。

**费用口径**：`config.json` 的 `costMode`（`auto`/`calculate`/`display`）与 `offline` 决定估算费用的计算方式，平台会把 ccusage 版本与计价模式随每行统计一起记录（`price_version`）。各服务器应保持同一版本与同一配置；升级 ccusage 时同步修改 `expectedCcusageVersion`，版本不符时采集会明确失败而不是混入不同口径的数据。

## 4. 日常运维

| 场景 | 处理 |
| --- | --- |
| 某目标显示“数据过期” | 服务器管理页看错误码：`CONNECT_*`/`UNREACHABLE` 网络问题；`AUTH_FAILED` 公钥未安装；`HOST_KEY_MISMATCH` 主机重装或遭劫持，核实后重新确认指纹；`DIR_MISSING`/`DIR_UNREADABLE`/`DIR_NOT_ALLOWED` 目录或权限/白名单问题；`CCUSAGE_VERSION_MISMATCH` 版本不符 |
| 恢复连接后 | 无需手工操作：下一轮采集会从上次成功的前一天开始补齐 |
| 行被标记 `retained` / `decrease_flagged` | 远端日志被清理或变小（Claude Code 默认会清理旧日志）。平台保留旧值。确认新值才正确时，在目标上执行“接受用量减少并覆盖”的手动采集 |
| 日志迁移到另一台服务器 | 旧目标设置“来源结束日期”，新目标设置“来源开始日期”，避免同一份日志被统计两次 |
| 用户换人/换绑定 | 使用“调整绑定”：默认从生效日起归新用户；需要迁移历史时勾选历史重归属（写入审计日志） |
| 轮换采集密钥 | 凭据页“轮换”录入新私钥 → 各服务器更新 `authorized_keys`。紧急情况先“撤销”，采集会立即停止使用该凭据 |
| 邮件最终失败 | 告警记录页查看失败原因，修复 SMTP 后点“重试” |
| 修改采集周期/时区 | 系统设置保存后立即生效（重新登记定时器） |

## 5. 备份与恢复

需要**分别**备份两样东西，缺一不可：

1. 数据库：`docker compose exec postgres pg_dump -U usage -Fc usage > usage-$(date +%F).dump`（建议每日，并异地保存）
2. 主密钥 `secrets/master_key`：放入密码管理器或离线介质，**不要**和数据库备份放在一起。

恢复演练（建议上线前做一次并记入验收记录）：

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U usage -d usage --clean --if-exists < usage-2026-09-19.dump
# 放回 secrets/master_key 后
docker compose up -d
```

验证：登录 → 服务器管理 → 对任一服务器点“测试连接”。成功说明凭据可被主密钥解密。Redis 无需备份；其数据丢失后，Worker 启动时会重新登记定时器，并为当前时点补建采集批次。

## 6. 升级

```bash
git pull && docker compose up -d --build
```

数据库迁移在启动时自动执行（带咨询锁，多容器同时启动是安全的）。迁移文件位于 `server/migrations/`，只增不改。
