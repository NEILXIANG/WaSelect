> 本文是 2026-09-29 全量逐行代码审查的 **MP 分片（微信小程序）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# MP 分片（微信小程序）逐行审查报告

MP 分片共发现 20 个问题：P1 两个，P2 七个，P3 十一个。两个 P1 都已用探针（加载真实页面代码跑一遍的小脚本）复现：
- **MP-01**：结算页每次点提交都新生成幂等键，逻辑层也没有在途守卫。请求超时后用户重试，或者连点一下，都会建出两张订单。
- **MP-02**：用户选好非默认地址后，只要看一次条款、或把小程序切到后台再回来，结算页就静默换回默认地址。

现有小程序单测 32 个文件、371 条全部通过，没有一条能抓到这些问题。

## 1. 覆盖清单（miniprogram/ 下全部非测试文件，均已逐行读完）

| 文件 | 行数 | | 文件 | 行数 |
|---|---|---|---|---|
| app.js | 112 | | pages/home/index.js / .vm.js / .wxml / .json / .wxss | 244 / 169 / 77 / 7 / 112 |
| app.json | 22 | | pages/detail/index.js / .vm.js / .wxml / .json / .wxss | 106 / 93 / 61 / 7 / 72 |
| app.wxss | 66 | | pages/cart/index.js / .vm.js / .wxml / .json / .wxss | 162 / 38 / 68 / 7 / 85 |
| config.js | 15 | | pages/checkout/index.js / .vm.js / .wxml / .json / .wxss | 230 / 102 / 89 / 7 / 76 |
| project.config.json | 54 | | pages/pay/index.js / .wxml / .json / .wxss | 177 / 59 / 7 / 36 |
| sitemap.json | 41 | | pages/order/index.js / .vm.js / .wxml / .json / .wxss | 93 / 63 / 40 / 6 / 32 |
| components/ws-button/index.js / .json / .wxml / .wxss | 99 / 4 / 8 / 23 | | pages/order-detail/index.js / .vm.js / .wxml / .json / .wxss | 131 / 129 / 107 / 7 / 81 |
| components/ws-price/index.js / .json / .wxml / .wxss | 95 / 4 / 1 / 23 | | pages/address/index.js / .vm.js / .wxml / .json / .wxss | 162 / 53 / 44 / 6 / 42 |
| utils/request.js | 231 | | pages/address-edit/index.js / .wxml / .json / .wxss | 148 / 123 / 6 / 32 |
| utils/wx-api.ts | 289 | | pages/legal/index.js / .vm.js / .wxml / .json / .wxss | 114 / 95 / 46 / 3 / 44 |
| utils/storage.ts | 94 | | pages/user/index.js / .vm.js / .wxml / .json / .wxss | 62 / 56 / 22 / 3 / 17 |
| utils/cart-store.js | 154 | | pages/index/index.js / .wxml / .json / .wxss（已退役、未登记） | 161 / 77 / 6 / 9 |
| utils/pay-plan.js | 228 | | pages/comp/index.js / .wxml / .json / .wxss（未登记） | 31 / 50 / 7 / 14 |
| utils/price-format.js | 132 | | utils/address-form.js | 178 |
| utils/quote-view.js | 59 | | utils/auth-session.js | 71 |
| utils/idem-key.js | 28 | | utils/idempotency.js | 94 |
| utils/random-id.js | 44 | | utils/trace.js | 25 |
| utils/jst-text.js | 75 | | utils/order-status.js | 66 |
| utils/error-text.js | 27 | | utils/placeholder.js | 40 |
| utils/wx-global.fixture.js | 29 | | assets/placeholder.png | 二进制，已确认存在 |

