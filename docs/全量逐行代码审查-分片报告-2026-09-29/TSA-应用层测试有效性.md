> 本文是 2026-09-29 全量逐行代码审查的 **TSA 分片（应用层测试有效性）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# TSA 分片报告：应用层测试有效性（server/src/app/*.test.ts）

本分片最严重的问题有一个：同一张订单被**第二笔真实扣款**（不同通道、不同机构单号、不同金额）时，系统只记为 `paid:already` + info 日志，每日对账也不会扫到。现有测试把这个行为当成正确结果断言了下来。该问题已用探针证实。另有 5 条 P2、7 条 P3，见下文。

整个过程只读仓库、没有跑 db/e2e。探针只用了自建的独立库 `review_tsa`，用完已删。

## 1. 覆盖清单（共 51 个文件，13,947 行，均已逐行读完）

| 文件 | 行数 | 文件 | 行数 |
|---|---|---|---|
| admin-audit.unit | 52 | order-query-routes.db | 296 |
| create-order.unit | 55 | admin-risk-routes.db | 299 |
| webhook-results.unit | 55 | admin-product-routes.db | 316 |
| admin-auth-store.db | 92 | auth-route-matrix.db | 320 |
| unit-of-work.unit | 98 | quote-create-chain.db | 338 |
| http-outbound.unit | 121 | mark-paid.db | 343 |
| admin-audit.db | 126 | scheduler.unit | 344 |
| auto-fulfilment.db | 128 | close-session-wiring.db | 350 |
| unit-of-work.db | 135 | admin-banner-routes.db | 352 |
| wechat-login.db | 135 | close-session-events.db | 352 |
| admin-auth-routes.db | 140 | admin-upload-routes.db | 367 |
| wechat-auth-routes.db | 161 | admin-buyer-consistency.db | 368 |
| review-mode.db | 169 | order-failure-consistency.db | 373 |
| scheduler-start.db | 169 | order-golden-chain.db | 377 |
| product-routes.db | 171 | pay-routes.unit | 381 |
| pay-link-routes.db | 174 | order-routes.db | 432 |
| pay-link.db | 176 | internal-jobs.db | 437 |
| rate-limit.unit | 180 | admin-ops-routes.db | 439 |
| address-routes.db | 194 | admin-order-routes.db | 457 |
| mark-paid-fault.db | 204 | pay-intent.db | 460 |
| expire-orders.db | 209 | pay-callback.unit | 471 |
| create-order.db | 215 | mark-disputed.db | 510 |
| order-race.db | 227 | auth.unit | 550 |
| quote-routes.db | 227 | stripe-golden-chain.db | 622 |
| pay-intent-routes.db | 238 | admin-catalog-buyer-chain.db | 263 |
| scheduler-start.unit | 279 | | |

为了下结论，还读了以下被测代码与测试工具：
- `test/helpers/` 下全部 10 个文件，以及 `test/db/test-db.ts`；
- `server/src/app/` 下所有被测源文件；
- `adapters/orders.ts`（autoAdvanceOrders）、`adapters/admin-auth.ts`、`orders-admin.ts`（markRefunded）、`domain/dispute-input.ts`、`mount.ts`（落账器）、`main.ts`（装配）、`config.ts`（出站 HTTP 那一段）；
- vitest 5.0.1 的 groupSpecs 源码：确认 db 和 e2e 两层是在同一个串行组里执行的，不会并发。

## 2. 发现列表

### TSA-01｜P1｜钱｜第二笔真实扣款被当成"同一笔钱的另一个事件"静默吞掉，测试把它当正确行为断言了
- **位置**：`mark-paid.ts:201-210,222`；`pay-callback.ts:380-397`；`daily-reconciliation.ts:160-162`；`close-session-events.ts:41-43`（注释）；测试 `pay-callback.unit.test.ts:315-325`、`order-golden-chain.db.test.ts:198-216`
- **问题**：订单已是 `paid` 时，`markOrderPaid` 先问状态机、直接抛 `40902 {from:'paid'}`（不带 reason），根本不核对这笔钱属于哪个通道、哪个机构单号、金额多少。管线据此一律记 `paid:already`（info 级），而对账 SQL 不扫 `paid:already`。
- **证据**：
  ```ts
  if (!canTransition(from, 'paid')) {           // mark-paid.ts:208 —— 在 assertSettlementMatches 之前
    throw new AppError(40902, { from, to: 'paid', where: 'mark-paid' });
  if (details?.from === 'paid') { … result: RESULT_PAID_ALREADY …   // pay-callback.ts:380
  ```
