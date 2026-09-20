-- 采集组件的安装方式按服务器持久化：auto（复用远端已装的 ccusage）/ latest（每次采集经 npx 取最新版，默认）/ pinned（平台固定版本）。
-- 采集脚本自动升级时沿用这台服务器当初选择的方式，不再悄悄改成默认值。
ALTER TABLE servers ADD COLUMN install_mode text NOT NULL DEFAULT 'latest' CHECK (install_mode IN ('auto', 'latest', 'pinned'));

-- 已接入的服务器保持默认的 latest：此前界面从不传安装方式，它们当初请求的都是 latest；
-- 审计记录里的 reused / installed 只是安装当时 npm 源不可达的临时回退，不代表管理员的选择。
