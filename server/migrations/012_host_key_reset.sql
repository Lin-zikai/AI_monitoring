-- 改过地址/端口的服务器：旧指纹作废后必须由管理员人工核对新指纹，接入流程不再对它“首次连接自动信任”
ALTER TABLE servers ADD COLUMN host_key_reset boolean NOT NULL DEFAULT false;
