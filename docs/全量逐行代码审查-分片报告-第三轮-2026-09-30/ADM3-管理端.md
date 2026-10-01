# ADM3 分片（admin-web）第三轮逐行审查报告（2026-09-30，HEAD 50d490b）

## 范围与方法

- **逐行读完**：admin-web 下全部源文件与测试（`src/**` 共 57 个文件，含 `testing/dom.ts` 与 4 份 `*.dom.unit.test.ts`），以及 `index.html`、`vite.config.ts`、`tsconfig.json`、`package.json`、`tokens.css`、`app.css`（`app.css` 用 grep 查过写死的颜色和尺寸，一处都没有）。
- **对照读的分片外文件**：
  - 服务端路由：`server/src/app/admin-ops-routes.ts`（fx / shipping-rates 全文）、`admin-order-routes.ts`（分页、ship、refund、响应形状）、`admin-product-routes.ts`（toAdminProduct、PUT）、`admin-risk-routes.ts`、`admin-banner-routes.ts`（响应形状）
  - `product-routes.ts` 的 `toImageSet`
  - `contracts/api-contract.yaml` 中 ship / AdminOrderListItem / ShippingRate 三段
- **上轮基线**：`docs/全量逐行代码审查报告-第二轮-2026-09-30.md`，分片原文 `docs/全量逐行代码审查-分片报告-2026-09-30/ADM.md`。本轮重点复核提交 88b2ba7 的五处修复，它们是：
  - FxPanel 的保存步骤与无基线预览
  - OrderDetail 的退款失败提示
  - ProductsPage 的 statusFields
  - RatesPanel 的重复检查
  - jsdom 测试基座
- **跑过的测试**：`npx vitest run --project unit admin-web` 的结果是 19 个文件、297 条全部通过。
- **探针**：放在 `scratchpad/round3/adm3/`，用独立的 `vitest.probe.mts`（root 指向仓库），复用仓库的 `admin-web/src/testing/dom.ts` 在 jsdom 里真实挂载组件。仓库文件一个都没改。

| 探针 | 结论 |
|---|---|
| `risk-stale.probe.test.ts` | 通过：处理 B 失败后点"确认拉黑"，发出的是 `/admin/users/user-A/block` |
| `fx-ack.probe.test.ts` | 通过：勾选"我已核对"后复选框从 DOM 消失 |
| `fx-key.probe.test.ts` | 通过：同币种、同一分钟内的两行汇率，React 报 duplicate key |
| `fx-double.probe.test.ts` | 通过：第一笔 POST 还没返回时再点一次"确认保存"，发出 2 个 POST |

**总体结论**：
- 安全面（XSS、token 进 URL 或日志、env 泄露）仍然没有新问题。全目录没有 `dangerouslySetInnerHTML`、`innerHTML`、由数据生成的 `href` 或 `window.open`。`<img src>` 只接服务端返回的 URL。
- 本轮新发现 P0 0 条、P1 0 条、P2 2 条、P3 7 条。
- 88b2ba7 的修复有两处带出了新缺陷：ADM3-03 和 ADM3-04 都在 FxPanel。另有一处注释漂移（ADM3-07）。

---

## 发现

### ADM3-01【P2】风控页：点下一单的"处理"失败后，面板仍停在上一单，"确认拉黑"会拉黑上一单的用户

- **位置**：`admin-web/src/risk/RiskPage.tsx:61-75`（`prepare`）、`:161-188`（确认面板）
- **问题**：`prepare(id)` 只在 `getOrder` **成功**后才改写 `orderId` 和 `userId`。失败分支只 `setError`，上一单留下的 `orderId`、`userId` 原样保留，确认面板和"确认拉黑"按钮都还在。面板上显示的是订单 **UUID**（`订单 {orderId} · 用户 {userId}`），列表行显示的却是 `order_no`，运营没法把面板和哪一行对上。另外 `confirmBlock` 不清旧的 error，成功后页面上会同时出现"已拉黑"和上一条红字。
- **触发场景**：
  1. 在拒付列表对 A 单点"处理"，面板出现"订单 ord-A · 用户 user-A"。运营决定先看 B 单，没有点"取消"。
  2. 对 B 单点"处理"，`GET /admin/orders/ord-B` 超时或 5xx。页面顶部出现红字"请求超时（10000ms）"，底部面板仍是 A。
  3. 运营以为面板是 B 的，点"确认拉黑"，结果拉黑的是 user-A。
