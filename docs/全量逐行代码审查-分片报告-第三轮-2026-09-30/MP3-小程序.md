# MP 分片（微信小程序）逐行审查报告：第三轮（2026-09-30，HEAD 50d490b）

## 0. 范围、方法与证据

- **范围**：`miniprogram/**` 全部非测试文件（app.js / config.js / app.json / project.config.json / sitemap.json；utils 17 个；components ws-button / ws-price；已登记的 11 个页面，每页的 js / vm / wxml / json；wxss 只略读，找写死的颜色和尺寸，结果一处也没有）。测试读了三份 `*.shell.unit.test.ts`、pay 和 checkout 的 vm 测试、`nav-param-guard` / `review-wording-guard` / `page-button-guard`，另读了 `test/helpers/mp-page.ts`、`test/helpers/fake-wx-request.ts`。退役页 `pages/index`、样板页 `pages/comp` 没有登记在 app.json 里，而且被 packOptions 忽略，所以只扫了一眼。
- **对照**：`contracts/api-contract.yaml` 0.6.16（错误码登记表、`/orders*`、`/pay*` 的请求和响应形状）、`packages/shared/src/errors.ts`（新码 40912 / 40913 的 action）；服务端读了 `app/pay-intent.ts` 文件头（换通道的语义）、`app/cancel-order.ts`（取消时不查机构）、`app/order-views.ts`（display 按订单快照算）。
- **上轮基线**：`docs/全量逐行代码审查报告-第二轮-2026-09-30.md` §六，以及分片 `docs/全量逐行代码审查-分片报告-2026-09-30/MP.md`（MP2-01～14）。另核了修复提交 `69c95d7` 的 miniprogram diff。
- **探针**（都在 `scratchpad/round3/probes/`，用独立的 vitest 配置跑真实的页面薄壳，宿主是 `test/helpers/mp-page.ts`）：
  - `p1-closedtext.mjs`：打印支付页关单文案和订单详情的截止时刻文案。
  - `p2-pay-inapp.unit.test.ts`：先点银行卡、再点微信支付，看页面剩下什么。
  - `p3-checkout-requote.unit.test.ts`：40905 之后、新报价回来之前再点提交，看请求体。
  - `p4-pay-auto.unit.test.ts`：审核期 auto 之后，看页面剩下什么。
- **存量测试**：`npx vitest run --project unit` 全量 unit，134 个文件、1913 条，全部通过。没有跑 db / e2e / gate，没有改仓库里的任何文件。
- **证据等级**：【实测】= 探针跑出来的真实输出；【读码确认】= 逐行读代码后确认；【推断】= 依赖平台时序或行为、没有实测的部分（会写明依赖哪一点）。

---

## 1. 发现

### P0 / P1

无。

### MP3-01【P2】支付页关单屏对"已超时关闭 / 已取消"也写"无需再支付"：用户会以为已经付过款

- **位置**：`miniprogram/pages/pay/index.vm.js:50-56`（`payPageView` 的 closedText 模板），消费方是 `pages/pay/index.js:128-132`（load）和 `:190-191`（checkStatus，AJ-227 新增）。
- **问题**：模板对所有不可付的状态一律写 `该订单${statusText}，无需再支付`。"无需再支付"只对已付款、已发货、已送达、已完成成立。对 expired / cancelled，用户需要的是重新下单；对 refunding / refunded，这句话也不对题。AJ-227 新加了"copylink 屏回到前台只查状态"这条路径，让这句话在银行卡主路径上成了必经的一屏。
- **触发场景**：用户点「银行卡」，复制链接，到浏览器里填卡、被 3DS 或输错卡号耽搁，超过 30 分钟后切回微信。`onShow` → `checkStatus` → 订单已是 expired，页面收起支付方式和短链，只剩「该订单已超时关闭，无需再支付」。很大一部分用户会把这句读成"已经付好了"，然后去等一张永远不会发货的单。而这一屏是微信支付上线前唯一的付款路径。
- **证据【实测】**（`p1-closedtext.mjs` 的输出）：
  ```
  expired => 该订单已超时关闭，无需再支付
  cancelled => 该订单已取消，无需再支付
  refunding => 该订单退款中，无需再支付
  ```
  `pay/index.vm.unit.test.ts:171` 只钉了 paid 包含"已付款"；另外几态只断言"不含原词、非空"，所以这个错误的尾句是绿的。
