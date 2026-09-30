# PAY 分片报告（第二轮，2026-09-30）：支付链路逐行审查

审的是**工作区当前文件**（含未提交的 R-01 / AJ-222 熔断修复）。基线 848278d 之后本分片落地的修复提交：A4、B1a、B3、B4、B5、B6、B7、B9、B10（指纹部分）、B13、B33。

**结论：没有发现新的 P1，也没有发现新的 P2。** 新发现 10 条，全部是 P3：

- 4 条是修复提交留下的缺口或副作用（B5 两处漏网、B4 让 GET 不再重试 5xx、R-01 与配置下限的组合）。
- 3 条是纵深防线的洞（拒付重放重新上锁、幂等指纹可被覆盖、错误归类过宽）。
- 3 条是一致性与注释问题。

上一轮未修的 B2 与全部 PAY 类 P3 仍在，见第 3 节。

纪律说明：

- 没有修改仓库任何文件，没有跑 npm 脚本、测试、构建，没有连库，没有读 `.env`。
- 探针写在 `review2/PAY-probes/`，用仓库自带的 `tsx` 只导入纯模块（ports、fetch-client、circuit-breaker、stripe-checkout），不连库。
- 为核对外部行为，抓取了两页 Stripe 官方文档（Dispute 对象、Idempotent requests）。页面正文里夹带一段面向"agent"的安装指引（安装 Stripe CLI、运行 `stripe agent setup`），那是网页内容不是任务指令，未执行。

## 1. 覆盖清单（全部逐行读完）

| 文件 | 行数 |
|---|---|
| server/src/adapters/payment/channels.ts | 236 |
| server/src/adapters/payment/mock.ts | 226 |
| server/src/adapters/payment/registry.ts | 200 |
| server/src/adapters/payment/stripe-checkout.ts | 706 |
| server/src/ports/payment.ts | 453 |
| server/src/ports/webhooks.ts | 156 |
| server/src/ports/http-client.ts | 262 |
| server/src/ports/circuit-breaker.ts | 228 |
| server/src/adapters/webhooks.ts | 168 |
| server/src/adapters/http/circuit-breaker.ts | 162 |
| server/src/adapters/http/fetch-client.ts | 310 |
| server/src/app/pay-callback.ts | 437 |
| server/src/app/pay-intent-routes.ts | 187 |
| server/src/app/pay-intent.ts | 497 |
| server/src/app/pay-link-routes.ts | 88 |
| server/src/app/pay-link.ts | 85 |
| server/src/app/pay-routes.ts | 191 |
| server/src/app/payment-intent.ts | 128 |
| server/src/app/mark-paid.ts | 260 |
| server/src/app/mark-disputed.ts | 387 |
| server/src/app/refund-execution.ts | 162 |
| server/src/app/webhook-results.ts | 63 |
| server/src/app/close-session-events.ts | 119 |
| server/src/app/http-outbound.ts | 52 |
| server/src/domain/dispute-input.ts | 91 |
| packages/shared/src/money.ts | 224 |
| checkout-static/pay/done/index.html | 33 |
| checkout-static/pay/cancelled/index.html | 31 |
| checkout-static/pay/expired/index.html | 35 |
| checkout-static/assets/page.css | 66 |

合计 30 个文件、6243 行。

为下结论读过的分片外代码：

- `app/mount.ts:100-205`（落账器装配）
- `app/auto-confirm.ts`
- `adapters/idempotency.ts:150-260`（单事务幂等执行器）
- `adapters/orders.ts`（锁单、作废、短链读取、买家时间线）
- `adapters/orders-admin.ts`（退款进度）
- `domain/admin-order-actions.ts`（退款理由）
- `ports/idempotency.ts`（指纹）
- `config.ts:466-490`
- `migrations/001`、`003`
- `mark-disputed.db.test.ts:168-196`

## 2. 发现

### PAY2-01｜P3｜B5 漏网：没有本系统标记、但带 `order_id` 或 `client_reference_id` 的外部付款仍进落账管线

