-- 账号额度提醒：剩余比例低于阈值时通知。告警记录新增一种类型
ALTER TABLE alert_events DROP CONSTRAINT alert_events_kind_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_kind_check CHECK (kind IN ('usage', 'collection_failure', 'account_limit'));
