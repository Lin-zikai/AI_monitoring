-- 账目明细：管理员手工登记的实际支出（VPN、Claude Code / Codex 订阅），与 ccusage 的“按量估算”对照
-- 同一个月同一类别允许多笔（多个账号 / 多份订阅）；金额保留原币种，换算在前端按设置里的汇率进行
CREATE TABLE bills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL CHECK (category IN ('vpn', 'claude-code', 'codex')),
  bill_month  date NOT NULL CHECK (date_trunc('month', bill_month) = bill_month), -- 账单所属月份，固定存当月 1 日
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency    text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  title       text, -- 服务商 / 账号 / 套餐
  paid_on     date,
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_month_category_idx ON bills (bill_month, category);

-- 账单截图直接存库：随数据库备份一起走；API 与各 Worker 之间也没有共享磁盘
CREATE TABLE bill_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id       uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes    integer NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_attachments_bill_idx ON bill_attachments (bill_id);
