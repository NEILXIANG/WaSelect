# ADM 分片（admin-web）第二轮逐行审查报告（2026-09-30）

审查对象：工作区当前文件（`git status` 显示 admin-web 下无未提交改动，即 HEAD=41d40ba 的内容）。
基线之后触及本分片的提交共 6 个：b6cb6b7（A7 运费留空）、5c9acf4（A8 汇率核对）、26cc9dd（B7 退款理由上限）、971b713（B1a withdrawn）、89ab280（B43 最小单位）、b6722e6（B41 退款 outcome）。
结论：安全面（XSS、环境变量泄露、token 处理）仍无新问题。新发现 **P1 0 条 / P2 4 条 / P3 6 条**，其中 2 条 P2 是修复提交（A8、B41）留下的缺口。未跑测试、未连库；探针 1 个（纯 Node，`review2/adm-probe1.mjs`）。

## 1. 覆盖清单（38 个非测试文件，5313 行，全部逐行读完）

| 文件 | 行数 | 文件 | 行数 |
|---|---|---|---|
| admin-web/index.html | 15 | src/orders/api.ts | 191 |
| admin-web/package.json | 27 | src/orders/view.ts | 335 |
| admin-web/tsconfig.json | 32 | src/orders/OrdersPage.tsx | 192 |
| admin-web/vite.config.ts | 20 | src/orders/OrderDetail.tsx | 301 |
| src/App.tsx | 156 | src/orders/OrderAddressForm.tsx | 95 |
| src/LoginForm.tsx | 84 | src/orders/address-view.ts | 125 |
| src/main.tsx | 23 | src/products/api.ts | 149 |
| src/format.ts | 88 | src/products/view.ts | 292 |
| src/app.css | 237 | src/products/ProductsPage.tsx | 197 |
| src/tokens.css（生成物） | 18 | src/products/ProductFormPage.tsx | 251 |
| src/api/client.ts | 155 | src/products/ProductFormParts.tsx | 129 |
| src/api/config.ts | 46 | src/ops/api.ts | 100 |
| src/api/endpoints.ts | 55 | src/ops/view.ts | 339 |
| src/api/errors.ts | 48 | src/ops/RatesPanel.tsx | 223 |
| src/api/token-store.ts | 92 | src/ops/FxPanel.tsx | 212 |
| src/api/upload.ts | 129 | src/ops/OpsPage.tsx | 28 |
| src/banners/api.ts | 88 | src/risk/api.ts | 63 |
| src/banners/view.ts | 195 | src/risk/view.ts | 87 |
| src/banners/BannersPage.tsx | 304 | src/risk/RiskPage.tsx | 192 |

`admin-web/public/` 不存在；仓库内没有 admin-web 的 `_headers` / `_redirects` / `wrangler.toml`（只有 checkout-static 的）。`admin-web/dist/` 被 gitignore，只读检查了产物里的 env 替换结果。

为对照而读的分片外文件：`server/src/app/admin-order-routes.ts`、`admin-ops-routes.ts`、`admin-risk-routes.ts`、`admin-banner-routes.ts`、`admin-product-routes.ts`、`admin-upload-routes.ts`、`refund-execution.ts`、`block-user.ts`（全文）；`domain/product-input.ts`、`banner-input.ts`、`fx-input.ts`、`admin-order-actions.ts`（全文）；`domain/shipping-rates-input.ts`、`dispute-input.ts`、`adapters/ops-config.ts`、`adapters/orders-admin.ts`、`app/product-routes.ts`、`app/http-outbound.ts`、`config.ts`、`packages/shared/src/errors.ts`、`money.ts`、`contracts/api-contract.yaml`（相关段）；`scripts/assert-admin-deploy-env.ts`；`admin-web/src/api/client.unit.test.ts`（token-store 用例段）。

## 2. 发现

### P2

