# ORD 分片审查报告（第二轮，2026-09-30）— 订单全生命周期

审查对象是**工作区当前文件**（HEAD = 41d40ba，本分片 26 个文件在工作区均无未提交改动）。仓库只读，未跑任何 npm 脚本 / 测试 / 构建，未连数据库，未读 `.env`。
唯一的探针是纯 Node 脚本 `scratchpad/review2/ORD/probe-paging.mjs`（不 import 仓库代码）。

## 1. 覆盖清单

| 文件 | 行数 | 状态 |
|---|---|---|
| server/src/app/create-order.ts | 279 | 逐行读完 |
| server/src/app/cancel-order.ts | 76 | 逐行读完 |
| server/src/app/expire-orders.ts | 87 | 逐行读完 |
| server/src/app/order-routes.ts | 211 | 逐行读完 |
| server/src/app/order-query-routes.ts | 86 | 逐行读完 |
| server/src/app/order-views.ts | 113 | 逐行读完 |
| server/src/app/quote-assembly.ts | 109 | 逐行读完 |
| server/src/app/quote-routes.ts | 127 | 逐行读完 |
| server/src/app/auto-confirm.ts | 71 | 逐行读完 |
| server/src/app/auto-fulfilment.ts | 62 | 逐行读完 |
| server/src/app/daily-reconciliation.ts | 340 | 逐行读完 |
| server/src/app/daily-heartbeat-watch.ts | 115 | 逐行读完（新文件） |
| server/src/app/admin-order-routes.ts | 513 | 逐行读完 |
| server/src/app/block-user.ts | 102 | 逐行读完（新文件） |
| server/src/adapters/orders.ts | 801 | 逐行读完 |
| server/src/adapters/orders-admin.ts | 696 | 逐行读完 |
| server/src/adapters/risk-admin.ts | 126 | 逐行读完 |
| server/src/domain/order.ts | 69 | 逐行读完 |
| server/src/domain/order-no.ts | 37 | 逐行读完 |
| server/src/domain/quote.ts | 215 | 逐行读完 |
| server/src/domain/stock-lock.ts | 44 | 逐行读完（新文件） |
| server/src/domain/admin-order-actions.ts | 203 | 逐行读完 |
| packages/shared/src/orderNo.ts | 76 | 逐行读完 |
| packages/shared/src/businessDay.ts | 61 | 逐行读完 |
| packages/shared/src/enums.ts | 113 | 逐行读完 |
| packages/shared/src/id.ts | 51 | 逐行读完 |

合计 **26 个文件、4783 行**。

为下结论另读的分片外文件：`app/refund-execution.ts`、`app/close-session-events.ts`、`app/admin-risk-routes.ts`、`app/internal-jobs-routes.ts`、`app/scheduler.ts`、`adapters/scheduler.ts`（record 段）、`adapters/idempotency.ts:150-290`、`adapters/catalog.ts`（报价相关五个方法）、`adapters/catalog-admin.ts:108-165`、`adapters/payment/registry.ts`（get / getForRefund / getForCallback）、`adapters/payment/stripe-checkout.ts`（退款段 grep）、`app/rate-limit.ts:105-135`、`app/mount.ts`（限流装配）、`main.ts:186-200`、`ports/scheduler.ts`（常量）、`packages/shared/src/money.ts`、`packages/shared/src/limits.ts`、`packages/shared/src/errors.ts`（相关码）、`migrations/001_init.sql`（orders / order_items / order_events / job_runs）、`migrations/012`、`contracts/api-contract.yaml` 相关段、`node_modules/postgres/src/{index,connection}.js`（unsafe 的参数路径）、jp 技术文档 §2.5。
测试文件只读了用例标题与个别断言（block-user / daily-heartbeat-watch / expire-orders / order-race / auto-fulfilment / admin-order-routes / create-order / order-routes / quote-routes / order-query-routes / review-mode 的 db 测试）。

`git diff 848278d..HEAD` 在本分片涉及 12 个文件（+683 / −52），对应 7 个修复提交：A3（b74df1d）、B7（26cc9dd）、B8（3fa3406）、B1b（0e5e3fb）、B11（aaa4cfe）、B12（70989fa）、B28（7bbb3ef）。每个改动都逐段核过，结论见第 4 节。

---

## 2. 发现

**P1：0 条。P2：2 条。P3：8 条。**

### P2

