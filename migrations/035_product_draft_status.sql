-- 035：商品状态增 `draft`（草稿）——管理端第二批 C（对标分析 §4.3「草稿 / 定时」，AJ-403）。
--
-- @why 新建即在售的后果是"半成品被买家看到"：图没传齐、文案没写好，买家已经能加购下单。
--      对标结论是"默认草稿"；草稿对买家的表现与 offline 完全一致（买家侧所有读取都只认 `status = 'active'`）。
-- @why 只放宽域约束、**不改列默认值**（仍是 001 的 `DEFAULT 'active'`）：
--      "新建默认草稿"是**应用层**规则（`POST /admin/products` 显式写 draft），
--      列默认值服务的是 seed / 测试夹具里"直接插一件在售商品"的那一类写入；改成 draft 会让它们全部静默变成不可见。
--      反向风险登记在 AJ-403：将来若有绕过管理端的批量导入**不写 status**，导入的商品会直接在售。
--
-- @breaking ⚠️ up 段 `DROP CONSTRAINT` + `ADD CONSTRAINT`（换一条同名约束）：形态上命中 DB2-07。
--      这一版之所以安全：新约束是旧约束的**超集**（多收一个 draft，原两值照收），
--      窗口里仍在服务的旧代码只会写 active / offline，不会被新约束拒；
--      反过来，旧代码读到新代码写的 draft 时——买家侧一律按"不是 active"处理（不可见、不可买，正是草稿的本意），
--      旧管理端前端把它显示成"已下架"（view.ts 旧映射：非 active 即 offline），按钮是"上架"，语义仍对。
--      `ADD CONSTRAINT … CHECK` 会全表校验并持 ACCESS EXCLUSIVE 锁：products 是百级行，成本可忽略。
--      @see test/lint/migrations.lint.test.ts（本标记的强制器）
--
-- @why down：**草稿改成 offline 再收紧**，不拒绝回滚（与 026 的"有 NULL 就拒绝"相反，理由见 test/db/migrations.db.test.ts 035 用例）：
--      draft 与 offline 对买家同一个样子，丢的只是"它从没上过架"这一条后台标签；
--      ⚠️ 绝不能改成 active——那会在回滚时把所有半成品一次性上架。
--
-- @see server/src/app/admin-product-routes.ts（PRODUCT_STATUS / 草稿只能是起点）；docs/自主决策记录.md AJ-403

-- Up migration

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_domain;
ALTER TABLE products
  ADD CONSTRAINT products_status_domain CHECK (status IN ('active','offline','draft'));

-- Down migration

UPDATE products SET status = 'offline' WHERE status = 'draft';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_domain;
ALTER TABLE products
  ADD CONSTRAINT products_status_domain CHECK (status IN ('active','offline'));
