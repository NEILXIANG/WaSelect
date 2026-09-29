> 本文是 2026-09-29 全量逐行代码审查的 **DB 分片（迁移·脚本·部署配置·契约一致性）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# DB 分片审查报告（迁移 / 脚本 / 构建部署配置 / 契约一致性）

**结论先说**：14 个迁移的 up/down 都能跑通，外键索引齐全。但有 **6 条 P2**，另有 10 条 P3：

- **DB-01**：并发请求能突破管理员账号锁定（已用探针证实）。
- **DB-02**：生产库和本地库同名，灌数据的安全闸门对端口转发到生产的情形无效，`npm run dev` 会清空生产库。
- **DB-03**：迁移往返测试查不出 003–014 任何一个 down 脚本的缺陷（注入空 down 后仍全绿）。
- **DB-04**：退款在"找得到机构通道"之前就先把订单改成退款中，通道不可用时订单会卡住。
- **DB-05**：`TERMS_VERSION` 超过 32 字符会让全站建单 500。
- **DB-06**：契约和代码注释对拒付结案的描述已经过时。

**环境说明**：开始时本机 Postgres 已停止（`postmaster.pid` 是残留文件），我用原数据目录 `/home/claude/pgdata` 执行 `pg_ctl start` 把它拉起来了，**现在保持运行**。验证迁移用的是自建的 `review_db`，审完已删除。仓库 `git status` 为空，所有探针都在 `scratchpad/review5/DB/`。

---

## 1. 覆盖清单（均已逐行读完）

| 文件 | 行数 |
|---|---|
| migrations/001_init.sql | 224 |
| migrations/002_hardening.sql | 128 |
| migrations/003_idempotency_and_identity.sql | 88 |
| migrations/004_idempotency_fencing.sql | 26 |
| migrations/005_webhook_processing_lease.sql | 44 |
| migrations/006_job_runs_trace.sql | 28 |
| migrations/007_country_profiles.sql | 83 |
| migrations/008_widen_terms_version.sql | 18 |
| migrations/009_country_profile_copy_and_index_dedupe.sql | 44 |
| migrations/010_config_tables.sql | 84 |
| migrations/011_addresses_one_default.sql | 26 |
| migrations/012_job_runs_processed.sql | 26 |
| migrations/013_dispute_opened_at.sql | 28 |
| migrations/014_admin_login_lockout.sql | 24 |
| scripts/pre-commit | 11 |
| scripts/check-contract.mjs | 182 |
| scripts/seed.ts / seed-lib.ts | 44 / 106 |
| scripts/dev-up.ts / dev-up-lib.ts | 130 / 320 |
| scripts/build-checkout.ts / checkout-build-lib.ts | 68 / 172 |
| scripts/gen-admin-tokens.ts / assert-admin-deploy-env.ts | 30 / 24 |
| render.yaml | 203 |
| .github/workflows/ci.yml（另看了 dependabot.yml 49 行） | 109 |
| package.json：根 / server / packages/shared / admin-web | 70 / 20 / 16 / 27 |
| tsconfig.json / server/tsconfig.build.json / packages/shared/tsconfig.build.json / admin-web/tsconfig.json | 31 / 28 / 21 / 32 |
| eslint.config.mjs | 325 |
| vitest.config.mts / vitest.coverage-gates.ts | 121 / 318 |
| .env.example / .gitignore / .prettierignore | 107 / 28 / 10 |
| contracts/api-contract.yaml | 499 |

**契约核对时按路由读过的实现**（不属本分片，只读与契约相关的部分）：
- 路由文件：mount.ts 全文；order-routes、order-query-routes、order-views、quote-routes、product-routes、address-routes、pay-routes、pay-intent-routes、pay-link-routes、wechat-auth-routes、admin-auth-routes、admin-order-routes（全部 handler）、admin-product/banner/ops/risk/upload-routes、internal-jobs-routes；http.ts 的 healthz/readyz 与错误兜底。
- 下游实现：adapters 下的 db.ts（createDb）、admin-auth、addresses、orders（autoAdvance）、orders-admin（列表 SQL）、payment/channels、payment/registry；domain 下的 product-input、shipping-rates-input、banner-input。

