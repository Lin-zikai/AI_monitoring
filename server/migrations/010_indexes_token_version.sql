-- 外键列补索引：删除 collection_runs / alert_events（保留期清理、级联删除）时，Postgres 要逐行回查引用方，没有索引就是全表扫描
CREATE INDEX usage_daily_run_idx ON usage_daily (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX alert_events_run_idx ON alert_events (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX usage_daily_server_idx ON usage_daily (server_id);
CREATE INDEX email_outbox_alert_event_idx ON email_outbox (alert_event_id);
-- 服务器列表的“有待确认数据”标记（hasFlaggedData）：异常行极少，部分索引几乎不占空间
CREATE INDEX usage_daily_flagged_idx ON usage_daily (target_id) WHERE integrity <> 'complete';

-- 会话吊销：JWT 内嵌版本号，改密码 / 重置密码 / 改角色 / 停用 / 退出登录时递增，旧令牌随即失效
ALTER TABLE users ADD COLUMN token_version integer NOT NULL DEFAULT 0;

-- 来源切换边界必须 start <= end。已有的倒置区间本来就采不到任何数据（采集范围为空），
-- 修复时保持这一效果：清掉结束日期并停用目标，原值记入审计日志，由管理员核对后重新启用；不删除任何统计数据。
INSERT INTO audit_logs (action, entity_type, entity_id, detail)
SELECT 'migration.fix_source_date_range', 'target', id::text,
       jsonb_build_object('sourceStartDate', source_start_date, 'sourceEndDate', source_end_date, 'wasEnabled', enabled)
  FROM collection_targets WHERE source_start_date > source_end_date;
UPDATE collection_targets SET source_end_date = NULL, enabled = false, updated_at = now() WHERE source_start_date > source_end_date;
ALTER TABLE collection_targets ADD CONSTRAINT collection_targets_source_range_check
  CHECK (source_start_date IS NULL OR source_end_date IS NULL OR source_start_date <= source_end_date);

-- 筛选项里的“模型”下拉：沿该索引逐个跳到下一个不同的模型名，代替每次打开页面的全表 DISTINCT
CREATE INDEX usage_daily_model_idx ON usage_daily (model);
