-- 只有管理员登录网页；普通用户只是被统计的人，邮箱仅作为可选的告警收件地址
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_login_needs_email CHECK (password_hash IS NULL OR email IS NOT NULL);
