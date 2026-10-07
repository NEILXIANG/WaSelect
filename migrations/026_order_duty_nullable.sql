-- 026：orders.duty_jpy 允许为 NULL（W-05）——"关税无法估算"不再存成 0。
--
-- @why 报价阶段无法估算关税时 duty_jpy=null、duty_estimate=false，前端据此不显示关税行；
--      建单却因为列是 NOT NULL 而存成 0，订单详情于是显示"预估关税 0 円"——
--      同一张单，结算时说不知道关税，详情里却说关税是 0（契约 Quote 明确要求"false 时不得展示具体数字"）。
--      0 与"未知"是两回事：日本原产按 15% 计，0 只可能是"没估"，不可能是"真的是 0"。
-- @why 只放宽、不改存量：已有的 0 无法区分是"未估"还是别的，原样保留；
--      非负约束（023 的 orders_duty_jpy_nonneg）对 NULL 天然放行，不用动。
-- @limitation down 段**遇到 NULL 就失败**（工程缺口第二轮 §3.6 #5，2026-10-06 改）：原先回填成 0 再收紧，
--      回滚一次就把"关税未知"重新说成"预估关税 0 円"，正是 up 要消灭的缺陷，且不留痕。
--      真要回滚，先由人决定这些单怎么处理（down 在生产不自动执行）。
--
-- @see server/src/app/create-order.ts（写入）；server/src/app/order-views.ts（读出）；
--      contracts/api-contract.yaml（0.6.30：Order.duty_jpy nullable）；docs/自主决策记录.md AJ-367

-- Up migration

ALTER TABLE orders ALTER COLUMN duty_jpy DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN duty_jpy DROP DEFAULT;

-- Down migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE duty_jpy IS NULL) THEN
    RAISE EXCEPTION '026 down 拒绝执行：存在 duty_jpy IS NULL（关税未知）的订单，回填成 0 会把"未知"说成"0 円"。请先人工处理这些订单';
  END IF;
END $$;
ALTER TABLE orders ALTER COLUMN duty_jpy SET DEFAULT 0;
ALTER TABLE orders ALTER COLUMN duty_jpy SET NOT NULL;
