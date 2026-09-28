-- 013：`payments.dispute_opened_at`——拒付的**开案时间**（I2 U-E）。
--
-- @why 契约 `Dispute` 有 `opened_at`，前端风控页（`admin-web/src/risk/view.ts`）读它做展示。
--      `payments` 已有 `dispute_id / dispute_status / dispute_amount / dispute_closed_at`，
--      唯独缺"什么时候开的案"——于是 `opened_at` 只能拿别的列顶替（`created_at` / `updated_at`），
--      而顶替的后果是**运营看到的开案时间是错的，并且没有任何一方报错**：
--      这与 D-46（运费取档方向）是同一类事故形态——错在展示层、静默、且责任人看不见。
--
-- @why 允许 NULL 而不是 `not null default now()`：拒付一定由机构事件写入，
--      "开案时刻"应当取**机构报文里的时间**（Stripe `created`），而不是"我们入库的那一刻"。
--      两者可以相差数小时（回调重试、队列积压），而**判断举证期限的起点是开案时刻**——
--      用入库时间会把举证窗口算短。列允许 NULL，是为了让"没有开案时刻"这件事暴露出来
--      （它表示写入方漏了字段），而不是被 `now()` 静默填平。
--
-- @limitation 本迁移**只加列，不回填历史数据**：目前没有任何服务端代码写 `dispute_*` 这四列
--      （Stripe dispute 事件的落地尚未实现），所以表里不存在需要回填的历史行。
--      ⚠️ dispute 写入方落地时必须保证 `dispute_id` 与 `dispute_opened_at` **同时**写入——
--      只写前者会让这一条出现在列表里却带着空的开案时间（不好判定"是什么时候出的事"）。
--
-- @see contracts/api-contract.yaml（Dispute）；server/src/adapters/risk-admin.ts（唯一读取方）；
--      migrations/001_init.sql（payments 表）；docs/自主决策记录.md AJ-154
-- Up migration

ALTER TABLE payments ADD COLUMN IF NOT EXISTS dispute_opened_at TIMESTAMPTZ;

-- Down migration

ALTER TABLE payments DROP COLUMN IF EXISTS dispute_opened_at;
