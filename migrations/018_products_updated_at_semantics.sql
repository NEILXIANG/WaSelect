-- 018：`products.updated_at` 的语义收窄为「**商品信息**最后被改的时刻」（AJ-258；第三轮审查 ADM3-02 + DB3-02）。
--
-- @why 它同时被三个消费方读：① 管理端列表的排序键（`order by updated_at desc, id`）；
--      ② 0.6.18 起 `PUT /admin/products/{id}` 的**乐观锁凭据**（`expected_updated_at`）；
--      ③ 页面上"最后修改时间"的展示来源。而 001 以来的实现里，
--      `decrementStock` / `incrementStock`（下单扣减、取消与关单回补）**也**写 `updated_at = now()`，
--      于是"库存变动"被算进了"商品被改过"，带来两个各自独立的缺陷：
--      · DB3-02：买家下一单就把那件商品顶到列表第一位，offset 分页整体位移 → 漏行 + 重行；
--      · ADM3-02 的连带：运营正在编辑时来一单，凭据当场失效 → "只改标题保存"被 40914 拒掉，
--        而"编辑期间下单仍能保存且不覆盖库存"是 AJ-175 **专门实现并被 e2e 钉住**的行为。
-- @why 库存是**并发写的实时余额**，不是商品信息——这与 AJ-175 把 `stock` 从 PUT 覆盖范围里
--      排除（省略即不改）是**同一个判断的两种写法**。本迁移不删任何数据，只把语义钉在库里，
--      让"这一列到底是什么意思"不必靠读代码猜（`\d+ products` 就能看到）。
-- @why **不动** `setProductStatus`（上下架）对它的推进：上下架是商品信息的一部分，
--      运营在列表里看得见，"这一版是哪一版"理应包含它。
--
-- @limitation 将来若要做"按商品变更的增量同步 / 缓存 ETag"，**不能再用这一列**——
--             它不再反映库存变动。同步需求应由 `order_events`（按订单查）回答，
--             而不是把 `updated_at = now()` 加回 stock 的两条 SQL 里（那会把本条修的两个缺陷一起带回来）。
--
-- @see server/src/adapters/catalog-admin.ts；server/src/adapters/orders.ts；
--      contracts/api-contract.yaml 0.6.18；docs/自主决策记录.md AJ-258

-- Up migration

COMMENT ON COLUMN products.updated_at IS
  '商品**信息**最后被改的时刻（insertProduct / updateProduct / setProductStatus 推进）。'
  '库存变动（下单扣减、取消与关单回补）**不**推进它：它是并发写的实时余额，不是商品信息。'
  '同时是 `PUT /admin/products/{id}` 的乐观锁凭据与管理端列表的排序键（AJ-258 / 契约 0.6.18）。';

-- Down migration

COMMENT ON COLUMN products.updated_at IS NULL;