- **另读了的测试文件**：page-button-guard.unit.test.ts（用来判断连点防线的覆盖范围）。
- **为下结论读过的分片外代码**：
  - 契约 `contracts/api-contract.yaml` 全部 paths 与 schemas
  - server 端：`domain/address-input.ts`、`app/pay-intent.ts`（resolveCharge / listedFor / 锁单复用）、`app/pay-routes.ts`、`adapters/payment/registry.ts#listAvailable`、`app/order-views.ts`、`app/wechat-login.ts`、`app/quote-routes.ts#parseItems`、`domain/quote.ts#summarize*`、`app/create-order.ts` 的抛错点、`order-routes.ts` 的 contact_email 校验、`errors.ts#toErrorResponse`
  - `packages/shared/src/errors.ts`（错误码与 action 登记表）
  - 文档：`docs/自主决策记录.md` AJ-179 与裁决⑯、`docs/开发前审计报告-2026-09-19.md`
- **官方文档实测**：
  - `wx.setClipboardData` 在隐私接口「剪切板」项内。未在隐私指引中声明时返回 `api scope is not declared in the privacy agreement`（errno 112）；用户拒绝官方隐私弹窗返回 104，10 秒内不再弹窗。
  - `<input>` 的 `maxlength` 默认值是 140。
- **探针**：放在 `…/scratchpad/review5/MP/` 下（probe-checkout / probe-double / probe-home / probe-cart / probe-errmsg），用 stub 的 Page / getApp / wx 加载真实页面代码。

## 2. 发现列表

### MP-01｜P1｜钱与状态 / 幂等失效
- **位置**：
  - pages/checkout/index.js:17-19（注释）、:197-202、:204-229
  - pages/pay/index.js:67、:118-123
  - utils/idem-key.js:8-11
- **问题**：注释说幂等键"一次提交一个、重试复用同一个"，实际每次点提交都新生成一个。`onSubmit` 也不看 `submitting`，按钮只靠原生 `disabled` 挡连点，没有传 `loading`，所以 ws-button 里的 JS 守卫不会生效。
- **证据**：
  ```js
  onSubmit() {
    if (!this.data.gate.ok) return;
    // ⚠️ 一次提交一个幂等键（重试复用，@see @limitation 二）
    this.idemKey = newIdemKey();
    void this.createOrder();
  },
  ```
  探针输出：
  - 第一次超时、第二次重试的两个键：`['idem-1xiiqmh…', 'idem-0qrs1h6…']`
  - 同一帧内两次 tap（逻辑层视角）：`POST /orders 次数: 2`，同时跳转了两个 `/pages/pay/index?orderId=…`
- **触发场景与后果**：
  - 弱网下 `POST /orders` 超过 10 秒，但服务端其实已经建单（扣了库存）。用户看到 "-1 request:fail timeout"，再点一次提交，会以新键建出第二张单，库存被双占 30 分钟。
  - 库存紧张时，第二次直接报 40901，用户以为下单失败，而第一张单只能去"我的订单"里找。事后对两张单都点"继续支付"会重复付款，只能人工退款。
  - 连点在渲染层 `disabled` 回写之前到达逻辑层时，同样会建两张单。
  - 登记表 40903 的 action 是"稍后用同一幂等键重放"，客户端没有能力照做。
  - 支付页同样每次点击换键（注释写的是"重试复用，同 checkout 的口径"）。因为服务端锁单并复用意图，后果较轻。
  - 正确的生命周期实现 `utils/idempotency.js#createIntentIdempotency` 只被已退役的 pages/index 和 e2e 使用。e2e 验的是一个生产页面没在用的模块。
- **解决方案**：
  1. checkout 与 pay 在 `onLoad` 中创建 `this.intent = createIntentIdempotency()`。
  2. 提交时 `const {key} = this.intent.acquire()`；成功后 `retire()`。
  3. 遇到 40905 / 40011 / 40901 / 40401 时，先重取报价或条款，再 `retire()`（内容已变，属于新意图）。网络错误、5xx、40903 时保留键。
  4. 结算页换地址、购物车变化时也 `retire()`。
  5. ws-button 改为 `loading="{{submitting}}"`，这样 JS 守卫生效，同时不触犯 page-button-guard。
  6. 删掉 idem-key.js，只保留一个模块。
  7. 补测试：把"取键 / 何时作废"抽成 vm 纯函数，或用本次探针的 stub harness 写页面级单测，断言三点：超时后重试同键；成功后换键；`submitting` 期间第二次 tap 不发请求。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### MP-02｜P1｜状态 / 正确性（发货地址被静默换回默认）
