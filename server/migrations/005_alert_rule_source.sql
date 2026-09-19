-- 告警规则可以限定数据源（NULL = 所有数据源合计）；告警记录留存触发时的数据源
ALTER TABLE alert_rules ADD COLUMN source text;
ALTER TABLE alert_events ADD COLUMN source text;
