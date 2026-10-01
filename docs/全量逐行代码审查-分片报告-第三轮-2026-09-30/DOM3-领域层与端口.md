# 第三轮全量逐行审查 · DOM 分片（domain / ports / shared）

- 基线：jp_project HEAD `50d490b`（工作区 clean），只读审查。
- 范围：`server/src/domain/**`、`server/src/ports/**`、`packages/shared/src/**`（含其测试）。
- 为下结论读过的分片外文件（只读相关段）：`adapters/http/circuit-breaker.ts`、`adapters/orders.ts:210-240`、`app/product-routes.ts:60-170`、`app/quote-assembly.ts:60-130`、`app/order-routes.ts:100-120`、`app/pay-intent-routes.ts:75-92`、`app/create-order.ts`（order_no 重试段）、`adapters/payment/stripe-checkout.ts`（retryAdviceHeader、URLSearchParams 编码）、`admin-web/src/format.ts:40-75`、`contracts/api-contract.yaml`（x-error-codes、/admin/fx、/admin/disputes、Dispute、BannerInput、ProductInput、IdemKey）、`migrations/001_init.sql`（products / addresses / banners 列型）、jp《技术文档》§1 状态表与 §7 错误码表。

## 读过的文件（逐行）

| 文件 | 行 | 文件 | 行 |
|---|---|---|---|
| shared/money.ts | 224 | shared/money.unit.test.ts | 279 |
| shared/orderNo.ts | 76 | shared/orderNo.unit.test.ts | 138 |
| shared/businessDay.ts | 61 | shared/businessDay.unit.test.ts | 53 |
| shared/enums.ts | 113 | shared/enums.unit.test.ts | 82 |
| shared/errors.ts | 220 | shared/errors.unit.test.ts | 59 |
| shared/id.ts | 51 | shared/id.unit.test.ts | 44（抽读） |
| shared/limits.ts | 58 | shared/index.ts | 18 |
| shared/design-tokens.ts | 26 | | |
| domain/quote.ts | 215 | domain/quote.unit.test.ts | 189 |
| domain/order.ts | 69 | domain/order.unit.test.ts | 118 |
| domain/order-no.ts | 37 | domain/order-no.unit.test.ts | 100（抽读） |
| domain/stock-lock.ts | 44 | domain/stock-lock.unit.test.ts | 77 |
| domain/admin-order-actions.ts | 203 | domain/admin-order-actions.unit.test.ts | 211（抽读） |
| domain/fx-input.ts | 118 | domain/fx-input.unit.test.ts | 112 |
| domain/product-input.ts | 225 | domain/product-input.unit.test.ts | 244（抽读） |
| domain/shipping-rates-input.ts | 87 | domain/dispute-input.ts | 91 |
| domain/dispute-input.unit.test.ts | 145 | domain/banner-input.ts | 101 |
| domain/banner-input.unit.test.ts | 152（契约比对段） | domain/address-input.ts | 108 |
| domain/upload-image.ts | 71 | | |
| ports/circuit-breaker.ts | 228 | ports/circuit-breaker.unit.test.ts | 215 |
| ports/http-client.ts | 262 | ports/http-client.unit.test.ts | 248（用例清单） |
| ports/idempotency.ts | 201 | ports/idempotency.unit.test.ts | 125 |
| ports/payment.ts | 453 | ports/webhooks.ts | 156 |
| ports/scheduler.ts | 255 | ports/scheduler.unit.test.ts | 103 |
| ports/events.ts | 99 | ports/rate-limit.ts | 57 |
| ports/rate-limit.unit.test.ts | 34 | ports/clock.ts / ids.ts / storage.ts / wechat-auth.ts / admin-audit.ts | 29 / 40 / 31 / 35 / 30 |

## 跑过的探针与测试（Node 22.22.2）