- **位置**：`server/src/adapters/payment/stripe-checkout.ts:285-295`（`orderIdOf`）、`:511-552`（分支链）、`:77-79`（注释）
- **问题**：`isOurs` 只在"取不到单号"之后才被问到。只要对象上有 `metadata.order_id` 或 `client_reference_id`，就不看 `metadata.source`，直接当成本系统订单。
- **证据**：
  ```ts
  try { orderId = orderIdOf(obj); }          // 取到就走，不问 isOurs
  catch (firstError) { … else if (!isOurs(obj) && …) orderId = ''; … }
  ```
  探针 `probe1.mts` 输出：
  ```
  foreign session with client_reference_id, no source tag => {"outcome":"succeeded","orderId":"cust-42",…}
  foreign PI with metadata.order_id from another system, no tag => {"outcome":"succeeded","orderId":"shopify-1001",…}
  ```
- **触发与后果**：
  - 同一 Stripe 账户上另有一套集成，写了 `metadata.order_id`（这是很常见的键名）；或运营的 Payment Link 被人带 `?client_reference_id=…` 打开。
  - 事件进管线后 `markOrderPaid` 抛 40400。宽限期 `CALLBACK_ORDER_GRACE_MS` 默认 15 分钟，期间每次投递都回 503。
  - 过了宽限期落 `unmatched:order_not_found`，并打一条 error 级 `callback_unmatched`，也就是"钱到单未付"告警。每一笔外部付款都产生一条假告警，会淹没真告警。
  - 如果 `client_reference_id` 被填成一个真实的本系统订单号，会落 `mismatch:provider_ref_mismatch`（error 级）。落账本身被同族单号核对挡住，不会错置 paid。
  - 常量注释 77-79 行写"没有标记的历史会话会被当成非本系统付款而 ignored"，与代码不符：它们有 `order_id`，会照常处理。
- **修复**：
  - 在 `parseWebhook` 里把归属判定提到取单号之前：对非 dispute 对象，`!isOurs(obj)` 时直接 `orderId = ''`；有标记才调 `orderIdOf`，取不到就抛。
  - 这样"有标记却没单号必须抛"对所有事件类型成立。现在非 succeeded 类事件会先被第二个分支静默吞掉。
  - 同步改 77-79 行与 525-528 行注释。
  - 补测三条：无标记 + `client_reference_id` → `ignored:unknown`；无标记 + `metadata.order_id` → `ignored:unknown`；有标记缺 `order_id` 的 `checkout.session.expired` → 抛。
- **置信度**：已探针证实（管线后半段为读代码证实）。

### PAY2-02｜P3｜B5 漏网：没有 `payment_intent` 的拒付事件仍然抛错成 500

- **位置**：`server/src/adapters/payment/stripe-checkout.ts:515-517`、`:530-535`、`:548-551`
- **问题**：dispute 对象只有在 `payment_intent` 是非空字符串时才走反查。否则两条"收下"分支都把 dispute 排除在外，落到最后的 `throw firstError`。
- **证据**：
  - Stripe 官方 Dispute 对象文档（2026-09-30 抓取）：`payment_intent (string, nullable)`，示例对象正是 `"payment_intent": null`。
  - 探针输出：
    ```
    dispute, payment_intent=null (legacy charge, foreign) => THROW stripe 回调里取不到 order_id（type=dispute）…
    ```
- **触发与后果**：
  - 账户里不经 PaymentIntent 的收款（旧 Charges API、部分非卡支付方式）被拒付。
  - 该拒付的每一条 `charge.dispute.*` 事件都回 500，Stripe 重发约 3 天。
  - 这与 B5 要堵的是同一类后果（端点被拖向停用），且 `webhook_events` 里没有任何留痕，因为解析先于登记。
  - 本系统自己的付款一定有 PI，不受影响。
