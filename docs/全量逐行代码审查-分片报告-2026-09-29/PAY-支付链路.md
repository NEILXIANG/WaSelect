> 本文是 2026-09-29 全量逐行代码审查的 **PAY 分片（支付链路）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# PAY 分片报告：支付链路逐行审查

没有发现 P0。发现 1 个 P1、7 个 P2、若干 P3。按严重度排在最前的是：
- **拒付**：部分拒付或汇率波动时，拒付不会落库。
- **查询函**：查询函结案后订单被永久锁住。
- **重复付款**：已 paid 的单上第二笔真实付款被静默吞掉。
- **幂等键**：Stripe 缓存了 5xx，这张单在 24 小时内建不出会话。

**纪律说明（需要你知道）**：做重定向探针时，我误把 `probe-redirect.mjs` 复制进了 `server/`（未跟踪文件）。发现后立即删除，`git status --porcelain` 已恢复为空。另外为验证锁超时建过临时库 `review_pay`，已 `dropdb`。没有跑 db / e2e / contract 测试，没有读 `.env`。

## 1. 覆盖清单（均已逐行读完）

| 文件 | 行数 |
|---|---|
| server/src/ports/payment.ts | 428 |
| server/src/ports/webhooks.ts | 156 |
| server/src/ports/http-client.ts | 213 |
| server/src/ports/circuit-breaker.ts | 201 |
| server/src/adapters/payment/channels.ts | 236 |
| server/src/adapters/payment/mock.ts | 226 |
| server/src/adapters/payment/registry.ts | 200 |
| server/src/adapters/payment/stripe-checkout.ts | 619 |
| server/src/adapters/webhooks.ts | 168 |
| server/src/adapters/http/fetch-client.ts | 268 |
| server/src/adapters/http/circuit-breaker.ts | 139 |
| server/src/app/pay-intent.ts | 412 |
| server/src/app/pay-intent-routes.ts | 152 |
| server/src/app/pay-link.ts | 85 |
| server/src/app/pay-link-routes.ts | 88 |
| server/src/app/pay-callback.ts | 437 |
| server/src/app/pay-routes.ts | 191 |
| server/src/app/payment-intent.ts | 68 |
| server/src/app/mark-paid.ts | 260 |
| server/src/app/mark-disputed.ts | 338 |
| server/src/app/refund-execution.ts | 162 |
| server/src/app/auto-confirm.ts | 71 |
| server/src/app/webhook-results.ts | 63 |
| server/src/app/close-session-events.ts | 119 |
| server/src/app/http-outbound.ts | 52 |
| server/src/domain/dispute-input.ts | 66 |
| packages/shared/src/money.ts | 207 |
| checkout-static/pay/done/index.html | 33 |
| checkout-static/pay/cancelled/index.html | 31 |
| checkout-static/pay/expired/index.html | 35 |
| checkout-static/assets/page.css | 66 |

- `checkout-static/.DS_Store` 已被 .gitignore 忽略，不是源码。
- 为下结论读过的分片外代码：
  - adapters/orders.ts：锁单、作废、短链读取
  - adapters/orders-admin.ts：退款进度相关
  - admin-order-routes.ts:271-356
  - mount.ts:95-387（落账器装配）
  - adapters/idempotency.ts:40-262
  - config.ts：支付规则
  - daily-reconciliation.ts:153-220
  - http.ts：raw body
  - event-bus.ts
  - migrations 001 / 003
  - scripts/checkout-build-lib.ts
  - miniprogram/pages/pay
  - test/helpers/fake-stripe-http.ts（只看意图）

## 2. 发现列表

### PAY-01｜P1｜钱与状态 / 拒付
- **位置**：app/mark-disputed.ts:219-257；mount.ts:156-164
- **问题**：拒付金额只要不等于扣款全额就拒绝落库。部分拒付和汇率波动的拒付因此都不会置 `has_dispute`，也进不了风控页。退款后才来的拒付同样拒落库。
- **证据**：
  ```ts
  where order_id = ${orderId} and status = 'succeeded'   // 223
  if (Number(p.charge_amount) !== d.amountMinor) {       // 251
    throw new AppError(40902, { ..., reason: 'amount_mismatch' ...
  ```
  Stripe Dispute.amount 的官方说明（2026-09-28 WebFetch）："Disputed amount. Usually the amount of the charge, but it can differ (usually because of currency fluctuation or because only part of the order is disputed)."