- **触发场景与后果**：用户先选 A 通道（例如没有 `expireSession` 的通道，或 Stripe 作废失败），再换到 B 通道付款成功；随后又在还开着的 A 页面付了第二次，A 的回调到达。
  - 探针结果：`disposition=paid:already | http=200 | webhook result=paid:already | levels: info:paid_already`。
  - 买家被扣了两次，没有 error 日志，也不进对账。
  - `close-session-events.ts:41-43` 的注释声称"第二笔以 channel_mismatch 进对账"，这与实现不符（违反约束六）。
  - 测试只用"同一个 provider_ref、同一金额、新 event_id"的形态断言 `paid:already`，从未构造"不同的钱"这种情况。
- **解决方案**：
  1. `mark-paid.ts`：当 `from==='paid'` 时，取该单 `status='succeeded'` 的那一行核对。
     - 通道不同，或同一 id 族但 `provider_ref` 不同 → 抛 `40902 {reason:'duplicate_payment'}`。这个词不超过 23 字符，要加进 `SETTLEMENT_MISMATCH_REASONS`。
     - 与已成功那笔一致 → 仍记 `paid:already`。
  2. 补测试：
     - `mark-paid.db`：已付单收到"另一通道 / 另一 cs 单号"的回调 → `details.reason==='duplicate_payment'`。
     - `order-golden-chain`：已付后发 `override:{provider_ref:'mock_other', amount_minor:X}` → 结果 `mismatch:duplicate_payment`、error 级、对账样本里包含该事件。
     - `pay-callback.unit`：把"已是 paid"的用例拆成两条，同一笔 → info，不同笔 → error。
  3. 修正 `close-session-events.ts:41-43` 的注释。
- **置信度**：已探针证实（`scratchpad/review5/TSA/double-pay-probe.mts`）
- **登记情况**：新发现。已登记的 KD-16 只覆盖"尚未付款"窗口内旧会话可付（那种情况走 channel_mismatch，是可见的），没覆盖"已付款之后"这个窗口。

### TSA-02｜P2｜状态机｜自动签收 / 自动完成的状态过滤没有测试，用例名声称测过
- **位置**：`auto-fulfilment.db.test.ts:168-183`（"只迁 delivered（不越级迁 shipped）"）；`adapters/orders.ts:109-119`
- **问题**：用来做对照的 `o-shipped` 的 `delivered_at` 是 NULL，而 `NULL <= ts` 为 NULL，这张单无论状态过滤在不在都不会被选中。文件里也没有任何非 `shipped`/`delivered` 状态、但计时列已过期的样本。
- **证据**：`await seed('o-shipped', 'shipped', { shipped: ago(1 * DAY) });`（delivered 为 null）
- **触发场景与后果**：探针把两处 `status = ${m.from}` 都删掉，再用测试同款种子跑：
  - 测试里的全部断言结果不变，仍然会是绿的；
  - 同时 `refunded` 单被改成 `completed`/`delivered`，`completed` 单被倒退回 `delivered`。
  - 状态机表允许 shipped/delivered 进入 refunding，所以带历史 `shipped_at` 的退款单是真实存在的形态。
- **解决方案**：两个作业的用例各补一组"计时列已过期但状态不对"的种子：`delivered`、`completed`、`refunding`、`refunded`、`cancelled`（自动完成那组要带 `delivered_at`），断言状态不变、`order_events` 没有新增行。补完后做一次缺陷注入：删掉过滤条件必须变红。
- **置信度**：已探针证实（`auto-advance-probe.sql`）
- **登记情况**：新发现

