> 本文是 2026-09-29 全量逐行代码审查的 **TSB 分片（其余测试与测试基础设施）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# TSB 分片报告：测试与测试基础设施的有效性

分片内 191 个文件已全部逐行读完。全程没有改动 `/home/claude/aj`，也没有读 `.env`，没有跑 db/e2e/contract 测试。探针都放在 `scratchpad/review5/TSB/`；验证迁移用的是临时独立库 `review_tsb`，用完已删除。

结论：P2 共 8 条，P3 共 12 条（大多是合并项）。其中有 3 条是测试把生产代码的错误行为钉成了"正确"期望：TSB-02、TSB-03、TSB-05。

## 1. 覆盖清单（每个文件后是行数；本节所列文件均已逐行读完）

**test/（71）**
- 根目录：`.DS_Store` 0（空二进制）；`signal-harness.ts` 39
- config：`coverage-threshold.unit.test.ts` 191；`gate-scripts.unit.test.ts` 152；`render-env.unit.test.ts` 326；`test-file-placement.unit.test.ts` 97
- contract：`payment-provider.contract.test.ts` 170；`payment-provider.contract.ts` 225
- db：`migrations.db.test.ts` 140；`test-db.ts` 253；`test-db.unit.test.ts` 69
- docs：`doc-templates.unit.test.ts` 95
- e2e：`admin-web-client.e2e.test.ts` 280；`dist-boot.e2e.test.ts` 215；`harness.ts` 214；`miniprogram-shell.e2e.test.ts` 354；`miniprogram-vm-real-response.e2e.test.ts` 163；`pay-callback-pipeline.e2e.test.ts` 550；`pay-channels.e2e.test.ts` 218；`stripe-callback.e2e.test.ts` 315
- factories：`addresses.db.test.ts` 243；`anti-examples.db.test.ts` 104；`anti-examples.ts` 102；`catalog.ts` 543；`catalog.unit.test.ts` 300；`entities.db.test.ts` 221；`entities.ts` 183；`manifest/engine.ts` 120；`manifest/us-address.ts` 189；`manifest/us-address.unit.test.ts` 94；`rng.ts` 109；`rng.unit.test.ts` 141；`scenarios.db.test.ts` 118；`scenarios.ts` 158；`seed-bundle.ts` 79；`stripe.contract.test.ts` 117；`stripe.ts` 294；`stripe.unit.test.ts` 191
- helpers：`chain-server.ts` 324；`fake-stripe-http.ts` 273；`fake-webhook-store.ts` 88；`fake-wx-request.ts` 84；`fixed-clock.ts` 61；`fixed-clock.unit.test.ts` 41；`memory-sink.ts` 42；`mount-ctx.ts` 49；`seed-order.ts` 43；`stub-id-gen.ts` 28
- lint：`comment-header.lint.test.ts` 120；`commit-gate.lint.test.ts` 41；`decision-log.lint.test.ts` 96；`idempotency-request.lint.test.ts` 111；`layering.lint.test.ts` 125；`progress-table.lint.test.ts` 43；`purity.lint.test.ts` 99；`type-aware.fixture.ts` 72；`type-aware.lint.test.ts` 64；`wx-global.lint.test.ts` 53
  - layering 夹具：`adapters/stripe-adapter.fixture.ts` 9；`adapters/violations.fixture.ts` 10；`app/app-token.fixture.ts` 2；`app/assemble.fixture.ts` 9；`domain/pricing.fixture.ts` 10；`domain/violations.fixture.ts` 19；`ports/payment-port.fixture.ts` 9；`ports/violations.fixture.ts` 14
  - purity 夹具：`purity/legal.fixture.ts` 12；`purity/violations.fixture.ts` 25
- setup：`install-network-guard.ts` 15；`network-guard.ts` 100；`network-guard.unit.test.ts` 53

**server/src 根目录（12）**：`config.contract.test.ts` 66；`config.unit.test.ts` 584；`context.unit.test.ts` 102；`contract-document.contract.test.ts` 100；`errors.unit.test.ts` 91；`http.unit.test.ts` 965；`logger.unit.test.ts` 366；`main.db.test.ts` 649；`main.unit.test.ts` 84；`process-errors.unit.test.ts` 78；`redact.unit.test.ts` 444；`routes.contract.test.ts` 168

**server/src/domain（11）**：`address-input` 121；`admin-order-actions` 79；`banner-input` 152；`dispute-input` 134；`fx-input` 96；`order-no` 100；`order` 118；`product-input` 225；`quote` 189；`shipping-rates-input` 111；`upload-image` 110（均为 `.unit.test.ts`）

**server/src/ports（5）**：`circuit-breaker` 183；`http-client` 205；`idempotency` 76；`rate-limit` 34；`scheduler` 103（均为 `.unit.test.ts`）

**server/src/adapters（34）**：`addresses.db` 119；`banners-admin.db` 159；`catalog-admin.db` 158；`catalog.db` 222；`clock.unit` 45；`country-profiles.db` 265；`country-profiles.unit` 203；`db.db` 537；`event-bus.unit` 186；`http/circuit-breaker.unit` 211；`http/fetch-client.unit` 446；`idempotency-cleanup.db` 114；`idempotency.db` 833；`identity.db` 182；`ids.unit` 47；`image-resize.unit` 87；`ops-config.db` 185；`orders-admin-write.db` 233；`orders-admin.db` 209；`orders.db` 436；`payment/channels.unit` 355；`payment/mock.unit` 216；`payment/payment-channels-seed.db` 100；`payment/registry.unit` 370；`payment/stripe-checkout.unit` 976；`rate-limit-memory.unit` 66；`risk-admin.db` 215；`scheduler.db` 159；`scheduler.unit` 58；`storage-fs.unit` 84；`storage-memory.unit` 57；`webhooks.db` 322；`webhooks.unit` 32；`wechat/code2session.unit` 93（均为 `.test.ts`）