#### ORD2-01｜P2｜可用性 / 可被放大：在途单没有任何每用户上限，任何登录用户都能零成本占满全店库存

- **位置**：`server/src/app/create-order.ts:105-179`（整条建单路径没有任何"该用户手上已有几张在途单"的判断；库存在第 6 步 `:173-179` 直接扣）；`server/src/app/order-routes.ts:97-100`（唯一的频率防线是按 IP 的限流）；`server/src/app/rate-limit.ts:118-122,132`（键只有 `req.ip`，30 次 / 分钟 / 入口）。
- **问题**：库存在**建单时**扣减、到 `expires_at`（默认 30 分钟）才回补，而建单既不要钱也不限张数。全仓（`server/src`、`migrations`、`docs`）检索不到任何"每用户在途单上限"的判断或登记（grep `占库存 / 在途单上限 / 未付单上限` 无命中）。代码自己在 `create-order.ts:125` 承认了这个风险面，但只对审核期设了闸门：
  ```ts
  // create-order.ts:123-126
  //      闸门必须在建单处（扣库存之前），不能只在支付处：否则审核员能把真商品库存占满 30 分钟。
  // create-order.ts:176-179
  for (const item of orderedItems) {
    const ok = await decrementStock(tx, item.productId, item.qty);
    if (!ok) throw new AppError(40901, { product_id: item.productId, qty: item.qty });
  }
  ```
- **触发场景与后果**：
  - 一个普通微信账号写个脚本循环 `POST /orders`（每次换一个 Idempotency-Key）：每张单可含 50 个 SKU、数量填到库存上限，只受单笔 18 万円限制；30 张 / 分钟 / IP 即每分钟锁住 540 万円货值。小店每个 SKU 库存是个位数到两位数，**几秒钟内全店显示售罄**；30 分钟到期后再来一轮即可无限续占，全程不花一分钱。
  - 真实买家看到的是 40901「库存不足」，运营看到的是库存归零、订单列表里一堆 `created`——没有任何告警类别覆盖它（六类对账都不看）。
  - 非恶意放大：已知待修项"结算页退出重进建第二张单 / 连点发两次请求"每多建一张，就把同一批货多扣一次。
- **修复方案**：
  1. `createOrder` 在第 2 步之后、第 6 步之前加一条：`select count(*) from orders where user_id = $1 and status in ('created','pending_payment')`（走 `idx_orders_user_created`），≥ 上限（建议配置项 `MAX_OPEN_ORDERS_PER_USER`，默认 3）即拒。需要新登记一个 409 错误码（文案"您有未支付的订单，请先支付或取消"），不要复用 40901。
  2. 并发两张同时过检查的问题：在计数前 `select 1 from users where id = $1 for update`（锁序 users → products，与 `blockUser` 的 users → orders → products 同向，不会成环），或用 `pg_advisory_xact_lock(hashtext(userId))`。
  3. 测试：同一用户连建 N+1 张 → 第 N+1 张被拒且库存未扣；取消一张后可再建；并发 2 张只成 1 张。缺陷注入：删掉计数判断，用例必须红。
- **置信度**：已读代码证实（建单路径无上限、限流只按 IP）。
- **是否已登记**：未登记（09-29 报告与自主决策记录均无）。

#### ORD2-02｜P2｜可用性 / 测试把错误钉成正确：购物车超过最大运费档 → HTTP 500「运费不可计算」+ error 日志

- **位置**：`server/src/app/quote-assembly.ts:69-71`；`packages/shared/src/errors.ts:161`；`server/src/http.ts:437-438`（≥500 一律 error 级）；钉住它的测试 `server/src/app/quote-routes.db.test.ts:196-201`、`server/src/app/order-routes.db.test.ts:270,297`。
- **问题**：包裹重量超过 `shipping_rates` 最大一档时，与"运费表没配"走同一个 50004：
  ```ts
  // quote-assembly.ts:69-71
  const weightG = summary.goodsWeightG + config.PACKAGING_WEIGHT_G;
  const shippingJpy = await catalog.findShippingPriceJpy(carrier, weightG);
  if (shippingJpy === null) throw new AppError(50004, { carrier, weight_g: weightG });
  // errors.ts:161
  50004: { code: 50004, message: '运费不可计算', action: '阻止下单，管理员补齐参数' },
  ```
  "购物车太重"是买家的正常操作，不是配置缺失：它应当是 4xx 且带"请拆单"的指引（金额超限有 40906 + `split_hint`，重量超限没有对应物）。