- **修复**：closedText 按类分文案，由 vm 给出。
  - paid / shipped / delivered / completed："该订单{状态}，无需再支付"。
  - expired / cancelled："该订单{状态}，未完成付款；如需购买请重新下单"。
  - refunding / refunded："该订单{状态}"。
  - expired 那一屏再给一个"回首页 / 回购物车"的意图（跳转由薄壳执行）。
- **应补测试（先红）**：`pay/index.vm.unit.test.ts` 增加 `for (const s of ['expired','cancelled','refunding','refunded']) expect(payPageView({status:s}).closedText).not.toContain('无需再支付')`，现状会红 4 条；再加 `expect(payPageView({status:'expired'}).closedText).toContain('重新下单')`。

### MP3-02【P2】订单截止时刻和时间线按 JST 显示，但没有任何时区标注：美国买家会把"请在 22:30 前完成支付"读成本地时间

- **位置**：`miniprogram/utils/jst-text.js:56-75`（输出 `YYYY-MM-DD HH:mm`，不带时区）；`pages/order-detail/index.vm.js:114-116`（`createdAtText` / `expiresAtText`）、`:85-90`（时间线）；`pages/order-detail/index.wxml:27-28`（"请在 {{expiresAtText}} 前完成支付"）。
- **问题**：AJ-165 ④ 选定"买家侧也显示 JST"是已入档的决策，本条不挑战它。问题在于展示串里没有 "JST" 或"日本时间"字样，而收货人是美国地址的用户。决策记录只写了"北美本地化是另一个单元"，没有登记"不标时区会被误读"这个后果。
- **触发场景**：加州用户在 PDT 9/30 06:00（= JST 22:00）下单，订单 30 分钟后到期（JST 22:30 = PDT 06:30）。详情页写"请在 2026-09-30 22:30 前完成支付"，用户以为自己有 16 个小时，晚上回来付款时订单早已超时关闭（再叠加 MP3-01，支付页还会对他说"无需再支付"）。时间线上的"已发货 2026-10-02 09:10"也会被读错将近一天。
- **证据【实测】**：`detailView({status:'pending_payment', expires_at:'2026-09-30T13:30:00.000Z', ...}).expiresAtText` 输出 `2026-09-30 22:30`，不带时区后缀。
- **修复**（不动 AJ-165 的口径，只改展示）：`jstDateTime` 的输出统一带后缀，例如 `2026-09-30 22:30（日本时间）`；或者新增 `jstDateTimeLabeled` 给买家页面用。截止时刻这一行更好的写法是由 vm 给出"剩余约 N 分钟"（用 `expires_at − created_at`，不读时钟；从订单列表"继续支付"进来的情形见 MP-13）。改动后要在 `docs/自主决策记录.md` 的 AJ-165 条目里补一句反向风险。
- **应补测试（先红）**：`order-detail/index.vm.unit.test.ts` 增加 `expect(detailView(pendingOrder).expiresAtText).toMatch(/日本时间|JST/)`，时间线行同理，现状会红。

### MP3-03【P2】在银行卡屏改点微信支付：旧短链和"复制链接"原样挂着，而服务端已经作废了那个银行卡意图（AJ-227 只修了一半）