**packages/shared/src（6）**：`businessDay` 53；`enums` 82；`errors` 59；`id` 44；`money` 279；`orderNo` 138（均为 `.unit.test.ts`）

**scripts（5）**：`checkout-build-lib.unit.test.ts` 338；`dev-up-lib.db.test.ts` 124；`dev-up-lib.unit.test.ts` 350；`seed-lib.db.test.ts` 73；`seed-lib.unit.test.ts` 55

**miniprogram（32）**
- `components/ws-button/index.unit.test.ts` 178；`components/ws-price/index.unit.test.ts` 172
- `design-token.unit.test.ts` 159；`page-button-guard.unit.test.ts` 149；`project-config.unit.test.ts` 412；`showcase-guard.unit.test.ts` 124；`storage-guard.unit.test.ts` 116；`vm-guard.unit.test.ts` 69
- `pages/*/index.vm.unit.test.ts`：address 87；cart 50；checkout 138；detail 145；home 250；legal 142；order-detail 182；order 92；user 74
- `utils/*.unit.test.ts`：address-form 221；auth-session 103；cart-store 141；error-text 35；idem-key 47；idempotency 136；jst-text 70；order-status 74；pay-plan 239；placeholder 37；price-format 176；quote-view 82；request 362；storage 194；wx-api 288

**admin-web/src（15）**：`api/client.unit` 373；`api/upload.unit` 138；`banners/api.unit` 86；`banners/view.unit` 201；`design-token.unit` 149；`format.unit` 53；`ops/api.unit` 94；`ops/view.unit` 220；`orders/address-view.unit` 179；`orders/api.unit` 165；`orders/view.unit` 272；`products/api.unit` 93；`products/view.unit` 243；`risk/api.unit` 68；`risk/view.unit` 103（均为 `.test.ts`）

**为下结论读过的分片外生产代码**：`mount.ts`、`stripe-checkout.ts`、`http-client.ts`、`fetch-client.ts`、`circuit-breaker.ts`、`domain/order.ts`、`address-input.ts`、`shipping-rates-input.ts`、`product-input.ts`（报关词部分）、`create-order.ts:206`、`order-views.ts`、`order-routes.ts`、`admin-order-routes.ts`、`mark-disputed.ts:299`、`orders.ts:192`、`packages/shared/src/errors.ts`、`seed-lib.ts`、`checkout-build-lib.ts`、`migrations/007|011|013|014`，以及小程序与管理端各 vm/utils/view 的实现、契约 yaml 的相关段落。

---

## 2. 发现列表（按严重度排序）

### TSB-01｜P2｜测试守错了对象，生产幂等键失效
- **位置**
  - 生产：`miniprogram/pages/checkout/index.js:196-200`（`@limitation 二` 写在 17-18）；`miniprogram/pages/pay/index.js:118-122`
  - 测试：`miniprogram/utils/idempotency.unit.test.ts:57-101`；`utils/idem-key.unit.test.ts:72-109`；`pages/checkout/index.vm.unit.test.ts:8`
  - 旁证：`utils/idempotency.js` 只有 `pages/index/index.js:35`（骨架页，已被 packOptions 排除）在用；`server/src/adapters/orders.ts:192`（建单即扣库存）
- **问题**：生产页面每点一次就生成一个新幂等键。"一次意图一个键"的所有断言，守的是一个生产不用的模块 `idempotency.js`。
- **证据**
  ```js
  onSubmit() {                        // checkout/index.js:196
    if (!this.data.gate.ok) return;
    // ⚠️ 一次提交一个幂等键（重试复用，@see @limitation 二）
    this.idemKey = newIdemKey();      // 每次点击都换键；request.js 只对 40101 重放
    void this.createOrder();
  ```
- **触发与后果**
  - 弱网下 `POST /orders` 超时（10s），或服务端已提交但响应丢了。页面报错，购物车不清空。
  - 用户再点一次，带着新键，服务端建出第二张 `created` 单。两张单各扣一份库存、各占 30 分钟。
  - 库存为 1 的商品，第二次点击直接返回 40901，而"我的订单"里多了一张幽灵待付款单。
  - `idempotency.unit.test.ts` 的"红灯证据 1"描述的正是这种缺陷形态，但它守在一个没人用的模块上；`idem-key` 的测试只测了生成。
  - 支付页同样每点一次换键。服务端按"订单+通道"复用意图，所以资金上无害，但幂等层等于形同虚设。
- **解决方案**
  - checkout 和 pay 两页改用 `createIntentIdempotency`：点击时 `acquire()`，成功后 `retire()`；items、地址、条款、期望合计、邮箱任一变化也 `retire()`。
  - 或者在 checkout vm 里加一个纯函数 `nextIdemKey(prevKey, prevBodyHash, body)`，并给它写单测：失败后再提交，键不变；改了地址，键变。
  - `miniprogram-shell.e2e` 补一条：第一次响应丢弃 → 再点 → 服务端重放 → `orders` 表只有 1 行。
  - 把 `idempotency.unit.test.ts:84-91` 改成真正测"内容变化就换键"。它现在和 75-82 逐字等价，是自证。
  - 最终只保留一套键模块。
- **置信度**：已读代码证实（`request.js:9-14`、`187-230` 确认除 40101 外不重试）。
- **是否已登记**：新发现。

