> 本文是 2026-09-29 全量逐行代码审查的 **ADM 分片（admin-web）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# ADM 分片（admin-web）审查报告

结论：安全面没有发现问题。代码里没有 XSS 注入点，构建产物也没有泄露环境变量。问题集中在两类：一是运营配置页（运费、汇率）的录入错误会直接变成少收或多收钱，二是订单页的几处主路径显示和交互错误。共 15 条：P1 两条，P2 六条，P3 七条。

基线：`tsc -p admin-web` 退出码 0；`vitest --project unit admin-web/src` 15 个文件、230 条全部通过。下面的 ADM-03、04、07、09 都是 `.tsx` 里的逻辑，这 230 条一条都没抓到。探针脚本放在草稿目录 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/ADM/`，共 7 个（probe1–7），用的是根依赖里现成的 jsdom。

## 1. 覆盖清单（全部已逐行读完）

| 文件 | 行数 |
|---|---|
| admin-web/index.html | 15 |
| admin-web/package.json | 27 |
| admin-web/vite.config.ts | 20 |
| admin-web/tsconfig.json | 32 |
| src/App.tsx | 156 |
| src/LoginForm.tsx | 84 |
| src/main.tsx | 23 |
| src/format.ts | 52 |
| src/app.css | 237 |
| src/tokens.css（生成物） | 18 |
| src/api/client.ts | 155 |
| src/api/config.ts | 46 |
| src/api/endpoints.ts | 55 |
| src/api/errors.ts | 48 |
| src/api/token-store.ts | 92 |
| src/api/upload.ts | 129 |
| src/orders/api.ts | 171 |
| src/orders/view.ts | 309 |
| src/orders/OrdersPage.tsx | 192 |
| src/orders/OrderDetail.tsx | 280 |
| src/orders/OrderAddressForm.tsx | 95 |
| src/orders/address-view.ts | 125 |
| src/products/api.ts | 149 |
| src/products/view.ts | 292 |
| src/products/ProductsPage.tsx | 197 |
| src/products/ProductFormPage.tsx | 251 |
| src/products/ProductFormParts.tsx | 129 |
| src/ops/api.ts | 100 |
| src/ops/view.ts | 197 |
| src/ops/RatesPanel.tsx | 223 |
| src/ops/FxPanel.tsx | 140 |
| src/ops/OpsPage.tsx | 28 |
| src/risk/api.ts | 63 |
| src/risk/view.ts | 77 |
| src/risk/RiskPage.tsx | 192 |
| src/banners/api.ts | 88 |
| src/banners/view.ts | 195 |
| src/banners/BannersPage.tsx | 304 |

admin-web/.DS_Store 是 Finder 元数据，0 字节，未纳入审查。

为核对行为，还读了分片外的这些代码：
- contracts/api-contract.yaml 全文
- 服务端 `admin-order-routes.ts`、`refund-execution.ts`、`admin-order-actions.ts`、`auth.ts`、`admin-ops-routes.ts`、`shipping-rates-input.ts`、`product-input.ts`
- 服务端局部：`fx-input.ts`、`address-input.ts`、`http.ts` 的 CORS 与错误兜底、`errors.ts` 的 `toErrorResponse`、`admin-product-routes.ts`、`pay-intent.ts` 的 `resolveCharge`、`db.ts` 的 int8 解析
- docs 中 AJ-148、AJ-178 两条决策记录

## 2. 发现列表

### ADM-01｜P1｜钱 / 表单校验：运费分档的运费留空，被静默当成 0 円保存
- **位置**：`ops/view.ts:164,168,188`（`rateErrors` 与 `toRateBody`）；`ops/view.ts:195-197` 与 `RatesPanel.tsx:185`（"新增一档"时运费默认为空串）
- **问题**：`Number('')` 等于 0，"≥0 的整数"这条校验放行空值，提交时又把空值转成 `price_jpy: 0`。
- **证据**：
  ```ts
  const price = Number(r['priceJpy'] ?? r['price_jpy']);
  if (!Number.isInteger(price) || price < 0) errors.push(`${at}：运费必须是 ≥0 的整数（円）`);
  price_jpy: Number(r['priceJpy'] ?? r['price_jpy']),
  ```
- **触发与后果**：运营点"新增一档"，只填了重量上限，没填运费（或清空后忘了重填），再点确认。前端 `rateErrors` 返回 `{ok:true}`，`toRateBody` 发出 `price_jpy:0`（probe1）。服务端按"0 円 = 手动包邮"合法接受（`shipping-rates-input.ts:68`）。此后这个重量段的所有订单运费都是 0，不报任何错——正是本文件头引用的 D-46 那类"每单少收钱且静默"。重量上限不会出这个问题，因为它要求 ≥1，空值会被拦下；运费没有同等的拦截。确认按钮只显示"用当前 N 档替换全部"，不显示价格，二次确认也看不出来。
- **解决方案**：
  - 两个数值字段都先 trim，空串单独报"运费必填（包邮请显式填 0）"。
  - 用 `/^\d+$/` 做严格整数解析，同时挡掉 `'1e3'`、`'0x10'` 这类写法。
  - `toRateBody` 遇到空值不再转成 0。
  - 确认区列出每档价格，以及与加载时原表的差异。
  - 补单测：`priceJpy:''` 报错、`'  '` 报错、`'0'` 放行；做一次注回缺陷验证，确认去掉校验后用例会红。
- **置信度**：已探针证实（probe1）
- **是否已登记**：新发现

### ADM-02｜P1｜钱 / 危险操作确认：保存展示汇率没有二次确认，也没有量级核对，而它直接决定 USD 实扣金额
- **位置**：`ops/FxPanel.tsx:48-64,131`；`ops/view.ts:81-92`
- **分片外依据**：`pay-intent.ts:105`；`fx-input.ts:19-24,40,78`；`docs/自主决策记录.md` AJ-148（4819-4833 行）
- **问题**：汇率表单一点即提交。前端只查 >0，服务端上限是 1000，而 USD 扣款按 `toMinor(total_jpy, fx_snapshot.USD)` 计算，汇率直接乘进扣款金额。
- **证据**：
  ```ts
  <button type="button" className="btn" onClick={() => void save()}>保存汇率</button>
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, first: '原始汇率必须是大于 0 的数字' };
  return { currency: 'USD', amount: toMinor(order.total_jpy, toRateInt(String(rate))) }; // pay-intent.ts:105
  ```
- **触发与后果**（probe7）：`67`、`150`（按"1 美元 = 150 円"反着填）、`0.067`、`0.00067` 四个值，前端和服务端 `parseFxInput` 全部接受。
  - 录成 0.00067：此后每笔 USD 订单少收 90%。
  - 录成 0.067 或 150：多收 10 倍到 2 万倍，会引来拒付。
  - 服务端只打一条 `fx_rate_jump` 警告日志，不拦截。
- **与登记描述不符的两处**：
  - AJ-148 ④ 的反向风险写"只能靠**页面二次确认**与对账发现"，但 FxPanel 根本没有二次确认。
  - AJ-148 与 `fx-input.ts` 注释声称上限 1000 能"挡住 0.0067 打成 67"。实测 67 被接受（67 < 1000）。
- **解决方案**：
  - FxPanel 改为两步确认：显示新 rate 与当前生效 rate 的倍数，以及"¥10,000 ≈ $X"预览。预览写成 `view.ts` 里的纯函数（如 `fxPreview`），buffer 取列表行里的 `buffer`。
  - 倍数 ≥1.5 或 ≤0.67 时标红，要求勾选确认。
  - 前端补上 ≤1000，与服务端一致。
  - 同步更正 AJ-148 与 `fx-input.ts` 里的示例。
  - 补 `fxPreview` 边界表单测。
- **置信度**：已探针证实（前端、服务端两侧都接受）；扣款链路已读代码证实
- **是否已登记**：已登记但描述有误（登记的缓解手段在汇率页不存在，"挡住 67"的例子不成立）

### ADM-03｜P2｜契约漂移 / 退款展示：退款 202 的 outcome 被丢弃，处于 refunding 的订单提示仍是 AJ-178 之前的说法
- **位置**：`orders/api.ts:115-133`；`orders/view.ts:191-199`；`OrderDetail.tsx:100-118,242-274`
- **问题**：
  - 契约 0.6.11 已把 202 响应体定为 `{order_id, outcome: succeeded|pending}`，但 `refundOrder` 返回 void，注释仍写"契约没给退款响应结构"。
  - refunding 状态的提示仍按旧的"失败重试"来写，不区分"机构处理中"和"确认失败"。
- **证据**：
  ```ts
  * @why 返回值是 202 且不读响应体：契约没给退款响应结构，          // api.ts:117
  '上次退款未确认完成（机构调用失败或超时）：可重试；机构侧同一幂等键不会退两次，退款原因沿用首次填写' // view.ts:198
  ```
- **触发与后果**（probe6）：退款返回 202 `pending` 后，页面没有任何"已退款"或"处理中"的提示，状态栏显示英文原值 `refunding`，提示语是"机构调用失败或超时"。
  - 实际语义是"机构处理中，再点即查询"；确认失败时服务端会换新幂等键重发，所以"同一幂等键"的说法也不对。
  - 要触发查询，运营必须重新填一遍原因（服务端会忽略它），否则会被"退款原因必填（会进审计台账）"拦住；还要再走一遍"确认退款"两步确认。
  - 运营很可能以为退款失败，转去 Stripe 后台手工退款。这正好落进 AJ-178 反向风险①：订单走不出 refunding，只能人工改库。
- **解决方案**：
  - `refundOrder` 返回 `outcome` 并做形状校验。
  - `OrderDetail` 按结果分别提示："已退款"，或"机构处理中，稍后点「查询退款结果」"。
  - `refundGate` 读取 events 最新一条：若是 `refund_pending`，按钮文案改为"查询退款结果"，免填原因、免二次确认；若是 `refund_failed`，提示"上次失败可重试（原因沿用首次）"。
  - 补 `refundGate` 单测（refunding + refund_pending 事件），以及 `refundOrder` 的 outcome 形状单测。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-04｜P2｜主路径缺陷：从列表进入详情时，"发货前改址"表单永远是空的
- **位置**：`OrderAddressForm.tsx:47`；`OrderDetail.tsx:52,198-206`；`OrdersPage.tsx:80`
- **问题**：表单状态只在挂载时用 `useState` 初始化一次。挂载那一刻的 `order` 是列表项，而列表项不含 `address`。
- **证据**：
  ```ts
  const [form, setForm] = useState(() => addressFormModel(order));      // OrderAddressForm:47
  const [order, setOrder] = useState<AdminOrderLike | null>(source);    // OrderDetail:52
  source={raw.find((o) => o.order_id === detailId) ?? null}             // OrdersPage:80
  ```
- **触发与后果**（probe2）：详情接口已返回完整地址后，7 个输入框仍全为空；对照组 `source=null` 时能正确预填。
  - 运营只想改一个字段，也得把 7 个全部重敲。
  - 重敲时电话或邮编敲错一位，只要格式合法就会被写进订单地址快照，最后印到面单上。
- **解决方案**（任选其一）：
  - `order.address` 到位前不渲染表单；
  - 或给 `<OrderAddressForm key={…address 指纹}>` 让它在详情加载后重挂载；
  - 或在表单内用 `useEffect`，在用户未改动时同步 `order.address`。
  - 补 jsdom 组件测试，探针可以直接改写成用例。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-05｜P2｜金额展示：原币最小单位被当成主单位显示（`USD 3350` 实为 $33.50）
- **位置**：`orders/view.ts:236-246`（`paymentSummary`）；`risk/view.ts:56-64`；`RiskPage.tsx:125`
- **问题**：契约规定"金额一律整数最小单位（CNY/USD 为分）"，这两处直接把分数值拼在币种后面显示。
- **证据**：
  ```ts
  const amount = Number.isInteger(o['charge_amount']) ? String(o['charge_amount']) : '';
  amountText: [currency, amount].filter((s) => s !== '').join(' ') || '—',
  ```
- **触发与后果**（probe1）：显示为 `stripe · USD 1234` 和 `USD 1234`，表头还写着"争议金额（原币）"。客服答复客户、判断拒付轻重时，金额会被读大 100 倍。
- **解决方案**：
  - `format.ts` 新增 `minorMoneyText(amount, currency)`，按币种小数位格式化。小数位表放 shared，不写死在业务代码里。
  - `paymentSummary` 与拒付列表改用它。
  - 单测：`USD 3350` → `USD 33.50`，`JPY 5000` → `JPY 5,000`。
- **置信度**：已探针证实（显示结果）；单位已读契约与迁移 001 确认
- **是否已登记**：新发现

### ADM-06｜P2｜前后端校验不一致，而服务端 40001 只回通用文案，运营无从下手
- **位置**：
  - `products/view.ts:229-258`
  - `ProductFormPage.tsx:156`
  - `ops/view.ts:154-178`
  - `orders/address-view.ts:84-104`
  - 服务端对照：`product-input.ts:79,131,176-179,185`；`shipping-rates-input.ts:60,83-85`；`address-input.ts`（LEN 常量）；`errors.ts:9,66-69`（details 只进日志）
- **问题**：服务端会拒绝、前端却不预检的规则有：
  - **商品**：
    - 勾了 food/cosmetic 标签时 HS 码必填（页面标签却写"食品/化妆品**建议**填"）；
    - title 不超过 255、jan 不超过 13；
    - 报关品名禁词：前端 `lower.includes(w)` 做子串匹配，服务端按 `\b…\b` 词边界匹配。前端会误拒 "drugstore" 这类合法写法，而这时服务端是放行的。
  - **运费**：
    - "启用的承运商必须恰好一家"（服务端称"最要紧的一条"，还注释说 admin-web 的 `rateErrors` 是"同一套整表校验"）；
    - carrier 不超过 32。探针里两家同时启用、40 字符承运商，前端都给 `ok:true`（probe1）。
  - **改址**：收件人 ≤100、line1 ≤200、city ≤100 不校验。
  - **汇率**：≤1000 不校验。
- **证据**：
  ```ts
  const hit = BLOCKED_CUSTOMS_WORDS.filter((w) => lower.includes(w));           // 前端：子串匹配
  const FORBIDDEN_DESC = /\b(medicated|whitening|spf|sunscreen|drug)\b/i;        // 服务端：词边界
  if (hs === undefined && tags.some((t) => HS_REQUIRED_TAGS.includes(t))) fail('hs_code', ...)
  ```
- **触发与后果**：beauty 是主力品类。勾上 cosmetic、按"建议填"把 HS 留空，保存只看到"参数缺失或格式错误"，页面上没有任何字段级提示。
- **解决方案**：
  - 把禁词正则、`HS_REQUIRED_TAGS`、各字段长度上限、MAX_RAW_RATE 移进 `@waselect/shared`，前后端引用同一份常量。
  - 前端补齐"单承运商"、HS 必填、长度等规则；HS 字段文案改为"必填"。
  - 补双向比对用例。
- **置信度**：运费与汇率部分已探针证实；其余已读代码证实
- **是否已登记**：新发现

### ADM-07｜P2｜竞态：列表请求乱序时，旧响应覆盖新结果
- **位置**：`OrdersPage.tsx:48-71`；`ProductsPage.tsx:50-72`；`RiskPage.tsx:44-58`
- **问题**：`load` 不带请求序号，也不取消旧请求，后返回的旧页数据会覆盖新页。
- **证据**：
  ```ts
  const res = await listOrders(api, { page, size: PAGE_SIZE, keyword: applied, ... });
  setRaw(res.items); setRows(orderRows(res.items)); setTotal(res.total);
  ```
- **触发与后果**（probe4）：连点两次"下一页"，第 2 页响应比第 3 页慢，结果页码显示"第 3 / 3 页"，表格却是第 2 页的数据。另有两个附带问题：
  - 数据减少后，当前页码可能超出总页数，页面显示空表"没有符合条件的订单"；
  - 搜索词没变时再点"搜索"不会重新拉取，页面没有刷新入口。
- **解决方案**：
  - `load` 里用递增的请求序号（`useRef`），只接受最新一次响应；或者给 `RequestOptions` 加 `signal`，在 effect 清理时 abort。
  - total 变小时把 page 夹回合法范围。
  - 用 jsdom 把探针改写成用例。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-08｜P2｜注释与界面文案落后于契约 0.6.1、0.6.10、0.6.11（误导运营和后续开发）
- **位置**（逐条）：
  1. `orders/view.ts:132-136`：称"服务端目前并不阻止拒付进行中照常发货…前端单边口径"。实际服务端自 0.6.1 起返回 40909（`admin-order-actions.ts:66`）。
  2. `orders/view.ts:174-177`：称"completed 不可退款是前端口径"。实际服务端状态机 `completed: []`，同样拒绝。
  3. `view.ts:145,182`、`OrderDetail.tsx:210`：写"有拒付进行中 / 先处理拒付"。0.6.10 起拒付**败诉**后 `has_dispute` 永久为 true，已经没有可"处理"的东西。
  4. `risk/view.ts:12,30`、`RiskPage.tsx:81`：拉黑确认写"不能再下单（40301）"。0.6.10 起是**所有买家登录接口**都返回 40301，这个不可逆操作的后果被写轻了。
  5. `orders/api.ts:10-14`：称"超时重发真的会发两次货"。实际服务端在事务内持锁判断 paid，第二次必然 40902。
  6. `api/client.ts:14-15,34`：称"写操作必传幂等键 / 超时以同键重发"。0.6.10 ⑥ 起 /admin 下的写接口都不认这个头。
  7. `ops/view.ts:78-79`：称"服务端不会替我们挡住 0"。0.6.3 起服务端已限定 >0 且 ≤1000。
  8. `FxPanel.tsx:10-12`、`ops/api.ts:38`：称列表只显示"当前生效"。0.6.3 起返回全部历史与未来生效行。
  9. `RatesPanel.tsx:9-11`：称"表格按重量上限升序展示"。实际不排序，新增的档追加在末尾。
  10. `products/view.ts:70-72`：称"状态文案走映射、不写三元，防止新状态被当成下架"。实现（:80,:92）恰恰是三元：probe1 中 `'archived'` 显示为"已下架"，按钮出现"上架"。
  11. `token-store.ts:10-11`：称"不渲染任何用户生成内容…D-52 Cloudflare Access 在前"。实际订单页渲染买家的收件人、地址、邮箱（React 会转义，所以无 XSS）；Access 只挡静态站、不挡 API，且 U-04 尚未确认已配置。
- **解决方案**：
  - 逐条改正注释。
  - 拒付文案改为"有未解除的拒付限制（进行中或已败诉）"。
  - 拉黑文案写明"此后该用户所有需要登录的功能都会被拒"。
  - `productRows` 改为 `LABELS[status] ?? '未知状态'`，且只有 `active` 才算在售。
- **置信度**：已读代码证实；第 10 条已探针证实
- **是否已登记**：新发现

### ADM-09｜P3｜运费表"档位重复"标记错位；整表替换缺防重复点击、缺明细
- **位置**：`RatesPanel.tsx:63-70,167,72-88,191-193`
- **问题**：`view` 是 `rateRows` 按重量排序后的结果，界面却用未排序的行号 `i` 去取 `view[i].duplicate`。
- **证据**：`{view[i]?.duplicate && <span className="error">档位重复</span>}`
- **触发与后果**（probe1）：表中依次为 500、2000、1000、1000 四档，"重复"标记打在了 2000 这一行，真正重复的第 4 行没标。另外：
  - 确认按钮没有 busy 状态，可以连点，发出多次 PUT；
  - 确认文案只显示档数，看不到价格；
  - 页面只在打开时取一次表，另一位管理员期间的保存会被整表覆盖。
- **解决方案**：按原顺序计算重复标记（如 `dupFlags(rows): boolean[]`）；加 busy；确认前展示与原表的差异；保存前重新取一次表，发现变化就提示。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-10｜P3｜汇率面板：React key 重复、不标注当前生效行、可重复提交
- **位置**：`FxPanel.tsx:85,48-64,77-80`
- **问题**：`key={r.quote}`，而服务端返回同一币种的多行。
- **证据**：`<tr key={r.quote}>`
- **触发与后果**：
  - React 报 4 次 "Encountered two children with the same key"（probe3）。本次探针渲染结果正确，但 React 对重复 key 的行为不作保证。
  - 未来生效行和历史行也统一列在"生效汇率"下，没有标注哪一行当前生效——服务端 0.6.3 的说明正是为了避免"把未来行呈现成当前生效"。
  - 保存按钮没有 busy，连点会插入两行，或者第二次返回 40910 把成功提示覆盖掉。
- **解决方案**：key 改为 `${quote}|${effective_from}`；`fxRows(items, nowMs)` 按当前时间标出当前、未来、历史；保存时加 busy。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-11｜P3｜40301 没有统一出口；会话失效时丢失编辑内容；登出不复位页面状态
- **位置**：`client.ts:152`；`upload.ts:99`；`App.tsx:64-68,110-119`；`ProductFormPage.tsx:9-10`
- **问题**：
  - 管理员被撤权或封禁后，服务端返回 40301（`auth.ts:211-228`）。页面仍停在已登录状态，每次操作都报"无权限"，token 留在 localStorage 里直到手动退出。这是刻意设计（`client.unit.test.ts:251` 有用例钉住），但 admin-web 全部接口都要求管理员身份，40301 实际等于"账号已不可用"。
  - 40101 会卸载整个页面，商品表单十几个字段、改址表单的内容全部丢失，登录页也不提示"登录已过期"。这和 ProductFormPage 注释里"失败保留表单"的承诺相矛盾。
  - 退出登录和 40101 都不复位 `tab` 与 `editing`，下一位登录者会直接落在上一位的"编辑商品"页。
- **解决方案**：
  - `onUnauthorized` 带上原因，登录页显示"登录已过期"。
  - 40301 在 App 层显示全局横幅和"切换账号"按钮。
  - 登出时执行 `setTab('products')` 与 `setEditing(null)`。
  - 可选：商品表单草稿暂存 sessionStorage，重新登录后恢复。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### ADM-12｜P3｜报障码只在登录页展示；上传错误的处理不完整
- **位置**：
  - 各页面的 `setError(e instanceof ApiError ? e.message : String(e))`（如 `OrderDetail.tsx:68,94,114`）
  - `upload.ts:68,81,104-105`
  - `BannersPage.tsx:227-232`
- **问题**：
  - N8 承诺的报障码（traceId）只有 LoginForm 兑现了。退款失败（50000，意味着"钱可能没退成"）时，管理员拿不到可检索的 ID。
  - 两个上传调用点都不传 traceId：网络错误时报障码为空；2xx 但响应不是 JSON 时，`await res.json()` 抛出 SyntaxError，页面直接显示 "SyntaxError: …"；形状校验出错时用的是本地 traceId，而不是服务端返回的那个。
  - 上传前不预检 10MB 与 jpeg/png/webp（`accept="image/*"` 会放行 heic、svg），超限和格式不符在服务端都只回通用的 40001。
  - Banner 的文件框不清空 value，同一张图第二次选择不会触发；上传期间文件框也不禁用，并发上传时后完成的一次会覆盖 imageKey。
- **解决方案**：
  - 统一一个 `errorText(e)`，输出"消息（报障码：xxx）"。
  - upload 默认生成 traceId；JSON 解析失败归为网络错误码；形状错误使用服务端 traceId。
  - 上传前预检大小与格式；Banner 文件框在 onChange 后清空 value，上传期间禁用。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### ADM-13｜P3｜退款、发货沿用默认 10 秒超时，超时后不刷新详情
- **位置**：`client.ts:26,83-110`；`orders/api.ts:101-133`；`OrderDetail.tsx:93-95,113-115`
- **问题**：
  - client.ts 自己的注释写"写操作建议显式给更长的值"，但 `refundOrder`、`shipOrder` 都不传超时。退款的第二段是同步调用 Stripe（`admin-order-routes.ts:330`）。
  - 超时后页面显示"请求超时（10000ms）"，并继续显示 paid，而服务端可能已经进入 refunding 甚至 refunded。
  - 另外，计时器在收到响应头后就清掉了，读取响应体的过程不受超时约束。
- **后果**：再点一次时服务端会按"重试"或"查询"处理，不会退两笔钱，但页面状态误导人。
- **解决方案**：退款与发货传 `timeoutMs: 30_000`；catch 分支里也执行 `void load()`；超时文案改为"结果未知，已刷新订单状态"。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### ADM-14｜P3｜商品表单数值与标签的细节问题，以及展示格式不一致
- **位置**：`products/view.ts:242-243,249-252,233-243,89`；`OrderDetail.tsx:144`
- **问题**：
  - 库存留空 → `Number('')` = 0 → 校验通过。编辑时清空库存框会发出 `stock:0`，把库存清零。
  - `'1e3'`、`'0x10'` 被当作 1000、16 接受；`stock` 为 99999999999 也被接受，前端没有上界（probe1）。
  - 禁售标签的报错会被"未知标签"的报错覆盖（probe1）。
  - 商品列表价格显示为"12345 円"，不走 `moneyText`（其它页面都是"12,345 円"）。
  - 订单详情的状态栏显示英文原值，而列表显示中文标签。
- **解决方案**：严格整数解析（`/^\d+$/`）；空库存报错；两类标签错误拼接显示；价格统一用 `moneyText`，状态统一用 `ORDER_STATUS_LABELS`。
- **置信度**：已探针证实
- **是否已登记**：新发现

### ADM-15｜P3｜违反约束二：页面超过 150 行，且没有组件级测试
- **位置**：各页面的代码行数（不含注释和空行）：

  | 文件 | 代码行数 |
  |---|---|
  | BannersPage.tsx | 266 |
  | OrderDetail.tsx | 235 |
  | ProductFormPage.tsx | 209 |
  | RatesPanel.tsx | 191 |
  | RiskPage.tsx | 162 |
  | OrdersPage.tsx | 157 |
  | ProductsPage.tsx | 156 |

- **问题**：决策记录（约 2531 行）写明"I1 做真实页面时应补 harness"，一直没做。ADM-03、04、07、09 都是 `.tsx` 里的逻辑，230 条单测全绿却一条都没抓到。jsdom 已经在根依赖里，本次探针就是用它跑通的 OrderDetail、FxPanel、OrdersPage。
- **解决方案**：新增 vitest 的 jsdom 环境（`// @vitest-environment jsdom` 或单独一个 project），把本分片探针改写成用例；按约束二拆分页面。
- **置信度**：已读代码并实测证实
- **是否已登记**：已登记但描述有误——原记录只说"组件层无测试"，没说页面已超限、也没说因此漏掉了实际缺陷

