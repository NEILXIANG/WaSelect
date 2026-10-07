-- 031：hs_code 列宽 10 → 16（products 与 order_items 快照；第三轮缺口，用户 2026-10-07 拍板加宽，AJ-386）。
--
-- @why 美国 HTS 10 位编码习惯带点书写（`3304.99.5000` = 12 字），VARCHAR(10) 存不进，运营只能去掉点号录成
--      `3304995000`——报关单与报关代理的写法对不上，人工核对时容易看错位。16 留出余量（含点的 10 位 + 余量）。
-- @why 两张表一起改：027 的订单行快照逐列照抄 products 的长度，单改一边会让"商品能存、建单时快照存不进"（22001 → 500）。
-- @limitation 只放宽长度，不校验形状（形状在管理端表单做提示，服务端只管列宽）。
-- @limitation ⚠️ down 段是**收紧**：存量里有 >10 字的 HS 码时 down 会失败（22001）——那正是不该静默截断的情形，
--      回滚前先把那些行改短或接受失败。up 段只放宽，对旧代码无害。
--
-- @see packages/shared/src/limits.ts（PRODUCT_MAX_CHARS.hs_code）；server/src/domain/product-input.ts

-- Up migration

ALTER TABLE products ALTER COLUMN hs_code TYPE VARCHAR(16);
ALTER TABLE order_items ALTER COLUMN hs_code TYPE VARCHAR(16);

-- Down migration

ALTER TABLE order_items ALTER COLUMN hs_code TYPE VARCHAR(10);
ALTER TABLE products ALTER COLUMN hs_code TYPE VARCHAR(10);