- `npx vitest run --project unit server/src/domain server/src/ports packages/shared/src` → 23 个文件 / 294 条全部通过（基线绿）。
- `scratchpad/round3/p1-dateparse.mjs`：`Date.parse` 在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下对 7 种输入的结果（DOM3-03）。
- `scratchpad/round3/p2-tominor.ts`（tsx）：`parseFxInput(raw_rate=600)` → `applyFxBuffer(…,0.03)` → `toMinor` 的溢出门槛；`toMinor(-1,500000)` 与 `Math.round` 对比；`allocate(-5,[0,1])` 的 -0（DOM3-05 / DOM3-06）。
- `scratchpad/round3/p3-raterint.ts`（tsx）：`toRateInt(4e-9)` 等（DOM3-04）。

**结论先行**：本分片没有发现 P0 / P1 / P2。AJ-222（熔断状态机探测超时出口）与 AJ-235（指纹深度上限）两处本轮改动逐分支核过，未发现新缺陷；错误码表 30 个码与契约 `x-error-codes`、技术文档 §7 三方一致；状态机迁移表与技术文档 §1 逐字一致且被整表断言钉住。新发现均为 P3（测试护栏空转 / 注释与事实不符 / 统一入口的防线漏口）。

---

### DOM3-01【P3】`FX_QUOTES` 声称"单测与契约双向比对"，实际没有任何比对

- **位置**：`server/src/domain/fx-input.ts:32`（注释 "契约 `POST /admin/fx` 的 quote 枚举（单测与契约双向比对…）"）；`server/src/domain/fx-input.unit.test.ts` 全文；契约 `contracts/api-contract.yaml:449`（`quote: {enum: [CNY, USD]}`）。
- **问题**：`fx-input.unit.test.ts` 不读契约，全仓 `scripts/`、`test/`、`server/src` 也没有别的地方引用 `FX_QUOTES` 做契约比对（grep 仅命中 fx-input 自身与其单测）。同目录的 `banner-input` / `dispute-input` 与 shared `enums` 都有真实的契约比对，只有这一处是口头承诺——约束九"没有强制器的纪律"的典型形态。
- **触发场景**：有人把 `FX_QUOTES` 改成 `['CNY','USD','EUR']`（或契约 enum 增删一个币）→ 单测里唯一引用 `FX_QUOTES` 的用例是"对每个 quote 都能解析"，EUR 同样通过 → 全绿；服务端接受契约外的币种、管理端下拉没有它，漂移静默。
- **证据**：【读码确认】（grep `FX_QUOTES|fx-input` 于 scripts/test/server/src）。
- **修复**：仿照 `banner-input.unit.test.ts:128-150`，在 fx-input 单测里抽 `/admin/fx` 请求体里 `quote: {type: string, enum: [...]}` 的方括号，与 `FX_QUOTES` 做集合相等；或把它加进 `scripts/check-contract.mjs` 的双向比对清单。
- **应补测试**：`expect(contractEnum('quote')).toEqual([...FX_QUOTES])`；注回（给 `FX_QUOTES` 加 `'EUR'`）必须红。

### DOM3-02【P3】拒付状态的契约比对锚错了对象：守的是 `Dispute.dispute_status`，被测函数服务的却是 `/admin/disputes?status=`

- **位置**：`server/src/domain/dispute-input.ts:32,40-48`（`parseDisputeStatus` 只用于列表查询参数）；`server/src/domain/dispute-input.unit.test.ts:122-144`（比对锚 = `dispute_status: {type: string, enum:` 那一行，即 Dispute schema）；契约 `contracts/api-contract.yaml:484`（查询参数 `status` 的 enum 仍是 `[open, won, lost]`）。
- **问题**：DB2-03 已报"查询参数 enum 缺 withdrawn"（仍存在）。本条是它背后的**护栏失效**：文件头 @why 说"比对让契约改了 enum 直接变成红灯"，但比的是响应 schema 而非查询参数，于是 `parseDisputeStatus('withdrawn')` 被接受、契约参数 enum 不含它，gate 全绿——DB2-03 这类漂移注定抓不到。另外 `:46-50` "三个合法状态各自原样带出"没有覆盖 `withdrawn` 的放行（第四态的放行从未被断言）。
- **触发场景**：现状即触发——实现接受 4 值，契约参数声明 3 值，单测绿。
- **证据**：【读码确认】。
- **修复**：比对锚改成 `/admin/disputes` 的 `name: status, in: query … enum: [...]`（参考 `enums.unit.test.ts:63` 的正则写法），同时保留对 Dispute schema 的比对；契约参数 enum 补 `withdrawn`（即 DB2-03 修法）。
- **应补测试**：查询参数 enum 与 `DISPUTE_STATUS` 集合相等（修契约前先红）；`expect(parseDisputeStatus('withdrawn')).toBe('withdrawn')`。