- **触发与后果**：
  - 输入：外币卡持卡人对 USD 扣款发起拒付，拒付金额比扣款少几分；或只争议部分货品。
  - 管线结果：`mismatch:amount_mismatch` + error 日志 + 返回 200，Stripe 不再重发。
  - `has_dispute` 仍为 false，发货闸门不拦，自动签收 / 自动完成照走。
  - 风控页看不到这条拒付，举证期限只能靠人从日志和对账里发现。
  - 退款会被 Stripe 以 `charge_disputed` 拒绝，订单卡在 refunding。
  - 退款后到达的拒付（payments 已是 `refunded`）落到 `no_succeeded_payment`，同样不落库。
- **解决方案**：
  - `markOrderDisputed` 改为：币种不符仍拒；金额不同照常落库（`dispute_amount` 本来就单独存），另打 `dispute_amount_differs` 的 error 日志；金额大于扣款额也落库，但升级告警。
  - 取支付行改为 `status in ('succeeded','refunded')`。
  - 从 `DISPUTE_MISMATCH_REASONS` 移除这两种情形，并同步契约里 `Dispute.dispute_amount` 的描述。
  - 补测三条：部分拒付 → has_dispute=true 且 dispute_amount=部分值；金额大于扣款 → 落库并记 error；已退款单的拒付 → 落库。
- **置信度**：已读代码证实，并有官方文档佐证。
- **登记状态**：新发现（mark-disputed.unit 现有用例「金额不符 → 40902」把当前行为钉成了期望）。

### PAY-02｜P2｜状态卡死 / 拒付
- **位置**：domain/dispute-input.ts:48-66；mount.ts:176-190；mark-disputed.ts:188
- **问题**：Stripe 的查询函（inquiry）生命周期会把订单永久锁在 `has_dispute=true`，系统里没有任何解锁路径。
- **证据**：
  ```ts
  if (raw === 'won' || raw === 'lost') return raw;  return undefined;   // dispute-input
  if (result === undefined) throw new AppError(40902, { reason: 'dispute_result_unknown' })  // mount
  ```
  - Stripe 事件文档："`charge.dispute.closed` … status changes to `lost`, `warning_closed`, or `won`"。
  - Dispute 示例对象的 status 为 `warning_needs_response`。
  - 探针：`charge.dispute.closed` + `warning_closed` → outcome `dispute_closed`，`parseDisputeResult` 返回 undefined。
- **触发与后果**：
  - 查询函开案（`warning_needs_response`）→ 走 disputed 落账器 → has_dispute=true。
  - 查询函未升级、以 `warning_closed` 结案 → 40902 → 管线记 mismatch → has_dispute 保持 true。
  - 结果：发货 40909、退款 40907、自动推进排除，全部永久生效。
  - 全仓只有 mark-disputed.ts:188 会写 has_dispute=false，没有管理端解锁接口，只能手工改库。
  - `prevented` 状态同理。
- **解决方案**：
  - domain 增加第三种结案结果（如 `withdrawn`），对应 `warning_closed` / `prevented`。
  - `markDisputeClosed` 对 withdrawn 复位 has_dispute，`dispute_status` 写 `withdrawn`（VARCHAR(16) 放得下）。
  - 契约 `Dispute.dispute_status` enum 与 admin-web 同步。
  - 另建一个带 admin_audit 的「解除拒付限制」逃生口。
  - 补测：warning_needs_response 开案 → warning_closed 结案 → has_dispute=false，订单可发货。
- **置信度**：已读代码证实，并有文档与探针。
- **登记状态**：新发现（dispute-input 注释写了「应当保持 open」，但「永久锁单」的后果没有登记）。

