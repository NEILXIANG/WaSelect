# ORD3 分片审查报告（第三轮，2026-09-30）— 下单与支付发起用例

## 范围与方法

- 基线：HEAD `50d490b`，工作区干净。**只读**，未改仓库任何文件。
- 逐行读完（23 个文件，3,552 行）：`server/src/app/` 下 create-order.ts、quote-assembly.ts、quote-routes.ts、order-routes.ts、order-query-routes.ts、order-views.ts、cancel-order.ts、expire-orders.ts、auto-confirm.ts、auto-fulfilment.ts、pay-intent.ts、pay-intent-routes.ts、payment-intent.ts、pay-routes.ts、pay-link.ts、pay-link-routes.ts、address-routes.ts、product-routes.ts、auth.ts、wechat-login.ts、wechat-auth-routes.ts、rate-limit.ts、unit-of-work.ts。
- 为下结论另读：`adapters/orders.ts`（本分片用到的全部函数，含 AJ-240 新增的 `lockUserForOrdering`）、`adapters/catalog.ts`（运费取档、汇率）、`adapters/idempotency.ts:195-290`（执行器与 lock_timeout 复位）、`ports/idempotency.ts`（指纹与 AJ-235 深度上限）、`app/mark-paid.ts:105-175,257`（provider_ref 核对）、`adapters/payment/mock.ts`（create 缓存）、`app/mount.ts:200-400`（限流与 identity 装配）、`domain/quote.ts:107-167`、`config.ts:330-360`、`packages/shared/src/errors.ts`、`contracts/api-contract.yaml` 订单 / 支付 / 地址段、`migrations/001_init.sql`（users 外键）、小程序 `pages/pay/index.js` 与 `utils/error-text.js`（错误如何呈现给买家）。
- 测试：读了 `order-routes.db.test.ts`（AJ-240 五条用例及 buildServer 装配，确认"拉黑复核"用例确实经过 60 秒身份缓存、能测到事务内复核）、`quote-routes.db.test.ts:197-225`（AJ-239 两条）、`pay-intent-routes.db.test.ts:209-230`（AJ-235）、`pay-intent.db.test.ts:149-230`。
- 运行：
  - `npx vitest run --project unit` rate-limit / auth / unit-of-work / pay-routes / ports/idempotency 五个文件：**5 files / 88 tests 全部通过**（Node v22.22.2）。
  - 探针 `scratchpad/round3/ORD3/probe-ipkey.ts`：`ipKey` 对压缩写法、IPv4-mapped、zone、NAT64、非法 9 段的输出（结论：本分片无新问题，见文末"确认没问题"）。
  - 探针 `scratchpad/round3/ORD3/probe-paid-expired.mts`：用假 tx 直接调真 `createPayIntent`，实测 ORD3-01。
- 未跑 db / e2e / gate（按分工）。

**本轮新发现：P0 0 / P1 0 / P2 0 / P3 4。** 上轮三项修复（AJ-235 指纹、AJ-239 40912、AJ-240 在途单上限 + `lockUserForOrdering`）逐条核过，**没有发现引入的新缺陷**（锁序与并发推演见文末）；AJ-240 有一处防护范围被注释说大了（ORD3-03）。

---

### ORD3-01【P3】已付款 / 已发货 / 已退款的单，过了 30 分钟支付窗口再点支付，返回的是"40904 订单已过期 → 重新下单"

- **位置**：`server/src/app/pay-intent.ts:236-242`
  ```ts
  if (status === 'expired' || clock.now() >= order.expires_at) {
    throw new AppError(40904, { order_id: input.orderId });   // 不看 status
  }
  if (status !== 'created' && status !== 'pending_payment') {
    throw new AppError(40902, ...);
  }
  ```
