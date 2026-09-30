# MP 分片（微信小程序）逐行审查报告 — 第二轮（2026-09-30）

审查对象：工作区当前文件（HEAD=41d40ba + 未提交的 B37/B38 改动）。只读，未跑测试、未连库、未改仓库任何文件。
本轮新发现 **P1 0 条 / P2 3 条 / P3 11 条**，另列"平台提审核对清单"（不计入缺陷数，全部标疑似）。
行号说明：审查期间 `pages/pay/index.js` 被并行修复（R-03 / AJ-225，`?orderId=` → `?id=`，新增 3 行注释）改动过一次；本报告里该文件 **:222 之后的行号按修复前的 HEAD 版本标注，对照当前工作区请 +3**。该修复只改了参数名，不影响下面任何一条结论。
主会话已知的 5 个 MP 待修项（支付成功跳详情参数名、首页共用序号槽、结算页连点/40908/退出重进）本轮均在代码里再次看到，**按 BRIEF 不重复报**。

## 1. 覆盖清单（94 个非测试文件，7176 行，全部逐行读完）

| 文件 | 行数 | | 文件 | 行数 |
|---|---|---|---|---|
| app.js / app.json / app.wxss | 112 / 22 / 66 | | pages/home index.js / vm / wxml / wxss / json | 262 / 169 / 77 / 112 / 7 |
| config.js / project.config.json / sitemap.json | 15 / 54 / 41 | | pages/detail index.js / vm / wxml / wxss / json | 106 / 93 / 61 / 72 / 7 |
| components/ws-button js / json / wxml / wxss | 99 / 4 / 8 / 23 | | pages/cart index.js / vm / wxml / wxss / json | 211 / 73 / 71 / 85 / 7 |
| components/ws-price js / json / wxml / wxss | 95 / 4 / 1 / 23 | | pages/checkout index.js / vm / wxml / wxss / json | 283 / 172 / 89 / 76 / 7 |
| utils/request.js | 231 | | pages/pay index.js / vm / wxml / wxss / json | 270 / 133 / 79 / 45 / 7 |
| utils/wx-api.ts | 289 | | pages/order index.js / vm / wxml / wxss / json | 93 / 63 / 40 / 32 / 6 |
| utils/storage.ts | 94 | | pages/order-detail index.js / vm / wxml / wxss / json | 131 / 129 / 107 / 81 / 7 |
| utils/cart-store.js | 154 | | pages/address index.js / vm / wxml / wxss / json | 162 / 53 / 44 / 42 / 6 |
| utils/pay-plan.js | 228 | | pages/address-edit index.js / wxml / wxss / json | 148 / 123 / 32 / 6 |
| utils/address-form.js | 178 | | pages/legal index.js / vm / wxml / wxss / json | 114 / 95 / 46 / 44 / 3 |
| utils/price-format.js | 132 | | pages/user index.js / vm / wxml / wxss / json | 62 / 56 / 22 / 17 / 3 |
| utils/idempotency.js | 94 | | pages/index（已退役，未登记）js / wxml / wxss / json | 161 / 77 / 9 / 6 |
| utils/quote-view.js | 76 | | pages/comp（样板，未登记）js / wxml / wxss / json | 31 / 50 / 14 / 7 |
| utils/jst-text.js | 75 | | utils/auth-session.js | 71 |
| utils/order-status.js | 66 | | utils/request-seq.js | 50 |
| utils/random-id.js | 44 | | utils/placeholder.js | 40 |
| utils/error-text.js | 37 | | utils/trace.js | 25 |
| utils/wx-global.fixture.js | 29 | | assets/placeholder.png | 二进制，确认存在 |

为下结论读过的分片外文件：`server/src/app/pay-intent.ts`（copylink 复用/重放都轮换 token）、`server/src/adapters/idempotency.ts`（handler 抛错删占位行；40908/40903 条件）、`server/src/app/create-order.ts:157-166`、`server/src/domain/quote.ts:179`、`server/src/app/order-views.ts`、`server/src/app/address-routes.ts`、`order-query-routes.ts`、`packages/shared/src/errors.ts`；测试 `pay/index.vm.unit.test.ts`、checkout/cart/quote-view 三份未提交测试 diff；`git diff 848278d..HEAD -- miniprogram` 与工作区 diff。
上一轮原文 `docs/全量逐行代码审查-分片报告-2026-09-29/MP-微信小程序.md` 已读。