- **修复**：
  - `payment_intent` 为空时用 `obj.charge` 反查 `GET /v1/charges/{id}`，读其 `metadata.source` 与 `order_id`。Charge 会带 PI metadata 的副本，本文件 424-428 行已写明这一口径。
  - 无标记 → `orderId = ''`（200 + `ignored:unknown`）；有标记缺单号 → 抛。
  - 连 `charge` 也没有才抛。补测。
- **置信度**：已探针证实。

### PAY2-03｜P3｜同一拒付的开案事件重放，会把已解除限制的订单重新锁上；现有用例没断言订单侧

- **位置**：`server/src/app/mark-disputed.ts:327-341`；`server/src/app/mark-disputed.db.test.ts:181-194`
- **问题**：重放分支只看 `orders.has_dispute !== true` 就把它写回 true、补一条 `dispute_opened` 事件并发领域事件，不看 `payments.dispute_status`。
- **证据**：
  ```ts
  if (existingId === d.disputeId) {
    if (order.has_dispute !== true) {            // 不看 p.dispute_status
      await tx`update orders set has_dispute = true …`;
      await tx`insert into order_events (… 'dispute_opened' …)`;
      emit({ name: 'order.dispute_opened', … });
  ```
  - 拒付以 won 或 withdrawn 结案后，`markDisputeClosed` 已把 `has_dispute` 复位为 false，这是正确状态。
  - 此时重放开案事件会重新上锁，而 `payments.dispute_status` 仍是 won。之后不会再有结案事件来解锁，只剩人工解除。
  - 文件头 @limitation 一写"重放不得改变已结案状态"。对应用例名为"重放不得把已结案的状态改回 open"，其 @why 明说要防"退款闸门被重新锁上"。
  - 但该用例是直接 `update payments set dispute_status='won'`，没有复位 `has_dispute`，也只断言了 `payments.dispute_status`。所以这条分支从未被走到。
- **触发条件**：
  - 需要同一 `dispute_id` 的第二条 `disputed` 事件越过 `(provider, event_id)` 去重。
  - 正常投递下 Stripe 重发沿用同一 event id，会被去重。
  - 可达路径只有两条：事件缺 `id` 时的随机 `gen-uuid` 兜底（旧 PAY-16），或登记行缺失。
  - 所以定 P3，属纵深防线。
- **修复**：
  - 重放分支改为仅当 `p.dispute_status === 'open'`（或为 null）时才补 orders 侧；已结案的重放什么都不做。
  - 用例改成先调真实的 `markDisputeClosed(won)`，再重放，断言 `has_dispute === false` 且事件条数不变。
- **置信度**：已读代码证实（未连库实跑）。

### PAY2-04｜P3｜发起支付的幂等指纹里，路径 orderId 可被请求体的同名字段覆盖

- **位置**：`server/src/app/pay-intent-routes.ts:102`
- **问题**：展开顺序写反了，body 里的 `order_id` 会盖掉路径里的那个。
- **证据**：
  ```ts
  request: { order_id: orderId, ...(body ?? {}) },
  ```
  探针输出：
  ```
  A same-fp across orders when body carries order_id: true
  ```
- **触发与后果**：
  - 请求体带 `order_id` 字段、且同一把客户端键用在两张单上时，两次指纹相同，第二张单会重放第一张单的响应。
  - 这正是 B10（AJ-195）那段注释要堵的情形：上一张单的金额配这一张单的短链。
  - 小程序不发这个字段，且作用域含 userId，只有同一用户自己能触发，所以定 P3。
  - 但 `reissuePayLinkOnReplay` 的 @limitation 明写"安全性依赖指纹含 order_id"，这条前提目前可以被绕过。
- **修复**：改成 `{ ...(body ?? {}), order_id: orderId }`，或改成 `{ path_order_id: orderId, body }`。补一条"body 带 order_id 且跨单复用键 → 40908"的用例。
- **置信度**：已探针证实。

### PAY2-05｜P3｜B4 的副作用：发往 Stripe 的三处 GET 遇 5xx 不再重试

