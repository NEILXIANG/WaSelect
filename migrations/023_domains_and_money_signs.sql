-- 023：补三组**已经定型、但库层一直没有设防**的约束（DB-07）。
--
-- @why 002 当初刻意**没有**给 `payments.status` / `shipments.status` 加 CHECK，理由是
--      "契约没枚举，编一套取值会在口径定下后误拒合法数据"（002 @limitation 一）。
--      那是对的，而且今天仍然对 `shipments.status` 成立——它至今被
--      `db.db.test.ts` 的 STATUS_EXEMPT 以书面理由豁免（技术文档 §3 只给了 DEFAULT、未枚举）。
--      但**同一条理由不能无限期地覆盖所有列**：下面这三类已经不是"口径未定"，
--      而是"口径早就定了、代码早已按它跑、只有库不知道"：
--        ① 枚举域：`banners.link_type` 与 `products.category` 在契约里**有明确 enum**，
--           且与 shared 常量有双向比对用例钉着（enums.unit.test.ts）；
--        ② 金额与重量：负值在任何一条路径上都不是合法业务值；
--        ③ 汇率：0 或负的汇率会让**所有**展示价变 0，且不会报错。
--
-- ── ① 枚举域 ──────────────────────────────────────────────────────────────
-- @why `link_type` 决定 `link_id` 怎么解释（product → 商品 id，category → 分类名，none → 不跳转）。
--      库不设防时，一个拼错的取值会**存进去、返回给小程序**，而小程序拿到不认识的 link_type
--      只能不跳——运营看到的是"配了跳转但点了没反应"，查配置永远查不出问题（与 D-46 同形态）。
-- @why `category` 同时是 `GET /products?category` 的查询参数枚举与商品分类 tab 的来源；
--      库里出现第五个值时，tab 上不会出现它（tab 取自 shared 常量），
--      于是这件商品**只能通过搜索找到、分类里永远找不到**——静默，且没人会去查库。
--
-- ── ② 金额 / 重量 ────────────────────────────────────────────────────────
-- @why 用 `>= 0` 而不是 `> 0`：**0 在业务上是合法值**（免运费档 `price_jpy = 0`、
--      未计税 `duty_jpy = 0`、占位期的 `charge_amount`）。本约束要挡的是**负号**，
--      即"退款 / 折扣 / 手续费把金额算成了负的"这一类符号错误——
--      它一旦发生，表现为"买家付了负数"或"对账差两倍"，而且没有任何一方报错。
-- @why 只约束**符号**，不约束**量级**。量级的真源在 shared（`SHIPPING_RATE_BOUNDS`、
--      `PRODUCT_LIMITS` 等），再加一份到 DB 就是第三份真源：
--      改一处漏两处时不会报错，只会变成"某个值在 A 处合法、在 B 处被拒"。
--      符号是**不会变**的性质，量级是**会调**的参数——只把不会变的那一层下沉到库。
--
-- ── ③ 汇率 ───────────────────────────────────────────────────────────────
-- @why `rate` / `raw_rate` 用 `> 0` 而不是 `>= 0`：汇率 0 会让 `toMinor(price_jpy, rateInt)`
--      把**所有**商品算成 0 元，页面显示"免费"，下单照常成功——
--      这是本项目里少数几个"静默 + 立刻造成真金白银损失"的形态。
--      @measured：`FX_RAW_RATE_BOUNDS` 与契约的 `exclusiveMinimum: 0` 已是同一口径，这里只是它的库层兑现。
--
-- @breaking ⚠️ up 段全部是 `ADD CONSTRAINT … CHECK`：收紧，会让窗口里旧代码的不合法写入 23514。
--      **这一版安全，有三个各自独立、都必须成立的理由**：
--      ① 生产尚未上线、这几张表都是**空的**（banners / products / shipping_rates / fx_rates
--         实测 0 行；orders 只有测试库 1 行且合规）；
--      ② 写入方的取值集合与本约束**同源**：枚举来自 `packages/shared/src/enums.ts`，
--         与契约由 `enums.unit.test.ts` 双向比对钉着；金额由领域层算完再落库，负值只会来自 bug；
--      ③ `banners` / `shipping_rates` / `products` 的写入口都在管理端，
--         改的是"运营填错一个数"这类低频操作，不是下单热路径。
--      ⚠️ 另外记录 017 已写过的那条代价：`ADD CONSTRAINT … CHECK` 会**立即全表校验**
--      并持有 ACCESS EXCLUSIVE 锁直到校验完成。今天表是空的，成本为 0；
--      等表大了再加约束，标准做法是 `NOT VALID` 先加、再单独 `VALIDATE`（后者只拿弱锁）。
--      @see test/lint/migrations.lint.test.ts（本标记的强制器，DB2-07 / AJ-317）
--
-- @limitation **故意不加**的两列：`payments.fee_jpy` 与 `payments.settled_jpy`。
--      ① 两者至今**没有任何写入方**（全仓只有读取），给一个没人写的列定域，
--         正是 002 @limitation 一 警告的"顺手编一套取值"；
--      ② `settled_jpy` 的语义是**净结算**（收款 − 手续费），当手续费大于收款时
--         它**可以为负**——那不是错误，而是"这一笔其实亏了"。
--         现在定死 `>= 0` 会把这个真实形态变成一条永远写不进去的约束。
--      两列已在 `db.db.test.ts` 的 MONEY_EXEMPT 里逐条写明原因（该机制要求豁免必须有理由）。
-- @limitation 不约束 `orders.weight_g` / `order_items.weight_g` / `products.weight_g`：
--      重量上界在 shared（`PRODUCT_WEIGHT_MAX_G`，与运费表 30kg 同值同源），
--      属"会调的参数"，按上面的口径不入 DB。
--
-- @see contracts/api-contract.yaml（BannerInput.link_type / products?category / FxRate）；
--      packages/shared/src/enums.ts（PRODUCT_CATEGORY）；
--      server/src/adapters/db.db.test.ts（金额列不变量 + MONEY_EXEMPT）；
--      migrations/002_hardening.sql（当年"暂不加"的那条决定）
--
-- Up migration