---

## 2. 发现

### P1
无新增（本分片现存的 P1 级问题即主会话已登记待修的"结算页连点/超时后 40908/退出重进建第二张单"）。

### P2

#### MP2-01｜P2｜银行卡（copylink）屏：再点一次通道后链接已被轮换，按钮却仍显示"已复制"——用户粘贴的是失效链接
- **位置**：`miniprogram/pages/pay/index.js:234-238`（run 的 copylink 分支）、`:252-259`（onCopy）；`pages/pay/index.wxml:43-53,68-74`；服务端 `server/src/app/pay-intent.ts:34,159-165,322-324`。
- **问题**：`run()` 每次拿到新 intent 只 `setData({ payUrl, guide })`，**不把 `copied` 复位**。而服务端对 copylink 的口径是"复用也轮换、幂等重放也轮换"（pay-intent.ts 文件头 @why 与 `reissuePayLink`）：同一张单每打一次 `POST /orders/{id}/pay`，上一条短链即失效。通道列表在引导屏出现后仍然可点（wxml:43 只看 `channels.length`）。
- **证据**：
  ```js
  if (plan.kind === 'copylink') {
    this.setData({ payUrl: plan.url, guide: payGuide(plan) });   // copied 不动
    return;
  }
  ```
  ```xml
  <ws-button text="{{copied ? '已复制' : '复制链接'}}" ... wx:if="{{payUrl}}" />
  ```
- **触发场景与后果**：点「银行卡」→ 点「复制链接」（copied=true，剪贴板=链接₁）→ 不确定是否成功/从浏览器回来后又点了一次「银行卡」（在途守卫只挡并发，不挡顺序点击；同键 → 服务端重放并**轮换 token**）→ 页面 payUrl=链接₂，按钮仍是"已复制"→ 用户去浏览器粘贴的是链接₁ → 落地页"链接已失效"。在 R1 微信支付上线前这是唯一付款路径，且页面明确告诉用户"已复制"。两个以上通道时 A→B→A 同样触发。不造成错扣，但会让人付不了款且无从自查。
- **修复**：`run()` 的每个分支都先 `setData({ copied: false })`（copylink 分支连同 payUrl 一起设；in_app / unsupported 分支同时把 `payUrl` 清空，避免"unsupported 引导屏 + 上一个通道的链接与复制按钮"并存）。抽成 vm `afterIntent(plan)` 返回完整 setData 形状并单测："第二次 copylink → copied 必为 false"。可选加固：引导屏出现后隐藏或禁用通道列表，只留"重新获取链接"。
- **置信度**：已读代码证实（前后端两侧）。
- **顺带**：`pay/index.js:22-26` @limitation 四写"两处会作废键：换通道与**支付已发起成功**"，实现里 `startPay` 成功后**没有** `retire()`（注释与实现不符；不 retire 本身无害——同键重放同样补发链接）。

#### MP2-02｜P2｜B35 的"回到支付页重新取数"恰好把银行卡路径排除在外：浏览器付完回来，通道与旧链接原样挂着；测试把它钉成了正确
- **位置**：`miniprogram/pages/pay/index.vm.js:64-79`（shouldRefreshOnShow）；`pages/pay/index.js:162-175`；`pages/pay/index.vm.unit.test.ts:194-196`。
- **问题**：`shouldRefreshOnShow` 的 @why 第一段说"用户去**浏览器**付完款再回来，只有重新取数才能把已付款显示出来——否则页面还挂着支付方式按钮，点了就是 40902"；紧接着的规则①却是 `payUrl !== ''` → 不刷新。去浏览器付款**只可能**发生在 copylink 屏（payUrl 非空），所以这条 @why 描述的场景永远走不到刷新。in_app 成功会 `redirectTo` 离开本页，auto/unsupported 也被规则②排除——`onShow` 刷新实际只在"微信支付取消/失败后"和"什么都没点"时生效。
- **证据**：
  ```js
  if (typeof a.payUrl === 'string' && a.payUrl !== '') return false;
  ```
  测试：`it('copylink 屏正在用 → 不刷新：刷掉短链等于把人回家的路拆了', …toBe(false))`。
