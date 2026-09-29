> 本文是 2026-09-29 全量逐行代码审查的 **ORD 分片（订单全生命周期）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

## ORD 分片审查报告（订单全生命周期）

仓库只读，没有改动任何文件。探针都写在 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/ORD/`（`deadlock-probe.mts`、`probe2.mts`、`fix-probe.mts`），用的是本分片自建的库 `review_ord`（已跑完 001–014 迁移，保留着方便复核）。没有跑 db / e2e / contract 测试项目。

### 1. 覆盖清单

| 文件 | 行数 | 状态 |
|---|---|---|
| server/src/app/create-order.ts | 286 | 已逐行读完 |
| server/src/app/cancel-order.ts | 68 | 已逐行读完 |
| server/src/app/expire-orders.ts | 82 | 已逐行读完 |
| server/src/app/order-routes.ts | 211 | 已逐行读完 |
| server/src/app/order-query-routes.ts | 86 | 已逐行读完 |
| server/src/app/order-views.ts | 113 | 已逐行读完 |
| server/src/app/quote-assembly.ts | 109 | 已逐行读完 |
| server/src/app/quote-routes.ts | 127 | 已逐行读完 |
| server/src/app/admin-order-routes.ts | 404 | 已逐行读完 |
| server/src/app/auto-fulfilment.ts | 62 | 已逐行读完 |
| server/src/app/daily-reconciliation.ts | 347 | 已逐行读完 |
| server/src/app/business-events.ts | 43 | 已逐行读完 |
| server/src/adapters/orders.ts | 710 | 已逐行读完 |
| server/src/adapters/orders-admin.ts | 641 | 已逐行读完 |
| server/src/domain/order.ts | 69 | 已逐行读完 |
| server/src/domain/order-no.ts | 37 | 已逐行读完 |
| server/src/domain/quote.ts | 215 | 已逐行读完 |
| server/src/domain/admin-order-actions.ts | 94 | 已逐行读完 |
| server/src/domain/address-input.ts | 108 | 已逐行读完 |
| packages/shared/src/orderNo.ts | 76 | 已逐行读完 |
| packages/shared/src/businessDay.ts | 61 | 已逐行读完 |
| packages/shared/src/enums.ts | 113 | 已逐行读完 |
| packages/shared/src/id.ts | 51 | 已逐行读完 |

为下结论，另外读了分片外的这些依赖：`adapters/catalog.ts`、`adapters/db.ts`（事务与超时）、`adapters/idempotency.ts:155-262`、`app/scheduler.ts`、`app/internal-jobs-routes.ts`、`app/refund-execution.ts`、`app/admin-audit.ts`、`adapters/payment/{registry,channels,stripe-checkout(refund 段)}.ts`、`packages/shared/src/money.ts`、`migrations/001/002/007`、`main.ts` 的调度装配段、契约相关段落、jp 技术文档 §1/§6.1、`AJ-142` 和 `AJ-176 裁决⑧`。

### 2. 发现列表

#### ORD-01｜P1｜并发 / 死锁
- **位置**：adapters/orders.ts:206-213；app/cancel-order.ts:61；app/expire-orders.ts:59-71；与之冲突的一方是 app/create-order.ts:176-186
- **问题**：建单已经按 product_id 排序加锁，但关单和取消回补库存时，加锁顺序跟着 order_items 的插入序，而且关单 job 在一个事务里跨多张订单逐单回补。这两条回补路径与排序后的建单之间仍然会形成 AB/BA 互等，形成死锁（40P01）。注释写的"统一顺序后只会排队不会互等"不成立。
- **证据**：
  ```ts
  // create-order.ts:179  统一顺序后所有事务对同一组行按同一序取锁，只会排队不会互等。
  update products p set stock = stock + oi.qty, updated_at = now()
    from order_items oi where oi.order_id = ${orderId} and oi.product_id = p.id   // 无序
  for (const id of ids) { if (await markOrderExpired(...)) await restoreStockForOrder(ctx.tx, id); }
  ```
- **触发场景与后果**：
  - 买家 X 的购物车顺序是 [B, A]，下单后取消；同时买家 Y 下单含 A、B（按 A→B 加锁）。
    - `deadlock-probe.mts` 在小表（Seq Scan + Nested Loop）和批量数据（索引 Nested Loop）两种执行计划下都复现了：`cancel: 40P01 deadlock detected`。
  - 关单 job 同一轮关两张单：X1=[B]、X2=[A]，与建单 A→B 并发。
    - `probe2.mts` 复现：`expire job: 40P01`，而且整批被回滚，两张单仍是 `created`。
  - 后果：
    - 取消或建单返回 50000；
    - 整批关单回滚，推迟到下一轮；tick 标记为失败；
    - 批次越大，关单事务里持有的商品行锁越多，冲突概率越高；
    - 建单事务处在幂等执行器的 `lock_timeout ≤ 2s` 预算内，等锁超时的 55P03 同样变成 50000。
- **解决方案**：
  1. 在 `restoreStockForOrder` 前按确定序预先锁行：
     `select id from products where id in (select product_id from order_items where order_id = any(${ids})) order by id collate "C" for update`
     - `collate "C"` 与 JS 的 `compareProductIdForLock`（按码元比较）一致。本地库是 C.UTF-8，生产库的排序规则未知，不加这个就可能出现两种锁序。
  2. 关单 job 改成：先对 ids 全部 `markOrderExpired`，收集真正迁移成功的 id，一次性按排序锁住全部相关商品，再逐单（或聚合）回补。
  3. 建单遇到 40P01 可以在执行器外整体重试一次；这是安全的，因为 pendingEvents 只在 createOrder 返回后才写入。
  4. 补一个 db 测试：建单（A→B）与取消（插入序 [B,A]）、关单批（X1=[B], X2=[A]）各并发 20 轮，要求零 40P01。
  - 修法已验证：`fix-probe.mts` 加上排序预锁后，两种执行计划下都是 `create: none / cancel: none`。
- **置信度**：已探针证实。
- **是否已登记**：新发现。2026-09-26 的 P1 只修了"建单对建单"，这条是那次修复的遗漏面。

#### ORD-02｜P2｜钱与状态 / 状态卡死
- **位置**：app/admin-order-routes.ts:280-330
- **问题**：退款第一段事务已经提交 `paid→refunding` 之后，才调用 `registry.getForRefund(provider)`。这是纯配置查找，本可以在事务内做；通道不可用时它抛 40001，订单却已经永久停在 refunding。
- **证据**：
  ```ts
  const plan = await withTransaction(deps.db, async (tx) => { … markRefunding(...) … });
  const outcome = await executeRefund(deps, deps.registry.getForRefund(plan.pay.provider), {
  ```
  另外，`registry.getForRefund` 在 `channel_not_configured` 时返回 `AppError(40001)`；`channels.ts` 在生产环境只有 mock 被列出时才注册 mock。
- **触发场景与后果**：审核期的 `is_test` 已付单，发货被拦（40902），也不能取消，唯一出口就是退款。审核结束后 mock 下线，管理员点退款：
  - 订单进入 refunding；
  - 管理员看到的是 400「参数缺失或格式错误」，以为什么都没发生；
  - 每次重试都走重试分支，然后再次 40001；
  - `stuck_refunds` 不设回看上界，每天永久报警；
  - 4xx 不写 admin_audit。

  Stripe 凭据轮换或缺失时同理。
- **解决方案**：
  1. 在事务内、`markRefunding` 之前解析 provider：`const provider = deps.registry.getForRefund(pay.provider)`。失败则事务回滚，状态不变，然后把 provider 带出事务。
  2. 给 `is_test` 单另开清理路径：`refundGuard` 显式拒绝，或者 mock 单直接落 `refunded`（不调机构）。
  3. 补测试：`REVIEW_MODE=off` 且 mock 未注册时退款 is_test 已付单，断言订单仍是 paid、没有 refunding 事件。
- **置信度**：已读代码证实（`channels.ts` 的 mockRegistered 条件、`registry.ts:142-155`）。
- **是否已登记**：新发现。

#### ORD-03｜P2｜钱与状态 / 可控输入
- **位置**：app/admin-order-routes.ts:275-278、304-310；adapters/payment/stripe-checkout.ts:540
- **问题**：退款理由不限长，却原样写进 Stripe 的 `metadata[reason]`（值上限 500 字符）；重试又强制沿用首次理由。一旦首次超长，这张单永远退不出去。
- **证据**：
  ```ts
  if (typeof reason !== 'string' || reason.trim() === '') throw …   // 无上限
  refundReason = original;                                          // 重试沿用首次
  'metadata[reason]': req.reason,
  ```
  WebFetch docs.stripe.com/metadata（2026-09-28）原文："value: 500 character limit."
- **触发场景与后果**：管理员写了一段超过 500 字的中文说明。
  - Stripe 返回 400，被记成 `provider_error`（结果未知）；
  - 后续每次重试都发同一段理由，永远 400；
  - `order_events` 是 append-only，理由改不了，只能手工插一条新的 refunding 事件；
  - 订单永久停在 refunding。
- **解决方案**：
  1. 路由层校验 `reason.trim().length ≤ 500`（或更保守的 200），超出返回 40001，校验放在事务之前。
  2. stripe 适配器对 metadata 做同口径的确定性截断作为纵深防御；重试时同样截断，保证同键同参。
  3. 补测试：501 字理由 → 40001，且订单仍是 paid。
- **置信度**：已读代码证实，外部限制已查官方文档。
- **是否已登记**：新发现。

#### ORD-04｜P2｜可靠性 / 看门狗失明
- **位置**：app/daily-reconciliation.ts:233-236、246-250；app/auto-fulfilment.ts:6；main.ts:168
- **问题**：daily 心跳只由 daily 作业自己检查。daily 一旦停跑，这个检查也不跑，所以"daily 没跑"永远报不出来。tick 的任务里没有任何一项盯 daily。AJ-102 说的"tick/daily 互相看心跳"只兑现了一半。另外 daily 从未成功过（null）时刻意不报，于是"cron 从来没配"也同样失明。
- **证据**：
  ```ts
  name = ${DAILY_JOB_ROW_NAME} and last_success_at is not null and last_success_at < … 26h
  // auto-fulfilment.ts:6 「挂在每日作业里还白拿看门狗：daily 心跳停滞会被每日对账报 stalled_heartbeats」
  jobs: [createExpireOrdersJob(), createCleanupIdempotencyJob()],   // tick 无 daily 检查
  ```
- **触发场景与后果**：Render Cron 被删、密钥轮换后 cron 拿到 40101、或上线时漏配 cron。
  - 自动签收、自动完成、六类对账全部静默停止；
  - 已发货订单永远不签收；
  - 退款滞留、回调异常无人报告；
  - 没有任何日志提示。
- **解决方案**：
  1. 在 tick 里加一个只读 job（或并入关单 job 之后）：`job_runs('daily').last_success_at` 超过 26 小时，或为 null 且进程已运行超过 26 小时，打 error `daily_heartbeat_stalled`。
  2. 修正 auto-fulfilment.ts:6 的注释。
  3. 补测试：daily 行 last_success_at 设为 27 小时前，跑一轮 tick，断言 error 日志。
- **置信度**：已读代码证实。
- **是否已登记**：新发现（契约 0.6.0③ 的描述低估了这个盲区）。

#### ORD-05｜P2｜审计留痕 / 拒付举证
- **位置**：adapters/orders-admin.ts:624-640；app/admin-order-routes.ts:369-396；app/admin-audit.ts:12-13、30-38
- **问题**：管理员改址后，原收货地址在任何地方都查不到了：
  - `address_snapshot` 被整体覆盖；
  - 事件 note 是固定文案；
  - admin_audit 的 before 没有设置，after 又把 recipient / phone / line1 / line2 脱敏了。
- **证据**：
  ```ts
  update orders set address_snapshot = ${tx.json(snapshot)} … where id = ${orderId} and status = 'paid'
  values (${orderId}, 'address_changed', '管理员改址', ${actor}, ${at})
  export const PII_KEYS = new Set(['password','phone','email','contact_email','recipient','line1','line2']);
  ```
- **触发场景与后果**：盗号后联系客服改址，或买家事后以"未收到货"发起拒付。我方拿不出"原地址是什么、何时被谁改成了什么"的证据，而改址恰恰是这类欺诈的典型手法。
- **解决方案**：
  - 在 `lockAdminOrder` 时一并读出旧 `address_snapshot`，事务内做以下之一：
    1. 写进 `address_changed` 事件的 note（JSON；order_events 在库内，只在管理端可见，与 orders 表同级存 PII，约束七禁止的是进日志）；
    2. 或 `setAuditBefore(res, 旧快照)`。注意 before 不经过 `auditPayload` 脱敏，需要先确认 admin_audit 是否允许存 PII。
  - 补测试：改址后能从事件或审计里还原旧地址。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-06｜P3｜对账漏报
- **位置**：app/daily-reconciliation.ts:103-151、316-327；jp 技术文档 §6.1（第 504 行）
- **问题**：
  1. 技术文档列出的对账项"未关单的过期单"（`created/pending_payment` 且 `expires_at` 已过）没有扫描；心跳检查只能覆盖"整个 tick 失败"，覆盖不了积压和持续被 SKIP LOCKED 跳过的情形。
  2. `paid_without_succeeded_payment` 只看 `status='paid'`。两本账不符的单一旦被发货或进入退款（shipped / delivered / completed / refunding），就从扫描里消失。
- **证据**：`where o.status = 'paid' and coalesce((select p.status … limit 1),'none') <> 'succeeded'`
- **后果**：两类异常各自有一条"逃出扫描"的路径。
- **解决方案**：
  1. 新增第七类：`status in ('created','pending_payment') and expires_at <= startedAt - interval '10 min'`。
  2. 第二类扩为 `status in ('paid','shipped','delivered','completed','refunding')` 要求最新支付为 succeeded，`refunded` 要求 refunded。
  3. 两类各补一个 db 用例。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-07｜P3｜注释与实现不符（"已防住"类）
- **位置**：app/create-order.ts:10-12；app/quote-assembly.ts:14-15；adapters/catalog.ts:101-106；adapters/orders.ts:190-196
- **问题**：注释声称"全部读取都在本事务内（无 TOCTOU）"。但连接用的是默认的 READ COMMITTED，每条语句取新快照；商品读取不加锁，扣库存也不检查 `status`。
- **证据**：`select id, title, price_jpy, … from products where id in …`（无 `for share`）；`update products set stock = stock - … where id = … and stock >= …`
- **触发场景与后果**：`probe2.mts ②` 的输出：`tx 内读到的价=100，扣减成功=true，提交后库里价=999 status=offline`。结果是按旧价成交了一件已下架的商品，例如因合规下架的那一刻正好有人下单。
- **解决方案**：
  - 二选一：
    1. 第 3 步改成 `… order by id collate "C" for share`，与第 6 步同序，不会引入新的锁序；
    2. 或 `decrementStock` 加 `and status = 'active'`，返回 false 时抛 40401。
  - 同时修正两处注释。
  - 补测试：事务内读价后另一连接下架，建单应 40401。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

#### ORD-08｜P3｜可控输入 / 错误码
- **位置**：app/admin-order-routes.ts:246-251；migrations/001（`carrier VARCHAR(32)`、`tracking_no VARCHAR(64)`）
- **问题**：发货的 carrier / tracking_no 只做 trim，不限长；超长时数据库报 22001，最终变成 50000。
- **证据**：psql 探针结果为 `value too long for type character varying(64)` 和 `(32)`。
- **解决方案**：路由层限制 carrier ≤ 32、tracking_no ≤ 64，超出返回 40001（与 order-routes 对 contact_email 的处理同口径）；契约补 maxLength；补一个用例。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

#### ORD-09｜P3｜报价与建单不一致
- **位置**：app/quote-routes.ts:74-94 与 app/create-order.ts:134-146、162
- **问题**：
  1. 审核模式下，报价接受任意 SKU，建单却对非 `REVIEW_SKU_ID` 一律 40401；
  2. 建单额外要求 USD 汇率（申报价值用），报价不要求。当 country_profiles 的展示币不含 USD 且 fx_rates 没有 USD 行时，报价成功、建单 50003。

  两处都违背了"40905 语义等于与报价一致"。
- **解决方案**：审核闸门抽成共用函数，报价也调用；报价同样传 `['USD']` 给 `assembleQuote`（或把申报币种写成配置），缺失时报价就给 50003。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-10｜P3｜注释 / 文档失真
- **位置**：
  - packages/shared/src/orderNo.ts:19-20
  - domain/quote.ts:15-16、146、161
  - domain/order-no.ts:18-19
  - packages/shared/src/id.ts:2
- **问题与证据**：
  1. 注释说"十万级碰撞概率约 0.5%"。实算（node）：n=1e5 时单日至少一次撞号的概率是 0.9905，单次插入撞号概率 9.3e-5；0.5% 大约对应 3,300 单/日。
  2. quote.ts 的 @limitation 一还写着"三口径未定前的展示口径"，与第 13 行"AJ-142 已定案"自相矛盾；并且 AJ-142 选定的公式是 `ceil(items×15%)`，代码用的是 `applyRate`（四舍五入），例如 1003 円时 150 对 151。
  3. `computeQuote` 注释写"@throws 50003 fx_rates 无当日行"，实际是取 `effective_from <= now` 的最新一行，不限时效。
  4. order-no.ts 写"摇号下一步端口化"，但 `IdGen.orderSeq` 早已端口化。
  5. id.ts 写"生产用随机种子"，但生产环境不用它（`systemIdGen` 用 `randomUUID`）。
- **解决方案**：逐条改注释；关税取整方向二选一——改用向上取整的 `applyRate` 变体，或在 AJ 决策记录里登记"改为半入"，并同步技术文档 §2.5。
- **置信度**：已读代码证实（第 1 条已数值计算）。
- **是否已登记**：新发现。

#### ORD-11｜P3｜契约漂移
- **位置**：contracts/api-contract.yaml:291-295、297-309、323-327、346-352、481-482
- **问题**：
  1. 以下接口实现会返回、响应清单却漏列（按契约自己的规则"漏列即漂移"）：
     - `/orders/quote` 的 400（40001）、404（40401）、500（50003/50004）；
     - `GET /orders` 的 400；
     - `GET /orders/{id}` 的 404；
     - `/orders/{id}/cancel` 的 400/404。
  2. `Order.address` 引用 `Address`，其中 `id`、`line2` 都是非 nullable 的 string。实际上无 line2 的快照恒为 `line2: null`，管理员改址后 `id: null`，买家详情原样透出。
  3. refund 的 description 仍写"0.6.7 起拒付结案（won/lost）时它被复位为 false"，与 0.6.10①（败诉保持 true）矛盾。
- **补充**：`routes.contract.test` 不比对 schema，所以以上都不会报红。
- **解决方案**：补齐 responses；Address 的 `id`、`line2` 标 `nullable: true`；删改 refund 那段描述。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-12｜P3｜违反约束四（写死国家 / 币种、双真源）
- **位置**：
  - domain/address-input.ts:40-41、79（US 专用正则，默认 `'US'`）
  - domain/quote.ts:29（`'USD' | 'CNY'`）
  - app/quote-assembly.ts:83（`?? 'JP'`）
  - app/create-order.ts:162、240（`'USD'`）
  - app/order-query-routes.ts:43-45 与 quote-assembly.ts:76-78
- **问题**：
  - 改址时国家查的是 country_profiles，格式却按写死的 US 正则校验；
  - 订单列表和详情的展示币读 `config.DISPLAY_CURRENCIES`，报价和建单读 country_profiles——运营只改其中一处，订单页就会少显示或多显示币种。
- **解决方案**：address-input 改为用 `country_profiles.address_template` / `phone_pattern` / `postal_pattern` 驱动；展示币统一取一个真源；申报币种改成配置。
- **置信度**：已读代码证实。
- **是否已登记**：部分已登记（AJ-176 的总体差距），但具体这几处未登记。

#### ORD-13｜P3｜事件机制无效果
- **位置**：app/business-events.ts:23-28；app/mark-disputed.ts:195、287、318
- **问题**：`order.dispute_opened` / `order.dispute_closed` 被发出，但既不在 `LOGGED_EVENTS` 里，也没有其它订阅者。这正是该文件头说的"有机制、无效果、还以为有"。发货、退款、自动签收、自动完成都不发领域事件。
- **解决方案**：把两个拒付事件补进 `LOGGED_EVENTS`；或者加一个单测：扫描源码里所有 emit 的事件名 ⊆ 已订阅集合。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-14｜P3｜输入形状
- **位置**：domain/address-input.ts:67、75、79
- **问题**：
  - `line2` 和 `country` 用 `String()` 强转非字符串值：对象会变成 `"[object Object]"` 并通过 ASCII 校验入库，`null` 会变成 `"null"`；
  - recipient 只有空格也能通过（DB 的 CHECK 同样放行）。
- **解决方案**：非字符串一律 40001；必填字段先 trim 再判空。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

#### ORD-15｜P3｜并发（疑似）
- **位置**：app/admin-order-routes.ts:280-344；app/refund-execution.ts:67-97
- **问题**：退款的第二段（事务外）没有按订单互斥。两个管理员同时点"查询在途失败单"时，各写一条 `provider_failed:R1`，`confirmedFailures` 被重复计数，下一次会跳过一把幂等键。
- **后果**：机构侧的全额上限（已全额退的 charge 不能再退）大概率兜住了资金，但事件流会失真。
- **解决方案**：第二段前按订单取 `pg_try_advisory_lock(hashtext(orderId))`，拿不到返回 40903；或者按 note 去重计数。
- **置信度**：疑似，缺并发实测。
- **是否已登记**：新发现。

**高风险分支无测试（只点名）**：
- 建单对取消 / 关单的死锁（ORD-01）；
- 退款时通道不可用（ORD-02）；
- 超长退款理由（ORD-03）；
- daily 停跑的发现（ORD-04）；
- 改址后旧地址可追溯（ORD-05）。

### 3. 看过但不是问题的疑点

- **运费取档**：`max_weight_g >= w` 并升序取第一行；重量 = 商品重 + `PACKAGING_WEIGHT_G`，入库的 weight_g 口径相同。全仓只有一处取档 SQL，`w=1850 → 4950` 成立。
- **申报价值分摊**：`allocate` 的和按构造恒等于 total；在单笔 ≤180,000 円的取值范围内浮点精确，`remainder ≤ n`。
- **库存双倍回补**：关单和取消都先做带状态条件的 UPDATE，拿到 true 才回补；expired / cancelled 是终态，不存在"回补后又成交"。重复的 product_id 在 domain 层就被拒，所以 `UPDATE…FROM` 不会少补。
- **过期边界**：关单 `expires_at <= now`，与 mark-paid 的 `now >= expires_at` 同向；关单扫描用 SKIP LOCKED；自动签收 / 完成在 CTE 内复查状态并排除 has_dispute；同一轮签收后不会连带完成（天数 ≥1，由 config 保证）。
- **订单号**：savepoint 捕获 23505 后换号重试 3 次；日期取 JST（UTC 15:00 跨日）；`formatOrderNo` 校验字母表。`Math.random` 已登记，单号不承担权限。
- **买家读接口**：`findOwnedOrder` 按 user_id 过滤之后才查附属数据；时间线只取 status / at 且按 ORDER_STATUS 过滤，note 和 actor 不外泄；不存在与非本人同为 40400。
- **幂等与事件**：只有 handler 成功后才 push 事件，重放不会发；handler 内部的 55P03 原样抛出，不会被重跑。
- **金额与分页比较**：40905 / 40906 与 split_hint 同用 `>`。管理端 status 先校验枚举；keyword 用 `position()`，没有通配符注入；分页参数有校验。
- **退款不回补库存**：技术文档没有规定。缺货退款场景本就不该回补，属于待业务确认的口径，不算缺陷。
- **拒付败诉后订单永远停在 paid / shipped**：AJ-176 裁决⑧ 的反向风险已写明"按钮一直禁用"。但"永远不自动完成、不进任何报表"这一点没有写入，可以顺带补一句。
