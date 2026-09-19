-- 账号额度快照：服务商侧的 5 小时 / 周额度已用比例与刷新时间。只存百分比与时间，不存任何令牌
CREATE TABLE account_limit_snapshots (
  id             bigserial PRIMARY KEY,
  provider       text NOT NULL,
  target_id      uuid REFERENCES collection_targets(id) ON DELETE SET NULL,
  server_name    text,
  status         text NOT NULL CHECK (status IN ('ok', 'error')),
  plan           text,
  windows        jsonb NOT NULL DEFAULT '[]',
  error_code     text,
  error_message  text,
  fetched_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_limit_snapshots_latest_idx ON account_limit_snapshots (provider, status, fetched_at DESC);