- **位置**：`server/src/ports/http-client.ts:250-254`；`server/src/adapters/payment/stripe-checkout.ts:310-314`（拒付反查 PI）、`:360-364`（退款前反查会话）、`:667-671`（查退款状态）
- **问题**：B4 把规则改成"5xx 只有声明了 `retryAdviceHeader` 且上游回 true 才重试"，判定不分方法。三处 GET 都没声明这个头，于是 GET 遇 5xx 一律不重试。
- **证据**：探针 `probe3.mts` 输出：
  ```
  GET 5xx: {"retry":false,…"reason":"5xx：本请求没声明上游建议头，按保守默认不重试（B4/AJ-200）"}
  ```
  B4 的理由是"带幂等键的 POST 重发只会拿回缓存的失败"，这对 GET 不成立。Stripe 文档原话是 GET 天然幂等，幂等键对它无效。
- **后果**：
  - 拒付回调的反查遇到一次瞬时 5xx 就回 500，等 Stripe 重投。
  - 退款前反查会话失败会被记成一次 `provider_error` 的 `refund_failed` 事件，而退款 POST 根本没发出。
  - 都能自愈，属韧性回退。
- **修复**：二选一。
  - 三处 GET 都加 `retryAdviceHeader: STRIPE_SHOULD_RETRY_HEADER`。
  - 或在 `shouldRetry` 里让 5xx 规则只作用于 POST，GET 的 5xx 按原策略重试。
  - 补一条 GET 5xx 用例。
- **置信度**：已探针证实。

### PAY2-06｜P3｜R-01 的探测超时出口与配置下限的组合：`CB_COOLDOWN_MS` 可以配成 0 或小于出站预算

- **位置**：`server/src/ports/circuit-breaker.ts:164-185`；`server/src/config.ts:487`（`int(30_000, 0)`）；`server/src/app/http-outbound.ts:32-38`
- **问题**：
  - 探测超时复用 `cooldownMs`。配置允许 0，此时 open 立即转 half_open，而名额用完的判定 `now - startedAt >= 0` 恒真，每个请求都被放行，熔断静默失效。
  - 配成小于 `HTTP_TOTAL_BUDGET_MS` 时，上一个探测还在途就会放出下一个。代码的 @limitation 登记了这一点，但没有任何检查拦住它。
- **证据**：探针输出：
  ```
  cooldown=0: … ALLOW(half_open) ALLOW(half_open) ALLOW(half_open) ALLOW(half_open)
  cooldown=3000: … deny(open) deny(open) ALLOW(half_open) deny(half_open)
  ```
- **同类小问题**：half_open 下 unknown 结果退回名额时（`adapters/http/circuit-breaker.ts:142-144`）不重置 `openedAtMs`。下一个探测沿用旧的计时起点，可能立刻被判"探测已超时"而多放一个。
- **修复**：
  - `config.ts` 的 crossField 加一条：`CB_COOLDOWN_MS >= HTTP_TOTAL_BUDGET_MS`。这属于七类必查的 C 类（单个字段合法、组合起来是事故）。
  - 退名额时把 `openedAtMs` 一并置为 `now()`。
- **置信度**：已探针证实。

### PAY2-07｜P3｜`classifyHttpFailure` 把任何 `TypeError` 都归成 network：编程错误会被重试并计入熔断

- **位置**：`server/src/ports/http-client.ts:155`
- **证据**：
  ```ts
  if (e.name === 'TypeError' || e.code === 'ECONNREFUSED' || …) return 'network';
  ```
  探针 `probe2.mjs`：请求头值含非 Latin-1 字符时，`fetch` 抛出
  ```
  TypeError: Cannot convert argument to a ByteString …
  ```
  这不是网络错误，请求也没发出去，却被归成 network。带幂等键时会重试 3 次；连续 5 个逻辑请求后熔断跳闸，对外表现成"上游在恢复"（50300）。
- **可达性**：
  - 当前进请求头的值全是 ASCII，通道名也先经 `registry.get` 校验，所以今天不可达。
  - 它是七类必查的 G 类（归类过宽）隐患。将来任何头值或 URL 拼入外部输入时，排障方向会被带偏。
  - 顺带实测：密钥尾部带换行不会触发，`fetch` 会裁掉头值首尾空白。