- **触发场景与后果**：银行卡付款成功后切回微信：页面与离开时完全一样（通道可点、"复制链接"可点、无任何"已付款"提示）。再点通道 → `40902 订单状态不允许此操作`；用户在"支付"动作上看到错误码，第一反应是"刚才没付成功"——正是 B35 要消除的那个感受。真值只能靠用户自己点「查看订单」。不涉及重复扣款（Stripe 会话已完成）。
- **修复**：copylink 屏的 onShow 改为"**只重取订单、不动短链**"：`GET /orders/{id}` → `payPageView(order)`；不可付则清空 `channels/notice/payUrl/guide` 并显示 closedText（或直接 `redirectTo` 订单详情）；仍可付则什么都不改（短链保留）。vm 拆成 `onShowAction({payUrl,guideTitle,paying}) → 'reload' | 'recheck_order' | 'none'` 并改测试。
- **置信度**：已读代码证实。

#### MP2-03｜P2（疑似，需对照微信官方规范）｜支付页文案直接告诉审核员"本次为审核期测试单"，并明文引导"离开微信到浏览器付款"
- **位置**：`miniprogram/utils/pay-plan.js:100-111`（payGuide）、`:215-219`（payNotice）。
- **问题**：
  1. auto 分支文案 `本次为审核期测试单，无需真实付款。` 会在**提审版本**里呈现给审核员。平台对"审核期间与上线后功能/内容不一致、规避审核"有处罚口径；页面上自述"审核期"等于自证存在审核期专用逻辑。（REVIEW_MODE 是已登记决策 AJ-30/34/179，这里只针对**文案本身**。）
  2. `选择「${label}」将离开微信，复制链接后在 Safari / Chrome 等浏览器中完成支付` 与 `银行卡支付由 Stripe 托管页完成` 是明文"引导至外部支付"。实物类目不受虚拟支付规则约束，但《运营规范》对"引导用户使用非微信支付方式/诱导跳出"是否有限制、海外主体是否有豁免，**我没有可核对的原文**。
- **后果**：若命中，结果是提审被拒或上线后被处罚，返工成本在合规侧而不在代码侧。
- **要验证什么**：① 对照《微信小程序平台运营规范》"支付规范/行为规范"章节原文（项目文档引用的 §14.2），确认"复制链接到外部浏览器完成付款"对**海外主体、实物商品**是否允许；② 查"审核期与线上不一致"条款，确认 mock 通道 + 该文案是否构成规避审核；若保留 REVIEW_MODE，文案至少改成不含"审核期"的中性表述（如"本单为测试订单，无需付款"），并在提审说明里主动披露测试 SKU 路径。
- **修复**：文案下沉为服务端下发（与 MP-12 的"文案 key"合并处理），审核期文案去掉"审核期"字样。
- **置信度**：代码部分已读证实；平台规则部分**疑似，需对照微信官方文档**。
- **登记情况**：上一轮把"审核期测试单文案（AJ-179）"列为已登记欠账，但登记的是功能决策，不含"该文案对审核员可见"这一风险，故单列。

### P3

#### MP2-04｜P3｜结算页 `refresh()` 开头自己算了一次闸门，漏传 `splitRequired` 与 `emailError`——每次 onShow 都有一段"该拦的没拦"的窗口（B38 未接全）
- **位置**：`miniprogram/pages/checkout/index.js:105-111`；对照 `:187-198`（updateGate 是全的）；测试 `checkout/index.vm.unit.test.ts`「闸门必须把 splitRequired 传进去」只断言源码里**出现过** `splitRequired` 字符串。
- **证据**：
  ```js
  const gate = submitGate({
    itemCount: items.length, addressId: this.addressId,
    termsAccepted: this.data.termsAccepted,
    totalJpy: this.data.quote?.totalJpy ?? null,     // 旧 quote 的合计；无 emailError / splitRequired
  });
  this.setData({ gate });
  ```