### TSA-03｜P2｜钱 / 拒付｜拒付金额必须等于扣款金额，这与 Stripe 文档矛盾，测试也把它断言成正确
- **位置**：`mark-disputed.ts:251-257`；`mark-disputed.db.test.ts:461-466`
- **问题**：Stripe 官方对 `Dispute.amount` 的说明是："Usually the amount of the charge, but it can differ (usually because of currency fluctuation or because only part of the order is disputed)"（2026-09-28 WebFetch 取得原文）。实现却在金额不等时拒绝落库。
- **证据**：`if (Number(p.charge_amount) !== d.amountMinor) throw new AppError(40902, {reason:'amount_mismatch'…})`
- **触发场景与后果**：部分拒付或汇率波动导致金额不同时：
  - 订单 `has_dispute` 保持 false，发货和退款闸门不会锁（可能发出货物、钱货两空）；
  - 风控列表里看不到这条拒付；
  - 只剩一条 `mismatch:amount_mismatch` 的 error 日志和对账记录。
- **解决方案**：
  - 拒付只校验币种一致、金额为正整数，按机构报的金额落 `dispute_amount`；金额与扣款额不等时额外打一条 warn。
  - 测试改为：金额小于扣款额 → 落库且 `has_dispute=true`；币种不符 → mismatch。
  - `stripe-golden-chain` 的拒付用例增加一条部分金额的样本。
- **置信度**：已读代码证实，并有官方文档佐证
- **登记情况**：新发现

### TSA-04｜P2｜状态 / 拒付｜询问类或被阻止的拒付结案后订单被永久锁住；该分支无测试，注释之间互相矛盾
- **位置**：`mount.ts:177-184`；`domain/dispute-input.ts`（parseDisputeResult 的 @why）；`mark-disputed.db.test.ts`（没有这条分支）
- **问题**：Stripe 的 Dispute.status 取值包括 `warning_closed`（询问关闭、未转成正式拒付）和 `prevented`。这两种结案都会被映射成 undefined，mount 随即抛 `dispute_result_unknown`，`has_dispute` 保持 true。domain 注释写的却是"open 的拒付收到 warning_closed 应当保持 open，不该报错"，与 mount 的实际行为相反。
- **触发场景与后果**：`charge.dispute.created(warning_needs_response)` 开案 → `charge.dispute.closed(warning_closed)` 被拒 → 这张单的发货（40909）和退款（40907）永久被拦，只能手工改库。全仓没有任何测试走到 `dispute_result_unknown`。
- **解决方案**：
  - 把 `warning_closed`/`prevented` 定义为"解除限制、不计输赢"：复位 `has_dispute`，`dispute_status` 记原值（契约的枚举需要同步），或者至少不再报错。
  - 补 `mark-disputed.db` 与 `stripe-golden-chain` 用例：询问开案 → 询问关闭 → 可以发货。
  - 另补一条用例：未知 status → `mismatch:dispute_result_unknown`、error 级。
- **置信度**：已读代码证实，并有官方文档佐证
- **登记情况**：新发现

### TSA-05｜P2｜替身不符 + 期望值自证｜Stripe 会话"创建后 30 分钟到 24 小时"的约束没有任何一处真正钉住
- **位置**：`test/helpers/fake-stripe-http.ts:134-157`；`stripe-golden-chain.db.test.ts:224-227`；参考 `stripe-checkout.unit.test.ts:190-193`（分片外）
- **问题**：
  - 替身不校验 `expires_at` 的取值窗口，而且响应里恒定返回 `1_800_000_000`；
  - 两处测试的期望值都用被测模块导出的 `STRIPE_MIN_SESSION_TTL_SEC` 来算，属于自证。
  - Stripe 文档原文："It can be anywhere from 30 minutes to 24 hours after Checkout Session creation."
- **触发场景与后果**：有人把 `STRIPE_MIN_SESSION_TTL_SEC` 改小，比如改成 60：
  - 全部测试仍然是绿的；
  - 生产上凡是离到期不足约 28 分钟时发起的会话都会被 Stripe 拒 400，Stripe 通道的核心功能不可用。
- **解决方案**：
  - 替身在 POST sessions 时校验 `now+1800 ≤ expires_at ≤ now+86400`，超出返回 400 invalid_request_error，并把请求值原样回显在响应里；
  - 链路测试改成字面量：`orderExpSec + 1800 + 120`；
  - 增加一条"订单到期前 30 秒发起支付 → 替身接受"的用例。