## 3. 看过但不是问题的疑点
- **XSS**：没有 `dangerouslySetInnerHTML`，没有由数据生成的 `href`；文本都经 React 转义；`<img src>` 来自服务端拼好的 URL，不会执行脚本。
- **环境变量泄露**：dist 包里 `import.meta.env` 被替换成 `{BASE_URL:'/',DEV:!1,MODE:'production',PROD:!0,SSR:!1}`，只有 `VITE_` 前缀的变量会被注入；admin-web/ 下没有 `.env`；sourcemap 默认关闭。CF Pages 构建有 `assert-admin-deploy-env` 兜底，防止把 localhost 烤进产物。
- **CORS**：服务端 expose 了 `x-trace-id`；允许的请求头包含 authorization、content-type、x-trace-id、idempotency-key；CORS 中间件在错误兜底之前，所以错误响应体浏览器能读到。
- **空响应体**：probe5 实测 Express 的 `res.status(200).end()` 会带 `content-length: 0`，client 的 noContent 分支能正确处理。残余风险是这个判断依赖代理保留 content-length，改成先读 `text()` 再解析会更稳，但没有证据表明现在出了问题。
- **操作闸门与服务端守卫**：发货、退款、改址三个前端闸门，在 10 个状态 × 拒付 × 测试单的所有组合下，结论与服务端 `shipGuard`、`refundGuard`、`addressGuard` 一致，且都是测试单先判、拒付次之、状态最后。
- **重复提交**：发货、退款、改址、商品保存、拉黑都有 busy 状态；React 18 对点击这类离散事件同步刷新，第二次点击前按钮已经禁用；发货与退款还有服务端状态机兜底。
- **卸载后 setState**：React 18 下是空操作，不泄漏、不报错。
- **金额类型**：`db.ts` 把 int8 解析为 number，`total_jpy` 等字段是数字，`moneyText` 能正常工作。
- **登录接口的 40101 触发 onUnauthorized**：登录页本来就没有 token，清空一次无副作用。
- **登出不调用服务端**：契约里没有登出接口，JWT 无状态、12 小时过期，服务端另有 token_ver 机制，属于设计取舍，不是新问题。
- **已登记、不重复报**：缺少 CSP 与 X-Frame-Options（地基清单 ⑩）；没有"含测试单"开关；商品 PUT 整行覆盖、缺乐观锁（0.6.9）。