#### ADM2-01｜P2｜A8 的量级核对拿错了基准行：比的是该币种**最早**一条汇率，不是当前生效的那条
- **位置**：`admin-web/src/ops/FxPanel.tsx:49-56`（取基准）、`:68-72`（传给 `fxPreview`）；`admin-web/src/ops/view.ts:160-167`
- **分片外依据**：`server/src/adapters/ops-config.ts:93`（`order by quote asc, effective_from desc`，且返回**全部**历史与未来行）；`server/src/app/admin-ops-routes.ts:98-100`
- **问题**：循环对同一币种"后者覆盖前者"，而服务端按生效时间**降序**返回，于是留下来的是每个币种**最旧**的一行。未来生效行也不过滤。
- **证据**：
  ```ts
  for (const x of Array.isArray(list) ? list : []) {
    ...
    if (q !== '' && Number.isFinite(r) && r > 0) rates[q] = r;   // 后者覆盖前者
  }
  ```
  探针（逐字抄这段循环，输入按服务端排序：未来行 0.0071 / 当前行 0.0069 / 最早行 69.01）输出 `currentRates picked by FxPanel: { USD: 69.01 }`。
- **触发场景与后果**：
  - 第一条汇率录错过、后来追加一条改正（汇率只能追加不能改，`admin-ops-routes.ts` @limitation 二）——这正是 A8 要防的事故发生之后的常态。此后基准永远是那条错值：每次录**正确**的值（0.0068 对 69.01，倍数 0.0001）都标红要求勾选，运营很快把勾选当例行公事；而再次录成 67（倍数 0.97）**不标红、直接提交**。防线方向整个反过来。
  - 长期漂移：日元兑美元相对首条记录累计变动超过约 33%（倍数 ≤0.67）或 50%（≥1.5）之后，每次正常维护都标红，同样训练出"无脑勾选"。
  - 服务端仍接受 67 / 150（已知项），所以这一步是目前唯一的拦截点。
  - 附带两处同源偏差：① 基准取的是 `rate`（含缓冲），新值是 `raw_rate`（不含），倍数恒偏 `1/(1+buffer)`——`FX_BUFFER_RATE` 允许到 0.5，配到 0.4925 以上时"原样重录"也会标红；② 样例金额用 `SAMPLE_JPY * raw`，而真实扣款用的是 `raw × (1+buffer)`，默认 3% 缓冲下样例比实扣少 3%。
- **修复方案**：
  - 在 `ops/view.ts` 新增纯函数 `currentFxRawRates(items, nowMs)`：每个币种取 `effective_from <= nowMs` 中**最新**的一行的 `raw_rate`；FxPanel 用它替换这段循环（`nowMs` 由面板传 `Date.now()`，view 内不取时钟）。
  - `fxPreview` 的基准改用 `raw_rate` 对 `raw_rate`；样例金额如要展示实扣口径，需要把列表行的 `buffer` 传进来再乘。
  - 补单测：三行输入（未来 / 当前 / 最早错值）→ 基准是当前行；注回"后者覆盖"写法必须红。
- **置信度**：已探针证实（取行）＋已读代码证实（服务端排序）
- **严重度**：P2

#### ADM2-02｜P2｜B41 修复只覆盖了 202：退款接口**抛错**（确认失败 / 结果未知 / 超时）时界面只有红字，订单仍显示"待发货"
- **位置**：`admin-web/src/orders/OrderDetail.tsx:130-134`（`doRefund` 的 catch）；对照 `:116-129`（成功分支）
- **分片外依据**：`server/src/app/admin-order-routes.ts:299-360`（第一段事务已把订单落到 `refunding` 并提交）；`server/src/app/refund-execution.ts:99-105,136,161`（机构报错 / 确认失败 / 查询失败一律抛 50000）；`packages/shared/src/errors.ts:152-156`（50000 文案只有"服务器内部错误"）
- **问题**：B41 的注释写"三种 outcome 必须分别说"，但契约 0.6.11 的三种情形里，只有"在途"走 202；"机构确认失败"和"结果未知"走的是 50000，落进 catch。catch 只做 `setError(e.message)`，不刷新详情、不通知列表、不复位确认态。
- **证据**：
  ```ts
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
  } finally {
    setBusy('');
  }
  ```