- **置信度**：已读代码证实，并有官方文档佐证
- **登记情况**：新发现

### TSA-06｜P2｜安全｜管理员登录防邮箱探测的计时防线（DUMMY_HASH）没有测试；邮箱脱敏只验了成功路径
- **位置**：`admin-auth-routes.ts:87-102`；`admin-auth-routes.db.test.ts:189-212`
- **问题**：把"邮箱不存在时也跑一次 bcrypt"删掉，全部测试仍然是绿的，因为用例只比较响应体是否相同。"日志不含邮箱"只在登录成功那条用例里检查过，失败路径没有检查。
- **解决方案**：
  - 把口令校验函数作为依赖注入到路由里（`deps.verifyPassword`），测试断言邮箱不存在时它被调用过、且入参是一个合法的 bcrypt 串；
  - 在"密码错 / 邮箱不存在"的用例里，把 `JSON.stringify(sink.lines)` 不含 `ghost@example.com` 也断言上；
  - 补一条 `password_hash IS NULL` 的管理员用例。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-07｜P3｜断言不足｜拒付拒绝路径只断言错误码、不断言 reason；列宽测试漏掉了拒付词表
- **位置**：`mark-disputed.db.test.ts:194-202, 369-399, 444-497`；`webhook-results.unit.test.ts:73-86`
- **问题**：
  - 以 `dispute_id_conflict`、`dispute_result_conflict`、`dispute_not_open`、`no_succeeded_payment` 以及通道、金额、币种为名的用例，断言都只有 `{code:40902}`。这几个 reason 字符串除了出现在用例名里，全仓没有任何断言。
  - 有人把其中某个 reason 改掉，管线会把它从 error 降成 warn（`ignored:status_conflict`），测试仍然是绿的。
  - 列宽测试"每个管线可能写入的值都 ≤ 32"没有包含 `DISPUTE_MISMATCH_REASONS`。其中 `mismatch:dispute_result_conflict` 正好 32 个字符，余量为零；这和已经专门钉住的 `settlement_unverifiable` 是同一种情况。
- **解决方案**：
  - 每条用例都改成断言 `details:{reason:…}`；
  - 列宽测试把 `DISPUTE_MISMATCH_REASONS`、`RESULT_DISPUTE_CLOSED`、`ignored:dispute_closed` 加进去；
  - outcome 清单改为从类型穷举生成（可以用 satisfies 或 record 映射）。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-08｜P3｜时序脆弱｜用 sleep 猜锁的时序，异步订阅者的竞态没有等待
- **位置**：`mark-paid.db.test.ts:92-101`；`expire-orders.db.test.ts:263-275`；`order-golden-chain.db.test.ts:252-254`；`order-race.db.test.ts:72-76, 218-222`；`order-failure-consistency.db.test.ts:146-152`
- **问题与后果**：
  - **mark-paid 并发用例**：持锁方固定 sleep 300ms 就放锁。去掉 `for update` 后能否让测试变红，取决于两个请求都在 300ms 内执行到 select；机器负载高时变异会漏检。
  - **expire-orders 用例**：同样是 300ms 放锁。负载高时，关单作业可能在锁释放之后才开始，正确实现反而会误红。
  - **order-golden-chain 与 order-race 第 3 条**：关单作业之后立刻做快照或断言 `payments=['cancelled']`，但作废支付行的是 `order.expired` 的异步订阅者，而且和测试共用同一个连接池。这是一个潜在的误红竞态；同一个文件里的"迟到付款"用例用了 waitUntil，这里没用。
  - **pg_stat_activity 探测**：没有按 `datname` 过滤，而且用 `=== 1` 判断。同一个 PG 集群上有别的任务时，可能过早放锁或等到超时。
- **解决方案**：
  - 持锁方先取自己的 `pg_backend_pid()`；测试轮询 `count(*) where $holder = any(pg_blocking_pids(pid))`，等到 2 个等待者再放锁；
  - expire 用例改成"作业跑完之后才放锁"，并套一个 5 秒的 `Promise.race`，一旦卡住就判红；
  - chain-server 给事件总线加上在途 Promise 计数，暴露 `srv.events.idle()`，`runExpireJob` 返回前先等它；
  - 所有 pg_stat_activity 查询都加 `datname = current_database()`。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-09｜P3｜共享状态泄漏
