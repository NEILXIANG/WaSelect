# 第三轮全量逐行审查 · 分片 DB3（数据层）

- 基线：jp_project HEAD `50d490b`（只读，未改任何仓库文件）
- 范围：`server/src/adapters/` 下 18 个源文件 + `migrations/001–016`，以及对应测试文件
- 对照：CLAUDE.md 十一条约束；`docs/全量逐行代码审查报告-第二轮-2026-09-30.md` 与分片 DB / CAT / ORD / INF 报告的「仍存在」清单

## 0. 读了什么

| 源文件 | 行数 | 对应测试（行数） |
|---|---|---|
| orders.ts | 831 | orders.db.test.ts (436)；另查 create-order / order-routes / order-race 的相关用例 |
| orders-admin.ts | 696 | orders-admin.db.test.ts (214)、orders-admin-write.db.test.ts (316) |
| idempotency.ts | 484 | idempotency.db.test.ts (866)、idempotency-cleanup.db.test.ts (114) |
| db.ts | 262 | db.db.test.ts (539) |
| catalog.ts | 225 | catalog.db.test.ts (222) |
| catalog-admin.ts | 165 | catalog-admin.db.test.ts (158) |
| country-profiles.ts | 225 | country-profiles.db/unit.test.ts (265 / 203) |
| ops-config.ts | 183 | ops-config.db.test.ts (268) |
| addresses.ts | 141 | addresses.db.test.ts (156) |
| identity.ts | 133 | identity.db.test.ts (182) |
| risk-admin.ts | 126 | risk-admin.db.test.ts (215) |
| banners-admin.ts | 136 | banners-admin.db.test.ts (159) |
| webhooks.ts | 168 | webhooks.db/unit.test.ts (322 / 32) |
| event-bus.ts | 169 | event-bus.unit.test.ts (285) |
| admin-audit.ts | 28 | （经 app/admin-audit 覆盖） |
| scheduler.ts | 125 | scheduler.db/unit.test.ts (159 / 58) |
| ids.ts / clock.ts | 28 / 35 | ids.unit (47) / clock.unit (45) |
| migrations/001–016 | 953 | test/db/migrations.db.test.ts、db.db.test.ts 结构不变量 |

为核对锁序与调用语义，另外读了这些调用方的相关段落：`app/create-order.ts`、`app/expire-orders.ts`、`app/admin-order-routes.ts`（退款、解除、改址）、`app/pay-callback.ts` + `webhook-results.ts`（result 列宽）、`app/mark-paid.ts`、`app/order-routes.ts`、`app/admin-risk-routes.ts`、`domain/stock-lock.ts`、`domain/quote.ts`、`ports/idempotency.ts`、`test/db/test-db.ts`。

**探针与测试**
- `scratchpad/round3/probe-identity-race.mts`（Node 22.22.2 + tsx）：见 DB3-01，输出已贴。
- 没有跑 db / e2e 项目，也没有跑 gate（按分片规则）。SQL 行为靠对照迁移只读推理，引用处都标了证据等级。

**逐项核过、确认没问题的高风险点**（下面不再展开）
- 全局锁序。建单是 users → products（按 C 序）→ 插 orders；取消是 order → payments → products；关单是 orders（`SKIP LOCKED`，从不等待）→ products（汇总后按 C 序）；拉黑是 users → orders（按 id）→ payments → products；落账是 order → payments。products 这一层两侧都按同一个全局升序取锁，关单从不等 orders 行锁，所以没有环。
- `lockUserForOrdering`（AJ-240）与 `blockUser` 在 users 行上是串行的：RC 隔离下，`lockPayableOrdersOfUser` 是一条新语句、拿新快照，一定能看到刚提交的新单。
- `withIdempotencyTx` 的 `SET LOCAL lock_timeout TO DEFAULT`：值是经 postgres.js `connection` 启动参数下发的，属于会话默认值（reset_val），所以 DEFAULT 回到的是 5s。用例「handler 内的 lock_timeout = 连接级默认值」钉住了这一点。
- webhook `result` 列宽 32：`resultValue()` 截断，其余常量都 ≤ 23 字符。
- `order_events.status` 各字面量都 ≤ 16 字符（< VARCHAR(20)）。
- `autoAdvanceOrders` 的数据修改型 CTE：`ev` 虽然不被主查询引用，按 PG 语义仍会完整执行。
- `stockRestorePlan` 与 JS 侧 `compareProductIdForLock`：商品 id 是 ASCII，两边的序一致。

