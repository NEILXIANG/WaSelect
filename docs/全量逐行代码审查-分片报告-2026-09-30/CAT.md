# CAT 分片审查报告（第二轮，2026-09-30）——商品目录、运营配置、地址、上传

审的是工作区当前文件。没有修改仓库、没有跑测试、没有连库。探针是纯 Node（`review2/CAT-probes/probe-nul.mjs` 与两段 `node -e`），未 import 任何连库代码。

## 1. 覆盖清单

26 个非测试文件、3337 行，全部逐行读完。

| 文件 | 行数 |
|---|---|
| server/src/app/product-routes.ts | 254 |
| server/src/app/admin-product-routes.ts | 200 |
| server/src/app/admin-ops-routes.ts | 195 |
| server/src/app/admin-banner-routes.ts | 166 |
| server/src/app/admin-risk-routes.ts | 116 |
| server/src/app/admin-upload-routes.ts | 157 |
| server/src/app/address-routes.ts | 143 |
| server/src/adapters/catalog.ts | 225 |
| server/src/adapters/catalog-admin.ts | 165 |
| server/src/adapters/banners-admin.ts | 136 |
| server/src/adapters/ops-config.ts | 183 |
| server/src/adapters/addresses.ts | 141 |
| server/src/adapters/country-profiles.ts | 225 |
| server/src/adapters/storage.ts | 43 |
| server/src/adapters/storage-fs.ts | 59 |
| server/src/adapters/storage-memory.ts | 46 |
| server/src/adapters/image-resize.ts | 58 |
| server/src/ports/storage.ts | 31 |
| server/src/domain/address-input.ts | 108 |
| server/src/domain/banner-input.ts | 101 |
| server/src/domain/fx-input.ts | 118 |
| server/src/domain/product-input.ts | 225 |
| server/src/domain/shipping-rates-input.ts | 87 |
| server/src/domain/upload-image.ts | 71 |
| packages/shared/src/limits.ts | 58 |
| packages/shared/src/design-tokens.ts | 26 |
| **合计** | **3337** |

为下结论另读的分片外文件：`app/block-user.ts`、`adapters/risk-admin.ts`、`app/admin-audit.ts`、`app/unit-of-work.ts`、`adapters/db.ts`、`adapters/orders.ts`（lockPayableOrdersOfUser / voidInitiatedPayment）、`http.ts`（paramId、B20 改动）、`packages/shared/src/money.ts`、`config.ts` 相关键、`migrations/001`/`011` 及各迁移里对配置表的约束、`contracts/api-contract.yaml`（/admin/fx）、`admin-web/src/ops/FxPanel.tsx` 与 `view.ts`、`admin-web/src/products/ProductFormPage.tsx`、`mount.ts` 的限流挂载。

看过的修复提交（`git diff 848278d..HEAD`）：B22（df3f563）、B23（e5e6746）、B25（35f8345）、B28（7bbb3ef）、B7/B17 对 limits.ts 的新增。**四个修复本身没有发现回归**，细节见第 4 节。

## 2. 发现

P1：0 条。P2：1 条。P3：9 条。

### CAT2-01｜P2｜汇率二次确认比的不是"当前生效值"，而是该币种最早的一行

- **位置**：`server/src/app/admin-ops-routes.ts:95-105`、`server/src/adapters/ops-config.ts:88-97`（返回全量、`quote asc, effective_from desc`）；消费方 `admin-web/src/ops/FxPanel.tsx:46-53`（另见 :10-12 的注释）。跨片：根因在两侧对同一个接口的理解不一致，前端文件属 ADM 片。
- **问题**：`GET /admin/fx` 返回全部行（历史 + 未来），契约 0.6.3 也这么写。FxPanel 却逐行执行 `rates[q] = r`，同币种后面的行覆盖前面的行，最后留下的是**排在最后的那一行，即最早录入的一行**。它既不是当前生效行，也不排除未来行。FxPanel 自己的注释还写着"服务端按 `effective_from <= now` 取最新一条，没有历史列表接口"，与服务端事实相反。
- **证据**：
  ```ts
  // FxPanel.tsx:46-53
  for (const x of Array.isArray(list) ? list : []) {
    ...
    if (q !== '' && Number.isFinite(r) && r > 0) rates[q] = r;   // 后者覆盖前者
  }
  setCurrentRates(rates);
  ```
  探针（复刻该循环，输入按服务端排序：未来行 0.0071 / 当前 0.0069 / 0.0067 / 最早一行曾录错 0.69）：
  ```
  currentRates = { USD: 0.69 }
  录入正确值 0.0069 → ratio 0.0100 risky true
  录入错值 0.69 → ratio 1.0000 risky false
  ```
