-- 核心数据表（对应方案第 11 节）。时间一律 timestamptz（UTC 存储），统计日期为统计时区下的自然日。

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  email               text NOT NULL,
  role                text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  team                text,
  password_hash       text,
  monthly_budget_usd  numeric(18,6) CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- 凭据：私钥与口令整体以 AES-256-GCM 加密，主密钥不入库
CREATE TABLE credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL UNIQUE,
  kind                text NOT NULL DEFAULT 'ssh_private_key' CHECK (kind IN ('ssh_private_key')),
  ciphertext          bytea NOT NULL,
  iv                  bytea NOT NULL,
  auth_tag            bytea NOT NULL,
  key_version         integer NOT NULL DEFAULT 1,
  public_fingerprint  text NOT NULL,
  key_type            text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  rotated_at          timestamptz,
  revoked_at          timestamptz
);

CREATE TABLE servers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL UNIQUE,
  host                  text NOT NULL,
  port                  integer NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  ssh_username          text NOT NULL,
  credential_id         uuid REFERENCES credentials(id) ON DELETE RESTRICT,
  host_key_fingerprint  text,
  collect_command       text NOT NULL DEFAULT 'ccusage-collect',
  enabled               boolean NOT NULL DEFAULT true,
  last_connect_ok_at    timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_targets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id             uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source                text NOT NULL DEFAULT 'claude-code',
  data_dir              text NOT NULL,
  -- 无法集中授权时，目标可覆盖服务器级 SSH 登录
  ssh_username          text,
  credential_id         uuid REFERENCES credentials(id) ON DELETE RESTRICT,
  shared_account        boolean NOT NULL DEFAULT false,
  -- 来源切换边界：仅入库 [source_start_date, source_end_date] 内的日期
  source_start_date     date,
  source_end_date       date,
  enabled               boolean NOT NULL DEFAULT true,
  initialized_at        timestamptz,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_status           text,
  last_error_code       text,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  failure_streak_id     uuid,
  lock_run_id           uuid,
  lock_expires_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, source, data_dir)
);
CREATE INDEX collection_targets_user_idx ON collection_targets (user_id);

-- 绑定历史：某日期的用量归属于 effective_from <= 日期 的最新一条绑定
CREATE TABLE target_user_bindings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id       uuid NOT NULL REFERENCES collection_targets(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  effective_from  date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, effective_from)
);

CREATE TABLE collection_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('scheduled', 'catchup', 'manual', 'init')),
  scheduled_slot  timestamptz UNIQUE,
  reconcile       boolean NOT NULL DEFAULT false,
  target_count    integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid REFERENCES collection_batches(id) ON DELETE SET NULL,
  target_id        uuid NOT NULL REFERENCES collection_targets(id) ON DELETE CASCADE,
  trigger          text NOT NULL CHECK (trigger IN ('scheduled', 'catchup', 'manual', 'init')),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'success', 'failed', 'skipped_locked', 'stale')),
  attempt          integer NOT NULL DEFAULT 0,
  range_since      date,
  range_until      date,
  started_at       timestamptz,
  finished_at      timestamptz,
  error_code       text,
  error_message    text,
  rows_written     integer,
  anomalies        jsonb NOT NULL DEFAULT '[]',
  ccusage_version  text,
  parser_version   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_runs_target_idx ON collection_runs (target_id, created_at DESC);
CREATE INDEX collection_runs_batch_idx ON collection_runs (batch_id);

-- 统计快照：按“采集目标 + 数据源 + 日期 + 模型”唯一；Token 为 bigint，费用为定点数；NULL 表示未知而非零
CREATE TABLE usage_daily (
  id                     bigserial PRIMARY KEY,
  target_id              uuid NOT NULL REFERENCES collection_targets(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  server_id              uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  source                 text NOT NULL,
  usage_date             date NOT NULL,
  model                  text NOT NULL,
  input_tokens           bigint,
  output_tokens          bigint,
  cache_creation_tokens  bigint,
  cache_read_tokens      bigint,
  total_tokens           bigint,
  cost_usd               numeric(18,6),
  currency               text NOT NULL DEFAULT 'USD',
  cost_mode              text,
  price_version          text,
  timezone               text NOT NULL,
  integrity              text NOT NULL DEFAULT 'complete'
                         CHECK (integrity IN ('complete', 'retained', 'decrease_flagged')),
  run_id                 uuid REFERENCES collection_runs(id) ON DELETE SET NULL,
  parser_version         text NOT NULL,
  collected_at           timestamptz NOT NULL,
  UNIQUE (target_id, source, usage_date, model)
);
CREATE INDEX usage_daily_user_date_idx ON usage_daily (user_id, usage_date);
CREATE INDEX usage_daily_date_idx ON usage_daily (usage_date);

CREATE TABLE alert_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  metric         text NOT NULL CHECK (metric IN ('tokens', 'cost', 'budget_pct')),
  period         text NOT NULL CHECK (period IN ('daily', 'monthly')),
  -- tokens/cost 为绝对阈值档位；budget_pct 为用户月预算的百分比档位（如 80、100）
  tiers          numeric(24,6)[] NOT NULL CHECK (cardinality(tiers) BETWEEN 1 AND 10),
  scope_type     text NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'team', 'user')),
  scope_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  scope_team     text,
  notify_user    boolean NOT NULL DEFAULT true,
  notify_admins  boolean NOT NULL DEFAULT false,
  extra_emails   text[] NOT NULL DEFAULT '{}',
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (metric <> 'budget_pct' OR period = 'monthly'),
  CHECK ((scope_type = 'user') = (scope_user_id IS NOT NULL)),
  CHECK ((scope_type = 'team') = (scope_team IS NOT NULL))
);

-- dedupe_key：用量告警为“用户 + 规则 + 统计周期 + 阈值档位”，每个周期每档只创建一次
CREATE TABLE alert_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('usage', 'collection_failure')),
  dedupe_key         text NOT NULL UNIQUE,
  rule_id            uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name          text,
  user_id            uuid REFERENCES users(id) ON DELETE CASCADE,
  target_id          uuid REFERENCES collection_targets(id) ON DELETE SET NULL,
  metric             text,
  period_type        text,
  period_key         text,
  tier               numeric(24,6),
  observed_value     numeric(24,6),
  threshold_value    numeric(24,6),
  data_as_of         timestamptz,
  incomplete         boolean NOT NULL DEFAULT false,
  incomplete_detail  jsonb NOT NULL DEFAULT '[]',
  email_note         text,
  run_id             uuid REFERENCES collection_runs(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_user_idx ON alert_events (user_id, created_at DESC);
CREATE INDEX alert_events_created_idx ON alert_events (created_at DESC);

CREATE TABLE email_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_event_id   uuid REFERENCES alert_events(id) ON DELETE CASCADE,
  message_id       text NOT NULL UNIQUE,
  to_addrs         text[] NOT NULL,
  subject          text NOT NULL,
  body_text        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status IN ('pending', 'sending');

CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email    text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  detail         jsonb NOT NULL DEFAULT '{}',
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