- **触发场景与后果**：Stripe 返回错误或超时 → 服务端此时订单已是 `refunding`、钱可能已退也可能没退 → 页面显示"服务器内部错误"，状态栏仍是 `paid`，"确认发货"按钮仍可点，`refundGate` 针对 refunding 的那句"可再提交一次，不会重复退"**不出现**（闸门按过期的 paid 计算）。运营的自然结论是"退款失败、订单没动"，随后两种动作都有害：去 Stripe 后台手工退（`refund-execution.ts` @limitation 一：此后我方同键重试被拒，订单走不出 refunding）；或改去发货（服务端回 40902"订单状态不允许此操作"，更看不懂）。这正是 B41 要消除的误判，只是换了入口。客户端 10 秒超时（`client.ts:26`）同样落在这里：查询在途单后重新发起是两次机构调用，各受 `HTTP_TOTAL_BUDGET_MS=6000` 约束，合计可超过 10 秒。
- **修复方案**：catch 里先 `await load(); onChanged();` 再设提示（顺序不能反，`load` 开头会 `setError('')`）；提示按"结果未知"写：`退款请求未得到确认：订单可能已进入「退款中」，已刷新状态。如显示退款中，请在本页再提交一次（服务端先查询上一笔，不会重复退）；不要在 Stripe 后台手工退款`；同时 `setConfirming(false)`。`doShip` 的 catch 同样补刷新。退款与发货传 `timeoutMs: 30_000`。
- **置信度**：已读代码证实
- **严重度**：P2（与 09-29 的 ADM-13 同根，当时定 P3；B41 修复后这条成了三情形中两种的唯一出口，建议升级）

#### ADM2-03｜P2｜商品上下架成功后，状态列文案不变：下架了仍显示"在售"
- **位置**：`admin-web/src/products/ProductsPage.tsx:79-81`（乐观更新）、`:146`（渲染）
- **问题**：乐观更新只翻 `online` 与 `status`，没有改 `statusText`；成功后也不重新拉列表。
- **证据**：
  ```ts
  prev.map((r) => (r.id === row.id ? { ...r, online: !r.online, status: next } : r))
  ...
  <td className={row.online ? 'ok' : 'muted'}>{row.statusText}</td>
  ```
- **触发场景与后果**：每一次上下架都触发。下架成功后该行写着"在售"（只是颜色变灰），按钮变成"上架"；上架成功后写着"已下架"。运营因合规问题紧急下架一件商品时，看到的是"在售"没变，容易判断为没生效而再点一次——那一下点的是"上架"，商品被重新放回货架。在"在售"筛选下该行也不会消失。另：`busyId` 只有一个槽位，先点 A 再点 B 时 A 的按钮在请求未回来前就恢复可点，连点会发出方向相反的两个 PATCH，到达顺序不保证。
- **修复方案**：`statusText` 不存进行数据，渲染时由 `status` 推导（或在 `view.ts` 提供 `withStatus(row, next)` 纯函数同时改三个字段并补单测）；`busyId` 改为 `Set<string>`；成功后可 `void load()` 以服务端为准。
- **置信度**：已读代码证实
- **严重度**：P2

#### ADM2-04｜P2｜运费表加载失败时页面声称"还没有运费档位"，且允许在空表上新增并整表替换
- **位置**：`admin-web/src/ops/RatesPanel.tsx:50-53`（失败不清空——但首次加载时本来就是空）、`:171-177`（空表文案）、`:182-207`（新增与保存不看是否加载成功）
- **问题**：没有"已成功加载"这个状态。首次 GET 失败（超时 / 5xx / 断网）后 `rows` 仍是初始的 `[]`，表格显示"还没有运费档位（所有订单都无法报价）"，错误文案在面板最底部；此时"新增一档 → 保存（整表替换）"全程可用。
- **证据**：
  ```tsx
  {rows.length === 0 && !loading && (
    <tr><td className="muted" colSpan={5}>还没有运费档位（所有订单都无法报价）</td></tr>
  )}
  ```
  对照 `ProductsPage.tsx:126` 有 `error === ''` 的守卫，这里没有。