- **触发与后果**：
  - 基线永远停在第一次录入的值。第一次录错过（随后更正）的话，此后每次正确录入都被标红，运营养成"无脑勾确认"的习惯；而与那次错值同量级的再次录错反而**不标红**。A8 加的二次确认在这种情况下方向相反。
  - 第一次没录错时，基线是上线当天的汇率，随时间漂移，提示文案里的"与当前生效值相差约 X%"是错的数字。
  - `FxPanel.tsx` 是 `.tsx`，这段循环没有任何测试（`view.unit.test.ts` 只测了 `fxPreview` 给定 `currentRate` 后的行为）。
- **修法**：
  - 前端：把取基线抽成 `view.ts` 的纯函数 `currentFxRates(list, nowMs)`：每个币种取 `effective_from <= now` 的第一行（列表已按倒序）；补单测（含未来行、多行历史）。更正 FxPanel :10-12 的注释。
  - 或者服务端在 `FxRate` 上加 `current: boolean`（需改契约），前端只读这个标记。两者选一，不要两处各判一次。
  - 今天正在修的 FxPanel 三项（取不到当前汇率放行 / 确认态不复位 / save 不再校验）不含这一条，建议并入同一次修复。
- **置信度**：已探针证实（循环复刻）+ 已读代码证实（服务端排序与契约）。
- **严重度**：P2（钱的展示价与申报价值的录入护栏在特定条件下失效或反向）。

### CAT2-02｜P3｜公开接口带 `%00` 可稳定制造 50000 + error 日志

- **位置**：`product-routes.ts:139-147`（keyword）、`:188`（`String(req.params.id)`）；`catalog.ts:123-129`、`:157`。
- **问题**：keyword 和商品 id 只判了"是字符串"，没有拒绝 NUL 字符。Postgres 的 text 不接受 0x00（报 22021 `invalid byte sequence for encoding "UTF8": 0x00`），全局错误处理不映射任何 SQLSTATE，于是落到 50000 + `unhandled_error`。
- **证据**：探针 `probe-nul.mjs`（Express 5，开 `case sensitive routing`）：
  ```
  /p/%00            200 {"id":"\"\\u0000\"","len":1}
  /q?keyword=%00    200 {"kw":"\"\\u0000\"","type":"string"}
  ```
  即 NUL 原样到达 handler，随后作为参数进 SQL。
- **触发与后果**：`GET /api/v1/products?keyword=%00`、`GET /api/v1/products/%00` 都无需鉴权、无限流。与 B20、CAT-13 同类：扫描器可以批量刷 error 级日志，淹没真实 5xx。管理端 JSON 里带 `\u0000` 的 title 等字段同样 50000（需登录，影响小）。
- **修法**：keyword 与路径 id 在路由层拒绝控制字符（`/[\u0000-\u001f]/` → 40001；id 直接按 CAT2-03 的形状正则走 40401）。更彻底的做法是在全局错误处理里把 SQLSTATE 22 类（数据异常）映射为 40001 + warn，一处兜住 CAT-13、B24 的同类表现。补路由用例。
- **置信度**：Express 侧已探针证实；Postgres 侧拒绝 0x00 是**疑似需实跑**（本轮不允许连库）。

### CAT2-03｜P3｜客户端可控的长字符串不经形状校验进日志

