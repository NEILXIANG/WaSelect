> 本文是 2026-09-29 全量逐行代码审查的 **CAT 分片（商品目录·运营配置·地址·上传）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# CAT 分片审查报告（商品目录、运营配置、地址、上传）

本分片共 24 个文件，全部逐行读完，没有修改仓库，也没有碰共享测试库。实测用的是自建库 `review_cat`（已跑完 001–014 迁移）。探针脚本放在 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/CAT/`，库保留着，方便复跑。

## 1. 覆盖清单

| 文件 | 行数 | 状态 |
|---|---|---|
| server/src/app/product-routes.ts | 214 | 已逐行读完 |
| server/src/app/admin-product-routes.ts | 200 | 已逐行读完 |
| server/src/app/admin-ops-routes.ts | 195 | 已逐行读完 |
| server/src/app/admin-banner-routes.ts | 166 | 已逐行读完 |
| server/src/app/admin-risk-routes.ts | 98 | 已逐行读完 |
| server/src/app/admin-upload-routes.ts | 157 | 已逐行读完 |
| server/src/app/address-routes.ts | 143 | 已逐行读完 |
| server/src/adapters/catalog.ts | 225 | 已逐行读完 |
| server/src/adapters/catalog-admin.ts | 165 | 已逐行读完 |
| server/src/adapters/ops-config.ts | 159 | 已逐行读完 |
| server/src/adapters/banners-admin.ts | 136 | 已逐行读完 |
| server/src/adapters/risk-admin.ts | 119 | 已逐行读完 |
| server/src/adapters/addresses.ts | 128 | 已逐行读完 |
| server/src/adapters/country-profiles.ts | 225 | 已逐行读完 |
| server/src/adapters/storage.ts | 43 | 已逐行读完 |
| server/src/adapters/storage-fs.ts | 59 | 已逐行读完 |
| server/src/adapters/storage-memory.ts | 46 | 已逐行读完 |
| server/src/adapters/image-resize.ts | 58 | 已逐行读完 |
| server/src/domain/product-input.ts | 212 | 已逐行读完 |
| server/src/domain/fx-input.ts | 98 | 已逐行读完 |
| server/src/domain/banner-input.ts | 101 | 已逐行读完 |
| server/src/domain/shipping-rates-input.ts | 87 | 已逐行读完 |
| server/src/domain/upload-image.ts | 71 | 已逐行读完 |
| server/src/ports/storage.ts | 31 | 已逐行读完 |
| **合计** | **3136** | |

为了下结论还读了分片外的依赖：
- 服务端：domain/address-input.ts；http.ts（兜底错误处理、paramId）；errors.ts；db.ts（withTransaction）；auth.ts（requireRole）。
- 审计与支付链路：app/admin-audit.ts 与 adapters/admin-audit.ts；pay-link.ts；create-order.ts §3–8；process-errors.ts。
- shared 与配置：money.ts、enums.ts；config.ts（存储与汇率相关项）；render.yaml。
- 迁移与契约：migrations 001 / 002 / 007 / 011；contracts 对应的路径与 schema。
- 前端：admin-web 的 products/view.ts 与 banners/view.ts。
- 依赖源码：busboy 1.6.0 的 `lib/types/multipart.js`；sharp 0.35.5 的 `dist/constructor.cjs`。

## 2. 发现列表

### CAT-01｜P2（R2 驱动落地后升 P1）｜可靠性：一个畸形上传能让进程崩溃退出
- **位置**：admin-upload-routes.ts:73-80（对照 :49-51 的注释）
- **问题**：busboy 的文件流没有挂 `'error'` 监听。multipart 报文在文件部分中途结束时，busboy 会用 `fileStream.destroy(err)` 抛出一个没人接的 error 事件，变成 `uncaughtException`，进而触发停机、退出码 1。
- **证据**：
  ```ts
  bb.on('file', (_name, stream) => {
    seen = true;
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('limit', () => { truncated = true; });
  });            // ← 文件流没有 'error' 监听
  ```
  busboy multipart.js:572-581 与 :604-610 在 `_destroy` / `checkEndState` 里调用 `fileStream.destroy(new Error('Unexpected end of form'))`。
- **触发与后果**：
  - 探针 `probe-upload-crash.mts` 走真实装配（`mountAllRoutes` + `createHttpApp` + 管理员 JWT）。发送一个"文件部分没有结束边界"的 multipart，结果是**HTTP 先回了 400，同时进程收到 `UNCAUGHT EXCEPTION: Unexpected end of form`**。
  - 生产里 process-errors.ts 会据此打 fatal 并以退出码 1 停机。API 是单实例（render.yaml `numInstances: 1`），所以等于全站重启，正在处理的支付回调也会被打断。
  - 生产目前的存储是 `null`，路由在读请求体之前（:96）就返回 50000，**所以今天的生产环境触发不到**。development 和 staging（允许 `STORAGE_DRIVER=fs`）可以触发。R2 适配器接上之后，任何持有管理员令牌的人或畸形客户端都能打崩服务。
  - :49-51 的注释说"报文损坏…都在此变成 40001"，与实际不符。
- **修法**：
  - 在 `'file'` 回调里加 `stream.on('error', () => reject(new AppError(40001, { reason: 'upload_malformed' })))`。
  - 加 `req.on('error'|'aborted', …)`，请求中途断开时 reject，避免 Promise 永远挂起。
  - 补 db 用例：发送无结束边界的报文 → 断言 40001，并用 `process.on('uncaughtException')` 探针断言没有触发。
- **置信度**：已探针证实｜**新发现**

### CAT-02｜P2｜并发 / 数据一致性：运费"整表替换"两次并发会合并出一张谁都不想要的表
- **位置**：ops-config.ts:141-157
- **问题**：事务用默认的 READ COMMITTED。后到的那个事务，它的 `delete` 看不到先到事务新插入的行，所以两次并发替换的结果是**两张表的并集**。
- **证据**：
  ```ts
  return withTransaction(db, async (tx) => {
    await tx`delete from shipping_rates`;
    for (const r of rows) { await tx`insert into shipping_rates …` }
  ```
- **触发与后果**：
  - 探针 `probe-ship2.mts`（连接预热后）两次并发替换，一次提交承运商 A、一次提交 B，**5/5 次**结果都是 `A:500,A:2000,B:700`，`resolveSingleActiveCarrier()` 返回 `null`，全站报价 50004。`parseShippingRates` 里"恰好一家活跃承运商"的守卫被绕过了。
  - 同一承运商、不同档位时，新旧档位混在一起，**静默算错运费**。
  - 请求体完全相同的双击会撞 23505，一个请求得到 50000。
  - 契约写的是"事务内 delete + insert，整表回滚"，当前实现只保证了回滚，不保证并发下的整表语义。
- **修法**：
  - 事务第一句加 `lock table shipping_rates in exclusive mode`。它不挡读，只让写者排队；后到事务的 delete 快照会取在拿到锁之后，能看到先到事务的结果。
  - 或者改用 `select pg_advisory_xact_lock(hashtext('shipping_rates'))`。
  - 补 db 用例：两次并发替换后，表内容必须**恰好等于**其中一次的输入。
- **置信度**：已探针证实｜**新发现**

### CAT-03｜P2｜正确性：改一个不存在的地址返回 404，却把用户原来的默认地址清掉了
- **位置**：addresses.ts:101-119（:104 的注释"语义不变"不成立）
- **问题**：`is_default=true` 时，代码先把该用户所有默认清掉，再去更新目标行。目标 id 不存在或不属于本人时，更新 0 行、返回 `null`，但事务照常提交。
- **证据**：
  ```ts
  if (input.is_default) {
    await tx`update addresses set is_default = false where user_id = ${userId} and is_default`;
  }
  const rows = await tx`update addresses … where id = ${id} and user_id = ${userId} returning …`;
  return r === undefined ? null : toRow(r);   // null 也提交
  ```
- **触发与后果**：探针 `probe-addr.mts` 结果为 `update missing id -> null | defaults before: ['a1'] after: []`。实际场景：一个标签页删了地址、另一个标签页还在编辑它并勾选默认，保存时得到 40400，同时原有默认被悄悄清掉，下单页就没有默认地址了。
- **修法**：先执行 `select 1 from addresses where id=${id} and user_id=${userId} for update`，查不到直接 `return null`，然后再"先清后设"。补 repo 用例：`update(不存在的 id, u, {is_default:true})` 之后，原默认地址仍在。
- **置信度**：已探针证实｜**新发现**

### CAT-04｜P2｜输入校验：商品输入不查列宽和数值上界，库拒绝后变成 50000；HS 码不查形状
- **位置**：product-input.ts:85-87、:147-149、:176、:184-185（对照 001 迁移的列宽）
- **问题**：`customs_desc_en` 列是 VARCHAR(120)，`hs_code` 是 VARCHAR(10)，`title_ja` / `purchase_source` 是 VARCHAR(255)，`weight_g` / `stock` 是 INT，`price_jpy` 是 BIGINT。这些在校验层都没有上限，超出后被 PG 以 22001 / 22003 拒绝，最终折叠成 50000。`hs_code` 的形状也不查。
- **证据**：探针 `probe-product.mts` 的结果：

  | 输入 | 校验 | 落库 |
  |---|---|---|
  | `customs_desc_en` 121 字 | 放行 | 22001 |
  | `hs_code:'3304.99.0000'`（12 字符） | 放行 | 22001 |
  | `hs_code:'abc'` | 放行 | **落库成功** |
  | `weight_g:2147483648` | 放行 | 22003 |
  | `stock:2147483648` | 放行 | 22003 |
  | `price_jpy:1e20` | 放行 | 22003 |
  | `title_ja` 256 字 | 放行 | 22001 |
  | `title:'   '`（纯空格） | 放行 | 落库成功 |
  | 图片三档都是空串 | 放行 | 落库成功 |

- **触发与后果**：美国 HTS 编码的常见写法 `3304.99.5000` 正好 12 个字符。运营从 USITC 网站复制过来，看到的是"服务器内部错误"，而且这次失败被当成 error 级的 `unhandled_error`。`customs_desc_en` 也不查 ASCII，日文品名会进报关单。
- **修法**：
  - 在 validateProductInput 里补：`customs_desc_en` ≤120 且只允许 `^[ -~]+$`；`hs_code` 先去掉点号，再要求 `^\d{6,10}$`；`title_ja` / `purchase_source` / `description` 限长；`weight_g` / `stock` ≤ 2147483647；`price_jpy` / `cost_jpy` ≤ 业务上限（见 CAT-05）；`title` 先 trim 再判空；图片 URL 非空且以 `https://` 开头。
  - 每条都给独立 reason，并补 120/121、10/11 这类边界表。
- **置信度**：已探针证实｜**新发现**

### CAT-05｜P2｜可用性：一个离谱的单价或汇率能让浏览页整页 500
- **位置**：product-routes.ts:82、:117、:123；product-input.ts:139；fx-input.ts:78、:96-98
- **问题**：
  - 售价没有上界。`toMinor` 在乘积超过 2^53 时抛 `RangeError`，列表和详情整页 500。按含缓冲的人民币汇率算，门槛约 1.803×10⁹ 円。
  - `raw_rate` 只要 >0 就放行。小于约 4.85×10⁻⁹ 时，对齐到 1e-8 网格后 rate=0，`toRateInt(0)` 抛错，所有浏览端点 500；报价也会是 500 而不是 50003。
- **证据**：探针 `probe-tominor.mts` 的结果：
  - `1900000000 CNY input ok= true → THROW 换算乘积超出安全整数范围`
  - `raw 4e-9 accepted, rate = 0 → toRateInt THROW 汇率必须为正数`
- **触发与后果**：店铺首页按 `created_at desc` 排序，新建的问题商品会落在第一页，整个商品列表 500。这违背了文件头 AJ-108 的承诺："浏览路径要降级、不白屏"。
- **修法**：
  - 商品单价设上界（例如 ≤ `MAX_ORDER_JPY`，或新增配置 `MAX_PRICE_JPY`）。
  - product-routes 里对每个币种单独 try，失败就省略该币种（与缺汇率时的降级口径一致）。
  - fx-input 增加 `applyFxBuffer(raw, buffer) > 0` 的校验，或给 `raw_rate` 设一个量纲下界。
  - 补路由用例：一个巨价商品在列表里时，响应仍是 200，只是 display 里少了对应币种。
- **置信度**：已探针证实｜**新发现**

### CAT-06｜P2｜合规：服务端报关禁词用词边界比对，漏掉了 `SPF50` 等常见写法
- **位置**：product-input.ts:79（注释在 :20-23）
- **问题**：正则 `\b…\b` 漏掉了最常见的真实写法。注释里说的"绕过例子"反而是能被拦住的。
- **证据**：
  ```ts
  const FORBIDDEN_DESC = /\b(medicated|whitening|spf|sunscreen|drug)\b/i;
  ```
  探针 `probe-regex.mjs`：

  | 输入 | 是否命中 |
  |---|---|
  | `UV Milk SPF50+` | 不命中 |
  | `Skin Aqua UV Gel SPF50+ PA++++` | 不命中 |
  | `Drugs` | 不命中 |
  | `Sunscreens` | 不命中 |
  | `sun-screen gel` | 不命中 |
  | `drug.store` | **命中** |

- **触发与后果**：
  - 注释说"drug.store 这种拆写能绕过"，实测是错的；真正会漏的是 `SPF50`、复数形式和连字符写法。
  - 前端 admin-web/src/products/view.ts:256 用子串匹配，比服务端还严。"服务端是权威"这层保护在服务端反而更弱：绕过前端直接调 API，或者前端将来改写，D-51 规定的 OTC 药品边界商品就能上架。
  - 单测只覆盖了 `skin SPF cream` 这种形式。
- **修法**：改成只要求左侧词边界，例如 `/\b(medicated|whitening|spf|sun-?\s?screens?|drugs?)/i`，或者直接与前端一样用子串。删掉错误的 `@limitation 一`，补 `SPF50+`、`Drugs`、`Sunscreens` 的用例。
- **置信度**：已探针证实｜**新发现**

### CAT-07｜P2｜管理端主路径："前端已有同一套校验"的说法不成立，运营只能看到笼统的 40001
- **位置**：admin-product-routes.ts:14-18；前端 admin-web/src/products/view.ts:219-259
- **问题**：`@limitation 一` 以"前端已有同一套校验，会先拦一次"为由，只把字段级错误写进日志。实际上前端 `productFormErrors` **没有**这几条：
  - food / cosmetic 标签要求必填 HS 码；
  - title ≤255；
  - jan_code ≤13；
  - 以及 CAT-04 里列出的各项上限。
- **证据**：服务端有 `if (hs === undefined && tags.some((t) => HS_REQUIRED_TAGS.includes(t))) fail('hs_code', …)`，前端整个文件里没有任何 hs_code 必填的判断。
- **触发与后果**：运营上一个带 food 标签、没填 HS 码的食品（food 是四个分类之一），得到"参数缺失或格式错误"，不知道是哪个字段，只能去翻日志。
- **修法**：
  - 把规则抽成 shared 里的一张规则表，前后端共用；或者按 limitation 里登记的方向扩展契约 `Err.data.errors`。
  - 补"前后端同夹具对拍"用例：同一组输入分别跑 `productFormErrors` 与 `validateProductInput`，判定必须一致。
- **置信度**：已读代码证实｜**新发现**

### CAT-08｜P2｜风控范围：拉黑后，被拉黑者已有的待付订单仍然能付款、之后照常发货
- **位置**：admin-risk-routes.ts:76-93；risk-admin.ts:102-117；对照 pay-link.ts:70-84
- **问题**：拉黑只写了 `blocked_at`、`token_ver+1`，作用范围只到带 Bearer 令牌的鉴权接口。无鉴权的支付短链 `/pay/link` 在解析时不查用户状态；已付款未发货的订单也不会被标记。
- **证据**：pay-link.ts 只校验 token、`status === 'pending_payment'` 和 `expires_at`，全文没有 users 或 blocked 的判断。
- **触发与后果**：拒付滥用者在被拉黑时手上还有一张 pending_payment 订单，在支付窗口内照样能通过短链到 Stripe 付款。付款成功后订单进入 paid，运营会把货发给一个已知的拒付滥用者。
- **修法**：
  - 拉黑时在同一事务里，调用现有的取消用例关掉该用户的 created / pending_payment 订单（回补库存、作废 `pay_token_hash`）。
  - mark-paid 遇到已拉黑用户，走"迟到付款转人工退款"那条既有路径。
  - 管理端订单列表对被拉黑用户标红。
  - 补链路用例：拉黑之后访问短链，应该 302 到失效页。
- **置信度**：已读代码证实｜**新发现**（COMMON 里的"迟到付款转人工退款"是另一个问题）

### CAT-09｜P2（潜在，R2 落地即升 P1）｜可靠性：大像素图会让进程超出实例内存
- **位置**：image-resize.ts:41-57
- **问题**：`sharp(input)` 用的是默认 `limitInputPixels = 0x3FFF²`（约 2.68 亿像素）。三个尺寸档位各自重新解码一遍原图，也没有预先检查尺寸和位深。
- **证据**：探针 `run-resize.mts`（基线 RSS 107MB）：

  | 输入 | 文件大小 | 耗时 | 峰值 RSS |
  |---|---|---|---|
  | 16000² 的 16 位 RGBA PNG | 3MB | 12.7 秒 | **618MB** |
  | 16000² 的 8 位 PNG | 776KB | 1.7 秒 | 300MB |
  | 16000² 的 JPEG | — | 0.8 秒 | 142MB（有加载时缩小，便宜） |

  render.yaml 里 API 的规格是 `plan: 0.5c-512mb`。
- **触发与后果**：运营上传一张厂商给的大尺寸 16 位 PNG（不需要恶意），进程就会被 OOM 杀掉；单实例意味着全站宕机。今天生产的存储是 `null`，所以触发不到。
- **修法**：
  - 改为 `sharp(input, { limitInputPixels: 40_000_000 })`，并先 `metadata()` 检查宽、高、位深，超限返回 40001 `image_too_large`。
  - 先缩到 1200 宽，再从这份结果派生 600 和 200 两档，避免解码三次。
  - 在模块初始化时设 `sharp.concurrency(1)`。
  - 补单测：合成一张 9000×9000 的 PNG，断言返回 40001。
- **置信度**：已探针证实｜**新发现**

### CAT-10｜P2｜地址校验：州码、电话、邮编只查形状，可能在付款后才发现发不了货
- **位置**：address-input.ts:40-41、:67、:103-105
- **问题**：
  - `state` 只要求 `^[A-Z]{2}$`，`ZZ`、`XX` 都能过。APO/FPO 的军邮代码（AA / AE / AP）以及 PR、GU 等领地没有任何区分。
  - 电话接受区号以 0 或 1 开头的号码，例如 `+10000000000`。
  - 邮编接受 `00000`。
  - 必填项只查长度是否为 0，纯空格的收件人、地址行、城市都能过。
- **触发与后果**：非法州码或无法派送的地址要到付款之后、发货阶段才暴露，只能退款。H2 已登记的形态清单里没有军邮和领地。
- **修法**：
  - 在 country_profiles 的 address_template 里给 state 加 `options`（模板 schema 本来就留了这个字段），服务端按表校验，军邮代码按业务决定是否拒绝。
  - 电话改为 `^\+1[2-9]\d{2}[2-9]\d{6}$`。
  - 必填项先 trim 再判空。
  - 补 manifest 形态与用例。
- **置信度**：已读代码证实｜**新发现**

### CAT-11｜P3｜并发：两次并发新建默认地址，其中一个返回 50000
- **位置**：addresses.ts:85-99
- **证据**：探针结果 `concurrent create default: ['fulfilled','rejected:23505']`。
- **后果**：数据是对的（011 迁移的部分唯一索引兜住了），但用户双击保存时，其中一次得到"服务器内部错误"，并打出一条 error 级日志。
- **修法**：事务开头加 `select 1 from users where id=${userId} for update`，把同一用户的请求串行化；或者捕获 23505 后重试一次。
- **置信度**：已探针证实｜新发现

### CAT-12｜P3｜时间解析过宽，"没有时区歧义"的注释不对
- **位置**：fx-input.ts:55-57、:87；banner-input.ts:48
- **问题**：`Date.parse` 的解析非常宽松。
- **证据**：探针 `probe-date.mjs`：
  - `"1"` 解析成 2001-01-01，`"0"` 解析成 2000 年；
  - `"2026-02-30T00:00:00Z"` 被滚成 3 月 2 日；
  - 不带偏移的 `"2026-10-01T09:00:00"` 在 `TZ=Asia/Shanghai` 下解析成 01:00Z，也就是按进程所在时区解释。
- **后果**：fx-input 注释里"毫秒是规范化的 UTC 值，没有时区歧义"不成立：歧义只是从 PG 挪到了 Node。契约要求 `format: date-time`。目前前端固定带 `+09:00`，所以正常路径没问题。
- **修法**：用严格的 RFC 3339 正则（必须带 `Z` 或 `±hh:mm`），再做一次往返校验。
- **置信度**：已探针证实｜新发现

### CAT-13｜P3｜分页参数没有上界，公开端点可以被刷出 error 级日志
- **位置**：product-routes.ts:54-61；admin-product-routes.ts:93-103
- **证据**：探针 `probe-offset.mts`：`page=1e300` 通过了 `Number.isInteger`，offset 被序列化成 `"2e+301"`，PG 报 22P02，最终 50000。
- **后果**：`/products` 不需要鉴权，任何人都能批量制造 error 级的 `unhandled_error`，干扰告警。
- **修法**：要求 `Number.isSafeInteger(page)` 且 `(page-1)*size ≤ 2^31`，或者直接给 page 设上限。
- **置信度**：已探针证实｜新发现

### CAT-14｜P3｜运费与 Banner 输入的几处校验缺口
- **位置**：shipping-rates-input.ts:65-76；banner-input.ts:63、:75-81、:97；admin-banner-routes.ts:73
- **问题**：
  - `max_weight_g`、`price_jpy`、`sort` 没有上界，INT 溢出后变成 500。
  - `active` 用的是 `!== false`，`"false"`、`0` 都会被当成启用。
  - `link_type=category` 时，`link_id` 不和 shared 里的 `PRODUCT_CATEGORY` 比对。注释以"分类是字符串字典没有表"为由不做，但枚举本身就在 shared 里，校验不需要任何 I/O。打错的分类会让小程序跳到 `/products?category=…` 然后 40001，正是文件头说的"错了不响"。
  - `link_type=none` 时仍然保存 `link_id`。
  - `image_key` 不校验是否符合 `img/<id>/detail.webp` 的形状。
- **修法**：逐条补上；`active` 要求 `typeof === 'boolean'`，缺省时视为 true。
- **置信度**：已读代码证实｜新发现

### CAT-15｜P3｜汇率落库后，按 raw_rate × (1+buffer) 不一定还原得出 rate
- **位置**：admin-ops-routes.ts:111、:124；fx-input.ts:96-98
- **问题**：`buffer` 列是 NUMERIC(6,4)，`raw_rate` 是 NUMERIC(18,8)，落库时都会被 PG 四舍五入；而 rate 是用未取整的值算的。
- **证据**：psql 实测 `0.03125::numeric(6,4)` 得到 `0.0313`，`0.006712345678::numeric(18,8)` 得到 `0.00671235`。
- **后果**：配置里 `FX_BUFFER_RATE` 只限了 [0, 0.5]，没限小数位数。库里的 rate 与 raw_rate × (1+buffer) 可能对不上，对账时是一笔说不清的账。另外，`FX_QUOTES` 写死了 CNY 和 USD，与 `DISPLAY_CURRENCIES` 配置是两个真源。
- **修法**：配置校验要求 buffer 为 0.0001 的整数倍；计算前先把 raw 取整到 8 位小数。
- **置信度**：已探针证实｜新发现

### CAT-16｜P3｜注释与实现不符（约束六）
- **问题**（逐条列出）：
  - **product-routes.ts:9-10**："`/admin/upload` 还不存在"——上传接口已经实现。
  - **catalog.ts:22**："fx_rates 只有读者没有写者"——ops-config.ts 已经在写。
  - **catalog.ts:5**："建单另起函数，不复用这里"——create-order.ts:150 直接用 `createCatalogRepo(tx)`。
  - **country-profiles.ts:22-24**："当前没有消费方"——address-routes.ts:62 在调用 `get()`。
  - **ops-config.ts:27**："同一秒提交两次得到 500"——路由已经把它映射成 40910，冲突粒度是毫秒而不是秒。
  - **risk-admin.ts:90-91**："无法走 `dispute_status` 的索引"——迁移里根本没有这条索引，真实代价是全表扫描整个 payments 表。
  - **upload-image.ts:16-17**："sharp 默认不带 libheif"——sharp 0.35.5 的 `versions` 显示 `heif: 1.23.5`，`format.heif.input` 只认 `.avif`。HEIC 解不了是因为缺 HEVC 解码器，结论没错，理由写错了。
  - **admin-upload-routes.ts:49-51**：见 CAT-01。
  - **addresses.ts:104**：见 CAT-03。
- **修法**：逐条更正。
- **置信度**：已读代码证实（sharp 那条已实测）｜新发现

### CAT-17｜P3｜约束四：地址校验写死美国规则，国家档案里的规则没人用
- **位置**：address-input.ts:40-41、:103-105；address-routes.ts:9-11、:59-66
- **问题**：路由按表查国家档案，但只检查了 `active`；档案里的 `phonePattern` / `postalPattern` / `addressTemplate` 没有任何消费方，domain 层继续写死 `+1` 和 5 位邮编。
- **后果**：在 country_profiles 里加一行 CA，国家检查能过，但加拿大邮编会被 40002 拒绝，DB 的 CHECK 约束也会拒。路由注释"上线新目的国 = 表里加一行"会误导后续开发。007 迁移的注释自称这只是"第一步"，但约束四要求新代码不得继续写死。
- **修法**：`parseAddress` 把查到的 profile 传给 domain，用档案里的 pattern 做校验；DB 的 CHECK 约束随后迁移成按国家条件判断。
- **置信度**：已读代码证实｜新发现（与 007 迁移的自述部分重叠）

### CAT-18｜P3｜契约漂移
- **位置**：product-routes.ts:162-166；addresses.ts:49；address-routes.ts:115、:134
- **问题**：
  - 公开商品详情对空值返回 `description` / `hs_code` / `customs_desc_en: null`，契约里这些字段是非空 string；管理端的同类函数 `toAdminProduct` 会省略空值字段，两边不一致。
  - 地址响应里 `line2: null`，同样与契约类型不符。
  - `/addresses/{id}` 的 PUT 实现会返回 400 和 404，DELETE 会返回 404，契约响应清单都没列。
  - 契约的 `AddressInput.state` 没有大小写约束，实现要求大写，`'ca'` 会得到 40002。
- **修法**：公开详情改为省略空值字段；契约补齐响应码。
- **置信度**：已读代码证实｜新发现

### CAT-19｜P3｜性能与分层
- **位置**：catalog.ts:124-139；risk-admin.ts:92-98；product-routes.ts:201-204
- **问题**：
  - 商品列表没有 `(status, created_at)` 或 `category` 索引，`title ILIKE '%kw%'` 走全表扫描，每次请求再单独跑一次 `count(*)`。
  - 拒付列表对整个 payments 表做全表扫描（不只是拒付行）。
  - `/fx` 在路由层直接写 SQL，绕开了仓储层，也与 ops-config"唯一读写仓储"的说法冲突。
- **修法**：
  - `create index on products (status, created_at desc, id)`；
  - `create index on payments (dispute_opened_at desc) where dispute_id is not null`；
  - 把 asOf 查询移进 `catalog.ts`。
- **置信度**：已读代码证实｜新发现

### CAT-20｜P3｜管理端行映射对空值不健壮
- **位置**：catalog-admin.ts:99；admin-product-routes.ts:56
- **问题**：
  - `customs_desc_en: String(r.customs_desc_en)` 会把 NULL 变成字符串 `'null'`（这一列在库里可空）。运营打开编辑页再保存，报关品名就被写成 `"null"`。
  - `r.images.map` 在 JSONB 不是数组时直接 TypeError。
  - 公开路径（catalog.ts:172、`imagesOf`）两种情况都处理了。
- **后果**：只有不经管理端 POST 写入的行（直接 SQL 导入）才会触发。
- **修法**：与 catalog.ts 用同一口径处理空值和非数组。
- **置信度**：已读代码证实｜新发现

### CAT-21｜P3｜合规：重新上架不重跑合规校验
- **位置**：admin-product-routes.ts:184-198；product-input.ts:82、:176-179
- **问题**：
  - `PATCH status=active` 只改状态，不重新校验。规则收紧之后（例如新增禁售标签），或者经 SQL 导入的商品，都能被重新上架。
  - HS 码必填只看标签，不看分类：category=food 但没打 food 标签时不要求 HS 码。
- **修法**：上架前读出整行，跑禁售标签、报关禁词、HS 必填三条子集，不通过返回 40001；分类为 food 时同样要求 HS 码（需要按 D-39 确认口径）。
- **置信度**：已读代码证实；分类是否应联动 HS 必填属**疑似**，缺业务口径确认｜新发现

### CAT-22｜P3｜审计缺改前值
- **位置**：admin-product-routes.ts:151-182；admin-banner-routes.ts:155-165；admin-audit.ts:69-79
- **问题**：
  - 商品 PUT（改价）和 Banner DELETE（不可逆）都没有调用 `setAuditBefore`，审计表里答不出"改之前是多少"。002 迁移注释举的例子恰好就是"什么时候改的价格"。
  - 新建商品和新建 Banner 的审计行 `target` 是 null，新生成的 id 没有进审计。
- **修法**：
  - 商品 PUT 用 CTE 在更新前取出旧行，再 `setAuditBefore`；
  - Banner 用 `delete … returning *` 拿到被删内容，再 `setAuditBefore`；
  - 新建时把新 id 放进 `res.locals`，由中间件写入 target。
- **置信度**：已读代码证实｜新发现

### CAT-23｜P3｜fs 存储：根目录带尾斜杠时所有上传都失败
- **位置**：storage-fs.ts:38、:42-43
- **证据**：探针 `probe-fs.mts`：`"…/u2/"` 和 `"./rel-dir/"` 都得到 `put FAILED: object_key_unsafe`；不带尾斜杠的写法正常。
- **后果**：开发环境把 `STORAGE_FS_DIR` 配成带尾斜杠，所有上传都是 50000。
- **修法**：改为 `const root = resolve(rootDir) + sep`（`resolve` 会去掉尾部分隔符），或者用 `path.relative` 判断越界。
- **置信度**：已探针证实｜新发现

### CAT-24｜P3｜拉黑的检查与写入之间有竞态
- **位置**：risk-admin.ts:103-116
- **问题**：先 `select is_admin`，再做一条不带条件的 update。两步之间如果对方刚被提升为管理员，会把一个管理员拉黑。`already` 标记也来自 update 之前的读，只影响日志准确性。
- **修法**：update 加上 `and not is_admin`；命中 0 行时再查一次，区分"人不存在"和"对方是管理员"。
- **置信度**：已读代码证实｜新发现

### 高风险分支缺测试（只点名）
- 两次并发运费整表替换（CAT-02）
- `update(不存在的 id, …, is_default=true)` 的副作用（CAT-03）
- 文件部分没有结束边界的 multipart（CAT-01）
- `SPF50+`、`Drugs` 的报关禁词（CAT-06）
- 各列宽、数值上限的边界（CAT-04）
- 巨价商品出现在浏览列表时的降级（CAT-05）
- 像素上限（CAT-09）
- 拉黑后访问支付短链（CAT-08）

## 3. 看过但不是问题的疑点

- **运费取档方向**：`max_weight_g >= w order by asc limit 1` 是向上取档，与 D-46 一致。
- **关键词转义**：`\`、`%`、`_` 都按 ILIKE 默认转义符 `\` 做了转义。
- **汇率缓冲的方向与取整**：rate = raw × (1+buffer)，展示外币价 = 日元 × rate，买家看到的外币价偏高，属于保守方向。先对齐 1e-8 网格，再在 `toRateInt` 取一次整，只舍入一次。实测 0.0067×1.03 精确得到 0.006901。
- **未来生效的汇率**：报价和 `findLatestFxRate` 都用 `effective_from <= now` 排除未来行；管理端列表全量返回，是设计如此。
- **运费替换中途失败**：在事务内，会整表回滚，现有测试已覆盖。问题只在并发（CAT-02）。
- **改价、下架对在途订单**：订单快照了 `unit_price_jpy`、`items_jpy`、`fx_snapshot`。建单时重算，客户端带 `expected_total_jpy` 时会给 40905；下架商品在报价和建单时经 `active` 判断为 40401。汇率变化只影响展示价和申报价值，不影响日元总额，因此不会误触发 40905。
- **PUT 商品**：不再改上下架状态；stock 省略时用 `coalesce` 保持原值。运营显式改库存时仍可能丢失更新，这一点契约 0.6.9 已登记。
- **拉黑的幂等**：`coalesce` 与 `case` 在行锁下重新求值，两次并发拉黑只会让 `token_ver` 加一次；本进程的身份缓存在拉黑后立即作废。
- **公开接口不泄露内部字段**：`/products` 与 `/products/{id}` 不返回 `cost_jpy`、`title_ja`、`jan_code`、`purchase_source`。
- **上传的存储键**：用 `crypto.randomUUID()` 生成，不可预测；fs 驱动有白名单正则、`..`/`//`/`\` 拒绝，以及 normalize 后的前缀校验，路径穿越防得住。
- **上传的其余护栏**：magic bytes 嗅探只认 jpeg/png/webp，svg、gif、avif 都拒；统一重编码为 webp，默认去掉 EXIF（含 GPS）；三档写入失败时按顺序补偿删除；busboy `fileSize` 的 +1 处理有实测注释。
- **地址归属与审计脱敏**：地址归属条件写在 WHERE 里，越权一律 40400；审计中间件对地址类 PII 键做了脱敏。
- **N+1**：列表页每次请求只查一次汇率，没有 N+1。
- **`origin_country === 'JP'` 写死**：契约 enum 与 DB CHECK 同源，属于 D-42/D-43 的既定口径，不单列。
- **跨分片线索（本分片未定论，疑似）**：create-order.ts:242-249 的 `declared_value_usd` 用的是**含 3% 缓冲的展示汇率**。AJ-142 定的是"按成交价申报"，含缓冲会让申报的美元价值偏高约 3%，建议负责建单的分片复核。