- **位置**：`miniprogram/pages/pay/index.js:234-256`（`run()` 的 in_app 分支直接 `return`，不碰 `payUrl` / `guide` / `copied`）；对照 `:264-265`（auto / unsupported 分支会清）。服务端语义见 `server/src/app/pay-intent.ts:38-41`：换通道时作废我方的旧支付行，旧短链随之失效。
- **问题**：上轮 MP2-01 的修复方案原文是"in_app / unsupported 分支同时把 payUrl 清空"，实际只改了 unsupported 和 auto 两个分支，in_app 分支漏了。
- **触发场景**（微信支付 R1 上线后，两个通道并存）：点「银行卡」，出现短链和「复制链接」。用户改主意点「微信支付」：`retireKey` → 新键 → 服务端作废 Stripe 行 → `requestPayment` 拉起。用户在微信收银台点取消，回到支付页后看到的仍是"请在浏览器中完成支付"、那条短链和「复制链接」按钮。他复制那条链接去浏览器，落地是失效页（40102）。还有一种更糟的情况：浏览器里早先打开的托管页还开着（pay-intent 的 @limitation 一写明"旧托管页仍可付"），用户在那里付款，同时又在微信里付了一次，其中一笔会作为迟到款进入人工退款。另外 `onShowAction` 看到 `payUrl` 非空，只会做 status 回查，不会整页重取，这个陈旧的屏幕会一直留着。
- **证据【实测】**（`p2-pay-inapp.unit.test.ts` 的输出）：
  ```
  requestPayment calls 1 | payUrl= https://x/pay/link/o1?t=OLD | guide= {"title":"请在浏览器中完成支付", ...}
  ```
- **修复**：in_app 分支在调 `requestPayment` 之前先 `setData({ payUrl: '', guide: { ...EMPTY_GUIDE }, copied: false })`。更稳的做法是把 `run()` 的三个分支收成 vm 的 `afterIntent(plan)`，返回完整的 setData 形状，让每个分支都显式给出 payUrl、guide、copied 三个键。
- **应补测试（先红）**：`pay/index.shell.unit.test.ts` 增加用例：先 stripe 再 wechat，断言 `page.data.payUrl === ''` 且 `page.data.guide.title === ''`，现状会红。再在 vm 层增加 `afterIntent({kind:'in_app'})` 必须含 `payUrl: ''` 的断言。

### MP3-04【P2】付款后、回调到达前的窗口里，落地的订单详情和订单列表仍给出"取消订单 / 继续支付"：取消会把已经扣款的单关掉，转入人工退款

- **位置**：
  - `pages/pay/index.js:246-249`：微信支付 success 后立即 `redirectTo` 订单详情。
  - `pages/pay/index.js:184-195`：copylink 回到前台只做一次 `checkStatus`。
  - `pages/order-detail/index.vm.js:100,113`：`canPay` / `canCancel` 只看 status。
  - `pages/order-detail/index.wxml:97-105`；`pages/order/index.wxml:36-38`。
  - 服务端 `app/cancel-order.ts` @limitation 一：取消 pending_payment 时只作废我方 initiated 行，不向机构核实；之后回调到达会判成 late_payment，转对账和人工退款。
- **问题**：本页"不做结论、真值看服务端回调"的口径没有错，但落地页把"回调还没到"呈现成了一个可以取消的待付款单。AJ-227 的状态回查只查一次，回调晚于用户切回的那一刻，这次回查就等于没做。
- **触发场景**：
  - **银行卡**：浏览器里付完款，数秒内切回微信 → `checkStatus` 仍是 pending_payment → 页面不变。用户点「查看订单」，看到"付款中"、「继续支付」和「取消订单」，以为没付上，于是点「取消订单」→ 服务端迁到 cancelled 并回补库存。Stripe 回调随后到达 → late_payment → 人工退款，商品可能已经被别人买走。
  - **微信支付**（R1）：success 回调后立刻 `redirectTo` 详情页，此时通知可能还没到，结果同上。