- **位置与问题**：
  - `scheduler-start.db.test.ts`：没有 reset，第 2、3 条用例依赖第 1 条的副作用。探测行只在 afterAll 里删；一旦进程被杀，下次运行插入 `PROBE_A` 会撞主键，整个文件一直红。
  - `chain-server.ts:244-259`：`runDailyReconciliation` 会改写迁移种下的 `daily` 心跳行（last_success_at、last_processed、trace_id），用完不恢复。
  - order-failure-consistency、admin-catalog-buyer-chain、order-golden-chain 三个文件每个只起一个服务：限流桶（orders.create 已用到约 19/30）和身份缓存在同一文件的用例之间延续。
  - 审计写入是发出就不管的，可能在下一条用例的 `resetTestDb` 之后才落库。
- **解决方案**：
  - scheduler-start.db 在 beforeAll 里先删三行探测数据，三条用例各自造状态；
  - `runDailyReconciliation` 执行前记下 daily 行的内容，执行后写回；
  - 链路文件改成每条用例起一个服务，或提供 `srv.resetCaches()`；
  - `resetTestDb` 之前先等审计写入落定（审计中间件暴露一个 flush 给测试用）。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-10｜P3｜替身与真实行为不符（fake-stripe-http）
- **位置**：`fake-stripe-http.ts:190-205, 116-131`
- **问题**：
  - **expire 恒返回 200**：官方文档写明 "can be expired when it is in one of these statuses: open … Returns an error if … already expired or isn't in an expireable state"。
  - **并发同键请求**：文档写明 "the request conflicts with another request that's executing concurrently, we don't save the idempotent result"，也就是会报错；替身把并发请求串行化，退款双击或两个管理员同时退款的路径无法暴露。另外全仓没有并发退款的测试。
  - 会话响应的 `expires_at` 是常量，和请求无关。
- **解决方案**：
  - 替身记录会话状态（open/complete/expired），expire 只放行 open；
  - 增加 `holdNext(path)`，让同一个键的第二个请求返回 409；
  - 在 `stripe-golden-chain` 增加"两个管理员同时点退款"的用例，断言 Stripe 侧只有 1 笔退款、订单最终是 refunded、时间线可以解释。
- **置信度**：已读代码证实，并有官方文档佐证
- **登记情况**：新发现（替身文件头的 @limitation 没有列出这三点）

### TSA-11｜P3｜用例名称声称验证了 X，实际没验 X（合并）
逐条列出，每条的修法都是把名称里说的内容写成断言：

| 位置 | 问题 |
|---|---|
| `admin-audit.db.test.ts:62` | 名称说 "trace_id 与响应头一致"，实际是 `String(row.trace_id)).toMatch(/.+/)`，`String(null)==='null'` 也能通过，永远为真 |
| `auth.unit.test.ts:164-186` | 两条"toPrincipal 拒绝"的用例，token 都没有 aud。探针：`missing required "aud" claim`，也就是在 jose 这一层就被拒了（N16 那组用例已补齐，这两条名称有误导） |
| `pay-routes.unit.test.ts:361-368` | 数组头是 set-cookie，签名头始终是普通字符串，注释里的"反证会变 40103"不成立 |
| `pay-link-routes.db.test.ts:102, 121-134` | 用例名写"相对失效页"，实际断言的是绝对地址；测试服务没有配 cors，"不放行 CORS"不可能红 |
| `auth-route-matrix.db.test.ts:173-174` | 名称说"所有受保护路由"，实际只遍历了买家路由 |
| `scheduler-start.db.test.ts:118-147` | "后到者不写心跳"没有断言；`expect(entered).toBe(true)` 是同义反复；"提交后分发"分辨不出"savepoint 之后、提交之前" |
| `internal-jobs.db.test.ts:152-154, 172, 221` | 基线已经把 `last_success_at` 设成 now()，所以"非空"必然成立；名称说"窗口下界来自注入时钟"，但端点用的是 systemClock，种子用的是 DB now() |
| `order-routes.db.test.ts:204-211` | 注释说验证"事件不重复发"，实际数的是 order_events 表的行 |
| `create-order.db.test.ts:157-163` | 名称说"重复释放被挡住"，但第二次根本没调用 restore，库存断言必然成立 |
| `review-mode.db.test.ts:113-116` | 分辨不出"重放时没有触发自动确认"和"触发了但被去重"（应断言 `pay_auto_confirmed` 仍是 1 条） |
| `rate-limit.unit.test.ts:238` | "绝不读 XFF"没有被验证 |
| `http-outbound.unit.test.ts:120-129` | 只校验默认值，用环境变量把预算设成 30s 照样能通过（config 里也没有跨字段规则） |