- **触发场景与后果**：技术文档 §2.5 的文档档位只到 3000g（含 250g 包材，即商品净重 > 2750g 就超）；日用品、厨具店里三瓶 1kg 的洗护或一口锅加两把刀就到了。结果：
  - 买家在购物车和结算页看到的是 `50004 运费不可计算`，不知道该删商品还是等修复；
  - 购物车每次改数量都会重新报价，每次都是一条 HTTP 500 + `request_failed` **error 级**日志——普通用户可以稳定制造 5xx 与告警噪声（限流只有 30 次 / 分钟 / IP）；
  - 真正的"运费表配空了"事故会被这些噪声淹掉；
  - 两份 db 测试把"超重 → 50004"钉成期望，改对时它们会红。
  影响面取决于生产运费表最大档配到多少（运营配置，未知）：配到承运商上限（如 30kg）则罕见，按文档档位配则是日常。
- **修复方案**：
  1. 区分两种 null：`findShippingPriceJpy` 查不到时再查一次"该承运商是否有任何活跃档"（或把仓储方法改为返回 `{price} | {overweight: maxWeightG} | {no_tiers}`）。无档 → 仍 50004；有档但超重 → 新登记一个 409 码（如"包裹超过可寄重量，请拆单"，details 带 `weight_g` 与 `max_weight_g`），warn 级。
  2. 报价响应可选加 `weight_split_hint` 或复用 `split_hint` 的前端提示位（先改契约）。
  3. 改两条测试的期望；加一条"运费表为空 → 仍是 50004"保住原语义。
- **置信度**：已读代码证实（路径、错误码、日志级别、测试断言均已读）。生产最大档的取值未知，故严重度带条件。
- **是否已登记**：未登记（09-29 只在契约漂移 ORD-11 里提到 quote 漏列 500）。

### P3

#### ORD2-03｜P3｜看门狗盲区：`never_ran` 的基准是进程启动时刻，每次部署清零；停滞后每轮 tick 报一条 error 无节流

- **位置**：`server/src/app/daily-heartbeat-watch.ts:74-86`；`server/src/main.ts:188,197`；`server/src/ports/scheduler.ts:70`。
- **证据**：
  ```ts
  // daily-heartbeat-watch.ts:76-79
  (   last_success_at is null
      and ${ctx.startedAt}::timestamptz - make_interval(hours => ${DAILY_NEVER_RAN_GRACE_HOURS})
          >= ${input.processStartedAt}::timestamptz )
  // main.ts:188
  const processStartedAt = systemClock.now();
  ```
- **问题与后果**：
  1. B11 要防的三类原因里有一类是"上线漏配 cron"（daily 从未成功，`last_success_at is null`）。这一支只在**同一个进程连续存活满 26 小时**后才报。开发期 / 上线初期部署频率高于 26 小时一次（或平台重启实例）时，`processStartedAt` 每次归零，这一支**永远不触发**——而漏配 cron 恰恰最可能发生在这个阶段。文件头 @limitation 二只写了"要等 26 小时"，没有写"每次部署重新计时"。
  2. 一旦判定停滞，每轮 tick（默认 60 秒）打一条 `daily_heartbeat_stalled` error，直到恢复：daily 某天只是一轮失败（`ok=false` 不更新 `last_success_at`），从第 26 小时到下一次成功约 22 小时 ≈ 1300 条相同的 error。
- **修复方案**：
  1. 基准换成库里的时间而不是进程时间：给 `job_runs` 加 `created_at timestamptz not null default now()`（新迁移；存量行取迁移时刻），判据改为 `last_success_at is null and created_at <= startedAt - 26h`；`processStartedAt` 可删。
  2. 节流：同一原因只在"整点轮"或每 N 轮报一次（用 `ctx.startedAt` 的分钟数取模，不引入新状态），其余轮返回 `processed: 1` 但不打 error。
  3. 测试：`last_success_at = null`、`created_at` 为 27 小时前、`processStartedAt` 为 1 分钟前 → 必须报 `never_ran`。
- **置信度**：已读代码证实。

#### ORD2-04｜P3｜审计留痕：拉黑连带取消的事件 actor 是固定串 `admin:block`，不带管理员 id；测试把它钉住

