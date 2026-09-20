-- 远端账户用环境变量（CODEX_HOME / CLAUDE_CONFIG_DIR）把数据目录改到了别处时，记录实际目录以提示管理员
ALTER TABLE collection_targets ADD COLUMN dir_hint text;