- **后果**：拉黑不可逆，没有解除接口。按 `block-user.ts`，拉黑会在同一事务里取消该用户所有未付款订单、回补库存、作废机构会话。这些都落在了错误的用户身上，而真正该拉黑的 B 没被处理。
- **证据**：【实测】探针 `risk-stale.probe.test.ts`：依次处理 A 成功、处理 B 超时、点"确认拉黑"，发出的请求是 `['/api/v1/admin/users/user-A/block']`，断言通过。
- **修复方案**：
  - `prepare` 开头先 `setOrderId('')`、`setUserId('')`、`setOk('')`，失败时面板自然消失。
  - 面板改为显示 `order_no`：从 `rows` 里按 orderId 取，或让 `prepare` 接收整行 `r`。
  - `confirmBlock` 开头 `setError('')`。
  - 顺带：`prepare` 成功时核对返回的 `order_id === id` 再落状态，防止乱序响应（B44 同类）。
- **应补测试**（新增 `risk/RiskPage.dom.unit.test.ts`）：
  - 先红断言：处理 A 成功 → 处理 B 抛 `ApiError(-1)` → `button(el,'确认拉黑')` 应为 `null`（现状不为 null）。
  - 面板文字应包含 A 行的 `order_no`。
  - 注回验证：删掉 `prepare` 开头的清空两行，用例必须变红。

### ADM3-02【P2】商品编辑是无版本号的整条 PUT，编辑页的数据取自列表快照：保存会把期间别人（或另一个标签页）改过的售价、重量、标题回滚

- **位置**：
  - `admin-web/src/products/ProductsPage.tsx:148-153`：编辑数据取的是 `raw` 快照
  - `admin-web/src/products/ProductFormPage.tsx:49-51, 81-83`：表单由这份快照初始化，保存时整条提交
  - `admin-web/src/products/view.ts:287-310`：只有 `stock` 做了"未改动不发送"（AJ-175），其余字段全部照发
  - 分片外：`server/src/app/admin-product-routes.ts:151-175`：PUT 不接收也不比对 `updated_at`，整行覆盖
- **问题**：
  - 契约没有 `GET /admin/products/{id}`，编辑页只能用列表页加载时的快照。
  - PUT 是全量更新，没有 `If-Match` 或 `expected_updated_at`。列表数据在页面上停留多久，快照就旧多久。
  - AJ-175 只把"并发写的列"`stock` 排除在外，但售价、重量、HS、报关品名、图片同样可能被另一次编辑改过。
  - `AdminProductLike` 里已经带了 `updated_at`，前端没有用它。
- **触发场景**：
  1. 运营在标签页 1 打开商品列表后放着。
  2. 在标签页 2（或另一位管理员）把商品 X 的售价从 2,980 改为 3,480 并保存。
  3. 回到标签页 1，点 X 的"编辑"，表单显示的是 2,980。只补一张图后保存。
  4. PUT 带着 `price_jpy: 2980`，服务端整行覆盖，改价被静默回滚，不报任何错。
  - 重量被回滚的后果相同，而且会影响运费取档。
- **证据**：【读码确认】`toProductInput` 无条件输出 `price_jpy`、`weight_g`、`images` 等字段；服务端 `repo.updateProduct` 直接写入，对 `updated_at` 不做任何比对。
- **修复方案**：
  - **根治**（要改契约）：PUT 带 `expected_updated_at`（或 `If-Match`）。服务端用 `where updated_at = $x` 更新，0 行时返回新码 409xx"商品已被他人修改，请刷新后再改"。前端收到后保留表单并提示刷新。
  - **契约未改前的缓解**：点"编辑"前先重新拉当前页，从新数据里取 source；或在编辑页醒目显示 `updated_at`。
  - Banner 的 `PUT /admin/banners/{id}` 同理（`BannersPage.tsx:82-86, 97-99`），影响较轻，一并处理。
- **应补测试**：
  - 服务端 db 用例：旧 `expected_updated_at` 发 PUT 返回 409xx，行不变。
  - 前端 dom 用例：`updateProduct` 抛该码时，表单不清、`onDone` 不被调用。
  - 先红点：现状没有冲突码，服务端用例必然红。

### ADM3-03【P3】汇率确认态：勾选"我已核对"之后复选框立刻消失，无法取消勾选（88b2ba7 引入）