### TSB-02｜P2｜测试固化错误行为：管理端把最小单位金额当主单位显示
- **位置**
  - `admin-web/src/orders/view.ts:236-246`，由 `OrderDetail.tsx:180-183` 渲染
  - `orders/view.unit.test.ts:111-117`
  - `risk/view.ts:57,64`；`risk/view.unit.test.ts:81-106`
  - 单位出处：`server/src/app/admin-order-routes.ts:339`（`amountMinor: plan.pay.charge_amount`）、`mark-disputed.ts:299`（`dispute_amount = ${d.amountMinor}`）
- **问题**：`charge_amount` 和 `dispute_amount` 的单位是美分，管理端直接拼成"USD 8600"，两份单测把这个结果当期望值。
- **证据**
  ```ts
  const amount = Number.isInteger(o['charge_amount']) ? String(o['charge_amount']) : ''; // view.ts:241
  ).toBe('stripe · USD 8600');                  // view.unit.test.ts:116
  amountText: 'USD 8600',                       // risk/view.unit.test.ts:101
  ```
- **触发与后果**：一笔 $86.00 的扣款或拒付，在订单详情和拒付列表里显示成"USD 8600"，客服或运营会读成 8,600 美元（差 100 倍），并据此回复客户、判断要不要应诉。日元单没有小数位所以不受影响，只有美元单出错，更难被发现。另外 `orders-admin.db.test.ts:77` 给 1000 円的单配了 `'USD', 11`（按汇率应约 670 美分），同样掩盖了单位问题。
- **解决方案**
  - admin-web 增加 `minorText(currency, minor)`，按币种小数位格式化：USD 显示 `$86.00`，JPY 显示 `12,800 円`，未知币种标注"最小单位"。`paymentSummary` 和 `disputeRows` 都改用它。
  - 测试期望改为 `'stripe · $86.00'`，并补一条 JPY 用例。
  - 契约里给 `charge_amount` / `dispute_amount` 注明"最小货币单位"。
  - `orders-admin.db` 的夹具按 `fx_snapshot` 换算出真实美分值。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。已登记的 `orders.charge_*` 指订单表的列，这里用的是 `payments` 行，不是一回事。

### TSB-03｜P2｜测试固化错误行为：订单详情显示"预估关税 0 円"
- **位置**
  - `miniprogram/pages/order-detail/index.vm.js:70-82`
  - `index.vm.unit.test.ts:163-169`
  - `server/src/app/create-order.ts:206`（`duty_jpy: q.dutyJpy ?? 0`）
  - 契约 `Order.duty_jpy`（"无法估算时为 0…AJ-176 未决"）
  - 对照：`utils/quote-view.js:196`（要求 `duty_estimate===true`）
- **问题**：服务端把"无法估算"存成 0，vm 只判断是不是整数，于是显示关税行。测试拿真实响应里不会出现的 `null` 证明"缺失时不显示"，同时又把 0 钉成"显示"。
- **证据**
  ```js
  if (Number.isInteger(o.duty_jpy)) {                               // vm.js:78
    lines.push({ label: '预估关税（含在商品价内）', value: formatJpy(o.duty_jpy) });
  expect(amountLines({ items_jpy: 8000, shipping_jpy: 1150, duty_jpy: null })).toHaveLength(2); // test:164
  expect(amountLines({ items_jpy: 8000, duty_jpy: 0 })).toEqual([..., { label: '预估关税（含在商品价内）', value: '0 円' }]);
  ```
- **触发与后果**：查不到关税率的单，在结算页（quote-view）不显示关税行；建单后在订单详情显示"预估关税 0 円"。同一张单两页说法相反，而这正是该测试注释自己说要防的"暗示不收关税"。
- **解决方案**
  - 契约 `Order` 增加 `duty_estimate`（或者服务端改存 NULL，即 AJ-176 的决议）。
  - vm 和 quote-view 统一为 `duty_estimate===true && Number.isInteger`。
  - 测试改用服务端真实形状（`duty_jpy:0` 且没有估值标记）断言不出关税行。
  - `vm-real-response.e2e` 补一条"无关税率商品建单 → 详情页不出关税行"。
- **置信度**：已读代码证实。
- **是否已登记**：部分已登记。契约里有 AJ-176 未决项，但前端显示"0 円"和测试把它固化这两点未登记。

### TSB-04｜P2｜fake 与真实服务不符：同键 5xx 重试被当成有效
- **位置**
  - `test/helpers/fake-stripe-http.ts:51,87-89`（`failNext`）
  - `server/src/adapters/http/fetch-client.unit.test.ts:152-161`
  - `server/src/ports/http-client.unit.test.ts:137-143`
  - `server/src/ports/http-client.ts:100-105`（maxAttempts 3）、`186-215`（shouldRetry）
  - `server/src/adapters/http/fetch-client.ts:195`（每次尝试都 `breaker?.after`）
  - `server/src/ports/circuit-breaker.ts:95-96`（阈值 5，冷却 30s）
- **问题**：替身把"5xx 之后同键重试"模拟成下一次必成功，也不回 `Stripe-Should-Retry` 头。单测据此把"POST 带幂等键遇 5xx 就重试"钉为正确做法。
- **证据**
  ```ts
  it('5xx + 有幂等键 → 真的重发，成功后返回 200', async () => {    // fetch-client.unit:152
    fetch: async (n) => (n === 1 ? { status: 503 } : { status: 200, ... }),
  failNext(status, body = ...) { forced = { status, body }; },     // fake 只影响下一次
  ```