- **位置**：`server/src/app/block-user.ts:82`；对照 `server/src/app/admin-order-routes.ts:91-98`；测试 `server/src/app/block-user.db.test.ts:202`。
- **证据**：
  ```ts
  // block-user.ts:82
  if (!(await markOrderCancelled(tx, orderId, userId, at, 'admin:block'))) continue;
  // admin-order-routes.ts:92-93
  // @why 发货 / 退款曾写成不带 id 的 `'admin'`（一致性审计 C3，AJ-176）：……时间线只看 order_events，不带 id 就无从追责。
  ```
- **问题**：`orders.ts:605-609` 的 @why 说加 actor 参数正是为了"审计时答得出是谁把这张单关掉的"，而传进去的值答不出"是哪个管理员"。`blockUser(deps, userId)` 的签名里根本没有操作者。admin_audit 有一行 actor，但订单时间线只看 order_events（同仓库自己在 C3 的结论）。
- **修复方案**：`blockUser` 增加 `actor: string` 入参，路由层传 `admin:${req.auth.sub}`；事件 note 写 `block`（或 `blocked_user`）以保留"因拉黑而取消"的语义；改测试断言。
- **置信度**：已读代码证实。

#### ORD2-05｜P3｜建单不复核收货地址的国家是否仍可下单 / 是否等于报价用的目的国

- **位置**：`server/src/app/create-order.ts:119-121,155`；`server/src/app/quote-assembly.ts:74-75`；对照 `server/src/app/admin-order-routes.ts:472-476`。
- **证据**：建单只做归属判定，地址的 `country` 原样进快照；关税率用的 `dest` 却来自"当前唯一活跃的 country_profile"，两者没有任何比较。而管理员改址路径是查了的：
  ```ts
  // admin-order-routes.ts:473-476
  const profile = await countryProfiles.get(input.country);
  if (profile === null || !profile.active) throw new AppError(40002, { field: 'country', ... });
  ```
- **后果**：当前只有 US 一国时不可达。接第二个国家、或下线一个国家后：地址簿里存量地址的国家不再可寄，建单照常成功；`duty_jpy` 按"唯一活跃国"估算，与快照里的实际目的国不是同一个。属于约束四"新代码不得以现状写死为由继续写死"指的那类隐性假设。
- **修复方案**：`createOrder` 第 2 步后查 `country_profiles`：地址国家不存在或不活跃 → 40002；`assembleQuote` 的 `dest` 改为由调用方传入（建单传地址国家，报价在无地址时沿用现口径）。
- **置信度**：已读代码证实（当前不可达，登记为接多国前必须做）。

#### ORD2-06｜P3｜订单行项目的返回顺序是随机的（按 `oi-<uuid v4>` 排序），不是购物车顺序

- **位置**：`server/src/adapters/orders.ts:506-511`；`server/src/adapters/orders-admin.ts:292-296`；id 来源 `server/src/app/create-order.ts:249`。
- **证据**：
  ```ts
  id: `oi-${idGen.uuid()}`,            // create-order.ts:249
  order by oi.id                        // orders.ts:510
  order by order_id, id                 // orders-admin.ts:295
  ```
- **后果**：同一张单每次返回顺序稳定，但与买家下单时的顺序、与 `declared_value_usd` 的分摊顺序都无关。买家详情页、管理端详情（拣货 / 报关对照）看到的行序是乱的。不影响金额。
- **修复方案**：`order_items` 加 `line_no smallint not null`（建单时写 `i`），两处查询改 `order by line_no`；存量行用 `row_number() over (partition by order_id order by id)` 回填。
- **置信度**：已读代码证实。

#### ORD2-07｜P3｜可控输入缺上限（四处，同一类）

| 位置 | 问题 | 后果 | 修法 |
|---|---|---|---|
| `admin-order-routes.ts:168-175` | `readPaging` 只判整数与下界，`page` 无上界 | 探针：`page=1e17&size=100` 通过校验，offset = `10000000000000000000`（超 bigint 上限 9223372036854775807）；`page=1e300` 时参数是 `"1e+302"`。推断 PG 报 22003 / 22P02 → 50000 + error 日志（**疑似，未实跑**）。仅管理员可达 | `page` 加上界（如 ≤ 100000），或 `(page-1)*size` 超过 `Number.MAX_SAFE_INTEGER` 即 40001 |
| `quote-routes.ts:47`；`order-routes.ts:66` | `product_id`、`address_id` 只判非空字符串，不限长 | 整串进 `AppError.details` → warn / error 日志；审核模式下 `create-order.ts:133-136` 还把最多 10 个客户端给的串写进 warn。单条日志可达请求体上限 | 两处加长度上限（如 ≤ 64），超出 40001 |
| `order-query-routes.ts:54-55` | `status` 重复传参时是数组，被原样放进 details（`status: raw`） | 日志里出现客户端构造的任意数组 | details 只放 `typeof raw`，或先 `String(raw).slice(0,32)` |
| `admin-order-routes.ts:259-264` | carrier / tracking_no 仍不限长（即旧 B24 / ORD-08，列在此只为归类） | 见旧报告 | 见旧报告 |

