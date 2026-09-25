-- 008：orders.terms_version 列宽 VARCHAR(16) → VARCHAR(32)（全面体检 P2）。
--
-- @why 旧宽度的实际余量只有 **2 个字符**（现行值 `TOS-2026-09-20` 已占 14）：
--      条款改一版（如 `TOS-2026-10-01-v2`）就会在建单时撑爆列宽——而建单是全站
--      最贵的一条写路径，它的失败形态不该由"列宽余量"这种一块钱的东西决定。
--
-- @why VARCHAR 加宽在 PG 里是**元数据变更**（不重写表、瞬间完成），
--      收紧才需要扫描校验——所以 up 安全、down 在超长值存在时会报错（如实，不静默截断）。
--
-- @see migrations/001_init.sql（原定义）；docs/全面体检报告-2026-09-25.md（问题台账）

-- Up migration

ALTER TABLE orders ALTER COLUMN terms_version TYPE VARCHAR(32);

-- Down migration

ALTER TABLE orders ALTER COLUMN terms_version TYPE VARCHAR(16);
