# 使用示例

**简体中文** · [English](EXAMPLES.en.md) · [返回 README](../README.md)

以下账户、服务器、路径和用量均为虚构示例。请替换为实际配置；这些示例不会自动写入平台数据库。

## 1. 为一个团队接入三台服务器

先在“用户列表”创建 Alice 和 Bob，团队均设为 `Research`，Alice 的月预算设为 US$100。然后在“服务器管理”逐个添加服务器，填写实际可达地址、SSH 端口、账户和对应私钥。

| 服务器名称 | 归属用户 | SSH 账户 | 需要保留的采集目标 | 数据目录 |
| --- | --- | --- | --- | --- |
| `gpu-01` | Alice | `alice` | Claude Code | `/home/alice/.claude` |
| `cpu-01` | Alice | `alice` | Codex | `/data/alice/codex` |
| `dev-01` | Bob | `bob` | Codex | `/home/bob/.codex` |

添加服务器会自动创建 Claude Code 和 Codex 两个目标。如果某台机器只使用一种工具，可以停用另一个目标，或保留“目录不存在视为未使用”。不要为了消除“未使用”而创建空目录。

对每个在用的目标依次执行“测试目录”和手动采集。预期结果：目标状态为“正常”、最近成功时间更新；有有效会话日志时出现统计数据。Alice 的两台服务器用量汇总到同一个用户，Bob 单独统计。

## 2. 主目录或日志目录不在默认位置

假设 `alice` 的真实主目录是 `/users/alice`，Codex 又单独使用 `/data/alice/codex`。

在被采集服务器上，以实际运行工具的账户执行以下只读检查：

```bash
getent passwd alice
printf 'HOME=%s\nCODEX_HOME=%s\nCLAUDE_CONFIG_DIR=%s\n' \
  "$HOME" "${CODEX_HOME:-}" "${CLAUDE_CONFIG_DIR:-}"
ls -ld /users/alice/.claude/projects /data/alice/codex/sessions
```

环境变量输出仅反映当前 shell；如果工具从其他终端、服务或启动器运行，还需核对其环境。

在平台中编辑目标：

| 数据源 | 正确的数据目录 |
| --- | --- |
| Claude Code | `/users/alice/.claude` |
| Codex | `/data/alice/codex` |

填写工具的数据根目录，**不要填末尾的 `projects` 或 `sessions`**。保存后测试目录并手动采集。“未使用”表示目录未找到；空用量则可能表示目录存在但所选日期没有有效记录。

## 3. 配置预算提醒

先在“系统设置”中配置 SMTP，并发送测试邮件。确认管理员有可接收邮件的邮箱。

在“告警规则”新建：

| 字段 | 示例值 |
| --- | --- |
| 规则名称 | 月预算 80% / 100% |
| 指标 | 月预算百分比 |
| 周期 | 月 |
| 数据源 | 全部 |
| 范围 | 全局 |
| 阈值档位 | `80`、`100` |
| 通知管理员 | 开启 |

“全局”表示规则适用于各个用户，**不是把整个团队的预算相加**。每位用户都需要设置自己的月预算，才有对应的预算百分比。

Alice 的月预算为 US$100 时：

| 采集后的当月估算费用 | 预期结果 |
| --- | --- |
| US$79 | 未达到阈值 |
| US$82 | 首次达到 80% 档，生成提醒 |
| US$85 | 同周期不重复发送已触发的 80% 档 |
| US$101 | 首次达到 100% 档，生成更高档提醒 |

如果一次采集跨过多个档位，只发送本次最高档位对应的邮件。提醒发生在采集入库后，并受 SMTP 投递状态影响。账目明细中的实际账单不会替代这里的 ccusage 估算费用。

开发者也可以使用 [monthly-budget-rule.json](../examples/monthly-budget-rule.json) 作为已登录管理员调用 `POST /api/alerts/rules` 的 JSON 请求体。平台使用登录 Cookie 认证；该文件不是网页的导入文件，也不包含凭据。只选择网页或 API 一种方式创建，避免重复建规则。

## 4. 手工部署的远端采集配置

[collector.config.json](../examples/collector.config.json) 是远端采集脚本使用的模板，适合需要明确目录白名单的手工部署。**它不是中央平台的 `.env`，也不是 Docker Compose 配置。**

```json
{
  "allowedDirs": ["/home/alice/.claude", "/data/alice/codex"],
  "ccusageBin": "/usr/local/bin/ccusage",
  "expectedCcusageVersion": "20.0.23",
  "costMode": "auto",
  "offline": true,
  "timeoutSeconds": 60,
  "totalTimeoutSeconds": 105,
  "allowAccountQueries": false
}
```

按以下步骤使用：

1. 根据[部署文档](DEPLOY.md)安装远端采集脚本和 ccusage。该模板采用固定版本 `20.0.23`，需与已安装版本一致。
2. 将 `allowedDirs` 改为当前这台机器上的实际目录。不同服务器使用各自的配置；若使用示例 2 的主目录，把 Claude 路径改成 `/users/alice/.claude`。
3. 用 `command -v ccusage` 核对 `ccusageBin`，并确认 SSH 采集账户可以读取目录中的日志。白名单不会授予操作系统文件权限。
4. 把调整后的模板保存为 `/etc/ccusage-collect/config.json`；无 root 时可保存到自己的目录，并通过 `CCUSAGE_COLLECT_CONFIG` 指定。已有配置应先备份再编辑。
5. 保持 `allowAccountQueries: false` 可以只采集用量。需要订阅额度查询时，按部署文档单独配置登录令牌读取权限。

在已安装采集脚本、配置路径正确且具有读取权限的远端账户下，可直接验证一天的统计：

```bash
ccusage-collect --source claude-code --dir /home/alice/.claude \
  --since 20260921 --until 20260921 --timezone Asia/Shanghai

ccusage-collect --source codex --dir /data/alice/codex \
  --since 20260921 --until 20260921 --timezone Asia/Shanghai
```

把日期改成实际有日志的日期。命令应输出 JSON；这里直接运行只生成统计结果，不写入中央数据库。中央入库仍由平台的手动或定时采集完成。

## 5. 如何理解面板上的数字

假设同一天采集到以下统计（仅为说明汇总方式，不是实际模型报价）：

| 用户 | 服务器 / 数据源 | Token | 估算费用 |
| --- | --- | ---: | ---: |
| Alice | gpu-01 / Claude Code | 1,200,000 | US$24 |
| Alice | cpu-01 / Codex | 800,000 | US$16 |
| Bob | dev-01 / Codex | 500,000 | US$10 |

- Alice 当天合计：**2,000,000 Token / US$40**。
- Bob 当天合计：**500,000 Token / US$10**。
- 三个来源当天合计：**2,500,000 Token / US$50**。
- 对相同日志重新采集一次，合计保持不变。

账号额度卡片的百分比由服务商返回，不能从上表 Token 或费用反推。如果实际订阅账单是 US$20，应在“账目明细”单独记账，不能用上表的估算费用替代。

---

[返回 README](../README.md) · [English examples](EXAMPLES.en.md) · [部署与运维](DEPLOY.md)