**迁移实测**：在 review_db 上跑 up 全部 → `down 14` → up，全部成功；down 到底后只剩 `pgmigrations`，没有遗留对象。

---

## 2. 发现列表

### DB-01｜P2｜安全
- **位置**：server/src/app/admin-auth-routes.ts:73-100；server/src/adapters/admin-auth.ts:62-81；migrations/014_admin_login_lockout.sql:6-7
- **问题**：锁定检查是在 bcrypt 之前单独读一次数据库，和"记一次失败"不是原子的。并发请求能全部越过锁闸，"连续失败 5 次锁定"的上限被突破。迁移 014 注释说"一条 UPDATE 原子读改写，避免第 6 次还能试"，实际不成立。
- **证据**：
  ```ts
  const cred = await findAdminCredential(deps.db, email);
  if (cred?.lockedUntil != null && cred.lockedUntil > now) { … throw new AppError(42901 …) }
  const ok = await verifyPassword(password, cred?.passwordHash ?? DUMMY_HASH);   // ~100ms
  … await recordLoginFailure(deps.db, cred.id, now, …)
  ```
- **触发场景与后果**：
  - 探针（`DB/lock-race-probe*.ts`，IP 限流替换为直通）：同一账号 30 个并发错口令 → 15 个 401、15 个 429；60 个并发 → **18 次口令校验穿过锁闸**（设计上限 5），库里显示锁被连续触发 3 次。
  - 用住宅代理池（每个 IP 在 5 次/15 分钟限额内）按"批次并发"攻击，每 15 分钟能试的次数等于并发度，不是 5。
  - 批次中的正确口令一旦排在锁生效之前完成，照样能登录。
- **解决方案**：改成"先占名额再校验"。bcrypt 之前执行：
  ```sql
  update users set failed_login_count = failed_login_count + 1,
    login_locked_until = case when failed_login_count + 1 >= $max then $now + make_interval(mins => $m) else login_locked_until end
  where id = $id and (login_locked_until is null or login_locked_until <= $now)
  returning …
  ```
  返回 0 行就回 42901；成功后用 `update … set failed_login_count=0, login_locked_until=null where id=$id and (login_locked_until is null or login_locked_until <= $now) returning id`，0 行同样回 42901。
  - 补 db 测试：30 个并发错口令，断言 401 不超过 5 条、其余 42901；批次里夹一个正确口令，断言它拿不到 token。
  - 注回缺陷：恢复成先读后判，测试必须变红。
- **置信度**：已用探针证实
- **是否已登记**：新发现

### DB-02｜P2｜安全 / 数据损坏
- **位置**：scripts/seed-lib.ts:49-57、105-108；scripts/dev-up-lib.ts:182；scripts/dev-up.ts:57-58、81-97；render.yaml:202
- **问题**：
  - 闸门②"库名拒 prod"的注释说它防的是"有人把生产 URL 指到本机代理"，但 render.yaml 里生产库名是 `databaseName: japan_shop`，和 dev 默认库名完全相同，这道闸门对生产库永远不会触发。
  - `npm run dev` 默认每次都会重新灌数据（TRUNCATE 全部业务表），而且环境变量里的 `DATABASE_URL` 优先于 `.env`。
- **证据**：
  ```ts
  if (/prod|production/i.test(dbName)) throw …        // seed-lib.ts:106
  seed: !argv.includes('--no-seed'),                   // dev-up-lib.ts:56
  databaseName: japan_shop                              # render.yaml:202
  ```
  探针 `DB/gate-probe.ts`：`assertSafeTarget('postgresql://waselect:pw@localhost:15432/japan_shop')` → **PASS**。
- **触发场景与后果**：开发者为排查生产问题开了 SSH/隧道端口转发（`localhost:15432` → Render 库），并在当前 shell 里 export 了 `DATABASE_URL`，之后在同一 shell 跑 `npm run dev`：
  1. 两道闸门都放行；
  2. 对生产库跑迁移；
  3. `truncate … restart identity cascade` 清空 orders、payments、users、order_events、admin_audit（append-only 触发器挡不住 TRUNCATE）。
  
  数据不可逆丢失。