- **触发场景与后果**：运营打开运营配置页时接口抖动一次，看到一句很吓人的"所有订单都无法报价"，照提示补录自己记得的一两档并确认。`PUT /admin/shipping-rates` 是整表替换，真实的整张表被这一两档覆盖：更重的包裹取不到档（全站报价失败），或全部订单按仅剩的一档收费。确认按钮只写"用当前 N 档替换全部"，看不出原表有几档（旧 ADM-09 已指出缺差异展示）。
- **修复方案**：增加 `loaded` 状态，首次加载成功前禁用"新增一档"与"保存"，空表文案改为仅在 `loaded && rows.length === 0` 时显示；加载失败时显示"加载失败，重试"按钮。`FxPanel.tsx:137-143`、`BannersPage.tsx:210-216`、`RiskPage.tsx:151-157` 的空态文案同样缺 `error === ''` 守卫（后果轻：只是把"没取到"说成"没有"），一并改。
- **置信度**：已读代码证实
- **严重度**：P2

### P3

#### ADM2-05｜P3｜拉黑确认文案没跟上契约 0.6.15：连带取消在途订单这一后果没有写
- **位置**：`admin-web/src/risk/view.ts:37`（`BLOCK_CONFIRM_TEXT`）；`admin-web/src/risk/RiskPage.tsx:81`（成功提示）
- **分片外依据**：`server/src/app/block-user.ts:77-88`；`contracts/api-contract.yaml:176-189`
- **问题**：B28 / AJ-213 之后，拉黑会在同一事务里取消该用户所有 `created` / `pending_payment` 订单、回补库存、作废机构会话。确认文案仍只写"不能再下单（40301）"，成功提示也只写"此后建单会被拒"。服务端返回空体，被取消了几张单前端无从展示。
- **后果**：不可逆操作的后果被写轻（旧 B45 第 4 项的延伸，属修复后新增的漂移）。
- **修复方案**：文案改为"拉黑后：该用户所有需登录的功能被拒；**尚未付款的订单会被立即取消并回补库存**；已付款订单不受影响，需另行决定退款或发货；后台没有解除入口"。如要展示取消数量，需先改契约让接口返回 `cancelled_order_ids`。
- **置信度**：已读代码证实

#### ADM2-06｜P3｜`refundGate` 注释称"详情里没有该字段"，与事实不符
- **位置**：`admin-web/src/orders/view.ts:200`
- **问题**：注释写"MVP 前端拿不到'上一笔是哪一种'（详情里没有该字段）"。实际 `AdminOrder.events` 里就有 `refund_pending` / `refund_failed`（`orders-admin.ts:482,500` 写入，`admin-order-routes.ts:241-246` 原样下发，`OrderDetail.tsx:207-211` 已在渲染）。
- **后果**：注释把"没做"写成"做不了"，会让后续修"再查询仍要重填原因"（已知项）的人以为要先改契约。
- **修复方案**：更正注释；已知项的修法可直接读 `events` 末条退款进度事件：`refund_pending` → 按钮改"查询退款结果"、免填原因、免二次确认。
- **置信度**：已读代码证实

#### ADM2-07｜P3｜token 存储的"内存降级"在"写抛错、读不抛错"时失效，登录后立刻被踢回登录页
- **位置**：`admin-web/src/api/token-store.ts:58-70`
- **问题**：`set` 在 `real.setItem` 抛错时写进内存；`get` 先读 `real.getItem`，它不抛错、返回 null，于是得到空串，内存里的 token 永远读不到。
- **证据**：探针（`setItem` 抛、`getItem` 返回 null）输出 `token after set: ""`。现有用例（`client.unit.test.ts:355-372`）只测了三个方法**全部**抛错的情形。
- **后果**：存储配额已满或只禁写的环境（旧版 Safari 隐私模式即此形态）下，登录成功 → 下一个请求不带 authorization → 40101 → 回登录页，循环。与文件头 @limitation 一"任何一步抛错都降级为内存存储，功能可用"不符。
- **修复方案**：`set` 抛错后置 `degraded = true`，此后 `get` / `clear` 一律走内存；或 `get` 在 real 返回 null 时回落读内存。补"只有 setItem 抛"的用例并做一次注回。
- **置信度**：已探针证实