-- ① 枚举域
ALTER TABLE banners
  ADD CONSTRAINT banners_link_type_domain
  CHECK (link_type IN ('none', 'product', 'category'));

ALTER TABLE products
  ADD CONSTRAINT products_category_domain
  CHECK (category IN ('beauty', 'daily', 'kitchen', 'food'));

-- ② 金额 / 重量符号（可空列必须显式放行 NULL：`NULL >= 0` 是 NULL，不是 true）
ALTER TABLE orders
  ADD CONSTRAINT orders_items_jpy_nonneg CHECK (items_jpy >= 0);
ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_jpy_nonneg CHECK (shipping_jpy >= 0);
ALTER TABLE orders
  ADD CONSTRAINT orders_duty_jpy_nonneg CHECK (duty_jpy >= 0);
ALTER TABLE orders
  ADD CONSTRAINT orders_total_jpy_nonneg CHECK (total_jpy >= 0);
ALTER TABLE orders
  ADD CONSTRAINT orders_charge_amount_nonneg CHECK (charge_amount IS NULL OR charge_amount >= 0);

ALTER TABLE payments
  ADD CONSTRAINT payments_charge_amount_nonneg CHECK (charge_amount >= 0);
ALTER TABLE payments
  ADD CONSTRAINT payments_paid_amount_nonneg CHECK (paid_amount IS NULL OR paid_amount >= 0);
ALTER TABLE payments
  ADD CONSTRAINT payments_dispute_amount_nonneg CHECK (dispute_amount IS NULL OR dispute_amount >= 0);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_unit_price_jpy_nonneg CHECK (unit_price_jpy >= 0);

ALTER TABLE products
  ADD CONSTRAINT products_cost_jpy_nonneg CHECK (cost_jpy IS NULL OR cost_jpy >= 0);

ALTER TABLE shipping_rates
  ADD CONSTRAINT shipping_rates_price_jpy_nonneg CHECK (price_jpy >= 0);
ALTER TABLE shipping_rates
  ADD CONSTRAINT shipping_rates_max_weight_g_positive CHECK (max_weight_g > 0);

-- ③ 汇率必须为正
ALTER TABLE fx_rates
  ADD CONSTRAINT fx_rates_rate_positive CHECK (rate > 0);
ALTER TABLE fx_rates
  ADD CONSTRAINT fx_rates_raw_rate_positive CHECK (raw_rate > 0);

-- Down migration

ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_link_type_domain;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_domain;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_items_jpy_nonneg;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipping_jpy_nonneg;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_duty_jpy_nonneg;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_jpy_nonneg;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_charge_amount_nonneg;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_charge_amount_nonneg;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_paid_amount_nonneg;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_dispute_amount_nonneg;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_unit_price_jpy_nonneg;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_cost_jpy_nonneg;
ALTER TABLE shipping_rates DROP CONSTRAINT IF EXISTS shipping_rates_price_jpy_nonneg;
ALTER TABLE shipping_rates DROP CONSTRAINT IF EXISTS shipping_rates_max_weight_g_positive;
ALTER TABLE fx_rates DROP CONSTRAINT IF EXISTS fx_rates_rate_positive;
ALTER TABLE fx_rates DROP CONSTRAINT IF EXISTS fx_rates_raw_rate_positive;