- **位置**：`admin-web/src/ops/FxPanel.tsx:193`
- **问题**：复选框的渲染条件是 `step.kind === 'confirm' && step.requireAck`。勾选后 `ackKey === formKey`，`fxSaveStep` 返回 `{kind:'save'}`，条件变假，复选框被卸载。
- **触发场景**：录入 0.67（与当前值差 100 倍）→ 点"保存汇率"→ 勾选。复选框随即消失，只剩一个可点的"确认保存"。运营想撤回勾选再核对一遍时，找不到复选框，只能点"取消"重来。页面上也不再有"我已核对"的字样，事后看不出这一步做过没有。
- **证据**：【实测】探针 `fx-ack.probe.test.ts`，勾选前后复选框存在性为 `{before:true, after:false}`。现有用例 `FxPanel.dom.unit.test.ts:123-138` 勾选后只断言按钮可点，没有断言复选框仍在。
- **修复方案**：渲染条件改为"是否需要勾选"本身。例如用 `fxPreview` 的 `risky || noBaseline`，或让 `fxSaveStep` 的 `save` 分支也带上 `requireAck`，与"是否已勾"分开。
- **应补测试**：勾选后 `ackBox(el)` 仍不为 null 且 `checked === true`；再点一次后回到 unchecked，确认按钮重新禁用。

### ADM3-04【P3】汇率列表的 key 改成 `quote|分钟级时间` 后仍会撞键：一分钟内录两次就触发 React duplicate key（88b2ba7 引入）

- **位置**：`admin-web/src/ops/FxPanel.tsx:139`（`key={`${r.quote}|${r.effectiveText}`}`）；`effectiveText` 来自 `formatJst`，只精确到分钟（`format.ts:72`）
- **问题**：留空生效时间 = 服务端取当前时刻（毫秒级）。同一币种在同一分钟内保存两次，两行的 `effectiveText` 完全相同，key 就相同。这种情况很常见：录错后马上改，或者双击"确认保存"。"保存无 busy"仍然存在（ADM-10），探针 `fx-double` 实测双击会发出 2 个 POST。
- **后果**：React 对重复 key 的行为没有保证，后续刷新时行可能被复用错位或丢失。汇率表本来就是"只能追加"的审计视图，显示错位会误导人判断哪一行是当前生效的。
- **证据**：【实测】探针 `fx-key.probe.test.ts`，两行 USD（03:10:41.900Z 与 03:10:12.100Z）挂载后 console.error 里出现 "same key"。
- **修复方案**：
  - key 用原始 `effective_from` 字符串（毫秒级 ISO）加 `raw_rate`，或直接用服务端行 id（契约若补上）。`fxRows` 要多输出一个 `key` 字段。
  - 同时给"确认保存"加 busy（ADM-10 的原修复建议），从源头消除双提交。
- **应补测试**：`fxRows` 对"同一分钟两行"输出的 key 互不相同；dom 用例 spy `console.error` 不含 "same key"；按住第一笔 POST 不放时再点"确认保存"，POST 仍只有 1 个（先红：现状是 2 个）。

### ADM3-05【P3】"当前生效"汇率按**浏览器时钟**判定，管理员电脑时钟偏差时基准会取错

- **位置**：`admin-web/src/ops/FxPanel.tsx:64`（`currentFxRawRates(list, Date.now())`）；`ops/view.ts:207-220`
- **问题**：服务端用 `deps.clock.now()` 给"立即生效"的行打时间，前端却用本机时钟判断 `at > nowMs`（未来行）。两个时钟不一致时，判定结果随偏差变化。
- **触发场景**：
  - 管理员电脑慢了 10 分钟。刚保存的立即生效行（服务端时间）在前端被当成"未来行"排除，基准仍是上一条。连续纠正时（先错录、马上改正），第二次核对拿错误值之前的那条当基准。
  - 电脑快了若干小时。几小时后才生效的预约行被当成"当前"，核对基准变成还没生效的值。
- **证据**：【推断】（读码可确认取值来源不同；实际偏差幅度取决于机器）。
- **修复方案**：
  - 服务端 `GET /admin/fx` 为每行下发 `is_current`（用服务端时钟算，并与 `findLatestFxRate` 同源），前端只读这个字段。这样顺带解决 ADM-10 的"不标当前生效行"。
  - 或者响应里带服务端 `now`。