- **位置**：`product-routes.ts:191`（`new AppError(40401, { product_id: String(req.params.id) })`）；`admin-product-routes.ts:154,176,187,193`、`admin-banner-routes.ts:130,147`、`admin-risk-routes.ts:90,95-96,105`；`address-routes.ts:64`（`country: input.country`）。
- **问题**：本分片只有 `address-routes` 用了 `paramId()`，且 `paramId` 自己声明"不校验字符集"。其余路由把原始路径参数直接放进 `AppError.details` / 日志 ctx / 审计 target。地址的 `country` 是 `String(b['country'])`，任意长度、任意内容，拒绝时原样进 details。
- **证据**：探针：`/p/` + 8000 个字符 → handler 收到完整 8000 字符。`http.ts:536,546` 把 `details` 整体写进日志字段；logger/redact 没有长度截断（只有深度上限 6）。
- **触发与后果**：`GET /api/v1/products/<约 16KB>` 每次产生一条十几 KB 的日志行，无鉴权、无限流。七类必查项 G 类（可控输入进日志）。`country` 最大可到 JSON 体上限 100KB（需登录）。
- **修法**：在 `http.ts` 加 `entityId(value)`：`^[A-Za-z0-9_-]{1,64}$`，不合形状直接按"不存在"处理（商品 40401、其余各自的 404 码），不查库、不把原值进 details。`parseAddressInput` 里 country 先过 `^[A-Z]{2}$`（不合 → 40002，details 不带原值）。
- **置信度**：已探针证实（长度透传）+ 已读代码证实。

### CAT2-04｜P3｜B25 只包住了 `toMinor`，`toRateInt` 仍在 try 之外；配置表没有任何 DB 层约束

- **位置**：`product-routes.ts:120`、`:156`；`migrations/001_init.sql:43-52`（fx_rates）、`:77-84`（shipping_rates）、`:188-199`（banners）；`fx-input.ts:48-51` 的注释。
- **问题**：
  - `minorOrUndefined` 只 catch `toMinor`。`toRateInt(rate)` 对 `rate ≤ 0`、非有限数、`≥ 1e6` 都会抛，而它在降级函数之外，抛了就是整页 500。
  - 写入侧现在有 `MIN_RAW_RATE` / `MAX_RAW_RATE`，但 `fx_rates.rate` 没有 `CHECK (rate > 0)`，任何绕过管理端的写入（seed、手工 SQL、将来的汇率同步 job）都能写出 0。B25 自己的测试注释明确说"读取侧必须自己能降级，不能假设库里不会有"，这一半没做到。
  - 同理 `shipping_rates` 没有 `price_jpy >= 0`、`max_weight_g > 0`；`banners` 没有 `link_type` 域约束和 `ends_at > starts_at`。全部不变量只存在于 domain 校验函数里，约束九的"结构不变量"只覆盖外键索引与 status 列。
  - `fx-input.ts:50-51` 写"⇒ `toRateInt(0)` 抛错 ⇒ 保存汇率这条管理端写路径直接 500"。实际写路径不调用 `toRateInt`，库里也没有 CHECK，修复前的真实形态是**保存成功 201，之后所有读路径 500**。注释把失效形态写错了。
- **修法**：
  - `product-routes.ts` 把 `toRateInt` 放进同一个按币种降级的 try（失败打 `display_rate_invalid`，省略该币种）。补用例：直接插一行 `rate = 0` 的汇率，列表与详情仍 200。
  - 新迁移：`fx_rates` 加 `CHECK (rate > 0 AND raw_rate > 0 AND buffer >= 0)`；`shipping_rates` 加 `CHECK (price_jpy >= 0 AND max_weight_g > 0)`；`banners` 加 link_type 域约束。
  - 更正 `fx-input.ts:50-51`。
- **置信度**：已读代码证实（`money.ts` 的 `toRateInt` 抛错条件、迁移全文 grep 无相关 CHECK）。另已探针确认 `MIN_RAW_RATE` 边界本身没问题（`raw = 5e-9`、buffer 0～0.5 对齐后都是 1e-8，不会舍成 0）。

### CAT2-05｜P3｜运费整表替换的"改前值"在锁外读，并发时审计与日志记的是过期的表