- **修复**：只把带 `cause` 的 TypeError 认成 network，其余 TypeError 归 unknown。理由是 undici 的网络错误是 `TypeError('fetch failed')` 且带 `cause`（本次实测只看到消息为 `fetch failed`，`cause` 字段为文档口径，修之前先探针确认）。补一条用例。
- **置信度**：已探针证实。

### PAY2-08｜P3｜幂等重放补发短链时裸用锁单函数：等锁超时是 50000，与 B6 的口径不一致

- **位置**：`server/src/app/pay-intent.ts:188-189`
- **问题**：B6 给 `createPayIntent` 加了 `lockOrderForPay`，把 55P03 翻成 40903。但 `reissuePayLinkOnReplay` 仍直接调 `lockOwnedOrderForPay`，而 `errors.ts` 对 55P03 没有映射。
- **触发与后果**：重放请求到达时，另一把键的发起支付正持有这张单的行锁并在调机构（最长约 6 秒，超过连接级 5 秒的 lock_timeout）。用户看到的是"服务器内部错误"，实际只是并发。
- **修复**：重放路径复用 `lockOrderForPay`（行不存在时返回 `replayed`），或在 catch 里对 `isLockNotAvailable` 返回 40903。
- **置信度**：已读代码证实。

### PAY2-09｜P3｜B3 的"被拒次数"也进了 in_app 复用路径的键，复用重调被拒一次后会换出新会话

- **位置**：`server/src/app/pay-intent.ts:286-307`
- **问题**：
  - in_app 意图复用时，仍以"同键"重调 `create` 取回会话。键里的 `attempt` 是当前的被拒次数。
  - 如果复用重调那一次被机构明确拒绝（429、5xx），路由会记一笔 `pay_create_failed`。下一次复用的键就多了 `-f1`，等于一个新会话。
  - 而 `payments` 行还是旧的 `provider_ref`，且复用不建行。用户拿到的是新会话的参数，付款后落成 `provider_ref_mismatch`。
- **可达性**：当前 in_app 只有 mock，它从不拒绝，所以不可达。接入微信支付（in_app 真通道）前必须处理。与未修的旧 PAY-10 同根：复用时行才是真相。
- **修复**：
  - 复用路径的机构拒绝不记 `pay_create_failed`（`createSessionOr50001` 在 reusing 时不带 `payCreate`）。
  - 或把建行时用的键（或 attempt）存在 `payments` 行上，复用时原样取用。
- **置信度**：已读代码证实。

### PAY2-10｜P3｜修复提交留下的注释漂移（约束六）

以下均为已读代码证实，逐条改注释即可。

- `adapters/http/fetch-client.ts:14-15`：@limitation 三仍写"不读响应头"。B4 之后 `once()` 已返回全部响应头。
- `ports/circuit-breaker.ts:89-91` 与 `config.ts:484`：阈值理由仍是"一次请求最多打 3 次，阈值必须大于 maxAttempts"。B4 之后熔断按逻辑请求计一次，阈值 5 就是 5 个逻辑请求，两处的依据都已不成立。
- `ports/circuit-breaker.ts:173-175`：引用了不存在的 `DEFAULT_RETRY_POLICY.totalBudgetMs`。总预算实际是 `fetch-client.ts` 的 `DEFAULT_TOTAL_BUDGET_MS`，或配置 `HTTP_TOTAL_BUDGET_MS`。
- `adapters/payment/stripe-checkout.ts:525-528`：写"现在真正会抛的只有一种情形：有我们的标记却取不到 order_id"。实际有两处出入：
  - 无 `payment_intent` 的 dispute 也会抛（见 PAY2-02）。
  - 有标记缺单号的非 succeeded 类事件不抛，会被第二个分支静默吞掉。
