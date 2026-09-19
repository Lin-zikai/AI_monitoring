-- 告警邮件不再发给用户本人：统一发给管理员（以及规则里额外指定的邮箱）
UPDATE alert_rules SET notify_admins = true, notify_user = false;
ALTER TABLE alert_rules ALTER COLUMN notify_user SET DEFAULT false;
ALTER TABLE alert_rules ALTER COLUMN notify_admins SET DEFAULT true;