#### ADM2-08｜P3｜B25 给服务端新增的两条上下界，前端没有同步预检
- **位置**：`admin-web/src/products/view.ts:233-234`（售价只查 ≥1）；`admin-web/src/ops/view.ts:88`（汇率只查 >0）
- **分片外依据**：`server/src/domain/product-input.ts:154`（`price_too_large`，上限 `MAX_ORDER_JPY`）；`server/src/domain/fx-input.ts:58,98`（`raw_rate_too_small`，下限 5e-9）
- **后果**：售价多打几个零、汇率小到会被舍成 0 时，前端放行，服务端回泛化的"参数缺失或格式错误"，页面没有字段级提示。属已知 B27（规则多份真源）在修复提交后新增的两处，不改变 B27 的结论，修 B27 时一并纳入。
- **置信度**：已读代码证实

#### ADM2-09｜P3｜汇率保存成功提示恒为"立即按新汇率计算"，与填写的生效时间无关
- **位置**：`admin-web/src/ops/FxPanel.tsx:80`
- **问题**：填了未来的 `effective_from` 时，新汇率此刻并未生效；填了早于现有最新行的时间时，它永远不会成为当前生效值。提示都是"已保存（新的展示价立即按新汇率计算）"。列表又不标注哪一行当前生效（旧 ADM-10 未修）。
- **后果**：运营以为已经生效，实际扣款仍按旧汇率。
- **修复方案**：按 `form.effectiveFrom` 是否为空 / 是否晚于当前时间分别给出"立即生效"或"将于 X（JST）生效"；与 ADM2-01 的 `currentFxRawRates` 一起，在列表上标出当前生效行。
- **置信度**：已读代码证实

#### ADM2-10｜P3｜Banner 页与商品表单的几处状态串位
- **位置与问题**：
  1. `BannersPage.tsx:124-138`：上传完成时把 `image_key` 写进"此刻的表单"。上传途中点了另一条的"编辑"或"新建"，图会落到另一条 Banner 上，保存后首页换错图。文件框上传期间不禁用、选完不清空（旧 ADM-12 已列）。
  2. `BannersPage.tsx:111-122`：删除的正是当前在编辑的那条时，`editing` 不复位，随后"保存"得到 40402。
  3. `banners/view.ts:158-159`：排序留空 → `Number('')` = 0 被当作合法；`1e2` 被当作 100（与旧 ADM-14 同类）。
  4. `BannersPage.tsx:249-254`：`link_type=category` 时目标 id 是自由文本，不与本仓已有的 `PRODUCT_CATEGORY` 比对，拼错的分类只有在小程序里点了才发现（服务端按设计不查，`banner-input.ts` @limitation 二）。
  5. `ProductFormPage.tsx:245`：图片上传中仍可点"保存"，保存成功后页面卸载，正在上传的那张图不在提交内容里，也没有提示。
- **修复方案**：上传开始时记下目标（`editing?.id ?? 'new'`），完成时不一致就丢弃并提示；删除成功后若 `editing?.id === id` 则 `startNew()`；排序用 `/^\d+$/`；分类用下拉；保存按钮 `disabled={saving || uploading}`。
- **置信度**：已读代码证实