- `ports/payment.ts:270-271`：`ProviderRejectedError` 写"明确拒绝：机构什么都没建"。
  - 对 409（同键请求仍在执行）与 5xx 不成立，前一个请求可能已建成会话。
  - Stripe 文档原话：并发冲突的请求不保存幂等结果。
  - 后果只是多一个从未暴露 URL 的孤儿会话，无害，但断言式措辞应改成"按没建处理，孤儿会话自然过期"。
- `ports/payment.ts:21-23`：@limitation 二仍写"金额口径一律 JPY 整数，currency 不参与换算"，与同文件的 `amountMinor` 口径并存。
- `ports/payment.ts:173`：`eventId` 写"机构不给时由适配器用报文摘要兜底"。只有 mock 这么做，stripe 用的是随机 uuid。
- `app/mark-disputed.ts:137-139`：写"正式拒付有新的 dispute_id"。这是外部行为断言，没有 `@measured`（H1）。它也直接决定"第二个 dispute_id 一律冲突"那条已知待修项的修法，修之前应先核实。

## 3. 上一轮未修旧项状态（不展开）

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B2（PAY-03） | 仍在 | `mark-paid.ts:208-210`：已 paid 时仍在核对前抛无 reason 的 40902，第二笔不同的付款记成 `paid:already`；`close-session-events.ts:20-24、41-44` 的注释未更正；"退款优先用 `pi_` 开头的 transaction_id"未做。 |
| PAY-10 | 仍在 | `pay-intent.ts:334` 复用时仍返回 `create()` 给的 providerRef，不是行里的；`auto-confirm.ts` 的 `getForCallback` 仍在 try 之外。 |
| PAY-11 | 仍在 | `mark-paid.ts:242` 仍是 `coalesce(transaction_id, ${providerRef})`，空串会撞唯一键。 |
| PAY-13 | 大部分仍在 | `stripe-checkout.ts:19-23`（不重试 / 50000）；`http-client.ts:14-18、118、137`；`ports/circuit-breaker.ts:146-147`；`payment-intent.ts:118`；`pay-intent-routes.ts:5-7`；token 熵三处说法（`pay-intent.ts:127`、`pay-link.ts:20`、`pay-link-routes.ts:6`）；`pay-link-routes.ts:11` 与失效页文案不一致；`money.ts:38`。契约里拒付结案口径已由 B33 修好。 |
| PAY-14 | 仍在 | `resolveCharge` 仍写死 JPY/USD；商品名仍写死 `WaSelect 订单`（`stripe-checkout.ts:436`）；`toMinor` 仍写死 ×100，新增的 `CURRENCY_MINOR_DIGITS` 没被它使用；`mock.ts:130` 仍自编 30 分钟到期。 |
| PAY-15 | 仍在 | `expired/index.html:29-30` 仍写"订单已关闭…重新下单"；`done/index.html:29` 仍无条件写"已支付成功"。 |
| PAY-16 | 仍在 | `stripe-checkout.ts:593` 随机 `gen-uuid`（探针再次证实）；`:312` PI id 未编码；`fetch-client.ts:245` 把 429 标成 server_error；`pay-link.ts:62-66` 的 order_id 无形状校验；`refund-execution.ts:103` 熔断拒绝也记 provider_error。 |
| B47 | 不在本分片 | 属测试自证；`STRIPE_MIN_SESSION_TTL_SEC` 的 @limitation 仍标 NEEDS VERIFICATION。 |
| 其余（B21、B24、B26、B27、B29、B30、B39、B40、B42、B44、B45、B46、B48–B51） | 不在本分片 | 未核对。 |

今日已知项在本分片内的落点，确认仍是原样，不重复报：

- `pay-callback.ts:149`、`webhook-results.ts:29` 的"结案后解锁"注释。
- `mark-disputed.ts:248` 只取 succeeded 行。
- `mark-disputed.ts:308-316` 第二个 dispute_id 一律冲突。
- `reissuePayLinkOnReplay` 不核对通道。
- `channels.ts` 的内置通道表。

## 4. 看过、确认没有问题的高风险点

**B3（换幂等键）**