- **位置**：pages/checkout/index.js:118-137（选址逻辑写在薄壳里，没有测试）
- **问题**：每次 `onShow` 都会重新计算地址，没有 pickedAddressId 时退回 `defaultAddressId`，把用户已经选中的 `this.addressId` 覆盖掉。
- **证据**：
  ```js
  const picked = app.globalData.pickedAddressId;
  app.globalData.pickedAddressId = '';
  const id =
    picked !== '' && list.some((a) => a && a.id === picked) ? picked : defaultAddressId(list);
  const found = list.find((a) => a && a.id === id);
  this.addressId = id;
  ```
  探针输出：`选 B 回来后: addr-B` → `看完条款返回后: addr-A`
- **触发场景与后果**：用户在结算页选了非默认地址 B 之后，以下任一操作都会触发 `onShow → refresh`，地址静默回到默认地址 A：
  - 点"查看条款全文"再返回；
  - 进地址页没选就返回；
  - 小程序切到后台再回前台（比如去聊天里复制邮箱再回来）。

  提交后订单按 A 发货。页面上会显示 A，但用户已经选过一次，大多不会再核对。跨境改址要走人工，还有重发成本。
- **解决方案**：
  1. 抽成 checkout vm 的纯函数 `resolveAddressId({picked, current, list})`，优先级为：picked（在列表中）> current（仍在列表中）> default。
  2. 薄壳只负责调用。
  3. 补单测，覆盖四种情况：选择后返回、未选择返回、当前地址已被删除、列表为空。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### MP-03｜P2｜合规 / 主路径可靠性（银行卡唯一入口复制失败时无任何兜底）
- **位置**：
  - pages/pay/index.js:163-166
  - pages/pay/index.wxml:51-55
  - docs/开发前审计报告-2026-09-19.md:74
- **问题**：`setClipboardData` 属于隐私接口，但支付页复制链接不传 `success` / `fail`，页面上也不展示链接文本。法务页和订单详情页都有失败兜底，唯独支付页没有。
- **证据**：
  ```js
  onCopy() {
    if (this.data.payUrl === '') return;
    wxApi.setClipboardData({ data: this.data.payUrl });
  },
  ```
  wxml 里没有 `{{payUrl}}`，只有一个"复制链接"按钮。
- **触发场景与后果**：
  - 用户在官方隐私弹窗点了拒绝（errno 104，10 秒内不再弹窗），或者隐私指引里漏了剪切板（errno 112，对所有用户都失败）。
  - 点"复制链接"没有任何反应，也没有文字说明。在微信支付（R1）上线之前，这是唯一的付款路径。
  - 文档自相矛盾：开发前审计报告第 74 行写"只用 wx.login"，第 155 行却写了"隐私声明含剪贴板"。
- **解决方案**：
  1. 补 `success`（切换为"已复制"）和 `fail`（提示"复制失败，请长按下方链接手动复制"）。
  2. wxml 增加 `<text user-select>{{payUrl}}</text>`，与法务页同一口径。
  3. 更正审计报告第 74 行。
  4. 隐私授权封装（F14 延后项）落地时，接入 `wx.onNeedPrivacyAuthorization`。
- **置信度**：代码部分已读代码证实；平台行为已查官方文档证实。
- **是否已登记**：隐私弹窗真机验证（测试策略 L4 第 3 项）和隐私授权封装已登记。支付页缺少失败兜底是新发现；"只用 wx.login"属于已登记但描述有误。

### MP-04｜P2｜正确性 / 用户体验（支付结果处理）
- **位置**：
  - pages/pay/index.js:87-115、:144-151
  - utils/error-text.js:21-27
- **问题**：
  1. `requestPayment` 没有 `success` 回调，付款成功后停在支付页，通道仍然可点。
  2. 取消或失败时文案显示"加载失败"：`errorMessage` 只读 `message`，而宿主返回的是 `errMsg`。
  3. 支付页不检查订单状态，已付、已关单的订单照样列出通道。