## 3. 09-29 已列、尚未修的条目状态

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B27（ADM-06） | 仍在 | HS 必填仍写"建议填"、单承运商规则 / 各长度上限前端不查；另见 ADM2-08 新增两处 |
| B26 | 仍在（前端侧） | 前端禁词仍是子串匹配（`products/view.ts:256`），与服务端词边界语义不同 |
| B42（ADM-04） | 仍在 | `OrderAddressForm.tsx:47` 仍只在挂载时取一次，列表进详情七个框全空 |
| B44（ADM-07） | 仍在 | 订单 / 商品 / 风控三个列表的 `load` 仍无请求序号，也不夹页码 |
| B45（ADM-08） | 仍在 | 11 处注释与文案均未改；拉黑文案又多落后一版（ADM2-05） |
| ADM-09 | 仍在 | `RatesPanel.tsx:167` 重复标记仍用未排序行号取已排序结果；确认按钮无 busy、无差异明细 |
| ADM-10 | 仍在 | `FxPanel.tsx:129` key 仍是 `r.quote`；不标当前生效行；保存无 busy |
| ADM-11 | 仍在 | 40301 无统一出口；40101 丢表单且登录页不提示原因；退出不复位 `tab` / `editing` |
| ADM-12 | 仍在 | 报障码仍只在登录页；`upload.ts:104-105` 仍用本地 traceId、2xx 非 JSON 直接抛 SyntaxError；无大小 / 格式预检 |
| ADM-13 | 仍在 | 退款 / 发货仍用 10 秒默认超时、catch 不刷新；建议升级，见 ADM2-02 |
| ADM-14 | 仍在 | 库存留空 → 0；`1e3` 被接受；标签两类错误互相覆盖；列表价格不走 `moneyText`；详情状态栏显示英文原值 |
| ADM-15 | 仍在 | 七个页面仍超 150 行（FxPanel 由 140 增至 212），仍无组件级测试；本轮 ADM2-01～04 全在 `.tsx` |
| B24 / B30 | 仍在（前端侧无对应预检） | 服务端条目，前端只是没有同源校验 |
| B2 / B21 / B29 / B39 / B40 / B46–B51 | 不在本分片 | 未核对 |

## 4. 看过但确认没问题的高风险点

- **XSS**：全目录无 `dangerouslySetInnerHTML` / `innerHTML` / 由数据生成的 `href` / `window.open`；`<img src>` 只有商品缩略图与 Banner 图，来自服务端字段，不会执行脚本；其余文本经 React 转义。
- **环境变量**：源码只在 `App.tsx:61` 读 `import.meta.env`；本地产物里它被替换成 `{BASE_URL,DEV,MODE,PROD,SSR}`，无 sourcemap；`admin-web/` 下没有 `.env*`；CF Pages 构建由 `assert-admin-deploy-env.ts` 拦住 localhost 回落。
- **登录态**：token 只进 localStorage 与 Authorization 头，不进 URL、不进日志（`console.info` 只打 path / trace_id / 状态码；path 含查询串，订单搜索关键词会出现在本机浏览器控制台，不外发）。跨标签页：A 退出后 B 的下一个请求不带头 → 40101 → 回登录页；A 换账号登录后 B 用新 token，审计归属正确。
- **三个订单闸门与服务端守卫**：`shipGate` / `refundGate` / `addressGate` 与 `shipGuard` / `refundGuard` / `addressGuard` 在状态 × 拒付 × 测试单上结论一致（测试单只拦发货，两端相同）。
- **退款请求体与 outcome**：`{reason}` 已 trim，上限取自 shared；`refundOrder` 对缺失 / 未知 outcome 返回 `unknown` 不猜；202 三种提示文案与服务端语义相符。
- **B43 最小单位**：`minorMoneyText` 的小数位取自 shared；整数除以 100 后 `toFixed(2)` 不会落在舍入中点上；未知币种 / 非整数显示"—"。
- **A7 运费留空**：`parseCount` 对空串 / `1e3` / `0x10` / 负数均返回 null，`toRateBody` 解析不出即抛错不回落 0；确认态下再改表格，`save` 仍用当次渲染的校验结果。
- **商品 PUT**：不带 `status`（服务端 PUT 不碰状态）；库存未改动时不发送；`cost_jpy` / `hs_code` 清空后服务端落 null。
- **Banner PUT**：清空起止时间 → 字段省略 → 服务端落 null（能清掉时间限制）；`line2` 空串仍带上。
- **空响应体**：201 / 200 `.end()` 与 204 走 `noContent` 分支；判断依赖代理保留 `content-length: 0`，未实跑线上链路，无证据表明有问题。
- **发货无二次确认**：按钮文案即"确认发货"，两个字段必填，服务端事务内持锁判 paid；属设计取舍，未列为缺陷。
- **表单隐式提交**：商品表单保存中按钮禁用，Enter 触发的隐式提交同样被挡。