- **位置**：`admin-ops-routes.ts:177-179`；`ops-config.ts:146-180`。
- **问题**：B22 给替换加了表锁，但路由里 `before = await repo.listShippingRates()` 在事务和锁之外。两次并发保存时，两个请求读到的 before 都是最初那张表；后到者真正覆盖掉的是先到者刚写入的表，这张表没有进它的审计 before，也没有进它的 `admin_shipping_rates_replaced` 日志。
- **后果**：文件头说这条审计存在的理由是"整表替换不可逆，一定要答得上'之前是多少'"。并发下后到者的答案是错的（先到者写入的内容只能从它自己的审计 after 里反推）。
- **修法**：`replaceShippingRates` 在拿到锁之后、`delete` 之前用 `selectShippingRates(tx)` 读出 before，返回 `{ before, after }`；路由用它调 `setAuditBefore`（此时响应尚未 end，时序允许）。补用例：沿用 B22 的并发用例，断言后到者的 before 等于先到者的输入。
- **置信度**：已读代码证实。

### CAT2-06｜P3｜商品可选字符串字段类型不对时被静默当成"没填"，PUT 会把原值清空

- **位置**：`product-input.ts:90-92`（`strOpt`），用在 :189（hs_code）、:197（jan_code）、:208（description）、:218（title_ja）、:220（purchase_source）。
- **问题**：`strOpt` 对非字符串返回 `undefined`，与"没传"不可区分。PUT 是整行覆盖，路由把 `undefined` 写成 `null`。
- **证据**：探针 `strOpt(330499) = undefined`。`hs_code: 330499`（数字）→ 校验通过 → 落库 `hs_code = null`；带 food 标签时则报 `hs_code_required`，提示"没填"而实际是"类型错"。
- **后果**：非前端调用方（脚本批量导入、将来的接口使用者）传错类型时，既不报错也不落库，原有值被清空。属 B24 同类但不在其清单内。
- **修法**：字段存在且非 null 且不是字符串 → `fail(field, '<field>_invalid')`；补边界表。
- **置信度**：已探针证实 + 已读代码证实。

### CAT2-07｜P3｜公开读接口没有限流，keyword 没有长度上限

- **位置**：`product-routes.ts:126-183`、`:185-215`、`:225-253`；`mount.ts` 只给 quote / create / pay / pay.link / login 挂了限流。
- **问题**：`GET /products` 每次请求 3 条 SQL（列表、`count(*)`、汇率），其中两条是无索引的 `ILIKE '%kw%'`（CAT-19 已记索引）；keyword 长度只受 URL 上限约束。`/products/{id}` 与 `/fx` 同样无限流。连接池 `max: 10` 与支付回调共用。
- **后果**：商品量小的时候单次代价很低，短期不是问题；商品上千之后，脚本刷带长 keyword 的列表会占住连接池，影响回调落账。属于需要提前登记的容量风险。
- **修法**：keyword 限 64 字符（超出 40001）；给公开读加一条宽松的 IP 限流规则（例如每分钟 300 次），走现有 `rateLimitRules` 表；`/fx` 的第二条 SQL 并进 `findLatestFxRates`。
- **置信度**：已读代码证实。

### CAT2-08｜P3｜商品图把完整 URL 存进业务表，与 Banner 的 AJ-143 论证相反

- **位置**：`admin-upload-routes.ts:146-154`（返回 `${IMG_BASE_URL}/${key}`）；`product-input.ts:94-112`（images 三档任意字符串）；`catalog-admin.ts:130,143`；`product-routes.ts:38-47`（原样透传）。对照 `admin-banner-routes.ts:15-19`。
- **问题**：Banner 存 `image_key`、读时由服务端拼域名，文件头明写"把完整 URL 存进业务表，换域名/换图床时要改历史数据"。商品走的恰恰是被否掉的做法：`products.images` 里是带域名的三档 URL（`ProductFormPage.tsx:101-109` 把上传返回的 URL 原样存入）。
- **后果**：开发期 `IMG_BASE_URL` 指向本机静态服务，R2 落地后换成 CDN 域名，届时所有已录商品的图片全部失效，需要一次数据迁移。自主决策记录里没有这一条取舍。B24 的"图片 URL 要求 https 开头"修法会把这个形态进一步固化。
- **修法**：趁商品量还小，把 `products.images` 改成存 `image_id`（或三档 key），读路径用 `IMG_BASE_URL` 拼；上传接口已返回 `image_key`，前端改存它即可。至少先把取舍登记进自主决策记录。
- **置信度**：已读代码证实。

### CAT2-09｜P3｜地址写操作的日志答不出"改了哪一条"