- **证据**：
  ```js
  wxApi.requestPayment({
    ...plan.params,
    fail: (err) => this.setData({ error: errorMessage(err) }),
  });
  ```
  探针：`errorMessage({errMsg:'requestPayment:fail cancel'})` 返回 `"加载失败"`。
- **触发场景与后果**：
  - 微信支付成功后页面毫无变化，用户再点一次会得到 40902。
  - 用户取消支付时看到"加载失败"，会以为系统坏了。
  - auto（审核期）模式显示"支付已完成"，但通道列表仍在。
  - 从返回栈回到一张已付订单的支付页，通道仍然显示。
- **解决方案**：
  1. `success` 回调里 `redirectTo('/pages/order-detail/index?id=…')`。
  2. `fail` 统一显示"支付未完成，可重新选择支付方式"（不解析 cancel 文案）。
  3. error-text 增加兜底：`errMsg` 为字符串时用它。
  4. 新建 pay vm `payPageView(order, listings)`：`!canPay(order.status)` 时隐藏通道并显示状态文案。
  5. 补单测。
- **置信度**：已探针证实（文案部分）；其余已读代码证实。
- **是否已登记**：新发现。

### MP-05｜P2｜并发 / 状态（首页响应乱序）
- **位置**：pages/home/index.js:164-184、:187-210、:217-230
- **问题**：`reload` 和 `loadMore` 不丢弃过期响应。代码注释里写着要防的"切到食品却看到厨刀"，实际会发生。
- **证据**：
  ```js
  const res = await this.fetch(listQuery({ page: 1, category, keyword: this.data.keyword }), traceId);
  this.apply(res, { reset: true, page: 1 });   // 无 "traceId 仍是当前链" 判断
  ```
  探针输出：`选中 tab: food | 列表: ['厨刀'] | total: 99`
- **触发场景与后果**：
  - 用户快速点"厨房"再点"食品"，厨房的响应后到，食品 tab 下显示厨刀。
  - 这时 `total` 也被污染成厨房的 99，触底会拉"食品第 2 页"并追加进来，列表混杂两个分类。
  - 搜索回车（`bindconfirm` 不受 ws-button 的 loading 保护）同理。
- **解决方案**：
  1. `reload` / `loadMore` 开头捕获本次的 `traceId`（或 `++this.seq`），`await` 之后如果 `this.traceId !== 捕获值` 就直接 return。
  2. 判断逻辑抽成 vm `isStale(current, issued)` 并补单测。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### MP-06｜P2｜并发 / 显示金额错误（购物车报价乱序）
- **位置**：
  - pages/cart/index.js:82-95、:98-122、:42
  - pages/cart/index.wxml:58-66
- **问题**：
  1. 报价不做序号校验，旧报价后到会覆盖新报价。
  2. 改完数量到新报价回来之前，旧合计还在显示，"去结算"仍可点。
  3. 购物车清空时不清防抖定时器。
  4. 报价失败时提示仍是"运费与合计还在计算中"。
- **证据**：
  ```js
  const res = await app.globalData.api({ … data: { items: app.globalData.cart.toOrderItems() } … });
  this.setData({ quote: quoteView(res) });
  ```
  探针输出：`行数量: 2 | 显示合计: 1500 | 去结算可点: true`（1500 是数量为 1 时的合计）
- **触发场景与后果**：弱网下连续点"+"，显示的合计与数量对不上。结算页会重新报价，所以不会直接扣错金额，但用户看到的价格是错的。
- **解决方案**：
  1. 加序号校验，丢弃过期报价。
  2. `refresh()` 时把报价标记为过期（或置为 null），过期期间"去结算"禁用。
  3. 购物车为空时 `clearTimeout`。
  4. 提示文案由 vm 按 `quoteError` 给出。
  5. 补单测。
- **置信度**：已探针证实。
- **是否已登记**：新发现。

### MP-07｜P2｜错误码映射（结算页不执行登记表里的 action，用户卡死）
- **位置**：
  - pages/checkout/index.js:224-226、:79-100
  - packages/shared/src/errors.ts：40905「提示刷新确认页」、40011「刷新页面重新加载条款后下单」、40901「提示并刷新」