- **场景与后果**：页面已判定"已超过单笔上限"（按钮禁用）→ 看条款返回/切后台回来 → onShow → 这次 setData 把 gate 算成 ok（旧合计还在、没传 splitRequired）→ 三条请求回来前按钮可点 → 提交必然 40906。邮箱同理：输入框里是非法邮箱（有错误提示），窗口内提交会以 `contactEmailOf(...).value === ''` 建单——**订单静默不带邮箱**，而页面上还显示着用户填的那串。另外 40905 恢复路径（`refresh({keepError:true})`）在新报价回来前同样以旧合计放行，连点会再吃一次 40905。
- **修复**：`refresh()` 里删掉这段手写 `submitGate(...)`，改为先 `setData({ rows })` 再调 `this.updateGate()`（唯一入口）；需要重报价时先 `setData({ quote: null })` 让闸门落到"还在计算中"。测试改为精确计数：薄壳里 `submitGate(` 只许出现 1 次。
- **置信度**：已读代码证实。

#### MP2-05｜P3｜结算页闸门不看条款版本、也没有"报价失败"态：拿不到 `/terms` 时放行提交并把开发者报错显示给用户；报价失败时永远说"还在计算中"
- **位置**：`miniprogram/pages/checkout/index.vm.js:42-58`（submitGate）、`:157-159`（orderBody 抛错）；`pages/checkout/index.js:122-134,171-184,241-266`；`index.wxml:73-74`。
- **问题与后果**：
  1. `GET /terms` 失败（termsVersion 为空）时，用户仍可勾选"已阅读并同意"，其余条件满足即 gate.ok → `orderBody` 抛 `orderBody：terms_version 不能为空（GET /terms 没拿到版本就不是提交时机）` → 被 catch 后经 `errorMessage` **原样显示给用户**；wxml 此时一直显示"条款版本加载中"，没有重试入口（只能离开再进）。
  2. `fetchQuote` 失败后 `quote=null`，闸门理由是"运费与合计还在计算中"——与 B36 在购物车修掉的是同一个缺陷，结算页没跟上。B37 新增的恢复路径让它成为**必经**：40401/40901 → requote → 报价端点同样 40401/40901 → 用户看到错误条 + "还在计算中"的禁用按钮，走不出去（只能自己想到退回购物车；购物车侧见 B39）。
- **修复**：`submitGate` 增加 `termsVersion`（空 → "条款加载失败，请返回重试"/"条款加载中"）与 `quoteFailed`（→ "合计未能获取，请返回购物车调整后重试"）两个输入；薄壳记录 `quoteError`；补单测。
- **置信度**：已读代码证实。

#### MP2-06｜P3｜购物车：防抖的 400ms 里"去结算"仍可点、旧合计仍显示；且 B36 注释里的后果描述不成立
- **位置**：`miniprogram/pages/cart/index.js:94-125,185-193`；注释 `:15-19`；vm `cart/index.vm.js:59-61`。
- **问题**：`changeQty → refresh → requestQuote` 只排定时器，`gate` 要到 400ms 后 `fetchQuote` 开头才置为 quoting。这 400ms 内页面是"新数量 + 旧合计 + 可点的去结算"——B36 想堵的窗口只堵了"在途"那一半。另外 @limitation 一与 vm @why 都写"放行等于把过期的 expected_total_jpy 喂给结算页"，而 `onCheckout` **不传任何金额**（`:203`，结算页自己报价），这句断言没有依据。
- **后果**：无金额风险（结算页重报价 + 40905 兜底），只是显示不一致；注释会误导后续维护者以为购物车是 40905 防线的一环。
- **修复**：`requestQuote()` 排定时器的同时 `setData({ gate: checkoutGate({ quoting: true }) })`；注释改为"显示一致性"而非"防线"。
- **置信度**：已读代码证实。

#### MP2-07｜P3｜B38 后同一句"已超过单笔上限，请分两单下单"在同一屏出现两次
- **位置**：`miniprogram/utils/quote-view.js:54-60`（hints）+ `cart/index.vm.js:70`（gate.hint）+ `checkout/index.vm.js:53`（gate.reason）；渲染于 `cart/index.wxml:46,69`、`checkout/index.wxml:48,88`。
- **后果**：报价卡里一行、按钮下方一行，逐字相同。纯展示问题。
- **修复**：`quoteView` 不再把它放进 `hints`（只留 `splitRequired`），文案由闸门唯一给出；或闸门文案改成动作指引（"请减少数量后重试"）。
- **置信度**：已读代码证实。