- **应补测试**：`currentFxRawRates` 改成读 `is_current` 后，构造"`effective_from` 晚于浏览器时间但 `is_current=true`"的行，基准必须取它。

### ADM3-06【P3】`rateErrors` 把"重量都没填"的几行报成"与前面某一档重复"，与 AJ-232 新增的 `rateDuplicates` 口径不一

- **位置**：`admin-web/src/ops/view.ts:432-434`（`key = `${carrier}|${String(max)}``，`max` 为 null 时 key 是 `carrier|null`）；对照 `:326-336`（`rateDuplicates` 对认不出的重量不判重）
- **触发场景**：连点两次"新增一档"，承运商默认继承首行，重量都留空。底部错误区出现三条："第 N 档：重量上限必填"、"第 N+1 档：重量上限必填"、"第 N+1 档：与前面某一档的承运商 + 上限重复（DB 唯一约束会拒）"。行上的"档位重复"标记却不亮。两处说法互相矛盾，运营会去找一个根本不存在的重复。
- **证据**：【读码确认】`parseCount('')` 返回 null，`String(null)` 为 `'null'`。
- **修复方案**：`rateErrors` 的判重只对 `max !== null` 的行做，或者直接复用 `rateDuplicates(list)[i]`，让两处共用同一份口径。
- **应补测试**：`rateErrors([两行 carrier 相同、重量为空])` 的 errors 中不含"重复"；先红：现状含。

### ADM3-07【P3】注释与事实不符（其中一处是 88b2ba7 之后新产生的漂移）

- `admin-web/src/orders/view.ts:4-5`、`products/view.ts:4-6`、`orders/view.ts:229-231` 仍写着"vitest 的 unit 层是 node 环境，没有 jsdom / 没有组件测试 harness"。这些注释是把逻辑抽成纯函数的理由，而 88b2ba7 已经建了 `testing/dom.ts` 与 4 份 jsdom 用例。结论（逻辑仍应放在 view）本身成立，但理由已经不是事实了，应改为"组件测试成本高、纯函数可做边界表"之类的真实理由。
- `admin-web/src/ops/api.ts:37-40` `listFx` 的文档写"当前生效的展示汇率"。事实是服务端返回全部历史行和未来行（`admin-ops-routes.ts:98-100`），`FxPanel.tsx:10-12` 也已写明"此处曾写'服务端只返回当前生效一条'——与实现不符，且正是量级核对取错基准的成因"。AJ-229 只改了 FxPanel 这一处，同一个错误说法留在了接口层。
- 证据：【读码确认】

### ADM3-08【P3】商品表单的分类下拉写死四个 `<option>`，不从 `PRODUCT_CATEGORY` / `CATEGORY_LABELS` 生成

- **位置**：`admin-web/src/products/ProductFormPage.tsx:195-204`；对照 `products/view.ts:31-40`（同一份键和文案，并且有"与契约 enum 双向比对"的用例守着）
- **问题**：契约或 shared 新增分类时，view 层的双向比对会红并被修好，但这个下拉不会跟着变。编辑新分类的商品时，受控 `<select>` 的 value 不在选项里，浏览器显示第一项"美妆护肤"，state 里仍是新分类。运营看到的分类是错的；如果他手动选回"美妆护肤"，就真的改错了。这也违反约束五（文案走配置，不写死在组件里）。
- **证据**：【读码确认】
- **修复**：`PRODUCT_CATEGORY.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)`。
- **应补测试**：dom 用例断言下拉选项集合等于 `PRODUCT_CATEGORY`。

### ADM3-09【P3】订单列表没有刷新入口，用同一关键词再点"搜索"不会重新请求

- **位置**：`admin-web/src/orders/OrdersPage.tsx:118-127`（`setApplied(keyword.trim()); setPage(1)`）、`:67-71`（`load` 只随 `page / status / applied` 变化）
- **触发场景**：客服搜到某单，显示"待付款"。客户说刚付了款，客服再点一次"搜索"想刷新，但 `applied` 与 `page` 都没变，effect 不触发，列表不动，他会据此回复客户"还没收到款"。现在唯一的刷新办法是切到别的页签再切回来，或者进详情。商品页的筛选 chip 重复点也一样。
- **证据**：【读码确认】
- **修复**：搜索按钮的 onClick 在值未变时直接 `void load()`（或者用一个递增的 `reloadTick` 加进 deps）；列表页头加"刷新"按钮。
- **应补测试**：dom 用例点两次"搜索"（关键词不变），列表 GET 次数 +2；先红：现状 +1。