- **问题**：建单失败时只设置 `error`，不重新报价、不重新拉条款。`refresh()` 开头也不清空旧的 `error`。
- **证据**：
  ```js
  } catch (e) {
    this.setData({ error: errorMessage(e) });
  }
  ```
- **触发场景与后果**：
  - 管理员改价后，用户提交得到 40905。页面仍显示旧合计，再点提交还是带旧的 `expected_total_jpy`，一直 40905，只能退出页面重进。
  - 条款升级后是 40011，同样卡死。
  - 刷新成功后，旧的错误条仍然挂在页面上。
- **解决方案**：
  1. 新增 vm `recoveryFor(code)`：40905 / 40901 / 40401 → 重新报价（并作废幂等键）；40011 → 重新拉条款并把 `termsAccepted` 置 false。
  2. 薄壳按返回的意图执行。
  3. `refresh()` 开头清空 `error`。
  4. 补单测。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-08｜P2｜文案与闸门（split_hint 语义写反，且放行一个必然失败的提交）
- **位置**：
  - utils/quote-view.js:49-51
  - pages/checkout/index.vm.js:42-54
  - server/src/domain/quote.ts:179
  - server/src/app/create-order.ts:172
- **问题**：
  - 服务端 `splitHint = totalJpy > maxOrderJpy` 表示"已经超过上限"，建单必然 40906。
  - 前端文案却是"接近…建议拆成两单"。
  - 购物车和结算页的闸门都照常放行提交。
- **证据**：
  ```js
  if (q.split_hint === true) {
    hints.push('单笔金额接近出口申报上限，建议拆成两单');
  }
  ```
- **触发场景与后果**：
  - 合计超过 MAX_ORDER_JPY 时，用户看到的是"建议"，点提交必然得到 40906。
  - "为规避申报而拆单"的措辞也有审核和合规上的敏感性。
- **解决方案**：
  1. 文案改为"已超过单笔上限，请分两单下单"（不提"申报"）。
  2. `submitGate` 增加 `splitRequired` 原因；购物车"去结算"同样禁用。
  3. 补单测。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-09｜P2｜主路径可用性（整车报价失败时无法定位是哪件商品）
- **位置**：
  - server/src/domain/quote.ts:119-134
  - server/src/errors.ts:66-68（错误体只有 `{code, message}`）
  - utils/cart-store.js:141-154
  - pages/cart/index.js:117-118
- **问题**：
  - 以下任一情况都会让整车报价失败：一件商品下架（40401）、库存不足（40901）、同一 product_id 重复（40001）、超过 50 行（40001）。
  - 错误响应里没有 product_id，购物车页只显示"40401 商品不存在或已下架"。
  - `normalize` 不做去重，`add` 也不限制行数。
- **证据**：
  ```js
  if (p === undefined) throw new AppError(40401, { product_id: item.productId });
  ```
  product_id 只进了 `ctx`，不进响应体。
- **触发场景与后果**：一件商品下架后，所有购物车里有它的用户都无法结算，也不知道该删哪件。本地存储出现重复条目时，报价会永久 40001。
- **解决方案**：
  1. 契约 Err 增加可选 `data.product_id`（40401 / 40901 使用，跨分片改动）。
  2. request.js 透传 `body.data`，购物车 vm 据此标红对应行。
  3. `normalize` 按 productId 合并数量。
  4. `add` 超过 50 行时拒绝并提示。
  5. 补单测。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-10｜P3｜可靠性（在途守卫缺失，逃出了"防线只在 ws-button"这条机制）
- **位置**：
  - pages/address-edit/index.js:110-117 + index.wxml:116-121
  - pages/pay/index.wxml:35-41 + index.js:118-123
  - page-button-guard.unit.test.ts（只扫描原生 `<button>`）
- **问题**：
  - 地址编辑页只传了 `disabled="{{saving}}"`，没有 `loading`，`onSave` 本身也不设防。`POST /addresses` 没有幂等，连点会建出两条相同地址。
  - 支付页通道行是 `<view bindtap>`，没有任何在途守卫。