### PAY-03｜P2（接入第二个真实通道后升为 P1）｜钱 / 重复扣款
- **位置**：app/mark-paid.ts:208-210；pay-callback.ts:380-397；daily-reconciliation.ts:160；close-session-events.ts:20-24、41-44
- **问题**：订单已是 paid 时，第二笔**不同**的真实付款被判成 `paid:already`（info 级、返回 200），日常对账也不扫它，重复扣款被静默吞掉。
- **证据**：
  ```ts
  if (!canTransition(from, 'paid')) { throw new AppError(40902, { from, to: 'paid', where: 'mark-paid' }); }  // 核对之前就抛
  if (details?.from === 'paid') { deps.logger.info('paid_already' ...  result: RESULT_PAID_ALREADY
  and (result in (${RESULT_LATE_PAYMENT}, ${RESULT_STATUS_CONFLICT}) or result like 'mismatch:%' ...  // 不含 paid:already
  ```
- **触发与后果**：
  - 用户 A→B 换通道后，同时开着两个支付页，两边都付了款。
  - 第一笔落账成功；第二笔的 `from='paid'` 在 `assertSettlementMatches` 之前就抛出，管线记成「正常形态」info。
  - 已登记的 KD-16 说这种情况会「以 channel_mismatch 进对账」，close-session-events 两处注释也这么写。实际上只有在订单**尚未 paid** 时才成立，已 paid 时这笔钱不会出现在任何报表里。
  - 连带问题：A→B→A 后，经旧 cs 会话的 PI 事件落账的单（跨 id 族放行），`payments.provider_ref` 仍是最新的 cs。退款时反查到的会话没有 PI（stripe-checkout.ts:332），退款永远记 provider_error。
- **解决方案**：
  - `markOrderPaid` 在 `from==='paid'` 时取 succeeded 行比对：通道不同，或同一 id 族但单号既不等于 provider_ref 也不等于 transaction_id → 抛 40902 `reason:'duplicate_payment'`（17 字符），并加入 `SETTLEMENT_MISMATCH_REASONS`。跨族（cs 与 pi）无法区分，维持 paid:already。
  - 退款优先用 `transaction_id`（若为 `pi_` 开头）。
  - 更正 KD-16 与两处注释。
  - 补测：mock 付款后 stripe 再付款 → `mismatch:duplicate_payment`；同一笔钱的 PI 事件 + session 事件 → 仍为 paid:already。
- **置信度**：已读代码证实。
- **登记状态**：已登记（KD-16），但描述有误。

### PAY-04｜P2｜可用性 / 机构幂等
- **位置**：app/pay-intent.ts:281-296、388-391；stripe-checkout.ts:407-423
- **问题**：建会话的幂等键是确定性的，只在「payments 行已提交」后才换轮次。Stripe 一旦缓存了 5xx，这张单在整个生命周期内都建不出会话。
- **证据**：
  ```ts
  idempotencyKey: intentIdempotencyKey(order.id, input.channel, reusing ? count-1 : count)  // 失败回滚→count 不变→同键
  ```
  Stripe 官方："Subsequent requests with the same key return the same result, including `500` errors"；键至少保留 24 小时（idempotent_requests，2026-09-28 WebFetch）。
- **触发与后果**：
  - Stripe 故障期间第一次建会话得到 500。fetch-client 同键重试 3 次都拿到缓存的 500 → 50001 → 事务回滚。
  - 用户再点，还是同一把键、同一个 500。订单只活 30 分钟，故障恢复后这批单也全部付不了。
  - fake-stripe-http 没有模拟「缓存 5xx」，所以测试是绿的。
- **解决方案**：
  - 建会话收到**确定的**机构答复（HTTP 5xx 或非校验类 4xx）时，在事务外持久化一个失败计数（如 order_events `pay_create_failed`，写在独立连接上），并把它编进键：`pay-<o>-<ch>-<round>-f<n>`。
  - 超时 / 网络错误（结果未知）仍保持同键，以便取回可能已建成的会话。
  - 孤儿会话的 URL 从未暴露给用户，会自然过期，无害。
  - 替身加「缓存 5xx」脾气，补测：首次 500 → 再次发起成功。
- **置信度**：已读代码证实，并有文档（未做真实 Stripe 实测）。
- **登记状态**：新发现（管理端退款路由已写了同类 @limitation，建会话侧没有）。