---

## 1. 发现

本分片**没有新 P0 / P1 / P2**。以下 4 条都是 P3。

### DB3-01【P3】身份缓存：`invalidate` 挡不住在途回源的旧值回写，被拉黑者仍可放行最长 60 秒

- **位置**：`server/src/adapters/identity.ts:105-126`（`withIdentityCache.load`）；调用点 `server/src/app/admin-risk-routes.ts:99`；`identity.ts:43-47`、`risk-admin.ts:24-26` 的「即时生效」说法。
- **问题**：`load()` 先 `await check.load(sub)` 回源，再无条件 `cache.set(sub, {at: now, record})`。`invalidate()` 只是 `cache.delete(sub)`，没有任何代际或版本标记。所以只要回源查询在拉黑事务**提交前**读到了「未封禁」，而它的结果在 `invalidate` **之后**才回来，这份旧值就会被写进缓存，按 `now`（回源开始的时刻）再活满 60 秒。
- **触发场景**：用户 U 的缓存条目恰好过期，U 的请求 A 开始回源（SELECT 读到 `blocked_at = null`）。同一时刻管理员拉黑 U：拉黑事务提交 → 路由调 `identity.invalidate(U)` → A 的查询结果到达 → `cache.set` 写回未封禁。之后 60 秒内，U 的每个请求都在 `requireRole` 命中缓存并放行，与 F-06 / AJ-183 声称的「下一个请求就回源、就被拒」相反。
  - 实际危害有限，所以定 P3。建单在 `lockUserForOrdering` 里有事务内复核（40301）；在途单已被拉黑事务取消，无法再付。窗口内仍能改地址、读订单。
- **证据**：【实测】`probe-identity-race.mts` 用桩 `IdentityCheck` 复现上述时序：
  ```
  A 读到 blockedAt = null
  invalidate 之后下一次 load: blockedAt = null | 回源次数 = 1
  ```
  即 `invalidate` 之后的下一次 load 命中了旧值，没有回源。
- **修复方案**：给缓存加代际计数。
  - `const gen = new Map<string, number>()`。`invalidate(sub)` 时 `gen.set(sub, (gen.get(sub) ?? 0) + 1)` 并 `cache.delete(sub)`。
  - `load` 在 `await` 之前记下 `const g = gen.get(sub) ?? 0`，回来后若 `gen.get(sub) !== g`，就**只返回结果、不写缓存**（或者再回源一次）。
  - 同步把 `identity.ts:43-47` 的「即时生效」改成带条件的表述。
- **应补的测试**（`identity.db.test.ts` 或新增 unit）：用桩 `check.load`，第一次调用挂在一个手动 resolve 的 Promise 上；在它 resolve 之前改桩数据为 blocked 并调 `invalidate`，再 resolve；然后 `await cached.load(sub)`。
  - 先红断言：`expect((await cached.load('u-1'))?.blockedAt).not.toBeNull()`，并断言回源次数为 2。当前实现是 null 和 1。

### DB3-02【P3】管理端商品列表按 `updated_at` 排序，而每次下单、取消、关单都会刷新 `updated_at` → 翻页漏行、重行

- **位置**：`server/src/adapters/catalog-admin.ts:115`（`order by updated_at desc, id`）；`server/src/adapters/orders.ts:193`、`:205`（`decrementStock` / `incrementStock` 都写 `updated_at = now()`）；`catalog-admin.ts:9-10` 的 @why 把 `updated_at` 定义为「最后修改时间」。
- **问题**：`updated_at` 同时承担两件事：管理端的排序键，以及每次库存扣减 / 回补的技术时间戳。关单 job 每轮回补库存，买家每次建单、取消都扣减或回补，这些都会把对应商品顶到列表第一位。而列表是 offset 分页（默认 size 50，`admin-product-routes.ts:94`）。
- **触发场景**：店里 60 件商品。运营看第 1 页（第 1–50 名）时，买家下单了第 55 名的商品 X → X 的 `updated_at` 刷新成最新，升到第 1 名，原第 1–50 名整体后移一位。运营翻到第 2 页（offset 50）：原第 50 名又出现一次（重行），而 X 已经挪到运营看过的第 1 页，这一轮再也看不到（漏行）。
  - 关单 job 每 60 秒回补一次，积压期间这种位移持续发生。页面上显示的「最后修改时间」也会被买家行为刷新，运营以为有人改过这件商品。