- **触发与后果**
  - Stripe 官方文档：同一幂等键的后续请求返回同样的结果，**包括 500**（压缩前已查官方文档和 stripe-node 源码；stripe-node 只在 `Stripe-Should-Retry` 为 true 时才重试）。
  - 所以建会话遇到 500 后，第 2、3 次重试拿到的是被重放的同一个 500：纯白等。
  - 熔断器按"每次尝试"记失败，一次逻辑失败算 3 次。两位用户先后遇到就达到阈值 5，`api.stripe.com` 熔断 30 秒，期间建会话、退款、作废会话、拒付反查全部快速失败。
- **解决方案**
  - 遇 5xx 时读 `Stripe-Should-Retry`：为 false 不重试，为 true 才重试。可以由适配器通过 `HttpRequest` 声明"5xx 可否重试"。
  - 熔断改为每个逻辑请求只记一次结果。
  - fake 按幂等键保存第一次的响应（包括 `failNext` 造出的 5xx），同键重放，并返回 `Stripe-Should-Retry: false`。
  - 补单测：同键 500 → 不重试且熔断只计 1 次；503 且头为 true → 重试。
- **置信度**：已读代码证实，加官方文档和 stripe-node 源码证实。
- **是否已登记**：新发现。

### TSB-05｜P2｜e2e 装配与生产漂移，测试固化已不存在的行为
- **位置**：`test/e2e/harness.ts:186-198`；`test/e2e/stripe-callback.e2e.test.ts:223-259`；对照 `server/src/app/mount.ts:133-192`
- **问题**：e2e harness 只装了 `succeeded` 落账器，而生产已经装了 `disputed` 和 `dispute_closed`。拒付 e2e 仍把"忽略拒付"钉成期望结果。
- **证据**
  ```ts
  appliers: { succeeded: { apply: ..., result: RESULT_PAID, disposition: 'paid' } },  // harness.ts:186
  await expect(res.json()).resolves.toEqual({ received: true, order_id: orderId, ignored: 'disputed' });
  expect(logged[0]?.result).toBe('ignored:disputed');     // stripe-callback.e2e:257
  ```
- **触发与后果**：拒付链路在生产上会落账（打 `has_dispute` 标记、登记拒付），e2e 却验证"拒付被忽略"。一旦生产的拒付落账器出问题，e2e 依旧是绿的；反过来有人照着 e2e 去"修"生产，会把拒付改回忽略。
- **解决方案**：把 appliers 的组装从 `mount.ts` 抽成一个导出函数，harness 直接复用；拒付 e2e 改为先造一张已付款、带支付记录的单，断言 `has_dispute=true`、`dispute_*` 写入、`result` 与生产一致。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### TSB-06｜P2｜回调主链路用例走"不可达预留边"，造单数据现实中不可能出现
- **位置**
  - `test/helpers/seed-order.ts:30-35`
  - `test/e2e/stripe-callback.e2e.test.ts:109-118,138-146`
  - `test/e2e/pay-channels.e2e.test.ts:75-83,156-171`
  - `server/src/main.db.test.ts:386-418`
  - 对照 `server/src/domain/order.ts:29-37`，`harness.ts:63`（`E2E_NOW='2026-01-02…'`）
- **问题**：这些用例在 `created` 单上直接登记支付记录，再让回调把单置为已付款，走的是状态机里标注"合法但走不到"的预留边。领域代码的注释明确写了"不要照着它去写…用例"。
- **证据**
  ```sql
  values (${orderId}, ${`W-${orderId}`}, ${opts.userId}, 'created', 1000, 0, 0, 1000, 500,
          '{}'::jsonb, '{}'::jsonb, 'E2E-SEED', now() + interval '30 minutes')   -- seed-order.ts:33
  -- stripe-callback.e2e:115  chargeCurrency:'USD', chargeAmount:12000（1000 円的单、fx_snapshot 为空）
  ```
- **触发与后果**
  - 真实的 待付款→已付款 路径（由支付意图创建流程在同一事务里登记支付记录）在这几条"回调主链路"用例里没有被覆盖。
  - 造出的数据在生产里不可能存在：fx_snapshot 为空却按美元扣款，生产会直接抛 50003；1000 円对应 $120；已付款时间取 E2E_NOW（2026-01-02），早于创建时间（数据库当前时间）。
  - 迟到付款守卫比较的是固定时钟和"真实当前时间+30 分钟"，在这些用例里永远不会触发，是一个恒假的前提。
  - 将来按注释删掉这条预留边时，这些用例会因为错误的原因变红。
- **解决方案**
  - 新增 `seedPendingOrder`：通过真实的支付意图函数（或同一事务的真实 SQL）登记支付记录并迁到待付款，主链路用例统一改用它。
  - 造单时写入与扣款币种匹配的 `fx_snapshot`，金额按汇率换算。
  - 创建时间和过期时间都由 E2E_NOW 推导，不用数据库 `now()`。
  - 单独保留一条注明"预留边"的用例。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### TSB-07｜P2｜迁移往返测试只测"回滚到底"，单步回滚的缺陷被掩盖
- **位置**：`test/db/migrations.db.test.ts:80-89`（文件头 4-7 行宣称要防的正是这种缺陷）
- **问题**：测试只做"全部回滚 → 再全部 up"。001 的回滚会整表 DROP，把后续迁移回滚脚本漏删的索引、约束一起删掉，于是缺陷永远不会暴露。
- **证据**
  ```ts
  runMigrations('down', migrationNames().length);
  expect(await businessTables()).toEqual([]);
  runMigrations('up');
  ```
  探针：在独立库 `review_tsb` 上用改过的迁移副本，删掉 011 回滚里的 `DROP INDEX`：
  - up → 全部回滚 → up：全部成功（测试的路径保持绿色）
  - 回滚 4 步 → up：报 `relation "addresses_one_default_per_user" already exists`