- **触发场景与后果**：
  - 出现重复地址。
  - 连点银行卡通道会发出两次支付请求，第二次会轮换 token。如果响应乱序到达，复制到的可能是已经失效的链接（40102）。
- **解决方案**：
  1. 地址编辑页改用 `loading="{{saving}}"`。
  2. 支付页 `onPay` 开头加 `if (this.data.paying) return;`（守卫测试只匹配 `loading`，这里不冲突），或者把通道行改成 ws-button。
  3. 守卫测试扩展为：页面里触发写请求的 `bindtap` 必须挂在 ws-button 上。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-11｜P3｜表单与服务端一致性
- **位置**：
  - utils/address-form.js:106-146
  - pages/address-edit/index.wxml 中的 7 个 `<input>`
  - pages/address/index.js:130-147
- **问题**：
  - 前端不校验长度，服务端限制是 recipient / city ≤100、line1 / line2 ≤200。
  - `<input>` 默认 `maxlength` 为 140（已查官方文档）。结果：recipient / city 在 101–140 字符时得到泛化的 "40001 参数缺失或格式错误"；line1 / line2 超过 140 字符时被静默截断。
  - "设为默认"会用 `toAddressInput` 把 `country` 强制写成 'US'。
- **解决方案**：
  1. `ADDRESS_LIMITS` 与服务端 LEN 做双向比对，写入 `formErrors`。
  2. wxml 显式设置 `maxlength`。
  3. 设默认地址时保留原 `country`。
- **置信度**：已读代码 + 官方文档证实。
- **是否已登记**：新发现。

### MP-12｜P3｜约束四（写死货币、通道、国家）
- **位置**：
  - utils/pay-plan.js:101-102（copylink 文案写死"银行卡…由 Stripe 托管页完成"）、:133、:153、:176-191
  - pages/pay/index.js:103
- **问题**：
  - 币种 'JPY' / 'USD' 写死；非 JPY 一律当 USD 处理展示。
  - copylink 引导文案写死了机构名（Stripe）和支付方式名（银行卡）。
  - 通道过滤用常量 `ADDRESS_COUNTRY_DEFAULT`，而服务端判定用的是订单的 `dest_country`（pay-intent.ts listedFor）。
- **后果**：新增一个 copylink 通道或第二个国家时，文案和扣款币种会静默出错。
- **解决方案**：
  1. ChannelView 下发 `charge_currency` 和引导文案 key（契约变更）。
  2. 国家取 `order.address.country`。
- **置信度**：已读代码证实。
- **是否已登记**：代码里自注了 @limitation，但不在公共欠账清单中；AJ-180 的新代码违反了 CLAUDE.md"新代码不得以现状写死为由"。

### MP-13｜P3｜§14.2 提示条的准确性
- **位置**：
  - utils/pay-plan.js:220-226
  - utils/pay-plan.js:182 / :189
- **问题**：
  - 关单时长按 `expires_at − created_at` 计算，是全时长而不是剩余时长。从订单列表"继续支付"进来时，距到期只剩 2 分钟，提示仍写"30 分钟内"。
  - 缺 display.USD 时文案是"金额以支付页为准"，但这句话本身就显示在支付页上。
- **解决方案**：
  1. 改写为"请在 {expires_at 的 JST 时刻} 前完成支付"（`jstDateTime` 是纯函数，不需要读时钟）。
  2. 缺金额时改为"金额以支付平台页面为准"。
- **置信度**：已读代码证实。
- **是否已登记**：倒计时缺失已登记，但登记描述没有覆盖"提示条给出错误剩余时长"这一点。

### MP-14｜P3｜约束十一（薄壳里漏了逻辑）/ 高风险分支无测试
- **位置**：
  - checkout/index.js:118-137（MP-02 的 bug 就在这里）、:197-229
  - pay/index.js:87-160（金额判空、逐币种循环、按 plan.kind 分派）
  - cart/index.js:138-146
  - address-edit/index.js:95-103