---

## 统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 2 | ADM3-01（拉黑串单）、ADM3-02（商品 PUT 覆盖他人改价） |
| P3 | 7 | ADM3-03 ～ ADM3-09 |

## 上轮遗留状态（逐条复核）

| 编号 | 状态 | 说明 |
|---|---|---|
| ADM2-01 | ① 已修；附带 ② 仍存在 | 基准取行已改为 `currentFxRawRates`，raw 对 raw，已修。附带 ② 仍在：样例金额仍是 `SAMPLE_JPY * raw`（`ops/view.ts:160`），比实际扣款少 buffer（默认 3%）。新的相关问题见 ADM3-05 |
| ADM2-02 | 已修 | catch 里先 load 再 setError，并给出结果未知提示；dom 用例覆盖了 5xx、网络错、4xx、202 pending 四种情形 |
| ADM2-03 | 主问题已修；附带项仍存在 | `busyId` 仍是单槽（`ProductsPage.tsx:48,78,88`）：先点 A 再点 B，A 的请求未返回时按钮已恢复可点 |
| ADM2-04 | RatesPanel 已修；附带项仍存在 | `FxPanel.tsx:147`、`BannersPage.tsx:210`、`RiskPage.tsx:151` 的空态文案仍缺 `error === ''` 守卫 |
| ADM2-05 | 仍存在（B45） | `risk/view.ts:37`、`RiskPage.tsx:81` 没有写"连带取消未付款订单" |
| ADM2-06 | 仍存在 | `orders/view.ts:200` 仍称"详情里没有该字段" |
| ADM2-07 | 仍存在 | `token-store.ts:58-70` 只有 setItem 抛错时，token 读不到 |
| ADM2-08 | 仍存在 | 售价上限、raw_rate 下限（5e-9）前端都没预检 |
| ADM2-09 | 基本已修 | `fxSavedText` 已区分立即生效和预约生效。填了早于现有最新行的时间时仍说"到所填时间后生效"，实际永远不会成为当前值（轻微） |
| ADM2-10 | 仍存在（5 项全部） | 上传结果写进当前表单；删除当前编辑项不复位；排序空串被当成 0；分类是自由文本；上传中仍可保存 |
| ADM-09 | 部分修 | 重复标记已按原序计算；确认按钮仍无 busy，双击会发两次 PUT；保存前不重取比对 |
| ADM-10 | 部分修 | key 已带时间，但分钟级仍会撞键，见 ADM3-04；仍不标当前生效行；保存仍无 busy，【实测】双击发 2 个 POST |
| ADM-11 / 12 / 13 / 14 / 15 | 仍存在 | 报障码仍只在登录页出现；退款仍用 10 秒默认超时；库存留空变 0、`1e3` 被接受；FxPanel 233 行、OrderDetail 311 行等仍超出 150 行上限 |
| B42 | 仍存在 | `OrderAddressForm.tsx:47` 仍只在挂载时取一次；从列表进详情时，地址七个框全空 |
| B44 | 仍存在 | 订单、商品、风控三个列表的 `load` 仍无请求序号，也不把页码夹回有效范围 |
| B45 | 仍存在 | 同 ADM2-05 |

## 看过、确认没有问题的点（本轮新增部分）

- `fxSaveStep` 的指纹绑定：改值或换币种后，确认态和勾选都会自动失效（dom 用例已覆盖）；非法值不会进入确认态。
- `refundFailureNotice` 按码分流：`-1` 和 `≥50000` 给"结果未知"提示，4xx 不给。2xx 非 JSON 响应与 202 空体分别落到 `-1` 和 `unknown`，两种都会刷新详情。
- 退款、发货按钮在 busy 期间是 `disabled`，React 离散事件同步冲刷，双击不会重复提交（只有 FxPanel 和 RatesPanel 的确认按钮缺 busy）。
- 分页参数：订单列表 size=20 在服务端 1..100 范围内；商品同样合规；拒付的 `status` 取值（含 withdrawn）与服务端一致。
- `testing/dom.ts`：`type()` 走原生 setter，对 select 派发 change，与 React 18 的受控组件兼容；没有新增依赖。
