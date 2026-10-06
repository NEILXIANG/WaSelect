-- 027：order_items 快照成本价、HS 码、英文报关品名（剩余清单 1-3 / B4 / B5）。
--
-- @why 与 021 的采购快照同一条理由：这三列在 products 上会被改（换供应商 → 成本变；
--      报关归类复核 → HS 码变；文案调整 → 报关品名变），订单只认**下单那一刻**的值。
--      JOIN products 的后果是"历史单的毛利被悄悄重算""已寄出包裹的报关资料与面单对不上"，
--      且没有任何一方报错。
-- @why 列名沿用 products 的 cost_jpy / hs_code / customs_desc_en，长度与类型逐列照抄：
--      快照列比源列短，就会在建单时被 22001 拦下（同一类问题见 CLAUDE.md 约束十 catalog.ts 邮编反例）。
-- @why cost_jpy 加非负约束，与 023 的 products_cost_jpy_nonneg 同口径。
-- @breaking ⚠️ up 段 `ADD CONSTRAINT … CHECK`：收紧（同 002 / 017）。但约束挂在**本迁移新加、全为 NULL**的列上，
--      存量行天然满足（NULL 放行），旧版本代码不写这一列，所以实际不会让任何旧写入失败。
-- @limitation 迁移前的历史订单行三列都是 NULL，不做回填：回填只能拿**当前**商品值，
--      那恰恰是本迁移要避免的"用今天的值冒充当时的值"。展示层按"未记录"降级。
-- @tradeoff cost_jpy 是内部信息（泄露成本 = 泄露毛利），只在管理端下发；放进 order_items
--      多了一处"顺手下发给买家"的风险——由契约 OrderItem / AdminOrderItem 分层与路由测试守住。
--
-- @see server/src/app/create-order.ts（写入）；server/src/app/admin-order-routes.ts（读出）；
--      contracts/api-contract.yaml 0.6.31 AdminOrderItem

-- Up migration

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cost_jpy BIGINT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS hs_code VARCHAR(10);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS customs_desc_en VARCHAR(120);
ALTER TABLE order_items
  ADD CONSTRAINT order_items_cost_jpy_nonneg CHECK (cost_jpy IS NULL OR cost_jpy >= 0);

-- Down migration

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_cost_jpy_nonneg;
ALTER TABLE order_items DROP COLUMN IF EXISTS customs_desc_en;
ALTER TABLE order_items DROP COLUMN IF EXISTS hs_code;
ALTER TABLE order_items DROP COLUMN IF EXISTS cost_jpy;