### PAY-05｜P2｜可靠性 / 回调端点可能被停用
- **位置**：adapters/payment/stripe-checkout.ts:455-472、243-253
- **问题**：只要 Stripe 账户里有非本系统创建的付款（Payment Link / Dashboard 收款 / Invoice），它们的 `checkout.session.completed` 或 `payment_intent.succeeded` 就一律抛错成 500。
- **证据**：
  ```ts
  } else if (OUTCOME_BY_TYPE[type] !== 'succeeded' && obj['object'] !== 'dispute') { orderId = '';
  } else { throw firstError; }
  ```
  探针结果：两类无 metadata 的成功事件都 → `THROW stripe 回调里取不到 order_id`。
- **触发与后果**：
  - 运营用 Payment Link 或 Dashboard 手工向顾客收一笔款，这很合理。
  - 端点返回 500，Stripe 会重试约 3 天，持续失败的端点会被停用，届时真实订单的回调也收不到。代码自己的注释（462-467）描述的正是这个风险，只是没覆盖 succeeded 类事件。
  - 另外 `webhook_events` 一行记录都没有，因为解析先于登记。
  - 非本系统付款的拒付反查不到 order_id，同样会 500。
- **解决方案**：
  - `create()` 在 session 和 `payment_intent_data` 的 metadata 里写入本系统标记（如 `metadata[app]`）。
  - 解析时没有标记 → orderId='' → unknown（返回 200、记 `ignored:unknown`），另打 error 级 `stripe_foreign_event`。有标记但缺 order_id 才抛。
  - 拒付反查到的 PI 没有标记时同样处理。
  - 补测：Payment Link 会话完成 → 200 ignored；本系统会话缺 order_id → 仍抛。
- **置信度**：已探针证实。
- **登记状态**：新发现。

### PAY-06｜P2｜并发 / 事务边界
- **位置**：app/pay-intent-routes.ts:86-120；pay-intent.ts:23-29、281；adapters/idempotency.ts:175-179、209；db.ts:113；miniprogram/pages/pay/index.js:118-122（分片外）
- **问题**：发起支付在 `runInTx` 的 handler 里调 Stripe，这违反了执行器自己写明的 @limitation 二。执行器用 `SET LOCAL lock_timeout`（≤ waitMs=2s）覆盖了**整个**事务，所以 handler 里锁订单行的 `FOR UPDATE` 也受这个限制。
- **证据**：
  ```ts
  await tx`select set_config('lock_timeout', ${String(remaining)}, true)`;   // idempotency.ts:209
  // @limitation 二：handler 必须只做 DB 写入。调外部服务（创建支付单…）不要放进这里
  ```
  探针：持锁方事务内 sleep 3 秒；等待方按同样写法设 lock_timeout=1800 后执行 `FOR UPDATE` → `B failed after 1815 ms code=55P03`。
- **触发与后果**：
  - 小程序每次点通道都生成新的幂等键，且支付中按钮不禁用（wxml:35-41 没有 paying 守卫）。
  - 连点两次，而 Stripe 响应超过约 2 秒时，第二个请求在 handler 内 55P03 → errors.ts 兜成 500。
  - 取消订单走默认 lock_timeout 5 秒，小于出站总预算 6 秒，同样可能 55P03。
  - 每个在途的发起支付占住一条连接最长 6 秒（连接池 10 条）。Stripe 变慢时，全站包括回调都会排队。
- **解决方案**：
  - `withIdempotencyTx` 在占位成功后把 lock_timeout 复位为默认值（再执行一次 `set_config`）；或者发起支付改用 `FOR UPDATE NOWAIT` 并把 55P03 映射成 40903。
  - 在执行器 @limitation 二里登记这个例外及其代价。
  - 小程序 `onPay` 加 `if (this.data.paying) return`。
  - 补测：两个不同键并发发起、create 耗时 3 秒 → 第二个得到 200 复用或 40903，而不是 500。
- **置信度**：已探针证实。
- **登记状态**：新发现。