#### MP2-08｜P3｜支付页 `load()` 不清旧错误；pay vm 的 JSDoc 挂错函数
- **位置**：`miniprogram/pages/pay/index.js:117-118`；`pages/pay/index.vm.js:81-101` 与 `:125`。
- **问题**：① `load()` 开头只 `setData({loading:true})`。微信支付取消后显示"支付未完成…"，切后台再回来（onShow 会重取）或首次加载失败后重取成功，错误条都一直挂着。② `payStartDecision` 的整段文档注释（:81-101）后面紧跟的是 `copyResult` 的注释与函数，`payStartDecision` 本体（:125）没有注释——B34 插入代码时把注释和函数拆开了。
- **修复**：`load()` 成功分支 `setData({ error: '' })`（失败保留新错误）；把 `copyResult` 整块移到 `payStartDecision` 之后。
- **置信度**：已读代码证实。

#### MP2-09｜P3｜订单详情：复制运单号后运单号从页面上消失；失败提示让用户"长按"一个不可选的文本
- **位置**：`miniprogram/pages/order-detail/index.wxml:71-73`；`index.js:92-100`。
- **证据**：
  ```xml
  <text class="track" data-no="{{view.trackingNo}}" bindtap="onCopyTracking">
    {{copied ? '已复制' : view.trackingNo}}
  </text>
  ```
- **后果**：复制成功后该处只剩"已复制"三个字，运单号要等下次 onShow 才回来（想核对/手抄都不行）。复制失败时提示"请长按运单号手动复制"，但 `<text>` 没有 `user-select`（对比 legal 页与 pay 页都加了），长按不会出现选择——兜底动作是空的。
- **修复**：运单号始终渲染并加 `user-select`；"已复制"放到旁边的提示行（现有"点运单号复制"那行）。
- **置信度**：代码已读证实；"`<text>` 默认不可长按选中"为平台行为，把握较大，建议真机确认一次。

#### MP2-10｜P3｜订单详情对已付/已退款订单仍写"应付合计"，且不显示实际扣款币种与金额
- **位置**：`miniprogram/pages/order-detail/index.wxml:49-53`；`index.vm.js:97-128`（不读 `payment`）；服务端 `order-views.ts:77-86,111` 已下发 `payment.charge_currency / charge_amount / paid_amount / paid_currency`。
- **后果**：银行卡实扣的是美元（§14.2 提示条也这么说），付完后详情页只有"应付合计 3,600 円 ≈ $24.50"——"应付"对已付单是错的标签，"≈"是参考价而不是账单上的那个数；用户拿信用卡账单对不上时，页面给不出依据。
- **修复**：vm 增加 `totalLabel`（可付态"应付合计"，其余"订单合计"）与 `paidText`（`payment.paid_amount` 存在时按币种格式化为"实付 $24.50"）；补单测。
- **置信度**：已读代码证实。

#### MP2-11｜P3（疑似，需开发者工具/真机看一眼）｜详情页轮播与订单详情缩略图没有高度
- **位置**：`miniprogram/pages/detail/index.wxss:10-18` + `index.wxml:19-23`；`pages/order-detail/index.wxss:22-33` + `index.wxml:33`。
- **问题**：`<swiper>` 未设高度（平台默认 150px），里面 `<image mode="aspectFit">` 只设 `width:100%`（`<image>` 默认高 240px）→ 主图被裁在 150px 高的轮播里。订单详情 `.item-img` 只设 `width:20%` + `mode="aspectFill"`，注释写"宽度定了高度自然对"——只有 `widthFix` 才随宽定高，`aspectFill` 下高度仍是默认 240px，缩略图会是一条 20%×240px 的竖条。成因很可能是 design-token 门禁禁止尺寸字面量，于是高度干脆没写。
- **要验证什么**：开发者工具里打开详情页与订单详情页，看主图是否完整、缩略图是否为正方形。
- **修复**：订单详情缩略图改 `mode="widthFix"`（与首页/购物车同口径）；轮播高度加一个有名字的 token（如 `--ws-gallery-height: 750rpx`）。
- **置信度**：疑似（组件默认尺寸凭平台知识，未实测）。

