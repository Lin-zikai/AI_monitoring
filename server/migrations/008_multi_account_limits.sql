-- 不同服务器可能登录不同的订阅账号：记录每个采集目标当前登录的账号，额度快照按账号保存
ALTER TABLE collection_targets ADD COLUMN account_key text, ADD COLUMN account_label text, ADD COLUMN account_checked_at timestamptz, ADD COLUMN account_error text;
ALTER TABLE account_limit_snapshots ADD COLUMN account_key text, ADD COLUMN account_label text;
DELETE FROM account_limit_snapshots; -- 旧快照没有账号标识，无法归属
DROP INDEX account_limit_snapshots_latest_idx;
CREATE INDEX account_limit_snapshots_latest_idx ON account_limit_snapshots (provider, account_key, status, fetched_at DESC);
