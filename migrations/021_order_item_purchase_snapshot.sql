-- 021：`order_items` 增三个**采购快照**字段——`title_ja` / `jan_code` / `purchase_source`（D-39）。
--
-- 需求原文（技术文档 §2.7）：
--   「待采购清单 = GET /admin/orders?status=paid（含商品的 title_ja / jan_code / purchase_source 快照，D-39）」
--
-- @why **落快照而不是 JOIN `products`**：`title_snapshot` / `unit_price_jpy` 早就是快照，
--      本迁移只是把"采购信息"纳入同一条口径——**订单记录的是"这一单当时买了什么"，
--      不是"这个商品现在是什么"**。商品的 `purchase_source` 是会变的（换供应商 / 换采购渠道），
--      `title_ja` 也会改（编辑订正日文原名）。JOIN 看起来更简单（不用存一列），
--      但结果是**历史订单的采购渠道被悄悄改写**，而没有任何一方报错——
--      采购员照着清单去问供应商，问的却是新渠道，货不对板要等收货才发现。
--      ⚠️ 反过来也说明为什么这三列**必须**跟着下单那一刻走：待采购清单是**执行依据**，
--      不是参考信息。
--
-- @why **三个一起加**而不是只加 `jan_code`：三者是**一组**——采购员照这三样去买
--      （日文原名用来在日本网站/店铺搜、JAN 码用来精确对货、采购来源告诉他去哪买）。
--      缺任何一个，清单就有一半不可执行（只有 JAN 码不知道去哪买，只有来源不知道买哪个规格）。
--
-- @why **全部可空**（与 `products` 上同名列一致）：
--      ① `products` 上这三列本来就可空（编辑未填 / 商品没有 JAN 码）；
--      ② 历史 `order_items` 行没有来源可填（见下一条 @limitation）。
--      可空 → 前端**降级**显示"—"，不报错、不用占位话术顶上
--      （与 `products.why` / `maker` 留白时的降级同口径，迁移 020）。
--
-- @limitation **不回填历史行**：与迁移 020 同一条理由——回填只能拿当前 `products` 抄一份，
--      而那正是本迁移要避免的"被改写"。代价是**迁移之前的历史订单没有采购信息**，
--      待采购清单里那几行显示"—"，采购员需要按商品另行确认。
--      ⚠️ 这个代价要在清单 UI 上说清楚（不能让运营以为"系统漏了"）：
--      缺采购信息时显示"未记录"，而不是空白或"—"（后者会被读成"这个值就是没有"）。
--
-- @see server/src/adapters/catalog.ts（建单取数：`findProductsForQuote` 要带上这三列）；
--      server/src/adapters/orders.ts（`insertOrderItems` 落库）；
--      server/src/adapters/orders-admin.ts（管理端读出：`listOrderItemsFor`）；
--      contracts/api-contract.yaml（管理端订单响应的 items）

-- Up migration

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS title_ja VARCHAR(255);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS jan_code VARCHAR(13);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS purchase_source VARCHAR(255);

COMMENT ON COLUMN order_items.title_ja IS
  '下单那一刻商品的**日文原名**快照（与 `title_snapshot` 同源同期）。'
  '⚠️ 是快照不是当前值：商品改名后本列**不变**——采购员要买的是当时看到的那件。'
  '可空（商品未填 / 历史行未记录），前端降级显示"未记录"。';

COMMENT ON COLUMN order_items.jan_code IS
  '下单那一刻商品的 **JAN 码**（日本商品条码，13 位）快照，采购对货用。'
  '⚠️ 是快照不是当前值（理由同 `title_ja`）。可空：相当一部分日本手作 / 工房商品没有 JAN 码，'
  '那是**事实**不是缺数据——所以前端显示"未记录"而不是报错。';

COMMENT ON COLUMN order_items.purchase_source IS
  '下单那一刻商品的**采购来源**快照（"楽天 〇〇店" / "京都 錦市場 直送"），告诉采购员去哪买。'
  '⚠️ 是快照不是当前值：换供应商后本列**不变**，否则历史订单的采购渠道会被悄悄改写。'
  '⚠️ 这是**内部信息**：只在管理端下发，🈲 不得出现在任何买家可见的响应里'
  '（泄露采购渠道等于泄露成本结构与供应链）。';

-- Down migration

COMMENT ON COLUMN order_items.title_ja IS NULL;
COMMENT ON COLUMN order_items.jan_code IS NULL;
COMMENT ON COLUMN order_items.purchase_source IS NULL;

ALTER TABLE order_items DROP COLUMN IF EXISTS title_ja;
ALTER TABLE order_items DROP COLUMN IF EXISTS jan_code;
ALTER TABLE order_items DROP COLUMN IF EXISTS purchase_source;