- **触发与后果**：线上出事需要回滚最近一个迁移时，回滚后无法重新上线，而这个测试一直是绿的。
- **解决方案**：对每个迁移做单步往返（从最新开始逐个 `down 1` → `up 1`），并对比 `pg_indexes`、`pg_constraint`、`information_schema.columns` 的快照；另外加一条元测试：up 段不带 `IF NOT EXISTS` 的对象，回滚段必须有对应的 DROP。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### TSB-08｜P2｜外部约束被自证：Stripe 会话最短有效期
- **位置**
  - `server/src/adapters/payment/stripe-checkout.ts:54-58,96`
  - `server/src/adapters/payment/stripe-checkout.unit.test.ts:140-152,191-194`
  - `test/helpers/fake-stripe-http.ts`（整个文件不校验 `expires_at`）
- **问题**：期望值直接引用生产常量 `STRIPE_MIN_SESSION_TTL_SEC`，fake 也不校验"创建后 30 分钟到 24 小时"的窗口。测试注释的推理是反的："写死 30*60 的话，改了下限这条会绿着骗人"。事实上，写死字面量改了会变红，引用常量改了才会一直绿。
- **证据**
  ```ts
  // 数字取自生产常量（单一来源）：写死 30*60 的话，改了下限这条会"绿着"骗人
  expect(form.get('expires_at')).toBe(String(Date.parse(...) / 1000 +
    STRIPE_MIN_SESSION_TTL_SEC + STRIPE_SESSION_MARGIN_SEC));
  ```
- **触发与后果**：有人把常量改到 30 分钟以下（或把 `ORDER_PAYMENT_TTL_MIN` 配到约 23.5 小时以上），Stripe 会对所有建会话请求回 400，银行卡支付整体不可用，而全部测试仍然绿。
- **解决方案**
  - 至少一条用例用字面量钉住外部事实：`expect(STRIPE_MIN_SESSION_TTL_SEC).toBe(1800)`，并附官方文档出处。
  - fake 校验 `expires_at - created ∈ [1800, 86400]`，不满足回 400。
  - 在 config 层对 `ORDER_PAYMENT_TTL_MIN` 设上限，并补测试。
  - 修正那段注释。
- **置信度**：已读代码证实（Stripe 官方文档压缩前已查）。
- **是否已登记**：新发现。

---

### TSB-09｜P3｜契约测试白名单不全，靠失真夹具才保持绿色
- **位置**：`test/contract/payment-provider.contract.ts:210-219`；`stripe-checkout.ts:490,526-529`；`test/factories/stripe.ts`（会话、支付意图夹具都缺 `created`）
- **问题**：白名单里没有 ports 已声明的可选字段 `occurredAtMs` 和 `disputeStatus`。真实的 Stripe 会话对象一定带 `created`，适配器解析时会附上 `occurredAtMs`。测试之所以绿，只是因为工厂造的会话没有 `created`。
- **证据**
  ```ts
  ...(typeof createdSec === 'number' && Number.isFinite(createdSec)
      ? { occurredAtMs: Math.round(createdSec * 1000) } : {}),   // stripe-checkout.ts:526
  ```
  探针 `contract-probe.mts`：带 `created` → 多出 `occurredAtMs`；不带 → 没有。
- **触发与后果**：谁把工厂改得更真实，契约测试就会误红；它也没有守住端口的真实形状。
- **解决方案**：白名单改为从 `ProviderEvent` 的全部键（含可选键）推导；工厂默认带上 `created`。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### TSB-10｜P3｜永真、自证、条件不执行的断言（合并）
- **位置与问题**
  - `test/factories/addresses.db.test.ts:213-216`：每条用例前都已清库（40-41 行），"反例一个都没进库"恒为真。
  - `server/src/main.db.test.ts:122-145`：停机用例手工调用 `closeDb` 再断言"关了"，自证；没测 bootstrap 里 afterDrain 的实际接线。
  - `main.db.test.ts:572-577`：注释写"不伪装成通过"，代码却是 `return`（计为通过），应改为 `ctx.skip()`。另外 4611-4614 端口写死。
  - `server/src/adapters/wechat/code2session.unit.test.ts:69-70`：第二次调用时替身的响应已经用完，抛出的是 `'测试没喂够响应'`，`.rejects.not.toMatchObject({code:40101})` 是空转（探针 `c2s-probe` 证实）。
  - `test/factories/catalog.unit.test.ts:292-295`：锚点用例只断言常量等于它自己的字面量，没检查运费档表里是否有 2000g→4950。
  - `server/src/adapters/catalog.db.test.ts:55`：标题写"含全部档界两侧"，实际 7 个向量缺 250/251、1000/1001 等边界。
  - `miniprogram/utils/idempotency.unit.test.ts:84-91` 与 75-82 逐字等价（见 TSB-01）。
  - `scripts/checkout-build-lib.unit.test.ts:81-86`：部署闸门的"自检"只用了 `http://` 输入，全部被"非 https"分支拒掉，回环地址那条判断从未被执行。变异探针 `deploy-gate-probe`：删掉 isLocal 分支，全部用例仍绿，`https://localhost` 被放行。
  - `admin-web/src/products/view.unit.test.ts:154-160`：标题写"库存/分类各自有提示"，断言里两者都没有，还用 `'category'.slice(0,0)` 把这个词凑进源码。
  - `test/e2e/miniprogram-vm-real-response.e2e.test.ts:153`：同时容忍"裸数组"和 `{items}` 两种形状，掩盖契约漂移。已被 `address-routes.db.test.ts:189` 部分兜住，所以列为 P3。
  - `test/factories/stripe.unit.test.ts:187-189`："验签必须用 timingSafeEqual"这条元测试扫的是**测试侧** `test/factories/stripe.ts`，没扫生产的 `stripe-checkout.ts:223`、`mock.ts:150`。