- **问题**：这几段判断逻辑都没有单测覆盖。结算页和支付页（建单、发起支付、幂等键）在页面层是零测试。
- **解决方案**：
  1. 为 checkout 补选址和错误恢复的 vm 函数。
  2. pay 新建 `index.vm.js`（vm-guard 会强制要求配套测试）。
  3. 或者引入本次探针的 stub harness，作为页面级测试。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-15｜P3｜可靠性（登录链）
- **位置**：
  - utils/auth-session.js:13-16、:34-45
  - utils/request.js:103-121
  - app.js:95-101
  - pages/user/index.vm.js:53-56
- **问题**：
  1. `wx.login` 没有超时，而 single-flight 共享同一个 Promise。一次挂起后，之后所有触发 40101 的请求都会永久挂起，直到重启小程序。注释只写了"登录按钮转了没反应"，低估了影响。
  2. 启动时的自动登录绕开了 single-flight：冷启动时若很快进入受保护页面，会发出两次 `wx.login` + 两次 login 请求。服务端 ON CONFLICT 保证安全，这里只是浪费。
  3. 自动登录失败后，「我的」页永远显示"正在登录…"，因为该页自身不发受保护请求。
- **解决方案**：
  1. 给 `wx.login` 加一个可注入时钟的超时（比如 8 秒）后 reject。
  2. app.js 启动登录改走 requester 暴露的 `ensureRelogin`。
  3. loginState 增加失败态。
- **置信度**：已读代码证实。
- **是否已登记**：已登记但描述有误（auth-session @limitation 一低估了影响）。

### MP-16｜P3｜导航栈
- **位置**：
  - checkout/index.js:223（用 navigateTo 进支付页）
  - pay/index.js:174-176
  - order-detail/index.js:84-86
  - order/index.js:88-92
- **问题**：
  - 付款后按返回，会回到"购物车是空的"那个结算页。
  - 从订单详情进入支付页再点"查看订单"，栈里会叠两层订单列表。
  - "继续支付"用 ws-button 但没有 loading，连点会压入两个支付页。
- **解决方案**：
  1. 结算页建单成功后用 `redirectTo` 进支付页。
  2. 支付页"查看订单"改为跳订单详情，或用 `navigateBack`。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-17｜P3｜法务与条款
- **位置**：
  - pages/legal/index.vm.js:53-68
  - checkout/index.js:109、:51-52
- **问题**：
  - vm 不校验链接是否为绝对 https URL。服务端现在返回占位相对路径（如 `/legal/terms.zh.html`），页面照样显示"复制链接"。vm 文件头宣称要防的正是"复制走一个打不开的地址"。
  - 条款版本变化时，已勾选的"同意"不会重置。
- **解决方案**：
  1. `termsView` 只保留 `^https://` 开头的链接。
  2. 结算页在 `termsVersion` 变化时把 `termsAccepted` 置 false。
- **置信度**：已读代码证实。
- **是否已登记**：服务端占位路径已登记；前端缺校验是新发现。

### MP-18｜P3｜健壮性与性能
- **位置**：
  - utils/cart-store.js:75-96
  - pages/detail/index.js:87-100
  - pages/home/index.js:217-229
- **问题**：
  - `add` / `setQty` 先改内存再 `persist`。持久化抛错时内存与存储不一致，异常冒到页面 handler，加购没有任何反馈。
  - 首页每次触底都把整个 `cards` 数组全量 setData。
- **解决方案**：
  1. 用副本计算，`persist` 成功后再提交到内存；页面 catch 后提示。
  2. 追加时用 `this.setData({[`cards[${i}]`]: …})` 这种路径式写法。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-19｜P3｜注释与实现不符、死字段（合并一条）