### PAY-07｜P2｜状态卡死 / 退款
- **位置**：adapters/payment/stripe-checkout.ts:540；admin-order-routes.ts:275-278、304-310；契约 348-351
- **问题**：退款理由没有长度上限，原样写进 Stripe `metadata[reason]`，而 Stripe 限制 value 不超过 500 字符。重试又被强制沿用首次理由。
- **证据**：
  ```ts
  'metadata[reason]': req.reason,
  refundReason = original;   // KD-4：重试必须用首次理由
  ```
  Stripe metadata 文档："values up to 500 characters long"。
- **触发与后果**：
  - 管理员填写超过 500 字的理由 → Stripe 400。校验类错误不缓存，但每次重试都发同一个超长理由 → 永远失败。
  - 订单永久停在 refunding，只能改库。
- **解决方案**：
  - 路由加 `reason.length > 500 → 40001 refund_reason_too_long`，契约补 `maxLength: 500`。
  - 适配器 `req.reason.slice(0, 500)` 作为纵深防线（确定性截断，不破坏同键同参）。
  - 补测。
- **置信度**：已读代码证实，并有文档。
- **登记状态**：新发现。

### PAY-08｜P2｜配置 / 短链不可达
- **位置**：app/pay-intent.ts:128；adapters/payment/channels.ts:231-232；config.ts:108-115
- **问题**：`CHECKOUT_BASE_URL` 带尾斜杠时，短链变成 `//o/…`，success / cancel URL 变成 `//pay/done`。三处里只有 `expiredPageUrl` 做了规范化。
- **证据**：探针结果：
  ```
  pay_url = https://pay.example.com//o/ord-1?t=abc  pathname = //o/ord-1
  matchRedirect(//o/..) = null   successUrl = https://pay.example.com//pay/done
  ```
  zod 的 url 规则接受尾斜杠，且不做规范化。
- **触发与后果**：部署时带上尾斜杠，所有银行卡短链都落不到 `/o/*` 规则（按项目自己的 CF 语义匹配器判定为不命中），付完款也回跳到 404。这属于「配置对了一半」的静默故障。
- **解决方案**：
  - config 里 `optionalUrl` 对该字段去掉尾部斜杠，或统一用 `new URL('/o/…', base)` 拼接。
  - 补测：带尾斜杠的 base → pathname 为 `/o/…` 和 `/pay/done`。
- **置信度**：已探针证实（真实 CF 对 `//o/` 的行为未实测）。
- **登记状态**：新发现。

### PAY-09｜P3｜可靠性 / 熔断
- **位置**：adapters/http/fetch-client.ts:151-166、178-249；adapters/http/circuit-breaker.ts:122-129
- **问题**：
  - `before()` 每次 send 只调一次，重试循环绕过熔断。
  - half_open 声称只放 1 个探测，实际会打 3 次上游。
  - `unknown` 被当成成功，直接复位计数。
- **证据**：探针结果：
  ```
  after req2 calls 6 {state:'open', failureCount:6}           // 第 4 次已跳闸，仍打了第 5、6 次
  half-open probe request: upstream calls = 3                  // "只放 1 个探测"
  before unknown failureCount 3 → after unknown failureCount 0
  ```
- **后果**：上游故障时恢复窗口被压缩，打过去的流量翻倍。
- **解决方案**：
  - 每次重试前重新 `breaker.before(key)`，不放行就停止重试并抛 CircuitOpenError。
  - `unknown` 改为不改变状态。
  - 补测上述三条。
- **置信度**：已探针证实。
- **登记状态**：新发现。

### PAY-10｜P3｜审核模式自动确认（AJ-179）
- **位置**：app/pay-intent.ts:274-296、321-327；adapters/payment/mock.ts:111-133；auto-confirm.ts:43
- **问题**：in_app 复用路径会用同一把键重调 `create`，但 mock 的会话缓存只在进程内存里。重启或多实例后拿到新的 providerRef，而 payments 行没更新，自动确认拿着新 ref 去落账。
- **证据**：
  ```ts
  providerRef: `mock_${deps.idGen.uuid()}`   // 缓存丢失即新值
  return { ..., providerRef: session.providerRef, ... }  // 复用时也返回新值 → autoConfirm 用它
  ```