- **解决方案**：
  1. 趁生产库还没创建，把 render.yaml 的 `databaseName` 改成 `japan_shop_prod`（创建后无法再改），让闸门②真正生效。
  2. 在 `clearBusinessTables` 前加基于库内容的闸门：`select exists(select 1 from payments where provider <> 'mock') or exists(select 1 from orders where is_test = false)` 为真就拒绝；或者由 dev-up 建库时写入 `app_config('env.kind','dev')`，seed 只认这个标记。
  3. `npm run dev` 改为只在库是新建的时候自动灌数据，重灌需要显式 `--seed`。
  - 补 seed-lib.db 测试：库里有一条非 mock 支付时 `seedOnce` 必须抛错。
- **置信度**：已用探针证实（闸门放行）；清表这一步已读代码证实
- **是否已登记**：新发现

### DB-03｜P2｜门禁失效 / 注释与实现不符
- **位置**：test/db/migrations.db.test.ts:80-89、126-129（守护本分片的迁移）；migrations/003–014 的 down 段
- **问题**：往返测试只做"全量 down 到底 → up"。001 的 down 会直接 DROP 整张表，003–014 的 down 里漏掉任何 DROP COLUMN/INDEX/CONSTRAINT 都会被掩盖。又因为 up 用了 `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，就算改成单步往返也发现不了。注释"漏 DROP 会让二次 up 失败"不成立。
- **证据**：
  ```ts
  runMigrations('down', migrationNames().length);
  expect(await businessTables()).toEqual([]);
  runMigrations('up');
  ```
  ```
  注入（DB/mig-inject：把 009/011/014 的 down 段改成 SELECT 1）
  → up、down 14、up 全部 "Migrations complete!"
  → 单步 down 1 / up 1 后 failed_login_count、login_locked_until 仍在，up 静默成功
  ```
- **触发场景与后果**：将来某个迁移的 down 写漏了。生产出事要回滚时，down"执行成功"但列、约束、索引残留，再次 up 时要么静默带着脏结构，要么在不带 IF NOT EXISTS 的语句处失败。而 gate 一直是绿的。
- **解决方案**：改成逐级快照比对。
  - 先在空库逐个 up，记录 S0…S14。每个快照用 catalog 查询生成：列（表、名、类型、可空、默认值）、`pg_indexes.indexdef`、`pg_get_constraintdef`、非内部触发器、函数。
  - 再从 14 往下逐个 `down 1`，断言结果等于 S(k-1)。
  - 注回缺陷：清空 014 的 down，必须变红。
  - 同步修正 126-129 行的注释。
- **置信度**：已用探针证实
- **是否已登记**：新发现

### DB-04｜P2｜状态卡死（跨分片，在契约核对中发现）
- **位置**：server/src/app/admin-order-routes.ts:280-331；server/src/adapters/payment/registry.ts:142-155；server/src/adapters/payment/channels.ts:154-160
- **问题**：退款第一段事务已经把订单改成 `refunding` 并提交，之后才调用 `registry.getForRefund(provider)`。这个调用在"通道未配置/未注册"时会同步抛 40001，订单就停在 refunding，机构那边什么请求都没发出。
- **证据**：
  ```ts
  } else if (!(await markRefunding(tx, id, refundReason, …))) { … }   // 第一段提交
  …
  const outcome = await executeRefund(deps, deps.registry.getForRefund(plan.pay.provider), {…
  ```
  `getForRefund`：`if (cfg === undefined) throw channelUnavailable(channel,'channel_not_configured')`（40001）。
- **触发场景与后果**：
  - 审核期结束后生产把 mock 移出 `PAYMENT_CHANNELS`，而生产环境不会注册未列出的 mock（channels.ts:154-156）。此时退审核期的测试单 → 订单变 refunding、接口回 400/40001。mock 在生产不能再开（REVIEW_MODE 约束），这张单**永久**卡在"退款中"。
  - Stripe 密钥配错或正在轮换（stripeReady=false）时退款同样卡住：买家看到"退款中"，实际没退；客服拿到的是"参数错误"。
- **解决方案**：把 `const provider = deps.registry.getForRefund(pay.provider)` 挪到第一段事务里、`markRefunding` 之前（它是同步的、不做 IO），抛错就整体回滚，状态不变。
  - 补 db 测试：用未注册的通道对 paid 单发起退款，断言订单仍是 paid、没有 refunding 事件。
- **置信度**：已读代码证实（没起 HTTP 跑）
- **是否已登记**：新发现

### DB-05｜P2｜配置与列宽不对齐
- **位置**：server/src/config.ts:310；migrations/008_widen_terms_version.sql:14；server/src/app/create-order.ts:213
- **问题**：`orders.terms_version` 是 VARCHAR(32)，但配置里的 `TERMS_VERSION` 只校验 min(1)，没有上限。
- **证据**：
  ```ts
  TERMS_VERSION: z.string().min(1, 'TERMS_VERSION 必填（建单比对，D-43）'),
  ```
  探针：插入 33 字符的 terms_version → `ERROR: value too long for type character varying(32)`
- **触发场景与后果**：运营把条款版本改成超过 32 字符（例如 `TOS-2026-10-01-revision-2-final-x`）：服务照常启动，`/terms` 也照常下发；之后**所有建单都 22001 → 50000**。这正是 008 想要杜绝的"由列宽余量决定建单成败"。
- **解决方案**：config 改为 `.max(32)`，超长时启动期就失败。再补一个 db 测试：读取 `information_schema.columns.character_maximum_length`，与配置上限做同源断言。
- **置信度**：已用探针证实（列宽）+ 已读代码证实
- **是否已登记**：新发现

### DB-06｜P2｜契约 / 注释与实现不符（钱相关闸门）
- **位置**：contracts/api-contract.yaml:348；server/src/app/mount.ts:168-175；server/src/app/mark-disputed.ts:103-108
- **问题**：三处仍写着"拒付结案（won/lost）一律把 has_dispute 复位为 false，闸门随之解锁"。但 0.6.10 ① 已经改成：败诉时保持 true，只有胜诉复位；实现（mark-disputed.ts:188）也是这样。
- **证据**：
  - 契约第 348 行：`⚠️ 0.6.7 起 has_dispute 的语义是「有进行中的拒付」：拒付结案（won/lost）时它被复位为 false，闸门随之解锁`
  - 实现：`update orders set has_dispute = ${c.result !== 'won'}`
- **触发场景与后果**：admin-web 或客服照着契约描述，会以为败诉后可以退款或发货；实际会被 40907/40909 挡住，于是被误判成 bug 去"修"闸门。
- **解决方案**：
  - 按 0.6.10 ① 改写契约第 348 行，版本号升到 0.6.12；
  - mount.ts 的 `dispute_closed` 注释、mark-disputed.ts:103 的 @why 同步改成"won 复位 / lost 保持"；
  - 可以在 contract-document 测试里加一条：refund 描述里不得出现 "won/lost 时它被复位"。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### DB-07｜P3｜约束缺位（结构不变量有盲区）
- **位置**：migrations/001_init.sql:57、77-84、159、191；test/db 的结构不变量（db.db.test.ts:516 用 `a.attname = 'status'`）
- **问题**：契约里有枚举的几列在库里没有 CHECK：
  - `payments.dispute_status`（open/won/lost）
  - `banners.link_type`（none/product/category）
  - `products.category`（4 个分类）
  - `shipping_rates.price_jpy ≥ 0`、`max_weight_g > 0`
  
  不变量只匹配列名**恰好是** `status` 的列，`dispute_status` 这类会漏掉。
- **证据**：`dispute_status VARCHAR(16),` 没有 CHECK；不变量查询写的是 `and a.attname = 'status'`。
- **触发场景与后果**：将来某个写入方写成 `'Won'` 或 `'closed'`，`/admin/disputes?status=won` 就再也查不到这条拒付；运费档写成负数时只靠应用层校验兜底。和 002 @why 讲的是同一类静默失败。
- **解决方案**：
  - 新增 015 迁移补上述 CHECK，写法与 `_status_domain` 同口径；
  - 不变量扩成 `attname = 'status' or attname like '%\_status'`，再加一张"契约枚举列 ↔ CHECK"登记表；
  - 注回缺陷：删掉 CHECK，测试必须变红。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### DB-08｜P3｜入口校验没对齐列宽 / INT 上限，会返回 500
- **位置**：
  - server/src/domain/product-input.ts:85-87、131-186（hs_code≤10、customs_desc_en≤120、title_ja/purchase_source≤255 都没校验；weight_g/stock 在 INT、price_jpy 在 BIGINT 上都没有上限）
  - server/src/app/admin-order-routes.ts:246-251（carrier≤32、tracking_no≤64 没校验）
  - server/src/domain/banner-input.ts:80-82（sort 在 INT 上没有上限）
- **证据**：探针结果：`hs_code='12345678901'` → `value too long … varchar(10)`；`weight_g=3000000000` → `integer out of range`；`customs_desc_en` 121 字符 → `varchar(120)`。http.ts 把非 AppError 一律映射成 50000。
- **触发场景与后果**：运营录入超长 HS 码或品名，或者手滑把重量填成 3e9，拿到的是 500"服务器内部错误"，而不是 40001 提示哪个字段有问题。发货时粘贴超长运单号也是 500。
- **解决方案**：在 `validateProductInput` / `parseBannerInput` / ship 路由按列宽加上限，超限报 40001 并带字段级 reason（参照 contact_email 的做法）。补边界表测试（等于上限 / 超 1）。
- **置信度**：已用探针证实
- **是否已登记**：新发现

### DB-09｜P3｜并发设默认地址返回 500
- **位置**：server/src/adapters/addresses.ts:85-117；migrations/011_addresses_one_default.sql:21-22；address-routes.ts
- **问题**："先清旧默认再设新默认"在 READ COMMITTED 下挡不住并发，后到的请求撞上 011 的部分唯一索引得到 23505，路由没有映射，返回 50000。
- **证据**：探针 `DB/addr-default-race.ts`：10 个并发 `create(is_default=true)` → 4 个成功、**6 个** `23505 … addresses_one_default_per_user`；最终只有 1 条默认，数据本身是一致的。
- **触发场景与后果**：用户双击"保存为默认"，一次成功一次 500，看到"服务器错误"的提示。
- **解决方案**：事务开头加 `select … from users where id=$1 for update`，把同一用户的地址写入串行化；或者捕获 23505 后重试一次、映射为 40903。补一条并发 db 用例。
- **置信度**：已用探针证实
- **是否已登记**：新发现

### DB-10｜P3｜契约漂移（响应清单与字段）
- **位置 / 问题**（按项目自己"响应清单漏列即漂移"的口径）：
  - `/products` GET（契约 271 行）只列 200，实现会回 400（product-routes.ts:58-59、97、101）。
  - `/orders/quote`（295 行）缺 400 / 404（40401）/ 500（50003/50004）（quote-routes.ts:43-50、domain/quote.ts:111-134）。
  - `/orders` GET（299 行）缺 400（order-query-routes.ts:55）。
  - `/orders/{id}` GET（309 行）缺 404（order-query-routes.ts:74）。
  - `/orders/{id}/cancel`（327 行）缺 400 / 404（order-routes.ts:194、cancel-order.ts:48）。
  - `/addresses/{id}` PUT 缺 400 / 404，DELETE 缺 404（address-routes.ts:115、134）。
  - `/auth/wechat/login`（213 行）缺 400 / 500。
  - `Product.description / hs_code / customs_desc_en` 实现会返回 `null`（product-routes.ts:162-166），契约写的是非 nullable 的 string。
  - `/internal/jobs/daily` 的 summary 写"对账 / **汇率刷新** / 存活校验"，实际执行的是 auto_deliver、auto_complete、reconciliation，汇率刷新不存在（catalog.ts:22 自己也写着"fx_rates 只有读者"）。
- **解决方案**：按上面补齐 responses、加 `nullable: true`、改写 summary，版本升到 0.6.12。长期看可以让 routes.contract.test 从各路由抛出的 AppError 码反推 HTTP 状态集合，与契约做双向比对。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### DB-11｜P3｜依赖声明位置错位 / 类型版本错位
- **位置**：package.json:66-69、51、47；server/package.json:7-19
- **问题**：
  - server 运行时实际 import 的 `busboy`（admin-upload-routes.ts:27）和 `sharp`（image-resize.ts:24）声明在**根** dependencies，与根 `comment:deps`（"运行时依赖一律声明在用到它的 workspace"）和 server 的 `"//"` 说明（"依赖以本包实际 import 为准"）都矛盾。`@types/busboy` 在根，而 `@types/express` 在 server，口径也不一致。
  - `@types/node ^24` 对应的 engines 是 `>=22 <23`：tsc 不会拦 Node 23/24 才有的 API。
- **证据**：用 grep 统计 server/src 非测试文件的外部 import：express、zod、postgres、sharp、pino、jose、busboy、bcryptjs。
- **解决方案**：把 busboy/sharp 移到 server/package.json 的 dependencies，`@types/busboy` 移到 server 的 devDependencies；`@types/node` 固定为 `^22`。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### DB-12｜P3｜render.yaml 细节
- **位置**：render.yaml:99-100、105-106、89-90
- **问题**：
  - ① `REVIEW_MODE` 的值 `on` 没加引号。YAML 1.1 解析器会把它读成布尔 true：本地 PyYAML `safe_load('a: on')` → `True`；而 js-yaml（仓库测试用的 1.2）读成 `"on"`。如果 Render 的解析器是 1.1 语义，config 的 `z.enum(['on','off'])` 会拒启，部署失败。
  - ② `ADMIN_OPENIDS` 的注释写"首次登录时写入 users.is_admin"，而 .env.example 和 AJ-176 都说它没有使用方，注释失真。
  - ③ `ADMIN_INITIAL_PASSWORD` 的注释写"首次登录后应改密"，但契约里没有任何改密接口。
- **解决方案**：值改为 `'on'`；按实况改写两处注释（或明确"改密需要直接改库"）。
- **置信度**：① 疑似（缺 Render 解析器语义的证据）；②③ 已读代码证实
- **是否已登记**：② 属已登记"ADMIN_OPENIDS 无使用方"，但 render.yaml 这里的描述是错的

### DB-13｜P3｜查询缺索引
- **位置**：server/src/adapters/orders-admin.ts:236-244；server/src/adapters/orders.ts:108-114
- **问题**：
  - 管理端订单列表 `order by created_at desc, id desc limit/offset` 加 `count(*)`，库里只有 `(user_id, created_at)` 复合索引和 open_status 部分索引，每一页都是全表扫描加排序。
  - 自动签收 / 自动完成的 `status='shipped'|'delivered' and has_dispute=false and <ts> <= $ order by <ts> for update skip locked` 没有对应索引。
- **解决方案**：新增迁移：`create index … on orders (created_at desc, id desc)`、`… (shipped_at) where status='shipped'`、`… (delivered_at) where status='delivered'`。
- **置信度**：已读代码证实（对照索引清单实测）
- **是否已登记**：新发现

### DB-14｜P3｜注释 / 文档失真（机械可改）
- **位置 / 问题**：
  - migrations/002:108-109 写"以 003 号迁移追加"，003:13-16 写"顺延到 005"，实际是在 **009** 落地的。
  - migrations/013:15-17 写"目前没有任何服务端代码写 dispute_*"，但 mark-disputed.ts 已经在写。
  - vitest.config.mts:8-9 写"server/src 为空目录"，:78 写 e2e"当前 4 个文件"，实际是 8 个。
  - dev-up.ts:73 失败提示"单独跑 npm run db:migrate 看完整输出"：node-pg-migrate 只在装了 dotenv 时才读 `.env`，而本仓库**没装 dotenv**，只配了 `.env` 的机器上会直接报 `DATABASE_URL environment variable is not set`（已实测）。
- **解决方案**：逐条改注释（迁移注释不影响执行）；把 dev-up 的提示改为 `DATABASE_URL=… npm run db:migrate`，或者给 db:migrate 加 `node --env-file-if-exists=.env`。
- **置信度**：已用探针证实（dotenv 那条）/ 已读代码证实
- **是否已登记**：新发现

### DB-15｜P3｜.gitignore 漏掉常见环境文件
- **位置**：.gitignore:2-5
- **问题**：只忽略了 `.env`、`.env.local`、`.env.*.local`。`.env.production` / `.env.staging` 没被忽略（`git check-ignore .env.production` 无输出）；项目本身就有 staging 环境。
- **解决方案**：改为 `.env*` 加 `!.env.example`。
- **置信度**：已用探针证实
- **是否已登记**：新发现

### DB-16｜P3｜配置表与业务列口径不一致
- **位置**：migrations/010_config_tables.sql:61；registry.ts:118；migrations/001:48；config.ts:264
- **问题**：
  - ① `payment_channels_key_shape` 允许 32 字符，而 `payments.provider`、`webhook_events.provider` 是 VARCHAR(16)，registry 也按 16 拦。将来这张表接线后，17–32 字符的 key 能通过表约束，但写入支付或回调时会报 22001。
  - ② `fx_rates.buffer` 是 NUMERIC(6,4)，`FX_BUFFER_RATE` 只限 [0, 0.5]、不限精度。配成 0.03125 时 rate 按 0.03125 计算，buffer 却存成 0.0313，同一行 rate ≠ raw×(1+buffer)。
- **解决方案**：CHECK 收紧到 `{0,15}`；config 加"≤4 位小数"的 refine。
- **置信度**：已读代码证实
- **是否已登记**：payment_channels 未接线属已登记，但列宽冲突是新发现

---

## 3. 看过但不是问题的疑点（便于复核）

- **SQL 迁移标记**：node-pg-migrate 9.0.0 的解析正则是 `^\s*--[\s-]*up\s+migration`（im），14 个文件的头注释里都没有误匹配的行。默认 `single-transaction=true`（已读 bin 源码），待跑的迁移整体原子执行。
- **外键索引**：7 个外键全部有非部分索引（catalog 实测）。009 删除重复部分索引是正确的，没有定义完全相同的索引。
- **append-only 触发器**：三张审计表 UPDATE/DELETE 都会被拒。TRUNCATE 不受影响，这是刻意设计（测试和 seed 需要）。
- **Render 蓝图字段**：`plan: 0.5c-512mb` / `0.5c-1g`、`preDeployCommand`、`postgresMajorVersion` 都在 blueprint-spec 里（2026-09-28 WebFetch 核对）。cron 能否对 web 服务用 `fromService.envVarKey`，文档两次查询结论不一致，没有找到禁止的明文，不报。
- **依赖审计**：`npm audit --omit=dev` 为 0 漏洞；全量 audit 只有 miniprogram-simulate → postcss 的高危公告，与根 `comment:audit` 的描述一致。`pg` 以 dev + peer 的形式进了 lockfile，`npm ci --include=dev` 能装上。
- **覆盖率门槛**：vitest 5 的逐文件阈值按 `relative(root, file)` 做 picomatch 匹配（已读源码），相对路径键确实生效。`cov` 失败时会置 exitCode=1，gate 会红。
- **check-contract**：实跑通过（28 个错误码、8 个枚举），隔壁文档库那份副本存在且与仓库内逐字相同。
- **seed 与测试库的清表名单**：`seed-lib` 和 `test-db` 的排除名单逐字一致。测试库闸门（`_test` 后缀）不受 DB-02 影响。
- **`.env.example` 行内注释**：Node 22 的 `util.parseEnv` 能正确剥离行内注释（探针验证了 PORT、FX_BUFFER_RATE、CORS_ORIGINS 等）。
- **int8 解析**：`createDb` 注册了 int8 → number 并带安全整数守卫；NUMERIC 保持字符串，由调用方用 `Number`/`toRateInt` 处理，ops-config 已转换。
- **已知设计，不另报**：`products_origin_jp` 与 addresses 的美国格式 CHECK 是 007 @why 自述的"第一步"，属已知设计。
- **未证实的风险（没报成发现）**：
  - CI `timeout-minutes: 15`，而 gate 里 unit/db/contract/e2e 要跑两遍（cov 再跑一遍），db 层单跑约 137 秒以上；在 GitHub 2 核 runner 上有超时可能，没有实测数据。
  - render.yaml 里数值型的 `value: 22` / `10000` 是否被 Render 接受，文档没写明。

---

**有一件事主会话可以记下**：本机 Postgres 16 用 `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/claude/pgdata -l /home/claude/pgdata/log.txt -w start"` 启动；容器重启后需要重新拉起，因为 `postmaster.pid` 会残留。