- **证据**：【读码确认】`catalog-admin.ts:115` 与 `orders.ts:193,205`。现有用例 `catalog-admin.db.test.ts:118`「第 2 页不与第 1 页重复」只在静态数据上验，两页之间没有库存写入，所以抓不到。
- **修复方案**（二选一）：
  - ① 列表改按不受库存写入影响的稳定键排序：`order by created_at desc, id`。
  - ② `decrementStock` / `incrementStock` 不再写 `updated_at`，或拆出 `edited_at` 列，只由 `insertProduct` / `updateProduct` / `setProductStatus` 写。
  - 推荐 ②：同时修正「最后修改时间」的语义，契约 `AdminProduct.updated_at` 的描述也要同步。
- **应补的测试**：`catalog-admin.db.test.ts` 造 3 件商品，size=2 取第 1 页；然后对第 3 名调 `decrementStock(db, id, 1)`；再取第 2 页。
  - 先红断言：`expect([...p1, ...p2].map(r => r.id).sort()).toEqual(allIds.sort())`（无漏、无重）。当前实现第 2 页会重复第 1 页的末行，并漏掉被扣库存的那件。

### DB3-03【P3】改址事件把旧地址全文写进 append-only 的 `order_events`：注释论证与事实相反，个人信息删除请求无法执行

- **位置**：`server/src/adapters/orders-admin.ts:668-670`（@why：「存 `order_events` 而不是 `admin_audit`……后者是全库 PII 的第二份聚集地、且 append-only 无法删除」），写入点 `:693`。
- **问题**：注释选 `order_events`、不选 `admin_audit` 的理由之一是后者 append-only、无法删除。但 `order_events` **同样**是 append-only：`migrations/002_hardening.sql:96-98` 给它挂了 `trg_order_events_append_only`，UPDATE / DELETE 都会被拒。所以这条论证前提不成立，属约束六「注释与实现不符」。
- **实际后果**：旧地址（收件人、电话、街道）以 JSON 全文落在一张无法 UPDATE / DELETE 的表里。买家行使删除或匿名化权利（APPI / CCPA）时，`orders.address_snapshot` 可以改写，但历次改址留下的旧地址只能先 DROP 触发器才能动，而这恰恰是 002 要防的操作。
- **触发场景**：管理员给订单 O 改过一次址 → `order_events.note = {"from":{"recipient":"…","phone":"+1…",…}}`；之后买家要求删除个人数据 → `update order_events set note = null where …` → `42501 审计表 order_events 只允许 INSERT`。
- **证据**：【读码确认】`orders-admin.ts:668-670,693`；`002_hardening.sql:88-98`；`db.db.test.ts:402` 钉住了 order_events 的 UPDATE / DELETE 被拒。
- **修复方案**：
  - 最小修复：改注释，如实写「两处都 append-only；选 order_events 的理由只剩与订单同级、便于应诉检索」，并在 @limitation 登记「删除请求需走触发器豁免流程」。
  - 结构修复：旧地址改存可匿名化的独立表（如 `order_address_history`，不挂 append-only 触发器、带 order_id 外键），order_events 的 note 只存该行 id。
  - 这是带取舍的改动，应入 `docs/自主决策记录.md`。
- **应补的测试**：若采用结构修复，在 `orders-admin-write.db.test.ts` 断言
  `await db\`update order_address_history set recipient='REDACTED' where order_id='o-1'\``
  能成功，且 `order_events.note` 里不含 `'Jane Doe'`。先红：当前 note 含原文、且不可改。

### DB3-04【P3】运费「选承运商」与「取档」是两条独立语句：两者之间整表替换提交，会把正常订单误报成 40912「超重」

- **位置**：`server/src/adapters/catalog.ts:178-197`（`resolveSingleActiveCarrier` 与 `findShippingPriceJpy` 分开查）；消费方 `server/src/app/quote-assembly.ts:67-70`（报价走连接池，建单在 RC 事务内），先解析 carrier 再取档；`ops-config.ts:166-179`（替换持有 EXCLUSIVE 表锁，但读者不受阻）。
- **问题**：READ COMMITTED 下每条语句拿新快照，两条读之间可以夹进一次替换提交。
- **触发场景**：运营把占位承运商 `placeholder` 整表换成真实承运商 `yamato`，AJ-204 的整表替换刚好在某个建单 / 报价请求的两条语句之间提交：
  - 第一条读到 `placeholder`；
  - 第二条 `where carrier='placeholder' and active` 已经 0 行 → 返回 null → 用例层按 AJ-239 抛 **40912「包裹超重」**。

  买家看到的是「超重」，实际是配置切换，文案误导，且错误码被对账 / 告警误分类。窗口很窄，只在改承运商名的那次保存上出现，所以 P3。