- **置信度**：JS 侧放行已探针证实（`scratchpad/review2/ORD/probe-paging.mjs`）；PG 侧报错形态疑似需实跑。

#### ORD2-08｜P3｜退款时通道不可用返回 40001「参数缺失或格式错误」，测试钉住 400

- **位置**：`server/src/app/admin-order-routes.ts:325`；`server/src/adapters/payment/registry.ts:142-155`；测试 `server/src/app/admin-order-routes.db.test.ts:443-448`。
- **问题**：B8 把通道解析搬进事务后状态不再卡死（已核，见第 4 节），但错误码没动：管理员点退款，看到的是"参数错误"，而这一步他唯一能填的参数是理由——会去反复改理由重试。真实原因是通道下线 / 凭据缺失，需要的动作是找运维。
- **修复方案**：退款路由捕获 `channelUnavailable` 的 AppError，转成已登记的 409 / 503 类码（文案"该支付通道当前不可用，无法退款"），details 保留原 reason；改测试期望。
- **置信度**：已读代码证实。

#### ORD2-09｜P3｜注释与实现不符（修复提交留下的，均已对照代码核实）

| 位置 | 注释说 | 实际 |
|---|---|---|
| `app/auto-fulfilment.ts:6` | "挂在每日作业里还白拿看门狗：daily 心跳停滞会被每日对账报 stalled_heartbeats" | 这正是 B11 指出的"被告报告自己"；看门狗已是 tick 上的 `daily-heartbeat-watch`。B11 的修法清单里有"修正此注释"，没做 |
| `app/daily-reconciliation.ts:2,5,27` | 文件头写"三类账务异常""三类是三个视角" | 已是六类（同一段下面列到 ⑥） |
| `app/daily-reconciliation.ts:82-86` | 一段讲"daily 超过 26 小时"的 JSDoc | 它注释的常量 `DAILY_STALL_HOURS` 已搬到 `ports/scheduler.ts`，这段悬空，现在挂在 `interface AnomalyClass` 头上 |
| `domain/admin-order-actions.ts:103-122` | `refundReasonGuard` 的完整 JSDoc | 后面紧跟的是 `textGuard` 的 JSDoc 与函数；`refundReasonGuard`（:145）本身没有注释，这段成了孤儿 |
| `domain/admin-order-actions.ts:2`；`adapters/orders-admin.ts:3,45`；`app/admin-order-routes.ts:2-5,14` | "三个订单操作""三条写路径""五条路由" | 加了 `dispute/release` 后是四个写操作、六条路由（测试标题已写"六条路由"） |
| `adapters/orders-admin.ts:443` | "admin_audit 未落地前这是'谁发的货'的唯一留痕" | admin_audit 已落地（AJ-183，同仓库 `admin-order-routes.ts:93` 自己写了） |
| `domain/stock-lock.ts:13` | "商品 id 全是 `p-xxx` 这种带连字符的形状" | 生产 id 是 `idGen.uuid()`（`admin-product-routes.ts:126`），`p-xxx` 只是 fixture；结论（含连字符、需显式 collate）仍成立 |
| `app/auto-confirm.ts:12` | "失败**不影响**发起支付的响应（只打 error 日志）" | `:43` 的 `registry.getForCallback` 在 try 之外，抛错会让已提交意图的请求 500；当前不可达（通道刚建过意图必然已注册），把它挪进 try 即可 |

- **置信度**：已读代码证实。

#### ORD2-10｜P3｜审核期建的测试单在审核模式关闭后仍可用真实通道付款（残留风险，跨片线索）