- **证据**
  ```ts
  it('反例一个都没进库（...）', async () => {            // addresses.db:213（beforeEach 已清库）
    const rows = await db`select count(*)::int as n from addresses`;
    expect(Number(rows[0]?.n)).toBe(0);
  ```
- **后果**：这些用例在被测行为退化时仍然是绿的。
- **解决方案**
  - 在同一用例里先制造违规再断言。
  - 停机用例改测 bootstrap 的 shutdown 钩子。
  - skip 用 `it.skipIf` 或 `ctx.skip()`。
  - code2session 每次调用单独建替身。
  - 锚点改断言 `pickTier(2000)=4950`。
  - 补齐缺失的边界向量。
  - 自检用例加 `https://localhost`、`https://127.0.0.1`、`https://[::1]`。
  - 元测试改扫生产验签文件。
- **置信度**：已读代码证实，其中 3 处已探针证实。
- **是否已登记**：新发现。

### TSB-11｜P3｜扫描型门禁的范围漏洞（合并）
- **位置与问题**
  - `test/lint/comment-header.lint.test.ts:26`：`SOURCE_ROOTS` 不含 `admin-web/src` 和 `scripts`。探针 `header-probe` 在这两处找到 10 个违规文件，例如 `scripts/check-contract.mjs` 连文件头都没有，`admin-web/src/main.tsx` 缺 `@why` 和 limitation。
  - `eslint.config.mjs:28`：purity 规则的范围只有 `server/src`。小程序 vm 只靠 `vm-guard.unit.test.ts:63-66` 拦 `wx.` 和 `new Date(`，拦不住 `Date.now`、`Math.random`、`getApp`；它的 `@limitation 二`（"法务页没有 vm"）也已过时。
  - `scripts/checkout-build-lib.unit.test.ts:232-237,317`：不扫 `rgb/hsl`、颜色关键字、`rem`；豁免按"整行包含子串"判断，同一行再加一个色值也会被豁免。
  - `admin-web/src/design-token.unit.test.ts:30-37`：只扫 `.css`，TSX 里的内联 `style={{}}` 完全不在范围内（目前没有违规）。
  - `miniprogram/page-button-guard.unit.test.ts:76-80`：只检查原生 `<button>`。`<view catchtap="onPay">`（`pages/order/index.wxml:36`）、地址页的"删除/设为默认"等写操作入口都绕开了连点防护。
  - `miniprogram/project-config.unit.test.ts:225-233`：`PRIVATE_PREFIXES` 里没有 `pages/checkout`，删掉它的 disallow 规则不会变红。`jumpTargets`（65-83 行）识别不了 `navigateTo({ url })` 这种简写（user 页的主入口）。
  - `test/factories/manifest/us-address.ts:65`：正则 `\b(...|#)\b` 里的 `#` 永远匹配不到（探针：`'1 Main St #5'` → false）。47、53 行分别匹配 5 位和 ZIP+4 邮编，几乎覆盖所有样本，所以反向审计实际空转。
- **证据**
  ```ts
  const SOURCE_ROOTS = ['server/src', 'packages/shared/src', 'miniprogram'];   // comment-header:26
  matches: (a) => /\b(Apt|Unit|Ste|Suite|Floor|Fl|Rm|#)\b/i.test(...)          // us-address:65
  ```
- **后果**：门禁对范围外的违规恒绿。
- **解决方案**
  - 扫描根改从 workspace 推导，并为每个根加"至少命中 1 个真实违规样本"的自检。
  - purity 规则把 `miniprogram/pages/**/*.vm.js` 纳入范围。
  - 扫描器改用 CSS parser，豁免按"文件+行+模式"三元组登记。
  - 按钮守卫扩展到任何带 `bindtap/catchtap` 且调用写接口的元素。
  - sitemap 私有前缀名单改从页面的"需登录"标记推导。
  - `#` 改写成 `(?:^|\s)#\s*\w`；反向审计要求每条样本命中至少一个"非通用"形态。
- **置信度**：已读代码证实，其中 2 处已探针证实。
- **是否已登记**：新发现。

### TSB-12｜P3｜测试基础设施缺陷（合并）
- **位置与问题**
  - `test/db/test-db.ts:43,127,177-183`：建库时用写死的 `japan_shop_test`，迁移时却用 `TEST_DATABASE_URL`。设成别的 `_test` 库名时，会建错库，随后迁移到一个不存在的库。
  - `test/helpers/chain-server.ts:281-301`：`snapshotState` 这个"零副作用"快照漏了 `orders.carrier/tracking_no/has_dispute/shipped_at/refunded_at`、`payments.provider_ref/settled_jpy/fee_jpy/dispute_*`、`users.blocked_at/token_ver`、`admin_audit`。拒绝路径若误写这些列，照样通过。
  - `chain-server.ts:244-253` 会更新 `job_runs`，而 `resetTestDb` 按设计不清这张表（`test-db.ts:229`）。后续读 `daily` 心跳的用例受执行顺序影响（泄漏已证实，具体受害用例属疑似）。
  - `test/setup/network-guard.ts:64,79-89`：只拦 `globalThis.fetch`，拦不住 `node:http`、`undici.request`、子进程；放行判断用 `startsWith`，`https://api.stripe.com.evil` 也能通过。目前没有 `allowOutbound` 的调用方，生产出站也只走 fetch，所以只是潜在问题。
  - 时序脆弱：`server/src/adapters/idempotency.db.test.ts:110,131,287,300,386` 靠 sleep 100–800ms 制造并发重叠；`server/src/http.unit.test.ts:669` 用 `setTimeout 60`。`idempotency.db.test.ts:383` 和 `pay-callback-pipeline.e2e.test.ts:188` 只 spy 了 `Date.now`，代码若改用 `new Date()` 就绕过（压缩前探针证实）。
