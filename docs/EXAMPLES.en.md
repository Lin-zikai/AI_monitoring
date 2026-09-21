# Usage examples

[简体中文](EXAMPLES.md) · **English** · [Back to README](../README.en.md)

All accounts, servers, paths and usage figures below are fictional. Replace them with your actual configuration. These examples do not automatically populate the platform database.

## 1. Connect three servers for a team

In 用户列表 (Users), create Alice and Bob, assign both to the `Research` team, and set Alice's monthly budget to US$100. Then add each server in 服务器管理 (Server management), using its real reachable address, SSH port, account and private key.

| Server name | Owner | SSH user | Target to keep | Data directory |
| --- | --- | --- | --- | --- |
| `gpu-01` | Alice | `alice` | Claude Code | `/home/alice/.claude` |
| `cpu-01` | Alice | `alice` | Codex | `/data/alice/codex` |
| `dev-01` | Bob | `bob` | Codex | `/home/bob/.codex` |

Onboarding creates both Claude Code and Codex targets. If a server only uses one tool, disable the other target or leave “treat a missing directory as not in use” enabled. Do not create empty directories simply to remove this status.

Run 测试目录 (Test directory), then a manual collection for each active target. Expected result: the status becomes 正常 (Normal), the last successful timestamp updates, and statistics appear if valid session logs exist. Alice's two servers roll up under one user; Bob remains separate.

## 2. Use a nonstandard home or log directory

Suppose `alice` has the home directory `/users/alice`, while Codex uses `/data/alice/codex`.

On the monitored server, run these read-only checks as the account that actually uses the tools:

```bash
getent passwd alice
printf 'HOME=%s\nCODEX_HOME=%s\nCLAUDE_CONFIG_DIR=%s\n' \
  "$HOME" "${CODEX_HOME:-}" "${CLAUDE_CONFIG_DIR:-}"
ls -ld /users/alice/.claude/projects /data/alice/codex/sessions
```

The printed environment only describes the current shell. If the tool runs from a different terminal, service or launcher, check that environment too.

Edit the platform targets to use:

| Source | Correct data directory |
| --- | --- |
| Claude Code | `/users/alice/.claude` |
| Codex | `/data/alice/codex` |

Enter the tool's data root, **not its `projects` or `sessions` subdirectory**. Save, test the directory and collect manually. 未使用 (Not in use) means the directory was not found; an empty usage result may instead mean that the directory exists but has no valid records for the selected dates.

## 3. Configure budget alerts

First configure SMTP in 系统设置 (Settings) and send a test email. Ensure the administrator has a working recipient address.

Create a rule in 告警规则 (Alert rules):

| Field | Example value |
| --- | --- |
| Name | Monthly budget 80% / 100% |
| Metric | Monthly budget percentage |
| Period | Monthly |
| Source | All |
| Scope | Global |
| Threshold tiers | `80`, `100` |
| Notify administrators | Enabled |

“Global” applies the rule to individual users; **it does not pool the entire team's budgets**. Each user needs their own monthly budget for a budget percentage to be evaluated.

With Alice's monthly budget set to US$100:

| Estimated monthly cost after collection | Expected behavior |
| --- | --- |
| US$79 | No threshold reached |
| US$82 | First crossing of 80%; create an alert |
| US$85 | Do not resend the already-triggered 80% tier in the same period |
| US$101 | First crossing of 100%; create the higher-tier alert |

If a single collection crosses several tiers, only the highest newly crossed tier generates an email. Alerts are evaluated after collection and delivery depends on SMTP. Actual bills in the expense ledger do not replace the ccusage estimates used here.

Developers can also use [monthly-budget-rule.json](../examples/monthly-budget-rule.json) as the JSON body for `POST /api/alerts/rules` with an authenticated administrator session. The platform uses login cookies; this file is not a UI import file and contains no credentials. Create the rule through either the UI or the API to avoid duplicate rules.

## 4. Configure a manually installed remote collector

[collector.config.json](../examples/collector.config.json) is a template for the remote collection script, useful when you want an explicit directory allowlist. **It is not the central platform's `.env` or a Docker Compose configuration.**

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

To use it:

1. Install the remote collector and ccusage following the [deployment guide (Chinese)](DEPLOY.md). This template pins version `20.0.23`, which must match your installed version.
2. Replace `allowedDirs` with actual directories on that machine. Each server has its own configuration. For the nonstandard home in example 2, change the Claude path to `/users/alice/.claude`.
3. Check `ccusageBin` with `command -v ccusage`, and ensure the SSH collector account can read session logs. An allowlist does not grant filesystem permissions.
4. Save the adapted template as `/etc/ccusage-collect/config.json`. Without root access, place it in an account-owned directory and set `CCUSAGE_COLLECT_CONFIG` to its path. Back up an existing configuration before editing it.
5. Leave `allowAccountQueries: false` to collect usage only. To enable subscription-limit queries, separately configure access to login tokens as described in the deployment guide.

Once the collector is installed, the configuration is in place and the remote account has read access, validate one day's statistics directly:

```bash
ccusage-collect --source claude-code --dir /home/alice/.claude \
  --since 20260921 --until 20260921 --timezone Asia/Shanghai

ccusage-collect --source codex --dir /data/alice/codex \
  --since 20260921 --until 20260921 --timezone Asia/Shanghai
```

Choose a date with actual logs. Each command should return JSON. Running it directly only produces statistics; it does not write to the central database. Use the platform's manual or scheduled collection for ingestion.

## 5. Understand the dashboard totals

Suppose the following records are collected for the same day. These figures illustrate aggregation, not actual model pricing.

| User | Server / source | Tokens | Estimated cost |
| --- | --- | ---: | ---: |
| Alice | gpu-01 / Claude Code | 1,200,000 | US$24 |
| Alice | cpu-01 / Codex | 800,000 | US$16 |
| Bob | dev-01 / Codex | 500,000 | US$10 |

- Alice's daily total: **2,000,000 tokens / US$40**.
- Bob's daily total: **500,000 tokens / US$10**.
- Combined daily total: **2,500,000 tokens / US$50**.
- Collecting the same logs again leaves those totals unchanged.

Account-limit percentages come from the provider and cannot be inferred from this table. If the actual subscription bill is US$20, record it separately in 账目明细 (Expense ledger); do not substitute estimated usage costs for actual payments.

---

[Back to README](../README.en.md) · [中文示例](EXAMPLES.md) · [Operations guide (中文)](DEPLOY.md)