- **证据**：【读码确认】两条语句独立执行；RC 快照语义属 PG 标准行为，未单独探针。【推断】触发频率。
- **修复方案**：两者合成一条 SQL，在同一快照里判定：
  ```sql
  with c as (select distinct carrier from shipping_rates where active)
  select (select count(*) from c) as n, r.price_jpy
    from c left join lateral (
      select price_jpy from shipping_rates
       where carrier = c.carrier and active and max_weight_g >= $1
       order by max_weight_g asc limit 1) r on true
  ```
  `n ≠ 1` → 50004；`price_jpy` 为 null → 40912。这样 D-46 的「唯一取档 SQL」仍只有一份。另一种办法是建单事务改用 REPEATABLE READ（代价是全建单链路改隔离级别，不推荐）。
- **应补的测试**：`catalog.db.test.ts` 在第一次 `resolveSingleActiveCarrier()` 之后、`findShippingPriceJpy()` 之前，用另一连接 `replaceShippingRates([{carrier:'yamato',…}])`。
  - 先红断言：`expect(resultCode).not.toBe(40912)`。合并后的查询在同一快照里要么全是旧表、要么全是新表。

---

## 2. 统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 0 | — |
| P3 | 4 | DB3-01（实测）、DB3-02、DB3-03、DB3-04 |

## 3. 上轮遗留在本分片的状态（逐项对照当前代码）

| 原编号 | 状态 | 当前位置 |
|---|---|---|
| B1b | 仍存在 | `orders-admin.ts:594-597`：`releaseDisputeHold` 仍只看 `has_dispute`，不看 `payments.dispute_status` |
| ORD2-06 | 仍存在 | `orders.ts:510`：`order by oi.id`（`oi-<uuid v4>`，行项目顺序随机） |
| ORD-07 | 仍存在 | `orders.ts:191-197`：`decrementStock` 不判 `status='active'` |
| ORD-15 | 仍存在 | `orders-admin.ts:519-535` 的计数方式未变，退款第二段无按订单互斥 |
| CAT-24 | 仍存在 | `risk-admin.ts:110-121`：select 无 `for update`，update 无 `and not is_admin` |
| CAT-11 / DB-09 | 仍存在 | `addresses.ts:88-102`：并发 `create(is_default)` 仍会撞 23505 |
| CAT-15 / DB-16 | 仍存在 | `ops-config.ts:131`：JS number 直落 NUMERIC；`payment_channels_key_shape` 仍允许 32 字符 |
| CAT-13 / ORD2-07 | 仍存在 | `orders-admin.ts:240`、`catalog.ts:131`、`catalog-admin.ts:116` 的 offset 无上限（路由层） |
| DB-07 | 仍存在 | `payments.dispute_status`、金额列无 CHECK。`db.db.test.ts:511-537` 的不变量只认列名恰为 `status`，`dispute_status` 天然漏网 |
| DB-13 / CAT-19 | 仍存在 | 无新增索引迁移（012–016 未涉及） |
| DB2-07 | 仍存在 | `015` 同一迁移内「建表 + 删列」 |
| B51 / DB-03 | 仍存在 | `test/db/migrations.db.test.ts` 仍是「down 到底再 up」 |
| INF-09 | 仍存在 | `scheduler.ts:108` 的 `last_error` 原样落库、不截断 |
| B6 / AJ-201 | 已修且无回归 | `idempotency.ts:239` 复位位置在 `inHandler=true` 之前；用例 `idempotency.db.test.ts:648` 有效 |
| B22 / AJ-204 | 已修且无回归 | `ops-config.ts:166`；并发用例 `ops-config.db.test.ts:196` 在空表前提下（resetTestDb 会清 shipping_rates）确能抓到无锁 |
| B23 / AJ-203 | 已修且无回归 | `addresses.ts:113-115` |
| B12 / AJ-208 | 已修；注释论证有误 | 见 DB3-03 |
| AJ-240（本轮新锁） | 已核，无死锁、无漏判 | `orders.ts:819-831`；锁序与拉黑同向；`order-routes.db.test.ts:504/521` 覆盖并发上限与事务内复核拉黑 |