- **证据**：前端部分【读码确认】（行号见上）；"回调晚于用户回到页面"【推断】（Stripe / 微信的回调延迟通常是秒级，但没有上限）；服务端取消不查机构【读码确认】。
- **修复**（二选一，都只动前端）：
  1. 支付页 success 和 copylink 回前台时，带一个一次性提示去详情页（例如 `?id=…&justPaid=1`）。详情页在 `justPaid` 且状态仍可付时，隐藏「取消订单」，显示"支付结果确认中，请稍后刷新"，由 vm 产出。
  2. vm 的 `canCancel` 增加输入"刚从支付页过来"，由薄壳传入，并在 onShow 时退避重查一次（重查要用 `setTimeout`，放在薄壳里）。

  服务端的根治（取消前向机构查一次会话状态）属于 PAY 分片，这里只登记。
- **应补测试（先红）**：`order-detail/index.vm.unit.test.ts` 增加 `expect(detailView(pending, { justPaid: true }).canCancel).toBe(false)`，现状 vm 不接收第二个参数，这条会红。再增加一份 order-detail 薄壳用例：`onLoad({id:'o1', justPaid:'1'})` 之后 `view.canCancel === false`。

### MP3-05【P3】40905 恢复路径：新报价回来之前，闸门以旧合计放行，再点一次必然再吃一次 40905（MP2-04 的后半没修）

- **位置**：`pages/checkout/index.js:296-300`（requote 分支调 `refresh({keepError:true})`）、`:110-118`（refresh 一开始就调 `updateGate()`，此时 `quote` 仍是旧值）；`index.vm.js:58`（闸门只看 `totalJpy` 是不是整数）。
- **问题**：上轮 MP2-04 的修复方案有两半，前一半是"删掉手写闸门、统一走 updateGate"，已经做了；后一半是"需要重报价时先 `setData({ quote: null })`"，没有做。
- **触发场景**：管理员改价后，用户点提交 → 40905，错误条出现，重报价在途 → 按钮仍然可点（submitting 已在 finally 里复位）→ 用户再点 → 请求体与上次相同，`keyAction` 返回 reuse，拿到的是 retire 之后的新键 → 仍带旧的 `expected_total_jpy` → 又一次 40905，又一次 refresh。弱网下可以循环多轮。钱不会错，但用户会被同一个错误反复弹回。
- **证据【实测】**（`p3-checkout-requote.unit.test.ts` 的输出）：
  ```
  gate after 40905, requote in flight: {"ok":true,"reason":""}
  posts expected_total: [ 9150, 9150 ]
  ```
- **修复**：requote 分支先 `this.setData({ quote: null, quoteFailed: false })` 再调 `refresh`，闸门会落到"运费与合计还在计算中"。
- **应补测试（先红）**：`checkout/index.shell.unit.test.ts` 增加用例：40905 后、报价 deferred 未兑现时，断言 `gate().ok === false`，再调 `onSubmit` 断言 `posts.length === 1`。现状两条都会红。

### MP3-06【P3】审核期 auto 之后，同一屏同时写着"支付已完成"和"支付前请确认…将以日元扣款 / 30 分钟内未支付将自动关闭"，通道按钮仍可点

- **位置**：`pages/pay/index.js:264-265`（auto 分支只设置 guide，不收起 `channels` / `notice`）；`utils/pay-plan.js:106-114`。
- **问题**：AJ-244 改掉了"审核期测试单"的措辞，但审核员实际看到的这一屏自相矛盾：顶部是"应付合计"、"支付前请确认"和"将以日元扣款 9,150 円"，中间是还能点的通道，下面是"支付已完成"。contract 0.6.11 ② 写明 auto=true 时响应返回的那一刻订单已经是 paid，也就是说 in_app 分支"成功后离开这一页"的理由同样适用于 auto。
- **触发场景**：审核员点「测试支付」，页面出现"支付已完成"，但支付方式和扣款提示原样还在。审核员再点一次，同键重放，页面什么也不变；如果他切后台再回来，才会变成"该订单已付款，无需再支付"。这种界面容易被当成"功能不完整"而驳回。
- **证据【实测】**（`p4-pay-auto.unit.test.ts` 的输出）：
  ```
  after auto: guide= 支付已完成 | channels= 1 | notice= ["测试支付：将以日元扣款 9,150 円","订单 30 分钟内未支付将自动关闭"]
  ```
  （探针里第二次点击的 40902 是桩写死的；真实服务端同键会重放，不会报错。）