- **置信度**：已读代码证实；auth 那一条已探针证实
- **登记情况**：新发现

### TSA-12｜P3｜chain-server 声称走生产装配，实际有漂移；"零副作用"快照有盲区
- **位置**：`chain-server.ts:1-11, 83-90, 281-292`；`main.ts:129-145`
- **问题**：
  - 没有传 `trustProxyHops`、`cors`、`silentPaths`，也没有经过 `bootstrap()`。
  - `snapshotState` 漏掉了业务确实会改的列：`orders.pay_token_hash/has_dispute/is_test/expires_at`、`payments.provider_ref/pay_url/transaction_id/dispute_*`，以及 users、addresses、admin_audit 三张表。这与它自己的 @limitation 二"只取会被业务链路改动的列"相矛盾。
- **解决方案**：
  - chain-server 改为调用 `bootstrap()`，或者把 main.ts 的 createHttpApp 参数抽成一个共享的 `httpAppOptions(config)`；
  - 快照补上以上列和表。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-13｜P3｜期望值用被测同一个函数算出来，文件头却写"独立复算"
- **位置**：quote-routes、order-routes、order-query-routes、pay-intent、product-routes、quote-create-chain（toMinor / allocate / applyRate）
- **问题**：20150 × 0.0067 恰好落在 .5 边界上，取整方向错了只能靠 money.unit 和 stripe-golden-chain 的字面量 13501 兜住。
- **解决方案**：改用字面量，例如 USD 13501、CNY 98735、各行申报价值的具体数值。
- **置信度**：已读代码证实
- **登记情况**：新发现

### TSA-14｜P3｜其它没有测试的高风险分支（只点名）
- 自动确认失败的两条分支：管线返回非 2xx、异常抛出（`pay_auto_confirm_failed`）；
- `admin_audit_write_failed`；
- 审计的 `before` 字段没有经过脱敏，也没有对应用例；
- 退款时 `provider_ref` 为 null 的分支（50000）。
- **置信度**：已读代码证实

## 3. 看过但不是问题的疑点
- **db 与 e2e 是否并发互删数据**：vitest 5 会把 fileParallelism:false 的项目统一放进一个 `sequential` 组串行执行（读过 groupSpecs 源码），不存在跨项目并发 TRUNCATE。
- **`expect.unreachable` 放在 try 里**：抛出的 AssertionError 会被 catch 分支里的 `toBeInstanceOf(AppError)` 判红；pay-intent 里的 `.then(unreachable, …)` 会让事务回滚，最终的 catch 也会判红。都不会假绿。
- **mark-paid-fault 里的 setTimeout(100) 负向检查**：事件总线同步分发，`business_event` 在响应返回前就已写入，这个 sleep 多余但无害。
- **order-race 依赖行锁 FIFO**：PG 的元组锁排队机制保证先到的等待者先拿锁，而且文件已有 @limitation 声明。
- **fake-stripe 同键异参按请求体字节比较**：被测代码对表单的编码是确定的；KD-9 用例也验证了四次请求逐字节相同。
- **admin-ops 失败路径断言"库里没变"**：这里的失败只发生在输入校验阶段；整表替换是否原子由 `adapters/ops-config.db.test.ts:143` 真库覆盖。
- **quote-create-chain 的 fx 期望值取自库里的 rate**：`admin-ops-routes.db:200` 已用字面量 0.006695 钉住了公式。

需要你在主会话里决定：TSA-01、03、04 属于生产缺陷，不只是测试问题，建议交给对应分片或主会话排进修复计划。

探针文件都在 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/TSA/`：
- double-pay-probe.mts
- auto-advance-probe.sql
- jose-aud-probe.mjs