- **位置**：`address-routes.ts:95`、`:135`；PUT（:104-122）没有日志。
- **证据**：`deps.logger.info('address_created', { result: 'ok' })`、`address_deleted` 同样只有 `result`，不带 address id；更新成功不打日志。
- **后果**：约束七要求关键路径能回答"谁、做了什么、对哪个对象"。用户投诉"我的默认地址怎么变了"时，日志只能看到有过一次 create，不知道是哪条、是否设了默认。
- **修法**：三处都打 `{ address_id, is_default }`（id 不是 PII）；补测试断言。
- **置信度**：已读代码证实。

### CAT2-10｜P3｜新增的注释与实现不符（上一轮 CAT-16 之外）

| 位置 | 问题 |
|---|---|
| `admin-risk-routes.ts:24` | "封号是本项目**唯一**不可逆的写操作"。`admin-ops-routes.ts:16` 自称运费整表替换不可逆，Banner DELETE 也不可逆。 |
| `ops-config.ts:87` | `selectFxRates` 的说明写"replaceShippingRates 要在同一事务里读回结果"。后者读的是运费表，`selectFxRates` 从未在事务里用过。 |
| `addresses.ts:66` | 接口注释"不存在或非本人 → false"，实际返回 `null`。 |
| `product-input.ts:5` | "不做落库（那是 `adapters/catalog.ts`）"，实际是 `catalog-admin.ts`。 |
| `product-input.ts:169`、`catalog-admin.ts:50` | 引用 `ProductInputValue.stock`，该类型不存在（叫 `ProductInput`）。 |
| `country-profiles.ts:48` | "见 @limitation 五"，文件头只有一～四。 |
| `country-profiles.ts:194-195` | "国家档案会被报价/建单/下单页反复读"，与同文件 :22 "当前没有消费方"自相矛盾；实际只有 `address-routes` 一个消费方。 |
| `admin-banner-routes.ts:146` | "（文件头 @why）"，文件头没有关于 PUT 0 行命中的 @why。 |
| `limits.ts:2` | "server / admin-web / 小程序同源引用"，小程序没有任何引用。 |
| `fx-input.ts:50-51` | 见 CAT2-04。 |

修法：逐条更正。置信度：已读代码证实。

## 3. 上一轮未修旧项状态

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B21（CAT-01） | 仍在 | `admin-upload-routes.ts:73-79` 文件流仍无 `'error'` 监听，也没有 `req` 中断处理；生产 storage 为 null 时触发不到。 |
| B24（CAT-04） | 部分 | 只补了 `price_jpy` 上界（B25）；`customs_desc_en` 120、`hs_code` 10、`title_ja`/`purchase_source` 255、`weight_g`/`stock`/`cost_jpy` 上界、title 纯空格、图片空串都还在。 |
| B26（CAT-06） | 仍在 | `product-input.ts:79` 仍是 `\b…\b`，@limitation 一 的错误说法也还在。 |
| B27（CAT-07） | 仍在 | `admin-product-routes.ts:14-18` 仍称前端有同一套校验；新增的 `price_too_large` 前端同样没有。 |
| B29（CAT-09） | 仍在 | `image-resize.ts:42` 仍是默认像素上限、三档各解码一次。 |
| B30（CAT-10） | 仍在 | `address-input.ts:40-41,67,104` 未变。 |
| CAT-11 | 仍在 | `addresses.create` 无串行化；B23 之后 `update` 路径在并发设默认时同样会撞 23505（无死锁）。 |
| CAT-12 | 仍在 | `Date.parse` 宽松；另外 `effective_from` 没有范围护栏，早于现行行或远未来的时间写入成功但永不生效。 |
| CAT-13 | 仍在 | `page=1e300` 仍 50000；B20 的修复没有覆盖它。 |
| CAT-14 | 仍在 | 运费 / Banner 的数值上界、`active !== false`、category 不比对枚举、image_key 形状均未变。 |
| CAT-15 | 仍在 | buffer / raw_rate 落库取整与 rate 不同源。 |
| CAT-16 | 大部分仍在 | 只有 `addresses.ts` "语义不变"那条随 B23 成立了；其余 8 条原样。 |
| CAT-17 | 仍在 | 国家档案里的 pattern 仍无人消费。 |
| CAT-18 | 仍在 | 公开详情仍返回 `null` 字段；地址 `line2: null`。 |
| CAT-19 | 仍在 | 无新索引；`/fx` 仍在路由里直接写 SQL。 |
| CAT-20 | 仍在 | `catalog-admin.ts:99` `String(r.customs_desc_en)`。 |
| CAT-21 | 仍在 | 重新上架不重跑合规校验。 |
| CAT-22 | 仍在 | 商品 PUT、Banner DELETE 无改前值；新建无 target。 |
| CAT-23 | 仍在 | `storage-fs.ts:38` 尾斜杠。 |
| CAT-24 | 仍在 | `risk-admin.ts:110-121` 现在在事务里，但 select 没有 `for update`，update 也没有 `and not is_admin`。 |