### DOM3-03【P3】管理端时间输入用 `Date.parse` 兜底解析：无偏移 / 非 ISO 串按**进程时区**解释，注释却称"没有时区歧义"

- **位置**：`server/src/domain/fx-input.ts:65-72`（@why "毫秒是规范化的 UTC 值，没有时区歧义——原样传字符串给 PG 的话，不带偏移的输入会按服务端时区解释"）、`:107`；`server/src/domain/banner-input.ts:44-51`（`parseAt`）。契约两处都是 `format: date-time`（RFC 3339，偏移必填）。
- **问题**：`Date.parse` 对"不带偏移的日期时间"同样按**本进程时区**解释，只是把歧义从 PG 挪到了 Node；另外它还接受大量非 RFC 3339 形态（`Oct 1 2026`、`2026/10/01`、甚至 `"1"` → 2001-01-01）。本机（Asia/Shanghai）与 Render（UTC）对同一输入相差 8 小时。
- **触发场景**：用脚本 / curl 直调 `POST /admin/fx`，`effective_from: "2026-10-01T00:00"`（运营意指 JST 零点）→ 生产存成 `2026-10-01T00:00Z`（= JST 09:00），本地开发存成 `2026-09-30T16:00Z`；`effective_from: "1"` 被接受为 2001 年。banner 的 `starts_at/ends_at` 同理。admin-web 自己发的都带 `+09:00`（`ops/view.ts:298` 的 `toIsoJst`），所以只影响非前端调用方——故定 P3。
- **证据**：【实测】`p1-dateparse.mjs`：`"2026-10-01T00:00"` 在 TZ=UTC → `2026-10-01T00:00:00.000Z`，在 TZ=Asia/Shanghai → `2026-09-30T16:00:00.000Z`；`"1"` → `2001-01-01T00:00:00.000Z`（UTC）；`"Oct 1 2026"`、`"2026/10/01"` 均被接受。另：JS Date 可表示到 ±27 万年，PG timestamptz 下限是公元前 4713 年，`"-100000-01-01T00:00:00Z"` 能过本层、落库时 22008 → 50000【推断，未连库】。
- **修复**：抽一个 domain 纯函数 `parseRfc3339Ms(raw)`：先用 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/` 要求显式偏移，再 `Date.parse`，并限定年份区间（如 2000–2100）；fx-input 与 banner-input 共用。同步更正 fx-input.ts:65-72 的注释。
- **应补测试**：`parseFxInput({…, effective_from: '2026-10-01T00:00'})` → 40001 `effective_from_invalid`（现状放行，先红）；`'1'`、`'Oct 1 2026'` 同样 40001；`'2026-10-01T00:00:00+09:00'` 仍通过。banner 同形三条。

### DOM3-04【P3】"唯一换算入口挡住 0 汇率"有漏口：`0 < rate < 5e-9` 时 `toRateInt` 返回 0

- **位置**：`packages/shared/src/money.ts:92-98`。
- **问题**：三审 P3-6 的防线是 `n <= 0` 抛错，但判定发生在**取整之前**；`Math.round(n × 1e8)` 对 `n < 5e-9` 得 0，于是返回 rateInt=0，下游 `toMinor(…, 0)` 恒为 0——正是这条防线声称要消灭的"全站按 0 元收款"。
- **触发场景**：`toRateInt(4e-9)` 或 `toRateInt('0.000000004')` → 0 → `toMinor(180000, 0)` = 0。当前生产路径不可达：库列是 NUMERIC(18,8)（最小正值 1e-8 → rateInt 1），`fx-input` 也拒 `< 5e-9`；`order-views.ts:44` 的 `toRateInt(String(raw))` 读的是快照里的库值。风险在于"唯一入口"的保证依赖上游恰好是 NUMERIC(18,8)，将来换数据源 / 放宽精度即失效。
- **证据**：【实测】`p3-raterint.ts`：`4e-9 → rateInt 0 → toMinor(180000)=0`；`'0.000000004'`、`4.99e-9` 同。
- **修复**：取整后再判：`const out = Math.round(n * RATE_SCALE); if (out <= 0) throw new RangeError('汇率小于 1e-8，整数化后为 0')`；`n <= 0` 那条可保留以给出更准确的报错文案。
- **应补测试**：`expect(() => toRateInt(4e-9)).toThrow(RangeError)`、`expect(() => toRateInt('0.000000004')).toThrow(RangeError)`；`toRateInt(5e-9)` 仍为 1。

### DOM3-05【P3】`fx-input` 放行的汇率上界（1000，含缓冲可达 1500）超出 `toMinor` 的安全域：报价 / 建单变 50000，而不是可识别的错误

- **位置**：`server/src/domain/fx-input.ts:40`（`MAX_RAW_RATE = 1000`）；`packages/shared/src/money.ts:117-118`（@limitation "按 MAX_ORDER_JPY=180,000 与 rateInt ≤ 1e8 计算…安全"）、`:124-127`；消费方 `domain/quote.ts:167`。
- **问题**：两个模块各自的"安全"假设对不上：money.ts 的安全论证假定 rate ≤ 1（rateInt ≤ 1e8），fx-input 却放行到 rate 1500（rateInt 1.5e11）。raw_rate ≳ 500 时，`MAX_ORDER_JPY` 以内的金额就会让 `toMinor` 抛 `RangeError`。浏览页有 B25 的逐商品降级兜住，**报价 / 建单 / 发起支付没有**，表现是 50000 + `unhandled_error`。
- **触发场景**：管理员把 CNY 汇率录成 `raw_rate: 600`（A8 的服务端只查上下界，前端二次确认可被绕过或误点确认）→ 所有合计 ≥ 150,000 円的购物车 `POST /orders/quote` 与建单返回 500；更低金额则显示离谱的展示价。
- **证据**：【实测】`p2-tominor.ts`：`raw_rate=600, buffer=0.03 → rate 618, rateInt 6.18e10`；`toMinor(145000)=8961000000`，`toMinor(150000)` 抛 `RangeError 换算乘积超出安全整数范围`。
- **归属**：根因属 A8 残留（"服务端仍只查上下界"，上轮已登记），本条补的是它的一个具体后果与两处注释互相矛盾；不单独升级。
- **修复**：二选一——① `MAX_RAW_RATE` 按 `Number.MAX_SAFE_INTEGER / (MAX_ORDER_JPY × RATE_SCALE × (1+MAX_BUFFER))` 推出（约 333），或按展示币量纲收紧到个位数；② `computeQuote` 的 display 循环把 `RangeError` 转成 50003（"汇率不可用"），与"缺汇率"同一处置。并把 money.ts:117 的 @limitation 改成与 fx-input 的真实上界对齐的表述。
- **应补测试**：`computeQuote(baseInput({ itemsJpy: 150_000, fxRateIntByCurrency: { USD: 61_800_000_000, CNY: … } }))` 期望 AppError 50003（现状抛 RangeError，先红）；或 `parseFxInput({quote:'CNY', raw_rate: 600})` 期望 40001。

### DOM3-06【P3】money.ts 三处注释 / 口径与实现不符

- **位置与问题**：
  1. `packages/shared/src/money.ts:104`（及技术文档 §0 同句）：公式写 `Math.round(jpy × rateInt / 1e6)`，而实现（:129-136）是"远离零"的 half-up。二者在负数上不同：`Math.round(-0.5) = -0`，实现给 `-1`。文件头 :6 与单测 :110-113"负数对称"说的是后者——公式那句与实现相反。
  2. `money.ts:75`：`MAX_RATE` 的理由写"超过它 `rate × 1e8` 会逼近 2^53"，实际 `1e6 × 1e8 = 1e14`，距 2^53（≈9.007e15）还差近两个数量级；真正的精度边界约在 rate ≈ 9e7。上界是保守的，但理由是错的（下一个人会据此以为 1e6 是硬边界）。
  3. `money.ts:202-223` `allocate`：负总额 + 零权重项会产出 `-0`（`Math.floor(-0) = -0`），而同文件 `applyRate` / `toMinor` 专门把 -0 归一（:188-191 的注释称 -0 "进 JSON/日志后无法区分地漂移"）。当前唯一调用方 `create-order.ts:258` 传正总额，不可达；属同文件口径不一。
- **触发场景**：①`toMinor(-1, 500000)` = -1，按注释公式应为 0；③`allocate(-5, [0, 1])` → `[-0, -5]`。
- **证据**：【实测】`p2-tominor.ts`：`toMinor(-1,500000)= -1  Math.round(-0.5)= -0`；`allocate(-5,[0,1]) [ -0, -5 ] Object.is(-0)=true`。
- **修复**：① 注释改为"`round_half_away_from_zero(jpy × rateInt / 1e6)`，整数商 + 余数实现"，并请文档库同步 §0；② 改写 MAX_RATE 的 @why（它是量纲护栏，不是精度边界）；③ `allocate` 末尾 `.map((v) => (v === 0 ? 0 : v))` 或在 bump 后归一。
- **应补测试**：`expect(allocate(-5, [0, 1]).every((v) => !Object.is(v, -0))).toBe(true)`（现状红）。

### DOM3-07【P3】`splitHint` 的比较方向没有被边界值钉住

- **位置**：`server/src/domain/quote.ts:179`（`totalJpy > input.maxOrderJpy`）；`server/src/domain/quote.unit.test.ts`"金额超 MAX_ORDER_JPY → splitHint=true"只用 179,000+4,950=183,950。
- **问题**：`>` 与建单硬拦（`create-order.ts:179` 同样 `>`）必须同向，否则会出现"报价说要拆单、建单却放行"或反之（MP 分片上轮核过两处当前一致）。但测试只取远离边界的值：把 `>` 改成 `>=`，全部用例仍绿——等于没有守着"恰好 180,000 可以下单"这条口径（CLAUDE.md 七类必查 B：边界有没有被跨过）。包邮阈值那条已用"恰好等于"钉住，唯独这条没有。
- **触发场景**：变异 `>`→`>=` 后 `npx vitest run quote.unit.test.ts` 仍全绿；上线后恰好 180,000 円的购物车被提示拆单，而建单实际会成功。
- **证据**：【读码确认】（全文件仅一处 splitHint=true 断言，无 false 边界断言）。
- **修复 / 应补测试**：`computeQuote(baseInput({ itemsJpy: 175_050, shippingJpy: 4950 })).splitHint === false`（total 恰为 180,000），`itemsJpy: 175_051` → true。

---

## 统计

| 级别 | 条数 |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 7（DOM3-01 ～ DOM3-07） |

## 上轮遗留在本分片的状态（只列一行）

| 原编号 | 状态 | 当前位置 |
|---|---|---|
| R-01 / AJ-222 熔断永久卡死 | 已修，复核无回归（half_open 时间出口、进入 half_open 重置计时、名额回收都逐分支核过） | `ports/circuit-breaker.ts:137-186` |
| INF2-03 / AJ-235 指纹递归无深度上限 | 已修，复核无回归（32 层、容器才计深、40001） | `ports/idempotency.ts:49-79` |
| ORD2-02 / AJ-239、ORD2-01 / AJ-240 新码 40912 / 40913 | 已修；shared 表、契约 `x-error-codes`、技术文档 §7 三方一致（30 个码） | `shared/errors.ts:151-172` |
| B25 / AJ-211 单价上界、汇率下界 | 已修（`price_too_large`、`raw_rate_too_small`）；上界侧的溢出另见 DOM3-05 | `domain/product-input.ts:154`、`domain/fx-input.ts:98` |
| PAY2-06 `CB_COOLDOWN_MS` 可为 0 | 仍存在 | `config.ts:494`（端口侧无下限校验） |
| PAY 同类小问题：half_open 名额回收不重置计时 | 仍存在 | `adapters/http/circuit-breaker.ts:142-144` |
| PAY P3 熔断阈值理由 / 引用不存在的 `DEFAULT_RETRY_POLICY.totalBudgetMs` | 仍存在 | `ports/circuit-breaker.ts:89-91`、`:173-175` |
| PAY P3 payment.ts 三处注释（JPY 口径、eventId 兜底、ProviderRejectedError"什么都没建"） | 仍存在 | `ports/payment.ts:21-23`、`:173`、`:270-271` |
| INF-09 "logger 不做自动脱敏（已核实）" | 仍存在 | `ports/scheduler.ts:229` |
| INF-16 `ids.ts`"D32 待办"、50300 action 写"按 Retry-After"而服务端不设该头 | 仍存在 | `ports/ids.ts:20-21`、`shared/errors.ts:195` |
| ORD-10 过期说法（0.5% 碰撞率、三口径未定、"无当日行"、关税取整方向与技术文档 `ceil` 不符） | 仍存在 | `shared/orderNo.ts:19`、`domain/quote.ts:15-16,146,161` |
| ORD-12 写死展示币联合类型 | 仍存在 | `domain/quote.ts:29` |
| ORD-14 地址 `String()` 强转 | 仍存在 | `domain/address-input.ts:75,79` |
| ORD P3 孤儿 JSDoc、"三个订单操作"、`p-xxx` | 仍存在 | `domain/admin-order-actions.ts:2,103-122`；`domain/stock-lock.ts:13` |
| B24 输入与列宽 / 整数上限不同源 | 仍存在（`weight_g`/`stock`/`cost_jpy`/`sort`/`max_weight_g`/`price_jpy` 无上界） | `domain/product-input.ts:156-173`、`domain/shipping-rates-input.ts:65-71`、`domain/banner-input.ts:80-83` |
| B26 报关禁词 `\b…\b` | 仍存在 | `domain/product-input.ts:20-23,79` |
| B30 地址只查形状 | 仍存在 | `domain/address-input.ts:40-41,67,104` |
| CAT2-04 注释称"保存汇率直接 500" | 仍存在 | `domain/fx-input.ts:50-51` |
| CAT P3 `adapters/catalog.ts`、`ProductInputValue.stock`、`limits.ts`"小程序同源引用" | 仍存在 | `domain/product-input.ts:5,169`；`shared/limits.ts:2` |
| DB2-03 `/admin/disputes` 参数 enum 缺 withdrawn | 仍存在（其护栏失效见 DOM3-02） | `contracts/api-contract.yaml:484` |
| TSA-13 报价测试期望值用被测取整口复算 | 仍存在 | `domain/quote.unit.test.ts:120-122,176-177` |
| D-74 `ORDER_STATUS_DISPLAY` 无消费方、与两端文案不一 | 仍存在 | `shared/enums.ts:97-108` |

另核过、无问题的点（免得下一轮重查）：`clipRefundReason` 截出的孤立代理项经 `URLSearchParams` 编码为确定的 `%EF%BF%BD`，重试同键同参成立；`stockRestorePlan` 的 collation 走 `tx.unsafe` 拼接常量而非参数化，SQL 合法；`scopeKey` 前两段不含冒号，不存在跨用户撞键；`retryAdviceHeader` 常量为小写、与 fetch-client 的小写化头表一致；`asOrderStatus` / 迁移表整表断言能抓"多加一条边"。
