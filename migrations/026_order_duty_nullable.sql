-- 026：orders.duty_jpy 允许为 NULL（W-05）——"关税无法估算"不再存成 0。
--
-- @why 报价阶段无法估算关税时 duty_jpy=null、duty_estimate=false，前端据此不显示关税行；
--      建单却因为列是 NOT NULL 而存成 0，订单详情于是显示"预估关税 0 円"——
--      同一张单，结算时说不知道关税，详情里却说关税是 0（契约 Quote 明确要求"false 时不得展示具体数字"）。
--      0 与"未知"是两回事：日本原产按 15% 计，0 只可能是"没估"，不可能是"真的是 0"。
-- @why 只放宽、不改存量：已有的 0 无法区分是"未估"还是别的，原样保留；
--      非负约束（023 的 orders_duty_jpy_nonneg）对 NULL 天然放行，不用动。
-- @limitation down 段把 NULL 回填成 0 再收紧——回滚后"未知"又会被说成 0（与本迁移之前同样的问题）。
--
-- @see server/src/app/create-order.ts（写入）；server/src/app/order-views.ts（读出）；
--      contracts/api-contract.yaml（0.6.30：Order.duty_jpy nullable）；docs/自主决策记录.md AJ-367

-- Up migration

ALTER TABLE orders ALTER COLUMN duty_jpy DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN duty_jpy DROP DEFAULT;

-- Down migration

UPDATE orders SET duty_jpy = 0 WHERE duty_jpy IS NULL;
ALTER TABLE orders ALTER COLUMN duty_jpy SET DEFAULT 0;
ALTER TABLE orders ALTER COLUMN duty_jpy SET NOT NULL;