#### MP2-12｜P3｜网络层错误原样显示宿主英文与 `-1`
- **位置**：`miniprogram/utils/request.js:162-170`；`utils/error-text.js:29-37`。
- **后果**：断网/超时时页面显示 `-1 request:fail timeout`、`-1 request:fail url not in domain list`；非 JSON 的 5xx（网关页）显示 `-1 请求失败（HTTP 502）`。对用户是乱码，对"域名白名单没配"这种上线事故却是唯一线索——两种读者混在一条文案里。
- **修复**：`errorMessage` 对 `code === NETWORK_ERROR_CODE` 输出"网络异常，请检查网络后重试"，原始 errMsg 只进实时日志（已经在记）。
- **置信度**：已读代码证实。

#### MP2-13｜P3（疑似，需真机）｜`ws-button` 禁用态下点击是否仍冒泡到宿主的 `bindtap`
- **位置**：`miniprogram/components/ws-button/index.wxml:1-8`；`index.js:20-24`（@limitation 二已写"只能真机验"）。
- **问题**：防线是"内部 `<button disabled>` 不触发 tap → `catchtap` 不执行 → 不 `triggerEvent`"。但页面是把 `bindtap` 绑在**自定义组件宿主节点**上的；若禁用按钮上的原生 tap 仍会冒泡/穿出组件（`catchtap` 因按钮禁用没机会拦），宿主的 `bindtap` 会直接收到原生 tap，禁用形同虚设。
- **影响面**：handler 里自带 JS 判断的不受影响（checkout onSubmit 查 gate、cart onCheckout 查 gate、detail onAddToCart 查 soldOut）；**`address-edit` 的 onSave 没有任何 JS 守卫**（MP-10），是唯一完全依赖这条平台行为的写操作。
- **要验证什么**：真机在样板页（pages/comp）点 disabled 按钮，确认计数不增加；已登记为 L4 人工项，本条只是指出"一旦不成立，受影响的是哪几个 handler"。
- **修复（防御性）**：组件内层再包一层 `<view catchtap="noop">`，让任何原生 tap 都出不了组件；对外只剩 `triggerEvent`。
- **置信度**：疑似，需真机验证。

#### MP2-14｜P3｜注释与实现不符 / 小项（合并）
- `pay/index.vm.js:64-72`：@why 与规则①自相矛盾（见 MP2-02）。
- `checkout/index.vm.js:127-130` 与 `checkout/index.js:270`：称"requote 后沿用同一个键会被服务端判成同键不同内容"。实际 40905/40901/40401 属 handler 抛错，`adapters/idempotency.ts:114-116` 会**删掉占位行**，同键再发是一次全新执行，不会 40908。retire 本身无害，但理由写错了（真正会 40908 的是"首次其实成功、客户端超时"那条，主会话已登记）。
- `legal/index.js:111`：复制失败提示"请长按**上方**链接"，而错误条渲染在页面最顶部（wxml:11-13），链接在它**下方**。
- `order-detail/index.wxml:80`：`wx:key="index"`——`index` 不是时间线行的字段（行只有 statusText/atText），开发者工具会告警；改 `wx:key="atText"` 或在 vm 里给行加序号。
- `cart/index.js:60,98`：`count` 写进 data（注释"标题显示用"），wxml 没有任何地方读它。
- `home/index.vm.js:5-7`：仍写"本项目没有小程序组件测试框架"，与 CLAUDE.md 约束十一 2026-09-28 的更正（已引入 miniprogram-simulate）不一致。
- `home/index.vm.js:103`、`detail/index.vm.js:56`：`soldOut: Number(p.stock) === 0`，`Number(null)`/`Number('')` 都是 0，stock 为 null/空串时会显示"已售罄"并禁用加购；契约若保证 stock 恒为整数则无影响，建议改 `p.stock === 0`。
- `address-edit/index.js:69-89`：编辑态异步回填 `form`，回填前用户已输入的内容会被整体覆盖（弱网可见）。
- **置信度**：均已读代码证实。

---

## 3. 未提交改动（B37 / B38，cart / checkout / quote-view）引入或未接全的问题（单列）