- **问题**：时间判定对**所有状态**生效，排在状态判定之前。`expires_at` 是建单时刻 + 30 分钟，任何订单过了这个点都满足条件。于是 paid / shipped / delivered / refunded / cancelled 的单在 30 分钟后再发起支付，拿到的都是 40904。40904 的文案是"订单已过期"，action 是"**重新下单**"（`packages/shared/src/errors.ts:83`）。注释写的"过期是更具体的拒绝理由"只对 created / pending_payment 成立。
- **触发场景**：买家在第 25 分钟用银行卡短链在浏览器付款，Stripe 回调晚到，或他切回小程序时支付页还停在引导屏。第 31 分钟之后，他在这一屏再点一次支付方式。服务端对这张**已付款**的单回"40904 订单已过期"，小程序原样显示（`miniprogram/utils/error-text.js:29-37` 拼成 `40904 订单已过期`）。买家按字面理解去重新下单、再付一次，结果是同一批货付了两次钱，只能走人工退款。已发货的单同理。
- **证据**【实测】：`probe-paid-expired.mts` 用假 tx 喂给真 `createPayIntent`（now=12:00）：
  ```
  status=paid     expires_at=11:00 → code=40904
  status=shipped  expires_at=11:00 → code=40904
  status=refunded expires_at=11:00 → code=40904
  status=paid     expires_at=12:10 → code=40902
  ```
  测试缺口【读码确认】：`pay-intent.db.test.ts:175-222` 里 "paid → 40902" 用的 `o-paid` 是默认的**未过期**单，恰好绕开了这条分支。
- **修复**：40904 只对"本来可付"的单生效：
  ```ts
  const payable = status === 'created' || status === 'pending_payment';
  if (status === 'expired' || (payable && clock.now() >= order.expires_at)) throw new AppError(40904, …);
  if (!payable) throw new AppError(40902, …);
  ```
  mark-paid、短链、关单三处同一比较方向不受影响：它们都已先按状态过滤。
- **应补测试**：`pay-intent.db.test.ts` 加 `seedPayable('o-paid-late', { status: 'paid', expiresAt: <now 之前> })`，断言 `codeOf(e) === 40902`。修复前这条是红的（按上面的探针输出，实际得到 40904）。shipped、refunded 各一条。缺陷注入时把 `payable &&` 删掉，三条都应变红。

### ORD3-02【P3】发起支付调机构期间（最长约 6 秒）买家点取消 → 等锁 5 秒超时 → 50000「服务器内部错误」+ error 日志

- **位置**：`server/src/app/order-routes.ts:184-209`（取消路由）→ `cancel-order.ts:47` → `adapters/orders.ts:480`（`for update`，无 55P03 转换）；对照 `pay-intent.ts:23-32,359-370`
- **问题**：`createPayIntent` 在事务内持有订单行锁，同时调 `provider.create`。出站总预算是 `HTTP_TOTAL_BUDGET_MS=6000`（`config.ts:490`、`fetch-client.ts:69`）。等锁的一方受连接级 `lock_timeout=5000` 约束（`adapters/db.ts:113`）。B6 / AJ-201 只给"另一笔发起支付"这一个等锁方把 55P03 翻成了 40903（`lockOrderForPay`），取消路径裸用 `lockOwnedOrderForCancel`。全局也没有任何 55P03 映射（`errors.ts` / `http.ts` 中检索不到），所以最后落成 50000 + `unhandled_error`。PAY2-08 报过同类问题，只覆盖了重放补发短链那一处；本条是取消入口，属新位置。
- **触发场景**：买家点"银行卡"，Stripe 慢（5–6 秒）。他等不及，返回订单详情点"取消订单"（或者在另一台设备上操作）。取消请求在锁上等满 5 秒，拿到"服务器内部错误"，运维侧多一条 error 日志。等支付事务提交后他再点一次取消能成功，所以不丢钱也不坏数据，只是错误码与日志级别都不对。
- **证据**【读码确认】：上面列出的四处常量与调用链；目前没有任何用例覆盖"取消撞上支付持锁"。
- **修复**：取消路由把 55P03 翻成 40903（语义是"这张单正被另一个操作处理"），可以提炼一个与 `lockOrderForPay` 共用的 `lockOrThrow40903`。更彻底的做法是在 http 兜底层统一把 `isLockNotAvailable` 映射为 409 / 40903 + warn（B6 注释里的顾虑是"把别处的锁冲突也说成重复提交"；对用户侧写路径来说，这个说法反而更接近事实）。
- **应补测试**：db 用例里先开一个事务 `select … for update` 锁住订单行并挂起，再用 `lockTimeoutMs=200` 的连接调取消路由，断言 `status=409`、`code=40903`。修复前应得 500 / 50000。