- **后果**：
  - 首次自动确认失败后，用户按注释说的「再点一次」恢复：如果中间发生过重启或打到另一个实例 → `mismatch:provider_ref_mismatch`，界面仍显示「支付已完成」，订单一直待付直到过期。
  - `getForCallback` 在 try 之外：一旦抛错，响应变成 500，但幂等行已提交成 200。
- **解决方案**：
  - 复用时 `providerRef` 取 `existing.provider_ref`（行才是真相），两者不一致时记 error。
  - 把 `getForCallback` 移进 try。
  - 补测：新建 provider 实例后复用 → 自动确认成功。
- **置信度**：已读代码证实。
- **登记状态**：新发现。

### PAY-11｜P3｜数据约束
- **位置**：app/mark-paid.ts:242
- **问题**：mock 事件不带 provider_ref 时，`transaction_id` 被写成空串 `''`，第二张这样的单会撞上 `UNIQUE(provider, transaction_id)`。
- **证据**：`transaction_id = coalesce(transaction_id, ${settlement.providerRef})`，而 mock.ts:174 在字段缺失时给 `''`。
- **后果**：第二笔触发 23505 → 500 → 该回调反复重发，永远落不了账。
- **解决方案**：改为 `coalesce(transaction_id, nullif(${…}, ''))`，并补测。
- **置信度**：已读代码证实（NULL 与空串的唯一性语义是 PG 标准行为）。
- **登记状态**：新发现。

### PAY-12｜P3｜幂等
- **位置**：app/pay-intent-routes.ts:88-92；pay-intent.ts:165-192
- **问题**：
  - 指纹只含 body，不含路径里的 orderId。同一个客户端键跨订单会重放另一张单的响应：mock 返回别的单的参数；stripe 的 pay_url 会被补发成本单，但 charge 字段仍是别的单的。
  - `reissuePayLinkOnReplay` 不核对当前在途意图的通道：一次陈旧的重放会轮换 token，让用户手里仍有效的链接失效。
- **解决方案**：
  - 改为 `request: { orderId, body: req.body }`。
  - 补发前用 `findInitiatedPayment` 核对通道一致且 `pay_url` 非空，不满足就原样返回。
  - 补测。
- **置信度**：已读代码证实（小程序键是随机串，撞键概率低，属纵深防御）。
- **登记状态**：新发现。

### PAY-13｜P3｜注释 / 契约漂移（约束六）
- stripe-checkout.ts:19-23：
  - 写「不重试」，但 fetch-client 对带幂等键的 POST 最多试 3 次。
  - 写「抛普通 Error 折叠成 50000」，但发起支付现在返回 50001。
- ports/http-client.ts：
  - 14-18 行写「退避与熔断还没接进实现」，实际已接入。
  - 97-98 行写「F12 第二单元做」，实际已做。
  - 116 行注释说 3xx 当 unknown，代码却返回 none。
- ports/circuit-breaker.ts:142-144：写「当作刚跳闸（重新计时）」，但代码不重新计时，状态会永久 open。
- payment-intent.ts:58：写「23505 只可能是部分唯一索引」，但表上还有 `UNIQUE(provider, provider_ref)`。
- pay-intent-routes.ts:5-7：写「HTTP 层重试换新键 = 新会话」，但现在机构键由订单派生。
- token 熵口径三处互相矛盾：
  - pay-intent.ts:123 写「128 bit 的一半也够」
  - pay-link.ts:20 写「128 bit」
  - pay-link-routes.ts:6 写「约 244 bit」
- pay-link-routes.ts:11 说失效页引导「重新发起支付」，而页面实际写的是「重新下单」。
- money.ts:21 写「未知币种一律抛错」，但没有实现。
- 契约 348 行退款描述仍是 0.6.7 口径（「won/lost 都复位」），与 0.6.10 和代码中 lost 保持 true 矛盾。
- 契约回调响应没有列 500 和 503/50300（熔断）。
- **解决方案**：逐条改注释和契约。
- **登记状态**：新发现。

