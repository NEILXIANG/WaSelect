-- 004：幂等租约栅栏令牌（二审 N1 / 甄别报告 P0-1）。
--
-- @why 003 引入租约解决了"占位永久卡死"，但留下一个交错漏洞：
--        A 抢到占位但慢于租约 → B 接管（UPDATE 按 key 定位）→ A 迟到失败/迟到写回，
--        它的 DELETE/UPDATE 也按 key 定位 → 删掉/覆盖的是 **B 的**占位行，
--        随后 C 进入抢不到记录 → 同一个幂等键的 handler 被执行第 3 次（建三张单）。
--      栅栏令牌（fencing token）让每一次抢占拿到一个唯一令牌，
--      后续所有写/删都携带"key + 令牌"双条件：令牌不符 = 租约已易主，0 行命中，禁止动那行数据。
--
-- @why 允许 NULL 而不回填：本表当前只有骨架期数据（生产未上线），
--      且令牌的语义是"一次抢占的身份"——历史已完成行没有存活持有者，回填令牌没有任何意义。
--      写入路径（004 后的代码）永远带令牌，旧代码已随部署整体替换，不存在"新表旧写"的窗口。
--
-- @limitation 令牌只保证"易主后旧持有者写不动"，不保证"handler 只跑一次"——
--      A 与 B 的 handler 仍可能各跑一次（A 慢 ≠ A 死），这是租约模型的固有代价，
--      handler 必须自身可重入（见 idempotency.ts @limitation）。
--
-- @see docs/二审意见甄别报告-2026-09-23.md §1 N1；server/src/idempotency.ts

-- Up migration

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS lease_token UUID;

-- Down migration

ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS lease_token;
