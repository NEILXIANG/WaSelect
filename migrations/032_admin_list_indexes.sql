-- 032：管理端列表 / 导出 / 审计页的排序索引（第三轮缺口 P2-22，AJ-386）。
--
-- @why `/admin/orders` 列表与导出都是 `where is_test = false order by created_at desc`，
--      现有索引只有 (user_id, created_at) 与 open_status 部分索引，排序只能全表 Sort；
--      `admin_audit` 不按 actor 过滤时（审计页默认视图）同样全表 Sort。10 万单量级就是秒级。
-- @why 普通 CREATE INDEX（非 CONCURRENTLY）：node-pg-migrate 每条迁移包在事务里，CONCURRENTLY 不能进事务；
--      上线前表很小，锁表时间可忽略。上线后再加同类索引须改用 CONCURRENTLY + 单独迁移（运维手册"上线后迁移规范"）。
-- @limitation 只覆盖默认排序；按 status 过滤的列表仍会用 open_status 部分索引或扫描，量起来再看 EXPLAIN。
-- @measured 2026-10-07 本机 PG16，`set enable_seqscan = off` 后
--   `explain select id from orders where is_test = false order by created_at desc limit 50`
--   → `Index Scan using idx_orders_is_test_created on orders`（无 Sort 节点）；
--   `explain select id from admin_audit order by created_at desc limit 50`
--   → `Index Scan using idx_admin_audit_created on admin_audit`。
--
-- @see server/src/app/admin-order-routes.ts；server/src/adapters/exports.ts；server/src/adapters/ops-log.ts（审计页查询）

-- Up migration

CREATE INDEX IF NOT EXISTS idx_orders_is_test_created ON orders (is_test, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);

-- Down migration

DROP INDEX IF EXISTS idx_admin_audit_created;
DROP INDEX IF EXISTS idx_orders_is_test_created;