### ORD3-03【P3】AJ-240 的在途单上限只限"张数"，一个账号仍能长期占住约 54 万円货值；注释把防护范围说大了

- **位置**：`server/src/config.ts:342-347`（`MAX_OPEN_ORDERS_PER_USER` 的 @why）；`app/create-order.ts:121-132`；`adapters/orders.ts:808-818`（`lockUserForOrdering` 的 @limitation 只写了"过期未扫仍占名额"）
- **问题**：上限约束的是张数，每张单的体量不受约束：一张单可以有 50 行，每行数量可以填到该 SKU 的全部库存，唯一的量上限是单笔 `MAX_ORDER_JPY=180,000`。所以一个账号能同时占住的货值是 3 × 18 万 = 54 万円。单到期回补后可以立刻再建，限流按 IP 每分钟 30 次，远够用。取消也没挂限流，"取消 → 马上重建"可以把占用维持成连续的，没有缺口。注释写的"把一个账号能同时占住的库存压到 3 张单（每张最多 50 行）"字面上没错，但读者会得出"已经堵住 ORD2-01"的结论。两处注释都没写剩余敞口。
- **触发场景**：店里 20 个 SKU，平均单价 8,000 円、每个 SKU 库存 3 件，全店货值约 48 万円。一个普通微信账号写脚本，把全部 SKU、全部库存分进 3 张单（每张不超过 18 万）。每张单到期后立即重建，全店对其他买家持续显示"库存不足"（40901），整个过程不付一分钱。六类对账都不会报，因为每张都是合法的待付款单。攻击者要多占，就多注册几个微信号。
- **证据**【读码确认】：`domain/quote.ts:120-135` 对 qty 的唯一约束是 ≤ stock；`create-order.ts:179` 是唯一的量上限；取消路由（`order-routes.ts:184`）没有 limiter。
- **修复**：先补注释，把剩余敞口写进 @limitation（这是约束六的要求，也是 H3"只写优点没写代价"）。要真正收紧，可以在同一把 users 锁下再做一条"该用户在途单的**件数合计**（或每 SKU 件数）上限"，或者规定"单个 SKU 在一张单里不超过 N 件"（N 做成配置项）。这属于运营口径，需要用户拍板，不宜代定。
- **应补测试**：如果选"件数合计上限"：同一用户第一张单 qty 等于上限，第二张单只要再加 1 件就应被拒（新码或复用 40913 + reason）。修复前第二张单会成功。

### ORD3-04【P3】（CAT2-02 同类，本分片的新落点）NUL 字符进 SQL → 50000 + error 日志，其中短链入口无需鉴权

- **位置**：
  - `pay-link-routes.ts:62-71` → `pay-link.ts:70-72` → `adapters/orders.ts:786`：**无鉴权**。只要 `t` 是任意 64 位 hex 就能通过形状校验，id 为 `%00` 时查库。
  - `order-routes.ts:75-86`（`contact_email` 的正则 `^[^\s@]+@[^\s@]+$` 放行 `\u0000`，而注释 `:76-77` 说它的目的就是"客户端可控输入应是 40001，不是 PG 报错 → 50000"）。
  - `quote-routes.ts:47`（product_id）、`order-routes.ts:66`（address_id）、`order-query-routes.ts:70-72` 与 `order-routes.ts:192-194`、`pay-intent-routes.ts:72-74`（路径 id）。