| 编号 | 归属 | 一句话 |
|---|---|---|
| MP2-04 | B38 未接全 | `refresh()` 里第二处 `submitGate` 没传 `splitRequired`（及既有的 `emailError`）；守护测试只查字符串出现，抓不到 |
| MP2-05② | B37 引入必经路径 | 40401/40901 → requote → 报价也失败 → 闸门说"还在计算中"，走不出去 |
| MP2-07 | B38 引入 | 同一句拆单提示在购物车、结算页各出现两次 |
| MP2-14 第 2 项 | B37 注释 | "同键会被拒"的理由与服务端幂等实现不符 |
| MP2-06 | B36（已提交）遗留 | 防抖 400ms 窗口未禁用；注释里的"喂过期 expected_total"不成立 |

B37/B38 本身的主路径我逐行核过：`recoveryFor` 的四个码与 errors.ts 的 action 对得上；`splitRequired` 与服务端 `q.totalJpy > MAX_ORDER_JPY`（quote.ts:179 与 create-order.ts:164 是同一比较）一致，不会出现"前端拦了、服务端其实放行"；`keepError` 的清/留语义正确；40011 分支复位勾选后 `fetchTerms → updateGate` 会把按钮关上。

---

## 4. 平台提审核对清单（不是代码缺陷，全部"疑似，需对照微信官方文档/真机验证"）

| # | 事项 | 现状 | 要验证什么 |
|---|---|---|---|
| 1 | 隐私：剪切板 | 代码调 `wx.setClipboardData`（pay / legal / order-detail 三处），均有 fail 兜底；未接 `wx.onNeedPrivacyAuthorization`，app.json 无 `__usePrivacyCheck__` | ① 后台《用户隐私保护指引》必须勾选"剪切板"，漏了则对所有用户 errno 112；② 2023-10 起隐私校验应已默认开启、`__usePrivacyCheck__` 不再必需——以当前官方文档为准；③ 不接 onNeedPrivacyAuthorization 时走平台默认弹窗，真机确认弹窗出现且拒绝后兜底文案可见 |
| 2 | 隐私：表单收集 | 地址页收集姓名/电话/地址，结算页收集邮箱，均为用户手填（不调隐私接口） | 隐私指引里"收集的信息类型"需列出收货地址、手机号、邮箱；数据存于境外服务器，是否需在指引中披露跨境传输 |
| 3 | 外部支付与审核期文案 | 见 MP2-03 | 同上 |
| 4 | request 合法域名 | `API_BASE='http://localhost:3000'`（F14 已登记）；`urlCheck:false` 仅开发者工具有效 | 上线域名须 https 且进白名单（每月改 5 次）；海外主体的服务器域名是否免备案；商品图走 `<image>` 网络地址不需要 downloadFile 白名单（确认未来不改用 downloadFile） |
| 5 | 登录 | `wx.login` → `/auth/wechat/login`，启动静默登录 + 40101 单飞重登；逻辑正确（死循环/倒退均已防） | code2session 对海外主体 AppID 的域名（api.weixin.qq.com）与境内一致与否属服务端分片；`wx.login` 无超时仍是 MP-15 |
| 6 | 开发页 | `pages/index`、`pages/comp` 未进 app.json，且在 packOptions.ignore；`*.unit.test.ts`、`*.fixture.js` 以 glob 排除 | 上传前在开发者工具"代码依赖分析"里确认包内无这两目录与测试文件 |
| 7 | 类目/客服/售后 | 「我的」页刻意无客服入口（已登记）；法务页无特商法表示（已登记） | 电商类目提审通常要求可见的客服与售后/退款政策入口；海外主体可选类目与资质清单 |
| 8 | 拆单文案 | "已超过单笔上限，请分两单下单" | `MAX_ORDER_JPY` 的来由是出口申报阈值（config.ts:331）；即便不出现"申报"二字，主动指引拆单仍可能被视为规避申报——属 D-42 业务决策，建议法务确认措辞（如只写"单笔订单金额上限为 X 円"） |
| 9 | 微信支付发货信息管理 | 未接（R1 才上微信支付） | R1 前确认跨境/机构模式是否适用"小程序发货信息管理"要求 |

