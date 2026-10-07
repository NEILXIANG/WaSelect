-- 029：order_items 加 line_no（下单顺序），读取按它排（工程缺口第二轮复核 2026-10-06）。
--
-- @why 行 id 是 `oi-<uuid v4>`，买家详情 / 管理端详情 / 待采购 / 报关与订单 CSV 原先都按 id 排序——
--      等于**随机顺序**：买家按 A、B、C 下单，各处的行序每张单都不一样，采购勾选与核对时对不上。
--      金额不受影响（declared_value_usd 跟着行走），所以一直没人报错。
-- @why 可空、不回填：存量行没有下单顺序可还原（id 本身是随机的），硬填一个序号是在编造事实；
--      读取用 `line_no nulls last, id`，存量单维持原样，新单按下单顺序。
-- @breaking ⚠️ up 段 `ADD CONSTRAINT order_items_line_no_positive CHECK`：形式上是收紧，但约束的是**本迁移新加、
--      存量全为 NULL** 的列，且 NULL 放行——对存量数据不可能失败，旧代码不写这一列也不受影响。回滚直接 down 即可。
-- @limitation 不加 (order_id, line_no) 唯一约束：写入方只有 insertOrderItems 一处、按数组下标生成，
--      加约束要么回填存量（见上），要么做成部分唯一索引——收益不抵复杂度，需要时再加。
--
-- @see server/src/adapters/orders.ts（insertOrderItems 写入、listOrderItemsWithImage 读取）；
--      server/src/adapters/orders-admin.ts；server/src/adapters/exports.ts

-- Up migration

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_no SMALLINT;
ALTER TABLE order_items ADD CONSTRAINT order_items_line_no_positive CHECK (line_no IS NULL OR line_no >= 1);

-- Down migration

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_line_no_positive;
ALTER TABLE order_items DROP COLUMN IF EXISTS line_no;