- **问题**：这些字符串只校验了"非空字符串"，NUL 会原样进参数化查询。PG 的 text 类型拒收 0x00（22021），全局没有 SQLSTATE 22 类的映射，于是落成 50000。
- **触发场景**：`GET /api/v1/pay/link/%00?t=0000…(64 个 0)`，无需登录，每 IP 每分钟 30 次，每次一条 500 + error 级 `unhandled_error`。扫描器可以稳定制造告警噪声。登录用户在建单时 body 里带 `"contact_email":"a\u0000@b"`，同样得到 500。
- **证据**：Express 把 `%00` 原样解码进 handler，这一点已由 CAT2-02 探针实测（`/p/%00 → "\u0000"`）；本分片各入口的放行逻辑【读码确认】；PG 拒收 0x00【推断】（公认行为，本轮不连库未实跑，与 CAT2-02 的置信度相同）。
- **修复**：与 CAT2-02 合并处理。首选在 http 兜底层把 SQLSTATE `22xxx` 映射为 400 / 40001 + warn，一处覆盖全部入口。另外 `contact_email` 的正则改成 `^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+$`，兑现它自己注释里的承诺。
- **应补测试**：`pay-link-routes.db.test.ts` 加 `GET /pay/link/%00?t=<64 hex>`，断言 302 到失效页（或 400），且日志里没有 `unhandled_error`。修复前应得 500。`order-routes.db.test.ts` 加 `contact_email: 'a\u0000@b'`，断言 40001。

---

## 统计

| 级别 | 新发现 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 0 | — |
| P3 | 4 | ORD3-01（实测）、ORD3-02、ORD3-03、ORD3-04 |

## 上轮修复复核（AJ-235 / AJ-239 / AJ-240）

- **AJ-240（在途单上限 + `lockUserForOrdering`）**：没有发现引入的缺陷。
  - 锁序：建单是 users（`for update`）→ products（排序后逐行）；拉黑是 users → orders → products；取消与关单是 orders → products；关单用 `skip locked`；mark-paid 是 orders → payments。全仓检索 `for update` 与 `update users`，没有任何路径先持 orders 或 products、再等 users，不成环。
  - `for update`（而不是 `no key update`）会挡住同一用户并发的 `insert into addresses`（外键取 `FOR KEY SHARE`），但只持续一次建单的时长。`wechat-login` 的 `on conflict do nothing` 不取行锁，不受影响。
  - 40913 在 handler 内抛出，幂等占位随事务回滚，不会把 40913 缓存 24 小时。买家取消一张单后用同一把键重试可以正常执行。
  - 拉黑复核用例经过 `mountAllRoutes` 的 60 秒身份缓存，确实测到了事务内复核，不是同义反复。
  - 剩余问题只有防护范围被说大，见 ORD3-03。
- **AJ-239（40912）**：`resolveSingleActiveCarrier` 取的是 `active=true` 的 distinct carrier，与取档 SQL 的 `active=true` 同源，"非 null ⇒ 至少一档"成立。包邮单超重同样返回 40912，符合承运商约束。报价与建单共用 `assembleQuote`。"超重 → 40912"与"一档都没有 → 50004"两条用例都在。
- **AJ-235（指纹）**：`{ ...(body ?? {}), order_id: orderId }` 顺序正确。`canonical` 按键排序，`__proto__` 键在展开时是普通自有属性。深度上限 32 在 `requestFingerprint` 里抛 40001，发生在事务之前。数组 body 在前面的 `channel` 校验处就被 40001 挡住。跨单伪造用例在（`pay-intent-routes.db.test.ts:209-230`）。

## 上轮遗留状态（仍存在的只列一行）