---

## 5. 上一轮未修旧项状态（不展开）

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B39（MP-09） | 仍在 | 报价 40401/40901 不带 product_id；`normalize` 不去重、`add` 不限 50 行；request.js 不透传 `body.data` |
| B40（TSB-03） | 仍在 | 订单详情 `duty_jpy` 为 0 仍显示"预估关税 0 円"（`order-detail/index.vm.js:78`） |
| B27（小程序侧 = MP-11） | 仍在 | 地址表单无长度校验、`<input>` 无显式 maxlength；"设为默认"仍把 country 强写 US |
| MP-10 | 部分 | 支付页在途守卫已修（B6）；地址保存仍只有 `disabled`、`onSave` 无 JS 守卫 |
| MP-12 | 仍在 | 币种/"银行卡·Stripe"文案/通道过滤国家仍写死 |
| MP-13 | 仍在 | 提示条仍按 `expires_at − created_at` 全时长；"金额以支付页为准"仍显示在支付页 |
| MP-14 | 部分 | checkout/pay 已有 vm 与源码字符串守护；`createOrder`/`startPay`/`load` 的编排仍无行为级测试 |
| MP-15 | 仍在 | `wx.login` 无超时；启动登录绕开 single-flight；「我的」页无失败态 |
| MP-16 | 仍在 | 建单成功仍 `navigateTo` 支付页；"查看订单"仍可能叠两层列表；"继续支付"无 loading |
| MP-17 | 仍在 | 条款链接不校验 https；版本变化（非 40011 路径）不复位"已同意" |
| MP-18 | 仍在 | cart-store 先改内存后持久化；首页触底全量 setData |
| MP-19 | 基本仍在 | idem-key 已删；其余（detail js/wxml、pay @limitation 二、pay-plan 文件头、ws-price:54、address vm、address-edit 死字段、D-36"人民币"、pages/index、payGuide.actionText、wx-api @limitation 十）原样 |
| MP-20 | 仍在 | checkout/pay/cart 整页共用一条 trace |

---

## 6. 看过但确认没问题的高风险点

- **合计只来自服务端**：cart/checkout 合计只读 `quoteView(res).totalJpy`；购物车行只显示快照单价、不算小计；结算页行不带价格；支付页金额取 `GET /orders/{id}`，美元取 `order.display.USD`；跨页不传金额。币种符号 円/$/¥ 各走各的格式化函数，无混用；整数最小单位，非整数抛错。
- **wxml ↔ setData 键**：11 个登记页面 + 2 个组件逐一核对，绑定字段全部能在 vm 输出或 data 里找到，无拼错（仅有未使用的 data 键，见 MP2-14、MP-19）。
- **响应形状**：`GET /addresses` 返回裸数组（address-routes.ts:77），与页面 `Array.isArray(res)` 一致；`GET /orders` 返回 `{items}`；`POST /orders` 返回 `order_id`。
- **40101 重放**：只重放一次、不递归；登录请求器不挂 relogin；single-flight 成败都清句柄；重放复用 trace 与幂等键安全（首发被鉴权拦在幂等之前）。
- **B36 序号机制**（购物车侧）：空车分支推进序号并清定时器；过期请求不清 loading；`isStale` 对脏值降级为"不过期"合理。
- **B35 微信支付 success → redirectTo、fail 统一文案、已付单不列通道**：逻辑正确（参数名问题主会话已登记）；`payPageView` 对未知状态按可付处理合理。
- **幂等键生命周期**（checkout/pay）：成功 retire、失败保留、换通道/换地址 retire——除主会话已登记的三条外无新问题。
- **结算页地址三段优先级**（A6）：picked > current（仍在列表）> default，实现与注释一致；picked 读走即清。
- **导航目标**：所有 navigateTo/redirectTo 的路径都在 app.json 登记；`?pick=1`、`?id=`、`?orderId=` 的读写两端除已登记那条外一致。
- **sitemap**：私有页全部 disallow，仅 home/detail/legal 可被索引。
- **storage**：统一 `ws:` 前缀；损坏 JSON 降级不崩；token 写失败不吞。
- **jst-text**：纯整数换算，跨日/跨月/跨年路径正确，只认 `Z` 结尾。