- **位置**：`server/src/app/create-order.ts:208`（`is_test: reviewMode` 建单时定死）；全仓 `is_test` 的消费方只有自动确认、发货闸门与管理端列表过滤（grep 已核），**发起支付不看它**。
- **场景**：`REVIEW_MODE=on` 期间建的单（30 分钟内有效）在切到 `off` 并上线 Stripe 之后被付款 → 订单 `paid` + `is_test=true`：发货被 40902 `test_order` 拦、管理端列表默认隐藏、六类对账都不报。真钱进来了，单看不见。
- **触发条件很窄**（切换前 30 分钟内建的单、且有人在切换后去付），所以只定 P3；但出口成本很低。
- **修复方案**：`pay-intent` 里 `is_test` 单只允许能自签确认的通道（按端口能力 `selfConfirmation` 判，不认通道名），否则 40902；或每日对账加一类"`is_test` 且最新支付行通道无 `selfConfirmation`"。
- **置信度**：已读代码证实（发起支付侧未读全，归 PAY 分片复核）。

---

## 3. 09-29 未修旧项的状态

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B24（含 ORD-08） | 仍在 | `admin-order-routes.ts:259-264` 发货的 carrier / tracking_no 仍只 trim 不限长；契约 `:375` 也没有 maxLength |
| B39 | 仍在（服务端侧） | 报价 40401 / 40901 的 `product_id` 只进 details，响应体仍只有 code / message |
| B40 | 仍在（服务端侧） | `order-views.ts:106` 详情仍原样返回 `duty_jpy`（无法估算时为 0），没有 `duty_estimate` |
| B46 | 仍在 | `auto-fulfilment.db.test.ts:110,119` 的 `o-shipped` 没有 `delivered_at`，被时间条件排除，状态过滤仍未被测到 |
| B2 B21 B26 B27 B29 B30 B42 B44 B45 B47–B51 | 不在本分片 | 未复核 |
| ORD-06 | 仍在 | `scanLedgerMismatch` 仍只看 `status='paid'`；仍没有"未关单的过期单"一类 |
| ORD-07 | 仍在 | `create-order.ts:10-12`、`quote-assembly.ts:14-15` 仍写"无 TOCTOU"；`decrementStock` 仍不查 `status='active'` |
| ORD-09 | 仍在 | 报价仍不过审核闸门、不要求 USD 汇率 |
| ORD-10 | 仍在（5 处全在） | `orderNo.ts:19` 的 0.5%；`quote.ts:15-16` "三口径未定"；`quote.ts:146` "无当日行"；`order-no.ts:18-19`；`id.ts:2`。关税取整仍是四舍五入，而技术文档 §2.5 现在明写 `ceil` |
| ORD-11 | 仍在 | `/orders/quote` 仍只列 200/409/429；cancel 仍只列 200/409；`Address.id / line2` 仍非 nullable |
| ORD-12 | 仍在 | `order-query-routes.ts:43-45` 仍读 config；`create-order.ts:155,230` 仍写死 `'USD'`；`quote.ts:29` 仍是 `'USD' \| 'CNY'` |
| ORD-13 | 仍在 | `LOGGED_EVENTS` 仍只有 4 个事件 |
| ORD-14 | 仍在 | `address-input.ts:75,79` 仍是 `String()` 强转 |
| ORD-15 | 仍在 | 退款第二段仍无按订单互斥。补一句：两个请求同时"查询到在途单失败"且其中一个撞上机构同键并发拒绝时，事件序可能以 `provider_error` 收尾且确认失败数为 2，下一次会换到第 3 把键而不再查询在途那笔——资金由机构全额上限兜住，但订单会卡在 refunding（推演，未实跑） |
| 申报价值用含缓冲的展示汇率（P3 表末行） | 仍在 | `create-order.ts:230-243` 未变 |

09-29 已列且已修好的（A3、B7、B8、B11、B12、B28、B1b 的主体）不再展开。

---

## 4. 看过但确认没问题的高风险点

**修复提交的回归检查**