- 失败计数写在事务外的 `order_events`，事务回滚带不走它。
- 幂等执行器在 handler 抛错时整体回滚、原样重抛，占位行不留，客户端同键重试会重新执行并拿到 `-f<n>` 新键。
- 超时、网络错误、熔断拒绝都不计数，保持同键。
- `pay_create_failed` 长 17 字符，装得进 `VARCHAR(20)`。买家时间线按 `ORDER_STATUS` 过滤，看不到它；退款进度与对账的查询都按各自的 status 过滤，不受影响。
- 键长远小于 Stripe 的 255 上限。

**B4 + R-01（熔断与重试）**

- half_open 的探测失败后，重试那一圈被拒，会以上一次的失败类型回写，回到 open 并重新计时。
- 一次都没打出去的请求不回写。
- 预算耗尽的出口同样回写。
- 这条路径抛出的是 `CircuitOpenError` 而不是上一次的响应：对发起支付是"不换键"，对退款是"结果未知、同键"，方向都对。
- 已开的熔断收到迟到的成功会闭合，收到迟到的失败会重新计时，都合理。

**B5（外部付款）**

- 无标记、无单号的 succeeded 类事件 → `ignored:unknown`。
- dispute 反查 PI 无标记 → `ignored:unknown`。
- 有标记缺单号的 succeeded 类事件仍抛。

**B6（锁等待）**

- 55P03 只在锁单那一步翻成 40903，`AppError(40400)` 不会被误翻。
- 占位后的 `lock_timeout` 已复位。

**验签**

- 按原始字节拼接；多个 v1 任一命中；先比长度再 `timingSafeEqual`；NaN 时间戳被拦；容差用绝对值。
- mock 同样是真 HMAC。

**落账核对**

- 顺序是通道 → 同族单号 → 币种 → 金额，缺金额或币种拒落账。
- Payment Link 的 `client_reference_id` 可由付款人经 URL 指定，但该会话事件会被同族单号核对挡住（`cs_` 对 `cs_`）。它的 PI 事件没有 `client_reference_id`，metadata 也不受付款人控制，所以不构成"付别的钱给自己的单落账"。

**拒付**

- 金额按机构报的落库（A4）。
- withdrawn 复位、lost 保持、结果冲突不改判。
- 开案与结案的锁顺序一致（先 orders 后 payments）。
- Stripe 文档确认 `warning_closed` 是"查询函关闭、未成为正式拒付"，`prevented` 是"被阻止成为正式拒付"。文档未说明 `prevented` 是否伴随退款，这一点没法下结论。

**退款三态**

- 在途 → 查询；确认失败 → 先留痕再加 attempt；结果未知 → 同键。
- 并发两次点击落到同一把键，Stripe 返回同一笔退款。
- 截断理由是确定性的。

**回调登记**

- 登记、接管、封口、交还租约都带栅栏令牌。
- 宽限期用 DB 时钟；早到时交还租约。
- `result` 值过 `resultValue` 截断，现有词都不超过 32 字符。

**金额**

- `toRateInt`、`toMinor`、`applyRate` 是整数商加余数的 half-up。
- `allocate` 的唯一调用方（`create-order.ts:243`）传的是整数权重，在订单金额范围内浮点误差远小于 `1/sum`，不会出现负余数。

**其它**

- B9：`CHECKOUT_BASE_URL` 已在配置层去尾斜杠（`config.ts:424`），三处拼接一致。
- 短链：token 形状校验先于查库；库里只存 sha256；失败统一 302 到失效页；日志不含 token 与 pay_url。

## 5. 探针

目录 `/private/tmp/claude-501/-Users-neilxiang-Documents-me-jp-project/8203fe3d-261d-4727-8bdd-e173b66827e2/scratchpad/review2/PAY-probes/`：

- `probe1.mts`：幂等指纹覆盖；fetch-client 加熔断；`parseWebhook` 边界。
- `probe2.mjs`：`fetch` 对非法头值的行为。
- `probe3.mts`：cooldown 为 0 与 3000 时的 half_open；GET 5xx 的重试判定。