## 4. 看过并确认没问题的高风险点

- **B22 表锁**：`lock table … in exclusive mode` 是事务第一句，不存在锁升级；全仓库只有这一处写 `shipping_rates`，没有任何 `for update/share` 读它，所以报价与建单读路径不受影响。`lock_timeout` 5s 确实是连接级参数（`db.ts:161`）。测试用"A 持住不提交、B 500ms 内跑不完"做判据，并在两次提交后重读库，能区分有锁与无锁。
- **B23 先锁后清**：逐个枚举了"两个并发 update 都设默认"、"update 与 create 并发"、"update 与 delete 并发"的锁序。同一用户任一时刻最多一行默认，清默认那句最多等一行，构不成环，没有死锁；最坏结果是 23505（CAT-11 同类）。
- **B25 降级**：列表与详情两处都走 `minorOrUndefined`；`logger` 已进 `ProductRoutesDeps`；测试同时断言 200 与 error 日志。上界取 `MAX_ORDER_JPY` 由两处调用点都正确传入。
- **B28 拉黑**：封号与取消在同一事务；锁序是 users 行 → orders（id 升序）→ 库存汇总回补。全仓库只有这一处 `update users`，建单对 users 只取外键的 KEY SHARE，与封号的行锁不冲突。`publishAll` 在提交后执行且不抛，路由随后的身份缓存作废一定会执行。拉黑与在途建单请求之间的窗口属已知项（mark-paid 不查拉黑），不重复报。
- **MIN_RAW_RATE 边界**：探针确认 `0.5/1e8` 在 buffer 0～0.5 下都对齐成 1e-8，注释里"对任意合法 buffer 都成立"成立。
- **运费取档方向**、关键词 ILIKE 转义、公开接口不泄露 cost_jpy / title_ja 等内部字段、地址归属进 WHERE、上传 key 由服务端 UUID 生成且 fs 驱动双重防穿越、三档写入失败的补偿删除：与上一轮结论一致，代码未变。
- **limits.ts / design-tokens.ts**：两个常量各有真实消费方（config、改密脚本、退款校验、admin-web）；颜色同源由 `checkout-build-lib.unit.test.ts:163-170` 钉住，`app.wxss` 五色与 `WS_COLORS` 当前一致。
- **fs 默认目录**：`npm run dev` / `start` 的 cwd 是仓库根，`./var/uploads` 命中 `.gitignore:28`。

## 5. 状态核对（2026-10-05，第五轮）

第二轮（2026-09-30）之后又过了第三轮、`C3-ORD / PAY / DB / SEC` 与 `C3-CAT` 本轮十二次提交。
**本节是回读代码本身得出的结论，不是给原报告打勾**——原报告的"仍在"已被证实**大面积过期**
（首次发现见 `docs/自主决策记录.md` §2 第 74 条，本轮是它的**第四次复发**：CAT2-01 / B21 / CAT-23 / B26）。

### 5.1 复核后**已关闭**（不要再排期）