- **修复**：auto 与 in_app success 同口径，直接 `redirectTo` 订单详情（`?id=`）；或者 `setData(closedScreen(...))` 再加上 guide。
- **应补测试（先红）**：pay 薄壳用例：auto 之后断言 `channels.length === 0 && notice.length === 0`，或者断言 `redirectTo` 被调用且 url 含 `order-detail/index?id=`。现状会红。

### MP3-07【P3】支付页整页重取没有序号，也不看在途：切前后台连续触发时旧响应可能盖回通道；微信收银台取消后，若平台触发 onShow，"支付未完成"会被抹掉

- **位置**：`pages/pay/index.js:118-156`（load 没有 seq、没有在途标志）、`:164-174`（onShow 每次都可能 reload）、`:253`（fail 回调设置 PAY_FAIL_TEXT）、`:120`（load 一开始就清 error）。
- **问题与场景**：
  1. 弱网下连续两次切前后台，会并发两个 load：A 的 GET 订单返回 pending，于是 `closedText: ''`，接着等通道列表；B 的 GET 返回 paid，于是 `closedScreen`；A 的通道列表后到，又把 channels 和 notice 写回去。结果是"该订单已付款"和可点的支付方式同屏。首页和购物车在 B36 里已经用 `request-seq` 修过同一类问题，支付页没有跟上。
  2. 调起微信支付时，页面会经历 onHide / onShow（平台行为）。取消后如果 `fail` 先于 `onShow` 执行，`onShowAction` 会返回 reload（in_app 不留 payUrl 和 guide），`load()` 开头的 `error: ''` 会把"支付未完成，可重新选择支付方式"清掉，用户看不到任何结果提示。
- **证据**：代码【读码确认】；"requestPayment 会触发页面 onHide / onShow，以及它与 fail 的先后顺序"【推断】，需要真机确认。
- **修复**：load 引入 `nextSeq` / `isStale`，与首页同一套写法；`onShowAction` 在 `loading === true` 时返回 none；PAY_FAIL_TEXT 改成放在独立的 `payResult` 字段里，不跟着 load 清空。
- **应补测试（先红）**：pay 薄壳用例：两个 deferred 的 load 交错兑现，旧的后到，断言 `channels.length === 0`。

### MP3-08【P3】首页「搜索」按钮在首屏或上一次搜索加载中会吞掉点击：新词不搜，列表仍是旧结果

- **位置**：`pages/home/index.wxml:22`（`loading="{{loading}}"` 接在搜索按钮上）；`components/ws-button/index.js:92`（loading 时静默 return）；对照 `pages/home/index.js:182-222`（B36 已经用序号保证"只有最后一次落地"）。
- **问题**：B36 之后，reload 本身就能安全并发，"最后一次赢"。按钮上的 loading 守卫反而阻止了"最后一次"被发出去，而且吞掉点击不给任何提示（ws-button @limitation 三）。
- **触发场景**：弱网冷启动，首屏"全部"还在加载，用户输入"資生堂"后点「搜索」，点击被吞。首屏返回后，列表是全部商品，输入框里却是"資生堂"，看起来像"搜索无效 / 搜不到"。键盘确认键走的是 `bindconfirm`，不受影响，所以两个入口的行为也不一致。
- **证据【读码确认】**。
- **修复**：去掉搜索按钮上的 `loading`（在途状态已经由列表区显示），让 reload 的序号来保证正确性。
- **应补测试（先红）**：`home/index.shell.unit.test.ts` 不渲染 wxml，所以加一条源码守卫：`<ws-button[^>]*bindtap="onSearch"` 标签里不得出现 `loading=`。现状会红。

### MP3-09【P3】报价的确定性失败被说成"请稍后重试"；40913 的"去订单列表"没有入口

