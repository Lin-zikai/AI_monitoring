-- 一步接入：服务器记住默认归属用户；自动创建的采集目标允许“目录尚不存在”（该用户还没用过这个工具）
ALTER TABLE servers ADD COLUMN default_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE collection_targets ADD COLUMN missing_ok boolean NOT NULL DEFAULT false;