- **证据**
  ```ts
  const TEST_DB_NAME = 'japan_shop_test';                       // test-db.ts:43
  const rows = await admin`select 1 ... where datname = ${TEST_DB_NAME}`; // :177，与 TEST_DB_URL 不同源
  ```
- **解决方案**
  - 库名改从 `TEST_DB_URL` 的 pathname 解析。
  - `snapshotState` 改为对全部业务表做 `SELECT *`（剔除易变的时间列），或按 `information_schema` 自动取列。
  - 需要心跳的用例在 `beforeEach` 里复位 `job_runs` 的种子行。
  - network guard 同时拦 `http/https.request`，放行时按 URL 的 origin 做精确比较。
  - 并发用例改用 barrier 或 advisory lock 编排；时钟偏移改用 `vi.setSystemTime`。
- **置信度**：已读代码证实（`job_runs` 的受害面为疑似）。
- **是否已登记**：新发现。

### TSB-13｜P3｜工厂和 fixture 失真（合并，违反约束三）
- **位置与问题**
  - **订单号用已废弃格式**：`miniprogram/pages/order-detail/index.vm.unit.test.ts:15`、`pages/order/index.vm.unit.test.ts:20,28`、`admin-web/src/orders/{view,api}.unit.test.ts`、`risk/view.unit.test.ts` 用 `WS-20260927-0001`；`test/helpers/seed-order.ts:33` 用 `W-${id}`。都通不过 `ORDER_NO_PATTERN`。
  - **运费 fixture 与项目锚点矛盾**：`admin-web/src/ops/view.unit.test.ts:23-28` 注释写"锚点：2kg = 4,950 円"，数据却是 `2000g→4050、5000g→4950`，而 4050 正是 `catalog.db.test.ts:44` 所说"向下取档"的头号红线错误值。
  - **错误码用错**：`admin-web/src/orders/api.unit.test.ts:120` 用 40903 表示"已发货"，注册表里 40903 是"重复提交"。
  - **HTTP 状态不真实**：`miniprogram/utils/request.unit.test.ts:78-81,148-361` 所有 40101 都配 HTTP 200，注释还称"这才是服务端真正的错误通道"。实际 `httpStatusOf(40101)=401`（`packages/shared/src/errors.ts:185`）。
  - **条款链接形态不真实**：`pages/legal/index.vm.unit.test.ts:15-23` 用绝对 https URL，而服务端当前返回的是占位相对路径 `/legal/terms.zh.html`（`product-routes.ts:181`）。vm 原样透传，用户会复制到打不开的地址，这一点没有测试守护。
  - **时间形态不真实**：`admin-web/src/banners/view.unit.test.ts:28` 的 ISO 带 `+09:00`，服务端一律输出 `Z`。
  - 压缩前已记录的：工厂电话含 NANP 不合法号段；美妆类商品的 `compliance_tags` 为空；`test/factories/anti-examples.ts` 多条反例复用同一 id。
- **证据**
  ```ts
  const RATES = [ /** 锚点：2kg = 4,950 円 */
    { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true }, // ops/view.unit:26
  ```
- **后果**：测试证明的是"对着假形状能跑"，查不出真形状下的缺陷。
- **解决方案**：各端 fixture 统一从 `test/factories` 生成，或用 `formatOrderNo`、`SHIPPING_TIERS`、`httpStatusOf` 推导；加一条元测试：`*.test.ts` 里形如订单号的字面量必须匹配 `ORDER_NO_PATTERN`。
- **置信度**：已读代码证实。
- **是否已登记**：新发现（服务端条款占位链接本身已在服务端 `@limitation` 里登记，fixture 失真未登记）。

### TSB-14｜P3｜前端校验只与契约比对，服务端这第三份真源的漂移没人守
- **位置与问题**
  - `miniprogram/utils/address-form.unit.test.ts:191-221` 和 `admin-web/src/orders/address-view.unit.test.ts:151-179` 只与契约比对。服务端 `domain/address-input.ts` 另有长度上限（收件人 100、地址行 200、城市 100），契约和两个前端都没有；state 在契约里只约束长度 2，服务端要求 `^[A-Z]{2}$`。
  - `admin-web/src/products/view.ts:47-53,255-256` 的报关敏感词用 `includes` 子串匹配（`drugstore` 也会被拒），服务端 `product-input.ts:79` 用 `\b…\b` 词边界匹配；两份词表之间没有同源断言。
  - `admin-web/src/ops/view.ts:154-178` 不预检"启用承运商必须恰好一家"（服务端 `shipping-rates-input.ts` 会以 `carrier_not_single` 拒绝），也不拦"重档比轻档便宜"。而 `ops/view.unit.test.ts:4-5` 声称"能拦的形状问题必须在保存前拦完"。
- **证据**
  ```ts
  if (input.recipient.length > LEN.recipient) throw new AppError(40001, { reason: 'recipient_too_long' }); // address-input.ts
  const hit = BLOCKED_CUSTOMS_WORDS.filter((w) => lower.includes(w));                                      // products/view.ts:256
  ```