| 编号 | 实际落点 | 判定依据（读代码看到的） |
|---|---|---|
| CAT2-01（P2） | **ADM3-05**：服务端下发 `is_current` | `admin-ops-routes.ts:128-139` 用 `findLatestFxRate` 算当前行；`view.ts:254` `currentFxRawRates` **只认**服务端标记、不认本机时钟。报告建议的"前端传 `nowMs`"没有被采纳——那会让前端出现第二份"现在几点" |
| CAT2-02 | 全局 SQLSTATE 22 类映射 | NUL 现在落在 22021 → 统一 40001，不是 50000（§2 第 74 条实测） |
| CAT2-03 | AJ-356 | `redact.ts` / 日志出口按字段限长 |
| CAT2-04 | AJ-357（读侧降级）+ DB 分片 AJ-331（迁移 023 补 17 条 CHECK） | **`toRateInt` 已进同一 try 按币种降级**；`fx_rates` 的 `rate > 0` 等约束已下沉到库。报告写的"只在 domain 校验里"已不成立 |
| CAT2-05 | AJ-354 | `replaceShippingRates` 在**锁内**读 before（`ops-config.ts:196` 之后） |
| CAT2-06 | AJ-352 | 存在且非字符串 → `<field>_invalid`，不再折叠成"没填" |
| CAT2-07（前半） | AJ-360 | `keyword` 已有长度上限 |
| CAT2-08 | AJ-361 / AJ-362 | 改存 `image_id` + 管理端回显。⚠️ **存量 URL 条目的一次性迁移未做**，登记为 AJ-361 ③（刻意推迟到"新旧并存"稳定之后） |
| CAT2-09 | AJ-355 | 地址写日志带 `address_id` / `is_default` |
| CAT2-10 | AJ-358 + **AJ-363**（本次补 B27） | 见下：报告里"前端已有同一套校验"这条注释**至今仍与事实不符**，已订正 |
| B21 | 已在 | `admin-upload-routes.ts:81` `bb.on('error', …)` |
| B26 | 注释部分已修 | `product-input.ts:21-24` 的 @limitation 一 已把 `\b` 写成**刻意不补的洞**并给了理由；`\b` 本身保留是取舍不是遗漏 |
| CAT-23 | PAY3-05 | `storage-fs.ts:33` 用 `resolve` 取代 `normalize`（尾斜杠坑已堵，注释里写清了） |
| CAT-20 | **AJ-363（本次）** | `catalog-admin.ts` 的 `toRow` 是唯一没有 null 守卫的可空列；已改读出 `string | null` + 响应整键省略 |

### 5.2 复核后**仍开着**（未修）

| 编号 | 现状 | 为什么现在不做 |
|---|---|---|
| B27（注释，已在 AJ-363 顺带订正） | ~~仍称前端有同一套校验~~ | 已改成如实写：前端 `view.ts:343` 对 `price_jpy` **只判 `>= 1`**，没有上界 ⇒ `price_too_large` 在前端无处可拦 |
| B29 | `image-resize.ts:59` 仍是 sharp **默认像素上限**（未设 `limitInputPixels`）；`.clone()` 已让三档共用一次解码，"各解码一次"那一半自然消失 | 上传是**管理员鉴权**路径且有文件大小上限（busboy），残余风险是"合法大小的解压缩炸弹占内存" ⇒ 属容量/韧性议题，随 C5 告警一起定 |
| CAT-24 | `risk-admin.ts:110` `select is_admin…` **无 `for update`**，随后的 `update` 也**没有 `and not is_admin`** |  select→update 之间有 TOCTOU 窗口（`选择的这一瞬间还不是 admin` → 之后被提权）。触发需要"提权与封号在同一毫秒并发"，实践中不存在；修它要重新论证 SEС/B28 那条已写好的锁序，收益不匹配 |
| CAT2-07（后半） | 公开读接口**没有 IP 限流** | 依赖真实流量数据选型 + 依赖 C5 告警（否则 429 自身不可观测），属 U7 之后的事（详见 §2 第 77 条拆法） |
| CAT-11/12/13/14/15/17/18/19/21/22、B24 余、B30 | **本轮未逐条复核** | 诚实说明：这 15 条我**没有回读代码**，不能凭 2026-09-30 报告的"仍在"下结论——那正是本节开头说的过期问题。它们的存在与否需要在继续 CAT 时逐条回读，或在 C8 复查期一并处理 |

> **给下一次的提醒**：本节 5.1 的每一行都写着"判定的依据是哪一段代码"。
> 再有人拿本报告排期时，**先看依据是否还成立**，别看编号是否在表里。