- **位置**：`pages/cart/index.vm.js:67`（hasError 时提示"合计未能获取，请稍后重试"）；`pages/checkout/index.vm.js:147-154`（`recoveryFor` 不认 40912 / 40913）；`packages/shared/src/errors.ts` 中 40912 的 action 是"提示减少数量或分多单下单"，40913 的 action 是"引导去订单列表支付或取消已有订单"。
- **问题与场景**：
  1. 购物车加到超重（0.6.16 新码 40912），错误条写"40912 包裹超过可配送的重量上限，请拆单"，按钮下方却写"合计未能获取，请稍后重试"。两句话方向相反，重试永远不会好。下架商品（40401）同理，这一点与 B39 相关。
  2. 结算页提交得到 40913（在途单已达 3 张；本页 `keyAction` 的 @tradeoff 自己承认超时后改内容会多建一张待付单）。页面只显示文案，没有去订单列表的动作；用户得自己回首页 → 我的 → 我的订单 → 逐张进详情取消。
- **证据【读码确认】**。
- **修复**：`checkoutGate` 增加 `errorCode` 输入，40912 / 40401 / 40901 给"请调整数量或移除商品"，只有网络错误和 5xx 才说"稍后重试"；`recoveryFor(40913)` 返回 `'go_orders'`，薄壳跳 `/pages/order/index`，或者在错误条旁给一个入口。
- **应补测试（先红）**：`expect(checkoutGate({hasError:true, errorCode:40912}).hint).not.toContain('稍后重试')`；`expect(recoveryFor(40913)).toBe('go_orders')`。

### MP3-10【P3】结算页建单在途时，地址卡和"查看条款全文"仍然可点：建单成功后，支付页会压在地址选择页上面

- **位置**：`pages/checkout/index.wxml:25`（地址卡 `bindtap="onPickAddress"`）、`:79`；`index.js:224-238`（两个跳转不看 `submitting`）、`:289`（成功后不判断当前页是否在栈顶，直接 `navigateTo`）。
- **触发场景**：弱网下点提交（转圈），等不及又点了地址卡进入选择页，这时建单成功，`navigateTo` 支付页，栈变成 [购物车, 结算, 地址(选择), 支付]。用户从支付页返回，落在一张"为已下完的单选地址"的页面上；点"用这个地址"后，回到的是空购物车的结算页。
- **证据【读码确认】**。
- **修复**：`onPickAddress` / `onOpenTerms` 在 `submitting` 为 true 时 return。这不属于 AJ-74 禁止的"按钮连点守卫"，因为它挡的是非按钮的跳转；或者提交期间给地址卡加 `catchtap` 遮罩。
- **应补测试（先红）**：checkout 薄壳用例：建单 deferred 未兑现时调 `onPickAddress`，断言 `navigations` 为空。

### MP3-11【P3】小项合并

- `pages/checkout/index.wxml:73-74`：`termsFailed` 时，闸门已经写"购买条款暂时取不到"，但条款区仍写"条款版本加载中"（MP2-05 修复留下的残留），同一屏两种说法。【读码确认】
- `pages/pay/index.wxml:21-26`：关单屏（已付款或已关闭）仍显示「应付合计 9,150 円」，与 MP2-10 同类，对已付单来说标签是错的。【读码确认】
- `miniprogram/nav-param-guard.unit.test.ts:49`：`pageConsts` 只认形如 `'/pages/x/index'` 的常量。`checkout/index.js:50` 的 `ADDRESS_PICK_PAGE = '/pages/address/index?pick=1'` 把 query 写死在常量里，这个守卫看不见它：将来目标页把 `options.pick` 改名，守卫仍然全绿。当前两端一致，只是守卫有盲区。修复：扫描常量字面量里的 `?k=`，或者规定 query 只能在模板串里拼。【读码确认】
- `pages/pay/index.vm.js:104-148`：`payStartDecision` 的整段 JSDoc 仍然挂在 `copyResult` 前面，函数本体没有注释（MP2-08 的②未修）。【读码确认】

---