- ORD2-05 仍存在（`create-order.ts:135` 建单不复核地址国家）
- ORD2-06 仍存在（`orders.ts:510` 仍 `order by oi.id`）
- ORD2-07 仍存在（`quote-routes.ts:47`、`order-routes.ts:66` 不限长；`order-query-routes.ts:55` 把 `status` 原样放进 details）
- ORD2-09 仍存在（`auto-fulfilment.ts:6`；`auto-confirm.ts:43` 的 `getForCallback` 仍在 try 之外）
- ORD2-10 仍存在（`pay-intent.ts` 仍不看 `is_test`）
- ORD-07 仍存在（`create-order.ts:10-12`"无 TOCTOU"；`orders.ts:191` 的 `decrementStock` 仍不判 `status='active'`）
- ORD-09 仍存在（报价不过审核闸门、不要求 USD）
- ORD-11 / DB-10 仍存在（契约响应清单漏列）
- ORD-12 仍存在（`order-query-routes.ts:43-45` 读 config；`create-order.ts:170,245-248` 写死 `'USD'`）
- B39 / B40 仍存在（`order-views.ts:106` 原样返回 `duty_jpy`）
- B20 仍存在（`product-routes.ts:188` 的 `String(req.params.id)`）
- PAY-10 仍存在（`pay-intent.ts:332-338` 复用时返回 `create()` 给的 providerRef。补一个本轮读到的触发面：mock 的会话缓存在进程内存里（`mock.ts:97`），实例重启后复用 in_app 意图会拿到新的 `mock_…`。审核期"首次自动确认失败 → 用户同通道再点"的恢复路径（`auto-confirm.ts:13-14` 写的那条）因此落成 `provider_ref_mismatch`，恢复不了）
- PAY2-08 仍存在（`pay-intent.ts:188-189`）
- PAY2-09 仍存在（`pay-intent.ts:286-307`）
- `reissuePayLinkOnReplay` 不核对通道：仍存在
- SEC-13 仍存在（`auth.ts:18-19` 的 @tradeoff"零 DB 读 / 无法即时失效"与 @limitation 一相反；`auth.ts:195`"aud 由 jose 在验签阶段强制比对"与 `:119-123` 及实现不符）
- A2 仍存在（限流取 `req.ip`，信任跳数待 staging 实测）
- ORD2-01 / ORD2-02 已修复（AJ-240 / AJ-239）

## 看过、确认没有问题的高风险点

- **越权**：买家读写全部把 `user_id` 放进 WHERE（findOwnedOrder / lockOwnedOrderForCancel / lockOwnedOrderForPay / findOwnedAddress / addresses.update·remove）。行项目、时间线、支付摘要三条查询只在归属校验通过后执行。非本人与不存在同为 40400。时间线按 `ORDER_STATUS` 过滤，读不到 `pay_create_failed`、拒付等内部事件。
- **报价与建单之间的漂移**：两者共用 `assembleQuote`。建单在同一事务内重读商品、运费、汇率，并用 40905 对账。fx_snapshot 与申报价值用的是同一次汇率查询。
- **库存**：扣减用条件更新并按序取锁；回补以状态迁移守卫为凭证、先汇总再按序执行。取消与关单都不会重复回补。
- **重复提交**：建单与发起支付都必须带幂等键。键按用户分作用域，执行器另外核对 user_id。handler 抛错时占位回滚。
- **状态机**：取消走 `assertTransition` 加 SQL 守卫；发起支付只放行 created / pending_payment（过期分支的问题见 ORD3-01）；短链读时判定 `pending_payment` 与 `now < expires_at`。
- **JWT**：只允许 HS256，必须带 exp / iat，校验 aud 与 issuer，回源比对 token_ver / blocked / is_admin。基础设施异常原样抛出，不会折叠成 40101。
- **限流键**：探针确认压缩写法、前导零、`::` 在尾部都归到同一个 /64；IPv4-mapped 点分写法转成 IPv4；非法形态原样返回，不会产生绕过。`::ffff:hex` 写法与 `::1` 会落进同一个 `0:0:0:0::/64` 桶，但 Node 的 `req.ip` 不会产出 hex 形态，不可达，不报。
- **工作单元**：事件在提交之后分发；回滚时代码根本走不到分发那一行。