- **位置与问题**：
  - detail/index.js:11-13、detail/index.wxml:4-6、:46-47：写着"没有加购按钮 / 结算页未落地"，实际两者都在。
  - pay/index.js:17-18 @limitation 二：写着"查看订单禁用、pages/order 未落地"，实际都已可用。
  - pay-plan.js:4-6、checkout/index.vm.js:11-13：宣称"确认页预取通道"，结算页根本没有 import pay-plan。
  - ws-price/index.js:54：写"含税价可带小数，四舍五入"，与 price-format @limitation 二（非整数抛错）相反。
  - address/index.vm.js:9-10 提到的 `data.pickedId` 不存在。
  - address-edit 里的 `first`（注释说"顶部一行显示"）和 `editing` 在 wxml 里都没有渲染。
  - idem-key.js:8-11 说"两处复用 this.idemKey"，见 MP-01。
  - price-format.js:39-42 引用 D-36 口径"≈ 人民币 ¥176"，实现（:126-131）输出的是 `≈ ¥176.00`，丢掉了"人民币"标注。
  - pages/index 写着"下单页落地后整体删除"，下单页已落地，它还在。
  - `payGuide.actionText`、order vm 的 `totalText` 在 wxml 里都没有使用。
  - wx-api.ts @limitation 十提到的"重新支付"按钮不存在。
- **解决方案**：逐条改注释，或者删掉死字段；D-36 的标注按口径补回"人民币"（并同步改单测）。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### MP-20｜P3｜trace 口径
- **位置**：checkout / pay / cart 的 `traceId`（在 onLoad 里生成一次）
- **问题**：同一页面实例的多次提交、多次 onShow 刷新全部共用一条 trace。这与首页"每次操作开一条新链"的口径不一致，多次提交在日志里分不开。
- **解决方案**：每次提交（onSubmit / onPay）生成新的 traceId。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

## 3. 看过但不是问题的疑点

- **40101 死循环**：重放只做一次、不递归。登录专用请求器没有配 relogin；single-flight 成功和失败都会清掉句柄。登录不会 bump token_ver（wechat-login.ts:80），不会出现 token 倒退。首次登录并发由 `on conflict (openid) do nothing` 保证安全。
- **重放复用同一 trace 与幂等键**：首次请求被鉴权拦下时 handler 并未执行，重放是安全的。
- **邮箱校验**：与服务端 order-routes.ts:81-83 完全一致（有 @、无空白、≤255）。
- **地址正则**：五条 pattern 与 server/domain/address-input.ts 一致；前端先 trim 再发送。
- **支付页美元金额**：`order.display.USD`（order-views.ts 按 fx_snapshot → toMinor 计算）与 pay-intent.ts:105 的实扣算法相同。币种顺序 JPY → USD 也与 resolveCharge 一致。
- **`/pay/channels`**：`listAvailable` 是纯函数，只会因参数错误返回 400，逐币种串行查询不会因服务端而中断。
- **支付页连点**：服务端 `lockOwnedOrderForPay` 锁单，同一通道复用意图，不会产生重复支付意图（残余影响见 MP-10）。
- **导航与页面登记**：所有 navigateTo / redirectTo 的目标都在 app.json 中登记；pages/index 和 pages/comp 既未登记，也已被 packOptions 排除打包；sitemap 已 disallow 全部私有页面。
- **wxml 绑定**：11 个页面的 wxml 绑定字段与 vm 输出字段逐一核对，没有拼错的字段。
- **价格格式**：円 / $ / ¥ 在各页面都分别走 formatJpy / formatUsdCents / formatCnyFen，没有混用（D-36 标注问题见 MP-19）。
- **已登记欠账，不重复报**：
  - 订单详情关税在无法估算时显示 0 円（裁决⑯）；
  - `GET /orders` 没有分页（服务端 @limitation）；
  - 条款 URL 是占位相对路径（服务端已登记）；
  - `API_BASE=localhost` 与 `touristappid`（config.js @limitation，F14）；
  - "离开微信"文案是 §14.2 的强制要求（AJ-180）；
  - 审核期"测试单"文案（AJ-179）。
- **ID 形状**：trace_id `mp-`+20 位落在服务端 `^[A-Za-z0-9._:-]{8,64}$` 之内；幂等键 `idem-[a-z0-9]+` 小于等于 128 且不含 `:`。
- **本地存储**：统一 `ws:` 前缀；损坏的 JSON 由 cart-store 的 `normalize` 降级处理，启动不会崩溃（重复条目问题见 MP-09）。