## 2. 上轮修复复核结论（本轮重点）

| 上轮项 | 本轮结论 |
|---|---|
| MP2-01 copylink 再点后 `copied` 复位（AJ-227） | copylink / auto / unsupported 分支已修；**in_app 分支漏清 payUrl 和 guide，见 MP3-03** |
| MP2-02 onShowAction / checkStatus / closedScreen（AJ-227） | 主路径成立；新引入了**关单文案误导（MP3-01）**；只查一次，回调延迟的窗口仍在（MP3-04）；load 没有序号（MP3-07） |
| MP2-03 审核文案（AJ-244） | "审核期 / 测试单 / 离开微信"已去掉并加了扫描守卫；auto 屏自相矛盾（MP3-06） |
| MP2-04 结算页闸门单入口 | 手写闸门已删；**requote 窗口仍放行（MP3-05，实测）** |
| MP2-05 termsFailed / quoteFailed | 闸门已修；wxml 残留"加载中"（MP3-11） |
| MP2-06 购物车防抖 400ms 窗口 | 仍存在（`cart/index.js:119-125` 没有预置 quoting 闸门） |
| MP2-07 拆单提示同屏两次 | 仍存在（`quote-view.js:54-60` 与 `cart/index.vm.js:70`、`checkout/index.vm.js:62`） |
| MP2-08 load 清错误 / JSDoc 错位 | ①已修；②仍存在（MP3-11） |
| MP2-09～MP2-14 | 仍存在（原编号），未逐条展开 |
| 首页 / 购物车序号（B36 / R-04） | 读码核过：reload 领号、loadMore 借号、过期请求不碰标志位，均成立；只有搜索按钮的 loading 与之冲突（MP3-08） |
| 结算页幂等键随请求体续期（AJ-228 keyAction） | 同键⇔同请求体的规则成立；40908 → renew 成立；已知的取舍（超时后改内容可能多建一张待付单）会叠加到 40913 上限（MP3-09②） |
| nav-param-guard | 对 `${PAGE}?k=` 形态有效；常量里写死的 query 是盲区（MP3-11） |
| 页面薄壳宿主 mp-page.ts | 可用，本轮 4 个探针都跑在它上面；限制是不支持数据路径 setData，所以 address-edit 的 `form.${field}` 无法用它测（已写在 @limitation 二） |

## 3. 统计

| 严重度 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 4 | MP3-01、MP3-02、MP3-03、MP3-04 |
| P3 | 7（MP3-11 内含 4 小项） | MP3-05～MP3-11 |

证据分布：实测 5 条（01、02、03、05、06）；读码确认 4 条（08、09、10、11）；读码加推断 2 条（04 的回调时序、07 的平台 onShow 时序）。

## 4. 上轮遗留状态（第二轮 §六，逐项一行）

| 项 | 状态 |
|---|---|
| `API_BASE` 写死 `http://localhost:3000`（`config.js:15`） | 仍存在 |
| AppID 是游客号 `touristappid`（`project.config.json:5`），`urlCheck:false` | 仍存在 |
| 条款链接为占位路径（服务端 `/terms` 的 urls） | 仍存在（前端照原样展示，可复制） |
| 无客服入口（`pages/user/index.wxml` 注释里写明"刻意没有"） | 仍存在 |
| 隐私指引须声明剪贴板：未接 `onNeedPrivacyAuthorization`，app.json 无隐私配置；三处 `setClipboardData` 都有 fail 兜底 | 仍存在（平台后台配置项） |
| MP2-03 支付页审核文案 | 部分修复（AJ-244）；新问题见 MP3-06 |
| B39 整车报价失败不知道是哪件商品 | 仍存在（B39） |
| B40 订单详情"预估关税 0 円" | 仍存在（B40，实测：`amountLines` 输出 `预估关税（含在商品价内） 0 円`） |
| MP-12 / MP-13 / MP-15 / MP-16 / MP-17 / MP-18 / MP-19 / MP-20 | 仍存在（原编号） |