- **A3 取锁序**：建单用 JS `<` 排序（`stock-lock.ts:34-36`），回补用 SQL `collate "C"`（`orders.ts:227-234`）；商品 id 是 UUID（ASCII），两种序一致。取消 / 关单 / 拉黑三条回补路径都走 `restoreStockForOrders` 的"先汇总、后按序逐行"；关单与拉黑都是先逐单迁移、循环外一次性回补。全仓 `update products` 只剩这两处加管理端单行更新。`create-order.db.test.ts:174,316,341` 有对应的零 40P01 用例。
- **`tx.unsafe(sql, [数组])` 的参数序列化**（`orders.ts:227`）：读了 postgres.js 3.4.9 源码——带参数且未预编译时 `describeFirst` 为真（`connection.js:238`），先 Describe 拿到服务端推断的 `text[]` 类型再 Bind（`:626-633`），数组走已注册的数组序列化器，不会退化成 `'a,b'`。
- **跨表锁序**：所有 `for update` 都先锁 orders（grep 全仓 12 处）；关单与自动推进用 `skip locked`，不会等待别人持有的订单行；`blockUser` 是 users → orders（id 升序）→ payments → products（全局序），与建单 / 取消 / 关单 / 落账都不成环。外键插入取的 `FOR KEY SHARE` 与 `update products / users` 非键列取的 `FOR NO KEY UPDATE` 相容。
- **B8**：`getForRefund` 在事务内、`markRefunding` 之前；`executeRefund` 里 `refundStatus === undefined → 50000` 这一支不会在"已落 refunding 之后"才触发——注册表在装配时强制"声明 supportsRefund 就必须实现 refundStatus"（`registry.ts:77-78`）。
- **B7**：理由校验在事务之前；上限按 UTF-16 码元计（比 Stripe 的字符口径更严）；适配器侧 `clipRefundReason` 是确定性截断，重试之间文本一致。
- **B12**：旧快照在同一事务内 `for update` 读出后写进 `order_events.note`；买家时间线按 `ORDER_STATUS` 过滤，读不到 `address_changed`；连续改址时每条事件的 `from` 接得上。
- **B28**：封号与取消同事务；已付单不动；重复拉黑不重复回补（迁移守卫）；`order.cancelled` 的订阅者按 `initiated / cancelled` 取行，取消事务里已作废的行仍能找到会话去作废；并发的发起支付持锁时拉黑会等它提交后再按新状态判定。
- **B11**：时间判定全在 SQL；行缺失会响；tick 任一 job 失败时 `last_success_at` 不动，反方向（daily 看 tick）仍成立。
- **B1b**：`releaseDisputeHold` 带 `has_dispute = true` 条件；不碰 `payments.dispute_*`。（"不看拒付状态"是已知待修项，不重复报。）

**钱**

- 运费取档 SQL 全仓唯一（`catalog.ts:189-194`），`>=` + 升序取一；重量含包材。
- `toMinor / applyRate` 整数商加余数，`allocate` 各行之和恒等于总额；申报总额为 0（小计 < 76 円）时分摊为全 0，不抛。
- 40905 与 40906、`split_hint` 同用严格比较；包邮判定 `>=`。
- 退款是原币全额，金额与币种取自扣款当时的支付行；同一把幂等键下并发重复点击不会发出第二笔（键为 `refund:<orderId>[:attempt]`，`stripe-checkout.ts:643-644`）。
- 库存不会双倍回补：三条回补路径都以带状态条件的 UPDATE 返回 true 为凭证；`expired / cancelled` 是终态。

**状态机与并发**

- 迁移表与各 SQL 守卫一致：关单 / 取消只认 `created / pending_payment`；发货只认 `paid`；`markRefunding` 认 `paid / shipped / delivered`；`markRefunded` 认 `refunding`。
- `autoAdvanceOrders` 一条语句内选取、迁移、记事件，迁移时复查状态并排除 `has_dispute`；同一轮签收后不会连带完成。
- 幂等执行器不会重跑 handler（`idempotency.ts` 的 `inHandler`），`order.created` 只在提交后分发，重放不发。
- 关单 job 的事件只在 savepoint 成功后登记（`scheduler.ts:115-124`）。
- `order_events.status` 是 VARCHAR(20)，最长的事件名 `dispute_released` 16 字符。
- `findRefundProgress` 按 `id desc`（BIGSERIAL）取最新，不受注入时钟同刻的影响。

**输入与越权**

- 买家读写全部带 `user_id =`；非本人与不存在同为 40400；时间线只出 `status / at`。
- 管理端 keyword 用 `position()`，无通配符注入；status 先过枚举；`tx(identifier)` 的列名只来自 `AUTO_ADVANCE` 白名单；`db.unsafe(DISPUTE_COLS)` 与 collation 拼接都是模块常量。
- 订单号：`ORDER_NO_PATTERN` 的字符类与 `ALPHABET` 逐字符对过（0-9、A-H、J、K、M、N、P-T、V-Z），一致；日期取 JST。
- 拉黑的 `already` 在并发下可能误报为 false，但 `token_ver` 只会加一次（UPDATE 里按行内当前值判定）。