### PAY-14｜P3｜约束四 / 五
- **问题**：
  - pay-intent.ts:91-108 `resolveCharge` 在 app 层写死 `'JPY'` / `'USD'` 分支（新增 CNY 就得改业务代码）。
  - stripe-checkout.ts:385 商品名写死 `WaSelect`。
  - money.ts:55-56 `toMinor` 把「最小单位 = 主单位 ×100」硬编码给所有目标币种。
  - mock.ts:130 无视 `req.expiresAt`，自己编了一个 30 分钟到期，违反端口「不得编造」。
- **解决方案**：
  - 币种指数表放进 shared。
  - 扣款币种按「配置可见 ∩ 能力」再按表判定是否换算。
  - 品牌名走配置。
  - mock 使用 `req.expiresAt`。
- **登记状态**：新发现。

### PAY-15｜P3｜静态页文案
- **位置**：checkout-static/pay/expired/index.html:92-94；done/index.html:29
- **问题**：
  - 失效页对「token 已轮换，但订单仍可付」的情况也说「订单已关闭…重新下单」，会诱导用户重复下单。
  - 完成页无条件写「已支付成功」，迟到付款（会走人工退款）也显示这句。
- **解决方案**：失效页改为「请回小程序重新发起支付或查看订单」；完成页改为「支付已提交，结果以小程序订单为准」。

### PAY-16｜P3｜零散
- stripe-checkout.ts:513：缺 event id 时用随机 `gen-uuid` 兜底，去重失效。
- stripe-checkout.ts:270：PI id 没有 `encodeURIComponent`，与另两处 GET 的写法不一致。
- fetch-client.ts:207：429 和 1xx 被标成 `server_error`。
- pay-link.ts:62-66：日志 order_id 直接用路径里的原值，没有形状校验（七类必查 G）。
- refund-execution.ts:102：熔断拒绝（请求根本没发出）也记成 `provider_error`。
- admin-order-routes.ts:330（分片外）：`getForRefund` 在 refunding 已提交之后才取，通道不可退时订单停在 refunding，却没有任何 refund_failed 事件。

## 3. 看过但不是问题的疑点
- **Stripe 验签**：
  - 拼接用原始字节。
  - 多个 v1 任一命中即通过。
  - 先比长度再 `timingSafeEqual`。
  - NaN 时间戳会被拦。
  - 容差用 abs，对未来时间戳同样生效。
  - 签名先于时间戳校验。
- **Adaptive Pricing**：官方说明 session 和 PI 的金额、币种保持集成币种（本地币种只在 `presentment_details` 里），所以金额核对不受影响。
- **Express 重定向**：`res.redirect(302, url)` 会原样保留 Stripe URL 的 `#` 片段（已探针）。
- **退款三态**：
  - 并发点击可能重复记 `provider_failed`，结果只是跳过一个轮次号，不会因此退两次。
  - 全额退款由 Stripe 的可退额度兜底，结果未知时同键重试，语义正确。
- **回调租约**：
  - 迟到的旧持有者 `finish` 返回 false、只打 warn。
  - 抢不到租约返回 503。
  - 早到回调的宽限期用 DB 时钟计算，并主动交还租约。
- **短链 token**：
  - 两个 crypto `randomUUID` 拼接，约 244 bit 随机位。
  - 库里只存 sha256，比对用 `timingSafeEqual`。
  - 格式校验先于查库。
  - `orders.id` 是 TEXT，任意路径 id 都不会触发 22P02。
- **建会话幂等（KD-9）**：请求体各字段都由订单快照决定，同单重试逐字节相同。到期时间为订单到期 + 32 分钟，满足 Stripe 的 30 分钟~24 小时窗口。
- **POST 重试**：没有幂等键的 POST 只对 429 重试。create / refund / expire 三处都带机构键。
- **关单连带**：事件总线发后不等，不会拖慢回调；换通道后在付款成功时作废旧会话，逻辑正确。
- **webhook_events 列宽**：`event_type` 为 64，对当前订阅的事件够用；`result` 超长会被截断。
- **4xx 复位熔断计数**：属于有文档记载的设计取舍，不算缺陷。

## 4. 探针与草稿
草稿目录 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/PAY/`：
- probe-breaker.mts
- probe-lock.mjs
- probe-slash.mts
- probe-stripe.mts
- probe-redirect.mjs