- **后果**：出现"前端说对、服务端返回 40001"的情况，而这些测试注释说的正是要防这个。
- **解决方案**：契约补上 `maxLength` 和 state 的 pattern；前端词表从 `@waselect/shared` 导出、匹配语义与服务端一致；加一条跨端测试，用同一组向量同时跑前端和服务端的校验函数。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### TSB-15｜P3｜测试侧注释、标题与事实不符（合并，违反约束六）
- `admin-web/src/orders/view.unit.test.ts:137`："服务端目前不拦"拒付单发货。实际服务端会拦：`admin-order-actions.ts:66` 返回 40909。
- `admin-web/src/orders/view.unit.test.ts:187`："列表接口没有 has_dispute 这个字段"。契约 0.6.1 起列表已经带了。
- `admin-web/src/ops/api.unit.test.ts:89`："空表服务端按清空处理"。契约写的是返回 40001 `rates_empty`。
- `scripts/seed-lib.unit.test.ts:49-54`："不拦 produce"。正则 `/prod|production/i` 实际会拦 `produce_demo`（探针 `seed-gate-probe`）。
- `test/factories/addresses.db.test.ts:219-228`："应用层校验那一层现在还不存在"。`domain/address-input.ts` 已经实现。
- `test/factories/stripe.ts:69,79,180`：写的是"深合并"，197 行实际是浅展开。
- `miniprogram/utils/price-format.js:29`：`@see ws-price（唯一调用方）` 与事实不符；1-2 行"副行 ≈ 人民币 ¥176"也与实现不符。
- `miniprogram/pages/home/index.vm.unit.test.ts:191-193`：注释自相矛盾。
- `packages/shared/src/orderNo.unit.test.ts:105`："任意合法日期"，实际取值范围含 `999999`。
- `scripts/dev-up-lib.unit.test.ts:68-72`：声称是"独立推导"，实际与 `seed-lib.ts:44` 的写法逐字相同。
- `miniprogram/vm-guard.unit.test.ts:16-18`：`@limitation 二` 已过时。
- 压缩前已记录的过时注释：`test/factories/catalog.ts` 的 `@limitation 四`、`stripe.ts` 关于 SDK 的 limitation、`admin-web-client.e2e` 的 `@limitation 一`（登录已实现）、`risk-admin.db` 的 limitation（写入方已存在）、`config.unit.test.ts:272-277`。
- **解决方案**：逐条改正。标题与断言不一致的用例，按标题把断言补齐。
- **置信度**：已读代码证实，1 处已探针证实。
- **是否已登记**：新发现。

### TSB-16｜P3｜高风险分支缺测试
- `miniprogram/pages/pay/index.js`：支付页没有 vm，也没有任何测试。幂等键生命周期、`run()` 的分支分派只能靠真机验证。
- `admin-web/src/products/api.ts:78-91`：`createProduct` 和"缺 id 就抛错"的路径没有测试。
- `admin-web/src/api/upload.ts:86-106`："2xx 但 body 带 code"的情况按成功处理，与 `client.ts` 口径不一致，也没有测试（describe 标题却写着"与 client.ts 同口径"）。
- `packages/shared/src/orderNo.ts:46-48`：`rand()` 返回 1 时的夹紧分支没有测试。文件头自己写着"取值区间必须跨越边界"。
- 压缩前已记录的：`quote` 拆单提示的 `>` 边界、`catalog.db` 的排序与 `_` 通配、`registry.unit.test.ts:363` 标题里的"反之"没测、`orders.db.test.ts:250` 的"并持行锁"未验证锁、`orders-admin-write.db` 在已发货或退款中的单上造 `initiated` 支付记录、`event-bus.unit` 的恒真断言。
- **解决方案**：pay 页把支付意图执行的编排抽进 vm 并补单测；上面几项各补一条最小用例。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

---

## 3. 看过但不是问题
- 地址列表的响应形状：契约、服务端、页面外壳都是裸数组，`address-routes.db.test.ts:189` 钉住了 `[]`。e2e 的双形态容忍只是弱化（已列入 TSB-10），不构成缺陷。
- 支付页连点：服务端按"订单+通道"复用支付意图，一张单不会生成两个会话。退款连点有状态机（进入退款中后再点返回 40902）和 Stripe 退款幂等键 `refund:${orderId}` 双重兜底。
- `chargeOptions` 的美元金额取订单 `display.USD`，服务端扣款时也从同一个 `fx_snapshot` 用 `toMinor` 换算（`order-views.ts:35-46` 对照 `pay-intent.ts:99-105`），两边一致。
- `jstDateTime` 只认以 Z 结尾的时间：服务端 `order-views.ts:60,107,110` 统一用 `toISOString` 输出。
- 首页分类枚举：`enums.unit.test.ts:57-69` 把 shared 与契约做了同源比对，小程序也与契约比对，三方已形成闭环。
- `wx-api` 在真实宿主路径上把非字符串的 storage 值收窄为空串，`storage.getString` 不会返回对象。
- redact 不遮蔽裸 `name` 键，是 AJ-33 记录在案的取舍，不是遗漏。
- network guard 目前没有放行调用方，生产出站只走 fetch，现阶段有效（潜在漏洞见 TSB-12）。
- 压缩前已核实：vitest 覆盖率门槛的 glob 语义正确；路由快照完整（所有挂载都是无条件的）；幂等请求 lint 覆盖的两个现有调用点都正确；订单号 FNV 向量正确；IPv6 回环判定正确；`server/src` 里没有使用 purity 规则的绕过写法；超卖并发在 app 层测试里有覆盖；`ignored:expired` 与生产一致；Stripe 签名时间容差的双向放宽是有意为之。
