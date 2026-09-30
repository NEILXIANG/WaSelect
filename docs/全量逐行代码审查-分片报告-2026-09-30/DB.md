# DB 分片审查报告（第二轮，2026-09-30）——迁移 / 脚本 / 部署配置 / 契约一致性

审的是**工作区当前文件**（HEAD = 41d40ba，与 origin/main 同提交；本分片内文件无未提交改动）。
全程只读仓库；未跑 npm 脚本/测试/构建；未连库；未读 `.env`。探针只在 `scratchpad/review2/DB-probes/` 下运行。

**结论**：P1 0 条，P2 2 条，P3 8 条。迁移 001–015 的 up/down 逐行读完，没有发现会让迁移失败或留下死状态的缺陷；上一轮 B31 / B32 / B33 / B8 / A1(DB-01) 在本分片内的部分已落地。两条 P2 一条是 B31 修复带来的回归（内容闸门把默认配置下的日常开发挡死），一条是本机门禁跑在测试框架自己声明不支持的 Node 25 上且没有任何机制报错。

---

## 1. 覆盖清单

| 文件 | 行数 | 备注 |
|---|---|---|
| migrations/001–015（15 个） | 224/128/88/26/44/28/83/18/44/84/26/26/28/24/53 = 924 | up 与 down 都逐行读 |
| scripts/dev-up.ts / dev-up-lib.ts | 130 / 320 | |
| scripts/seed.ts / seed-lib.ts | 44 / 154 | |
| scripts/build-checkout.ts / checkout-build-lib.ts | 68 / 172 | |
| scripts/check-contract.mjs / assert-admin-deploy-env.ts / pre-commit | 182 / 24 / 11 | |
| scripts/gen-admin-tokens.ts / admin-password.ts / admin-password-lib.ts | 30 / 61 / 74 | 后两个是上轮之后新增（B17） |
| render.yaml / .env.example | 218 / 109 | |
| .github/workflows/ci.yml / dependabot.yml | 109 / 49 | |
| package.json：根 / server / shared / admin-web | 71 / 20 / 16 / 27 | |
| tsconfig.json / server、shared 的 tsconfig.build.json / admin-web/tsconfig.json | 31 / 28 / 21 / 32 | |
| eslint.config.mjs / vitest.config.mts / vitest.coverage-gates.ts / .nvmrc | 325 / 142 / 318 / 1 | |
| contracts/api-contract.yaml | 537 | 全文 |
| server/src/app/mount.ts | 396 | 全文 |
| 17 个 *-routes.ts（address / admin-auth / admin-banner / admin-ops / admin-order / admin-product / admin-risk / admin-upload / internal-jobs / order-query / order / pay-intent / pay-link / pay / product / quote / wechat-auth） | 共 2960 | handler 全读；admin-product-routes、admin-upload-routes、address-routes 三个文件的**文件头注释**（各前 25–30 行）只看了开头，未逐行 |

合计约 62 个文件、7600 行。为下结论另读：`adapters/admin-auth.ts` 全文、`domain/dispute-input.ts`、`app/login-attempts-cleanup.ts`、`app/webhook-results.ts`、`app/admin-audit.ts` 与 `adapters/admin-audit.ts` 相关段、`admin-web/src/api/token-store.ts`、`test/db/migrations.db.test.ts`、`test/db/test-db.ts` 相关段、`scripts/seed-lib.db.test.ts` 的 diff、`docs/测试策略与验证门禁.md` §4.2、上一轮分片原文与主报告 4.5 / 5.5。

契约逐路径核对结果：契约 37 个「方法 + 路径」与实现一一对应（`GET /home` 登记在 NOT_IMPLEMENTED）；鉴权口径（`security: []` 的 9 条公开路径、其余 bearer、`/internal/*` 共享密钥）全部一致。字段 / 响应码层面的差异见 DB2-03、DB2-04。

---

## 2. 发现

### P2

#### DB2-01｜P2｜B31 修复的回归：内容闸门的前提不成立，默认配置下本地下过一张单后 `npm run dev` / `npm run db:seed` 永久拒绝

- **位置**：`scripts/seed-lib.ts:93-94,110-127,145`；`scripts/dev-up.ts:81-97`；`scripts/dev-up-lib.ts:56`；`server/src/app/create-order.ts:208`；`.env.example:61,71`；`scripts/seed-lib.db.test.ts`「只有审核期测试单与 mock 支付行 → 放行（不能把日常开发挡死）」
- **问题**：闸门④的判据是"库里有 `is_test=false` 的订单或 `provider <> 'mock'` 的支付行就拒"，依据是注释里的这句：
  ```
  内容闸门不认名字：库里只要有"真业务"的痕迹就拒，因为 dev 库里的订单只可能是
  审核期测试单（`is_test=true`）、支付行只可能来自 `mock` 通道。
  ```
  而 `is_test` 只在审核模式下为 true：
  ```ts
  is_test: reviewMode,            // create-order.ts:208
  REVIEW_MODE=off                 // .env.example:71（dev-up 物化出来的 .env 就是它）
  PAYMENT_CHANNELS=mock,stripe    // .env.example:61
  ```
  也就是默认开发配置下，本地建的**每一张**订单都是 `is_test=false`；用 Stripe test mode 联调时支付行是 `provider='stripe'`。两条判据在日常开发里都会命中。
- **触发场景与后果**：
  1. 新机器 `npm run dev` → 用小程序开发者工具或 curl 下一张单 → 停服务 → 再 `npm run dev`。
  2. `dev-up-lib.ts:56` 默认 `seed: true`，第三步「灌假数据」抛 `拒绝清表：库里有 1 张 is_test=false 的**真订单**…请确认 DATABASE_URL 指向的是本机开发库，而不是端口转发到生产的库`，`runSteps` 失败即停，**服务不起**。
  3. 错误文案把人引向"是不是连到生产了"，而实际只是本地下过单；闸门注明"不提供 `--force`"，出路只有每次手敲 `--no-seed` 或删库。
  4. 注释自己写了后果："拦太宽比不拦更危险……于是有人会把闸门删掉"——现在正是拦太宽的形态。测试用 `is_test=true` 的订单证明"日常开发不被挡"，把错误前提钉成了正确。
- **修复方案**（三选一或叠加，推荐 ①+②）：
  ① `dev-up.ts` 改为**只在库是新建的时候自动灌**（`ensureDatabase` 返回 `'created'`）；已存在的库要重灌必须显式 `--seed`（上一轮 B31 修法第 3 条，未落地）。这样日常重启不碰数据，闸门④只在人主动要求清表时出现。
  ② 闸门④改成**环境标记**而不是猜内容：`ensureDatabase` 建库成功后写 `app_config('env.kind') = '"dev"'`（`app_config` 在清表排除名单里，不会被 seed 清掉），`assertNotProductionData` 改为"标记不是 dev 就拒"。生产库永远不会有这个标记，开发库不受订单内容影响。
  ③ 至少把错误文案改成两种可能都说（"本地下过的普通订单也会触发；确认是开发库请用 `npm run dev -- --no-seed`"），并改掉 `seed-lib.ts:93-94` 与测试标题里"dev 库的订单只可能是 is_test=true"这句不成立的话。
  - 测试：用**默认配置**（REVIEW_MODE=off）经 `createOrder` 建一张单再 `seedOnce`，断言行为与文档一致；注回验证：把标记判定删掉必须红。
- **置信度**：已读代码证实（未实跑 dev-up；`is_test` 赋值、默认 seed、默认 REVIEW_MODE 三处都是直接读到的）
- **附带**：闸门④放在 `clearBusinessTables` 之前后，对**未迁移的库**跑 `npm run db:seed` 会先在 `select … from orders` 处抛 42P01，`seed-lib.ts:79` 那句"库里没有业务表：迁移是不是没跑？先 npm run db:migrate"变成不可达。

#### DB2-02｜P2｜本机 gate 跑在 Node 25.3.0 上：vitest 自己声明不支持该版本，仓库内没有任何机制会报错

- **位置**：`package.json:7-11`（engines / packageManager）；`.nvmrc`；`scripts/pre-commit`；`.github/workflows/ci.yml:89-92`；`render.yaml:56-57,187-188`；无 `.npmrc`
- **事实（全部已探针 / 已读证实）**：
  - 本机 `node -v` = v25.3.0（V8 14.1、undici 7.18.2、ICU 78.2、OpenSSL 3.6.3），`npm -v` = 11.7.0；机器上只装了这一个 Node。engines 要求 `node >=22 <23`、`packageManager: npm@10.9.7`。
  - 仓库根没有 `.npmrc`，没有 `engine-strict`；全仓 grep `process.version` / `versions.node` / `engine-strict` 零命中；`pre-commit`、`gate`、`dev-up.ts`、`vitest.config.mts` 都不检查 Node 主版本。npm 只在 `npm install` 时打一条 `EBADENGINE` 警告，不失败。
  - `package-lock.json` 里 **vitest 5.0.1 的 engines 是 `^22.12.0 || ^24.0.0 || >=26.0.0`**——Node 25 被测试框架明确排除。也就是 CLAUDE.md 完成标准第 5 条引用的每一次本机 `gate-exit=0`，都产生于测试框架声明不支持的运行时。
  - Node 25 上存在、Node 22 上不存在的全局：`Promise.try`、`RegExp.escape`、`Uint8Array.fromBase64`、`Error.isError`、`URLPattern`、`Float16Array`、`Intl.DurationFormat`（探针逐个 `typeof` 为 function）。`@types/node` 实装 24.13.6（声明 `^24`，另有 dependabot 分支要升到 26），tsc 对 Node 23/24 才有的 `node:*` API 不会报错。
  - Node 25 默认启用 Web Storage：探针 `typeof localStorage === 'object'`、`typeof localStorage.getItem === 'undefined'`，并打 `--localstorage-file was provided without a valid path` 警告。`admin-web/src/api/token-store.ts:88` 的 `typeof localStorage === 'undefined' ? undefined : localStorage` 在 Node 22 走 undefined 分支、在 Node 25 拿到一个没有方法的对象（靠 try/catch 降级）——同一段代码两个版本走的分支不同。
- **风险评估**：
  - **已排除的**：grep `server/src`、`scripts`、`packages/shared/src`、`admin-web/src`、`miniprogram` 的非测试代码，上面那批新全局、`toSorted`/`groupBy`/`withResolvers`/Set 方法等**零使用**；`Intl` / `toLocale*` 在服务端零使用；出站错误分类（`ports/http-client.ts:152-155`）按 `TimeoutError` / `AbortError` / `TypeError` 名字判，undici 6 与 7 一致；`.env.example` 用本机 `util.parseEnv` 解析出 63 个键、行内注释全部正确剥离。**今天的代码没有发现已经依赖 Node 25 的地方**。
  - **仍然成立的**：① v8 覆盖率的分支计数随 V8 版本变化，40 多条逐文件 100% 门槛在 Node 25 上过不等于在 CI 的 Node 22 上过（反之亦然）；② 仓库里所有关于 Node 行为的 `@measured`（busboy 上限、bcrypt 耗时、`process.loadEnvFile`、execFile 错误形态等）都是在 25 上测的，生产是 22；③ 将来任何人写下一个 23+ 才有的 API，本机类型检查、lint、全部测试都绿，只有 CI 或生产启动时才红；④ lockfile 由 npm 11 写、CI 由 npm 10 `npm ci` 读。
  - **兜底现状**：CI 固定 Node 22 并在 push 到 main 后跑同一条 `npm run gate`，HEAD 已推到 origin/main，所以 Node 22 这一关是存在的——但它是**事后**的（直接推 main，不挡提交），本机没有 `gh`，我无法确认最近几次 CI 是否为绿。交付说明里的 gate 结论目前只来自 Node 25。
- **修复方案**：
  1. 根目录加 `.npmrc`：`engine-strict=true`（`npm ci` / `npm install` 在错版本上直接失败）。
  2. `gate` 与 `pre-commit` 最前面加一步版本断言（`.npmrc` 管不到 `npm run`）：新增 `scripts/assert-node-version.mjs`，读根 `package.json` 的 `engines.node`，`process.versions.node` 主版本不是 22 就 `exit 1` 并提示 `nvm use`；`gate` 改为 `node scripts/assert-node-version.mjs && npm run format:check && …`。
  3. `test/config/` 加一条同源断言：`.nvmrc`、`engines.node`、`ci.yml` 的 `node-version`、`render.yaml` 两处 `NODE_VERSION` 必须是同一个主版本（现在是五处各写一份，没有任何检查）。
  4. `@types/node` 固定 `^22`，并在 `dependabot.yml` 对它加 `ignore: update-types: ["version-update:semver-major"]`。
  5. 本机装 Node 22（`nvm install 22`）后**重跑一次 gate**，把这次的通过数作为基线；在此之前把"本机 gate 绿"当作"Node 25 上绿"来读。
- **置信度**：已探针证实（版本、全局、localStorage、vitest engines、无检查机制）；"覆盖率计数会不同"是疑似，需在 Node 22 上实跑 `npm run cov` 对比。

### P3

#### DB2-03｜P3｜契约：拒付相关三处没跟上 0.6.13 / 0.6.14

- **位置**：`contracts/api-contract.yaml:470`、`:530`、`:214,216`；`server/src/domain/dispute-input.ts:32`
- **问题与证据**：
  - `/admin/disputes` 的查询参数 `status` 仍是 `enum: [open, won, lost]`，实现接受四个值：`DISPUTE_STATUS = ['open','won','lost','withdrawn']`（0.6.13 只给 `Dispute.dispute_status` 加了 `withdrawn`，漏了查询参数）。按契约生成的前端下拉筛不出 withdrawn。
  - `AdminOrder.has_dispute` 的描述仍写"**仅胜诉结案复位**"，而 0.6.13 起 won 与 withdrawn 都复位，0.6.14 起还可人工解除；同文件第 379 行的退款描述已经改对，两处自相矛盾。
  - 40907 / 40909 的登记文案是"存在**进行中的**拒付"，而败诉后（已结案）同样返回这两个码；客服看到"进行中"会去等结案，实际永远不会解。
- **修复**：参数 enum 补 `withdrawn`；描述改为"lost 保持，won / withdrawn 复位，另可人工解除（0.6.14）"；两条错误文案改为"存在未解除的拒付限制"（shared `errors.ts` 同步，check-contract 会双向拦）。`dispute-input.unit.test.ts` 的契约比对把查询参数也纳入。
- **置信度**：已读代码证实

#### DB2-04｜P3｜契约漂移（上一轮 DB-10 之外的新增项）

- **位置与问题**：
  - **有响应体却写成无体**（项目自己在 0.6.6② 定的口径："把实际有 body 写成无 body 比漏列状态码更糟"）：`POST /admin/orders/{id}/ship` 实回 `{order_id, status, carrier, tracking_no}`（admin-order-routes.ts:277）；`POST /admin/orders/{id}/address` 实回 `{order_id, address}`（:507）；`POST /orders/{id}/cancel` 实回 `{ok: true}`（order-routes.ts:204）。契约三处都只有 `'200': {description: OK}`。
  - **503 / 50300 漏列**：熔断打开时 `errors.ts:79` 映射 50300（HTTP 503 + `retry_after_ms`），会从 `POST /orders/{id}/pay`、`POST /admin/orders/{id}/refund`、`POST /auth/wechat/login` 三条出站路径冒出来；契约这三条的 responses 都没有 503（只有 `/readyz` 与回调列了 503）。
  - **契约比实现宽松的上限**：`OrderItemsInput` 无 `maxItems`（实现 50，quote-routes.ts:37）；`contact_email` 无 `maxLength`（实现 255）；`AddressInput` 各字段无 `maxLength`（实现按列宽 100/20/200/200/100/10 拦 40001）、`state` 无 `pattern`（实现 `^[A-Z]{2}$`）；`/auth/admin/login` 的 email / password 无 `maxLength`（实现 255 / 1024）。
  - `AdminOrder.payments[]` 实回多一个 `created_at`（:239），契约 schema 没有。
  - `/internal/jobs/daily` 的 summary 仍是"对账 / 汇率刷新 / 存活校验"；实际是 auto_deliver → auto_complete → 对账 → login_attempts 清理（internal-jobs-routes.ts:88-93），比上一轮又多漂了一项。
- **修复**：逐条补进契约并升 0.6.16；长期做法同上一轮建议——让 routes.contract.test 从各路由可抛出的错误码反推状态集合做双向比对。
- **置信度**：已读代码证实

#### DB2-05｜P3｜`npm run admin:password`（B17 新增）：口令与邮箱被 npm 原样回显；不显示改的是哪个库；不留审计

- **位置**：`scripts/admin-password.ts:6-9,28-51`；`scripts/admin-password-lib.ts:44-46,56-73`；`package.json:41`
- **问题与证据**：
  - 探针（scratch 目录、同名 script）：
    ```
    $ npm run admin:password -- boss@example.com 'S3cret-new-password-32'
    > sigprobe@0.0.0 admin:password
    > node -e 0 boss@example.com S3cret-new-password-32
    ```
    npm 把参数原样打到 stdout。`admin-password.ts:48` 的"成功也**不打印邮箱**（约束七）"因此不成立，新口令明文进终端回滚缓冲（录屏、tmux 日志、CI 日志都会带上）。
  - 两处注释互相矛盾：`admin-password.ts:9` 写"口令会出现在 shell history 与 ps 输出里"；`admin-password-lib.ts:45-46` 写"参数至少不会落进 history 文件"（命令行参数恰恰会进 history）。
  - `:19` 从当前目录加载 `.env`，`:28` 取 `DATABASE_URL`，成功时只打印 `已重设口令，token_ver=N`，**不显示目标主机与库名**。泄露后轮换的场景下，操作者忘了传生产 URL 时改的是本地 dev 库的同邮箱管理员，输出与改生产时一模一样——以为轮换了，实际没有。
  - `:43` 失败分支打印了完整邮箱，与 `:48` 的口径相反。
  - 不写 `admin_audit`（管理员改密是约束七点名的管理员操作；中间件只覆盖 HTTP 路径）；不清 `login_attempts`，被锁的管理员改完密仍要等锁到期。
- **修复**：口令改为从 stdin 无回显读取（`readline` + 关闭回显），或读环境变量 `ADMIN_NEW_PASSWORD`，命令行只留邮箱；成功与失败都打印 `host/dbname`（不含凭据）并要求非 localhost 目标二次输入库名确认；写一行 `admin_audit(actor='cli', action='admin_password_reset', target=<user id>)`；同事务删该邮箱的 `login_attempts` 行；失败分支不打邮箱；改掉 lib 里那句错的注释。
- **置信度**：已探针证实（npm 回显，npm 11.7.0）；其余已读代码证实

#### DB2-06｜P3｜迁移 012 给 `job_runs.last_processed` 定的语义已被 daily 作业的组成打破

- **位置**：`migrations/012_job_runs_processed.sql:4-11`；`server/src/app/scheduler.ts:180`；`server/src/app/internal-jobs-routes.ts:88-93`；`server/src/app/login-attempts-cleanup.ts`
- **问题与证据**：012 的说法是"对账 job……`last_processed = 0` 是好消息（无异常），`last_processed > 0` 才是要人去看的"。实际写入的是**同一轮所有 job 的和**：
  ```ts
  const processed = results.reduce((sum, r) => sum + (r.ok ? r.processed : 0), 0);
  ```
  而 `daily` 这一轮现在有四个 job：自动签收条数 + 自动完成条数 + 对账异常条数 + 被清掉的登录尝试行数。只要前一天有人输错过一次管理员口令，或有一张单到期自动签收，`job_runs('daily').last_processed` 就 > 0。
- **后果**：看门狗"看一眼 job_runs 就知道扫出几条异常"这条用途失效——非零是常态，真异常混在里面分不出来；全仓也没有任何读者读这列（grep 只有写入方）。
- **修复**：要么在 `job_runs` 加 `last_anomalies integer`（只由对账 job 上报，`JobOutcome` 增一个可选字段），`last_processed` 改注释为"本轮各 job 处理条数之和，不代表异常"；要么按 job 名各写一行。012 的注释同步改。
- **置信度**：已读代码证实

#### DB2-07｜P3｜015 在同一个发布里"建新表 + 删旧列"，而部署顺序是先迁移、旧实例仍在服务

- **位置**：`migrations/015_login_attempts.sql:40-42`；`render.yaml:38`（`preDeployCommand: npm run db:migrate`）
- **问题**：`preDeployCommand` 在新版本启动**之前**执行，Render 在新实例健康前旧实例继续接流量。015 的 up 直接 `DROP COLUMN login_locked_until, failed_login_count`，旧版本代码（014 口径）读这两列——从迁移完成到新实例接管的窗口内，旧实例上的管理员登录会 42703 → 500。另外正在生效的锁随列一起消失（等于部署即解锁）。
- **后果**：当前生产未上线，这一次不会造成事故；但仓库里没有"破坏性变更分两次发布（先停用、下个版本再删）"的纪律，下一次对 `orders` / `payments` 这类表做同样的事就是下单路径 500。
- **修复**：在 `docs/` 的迁移约定与 render.yaml 注释里写明 expand → contract 两步走；`test/lint` 可加一条简单检查：同一迁移的 up 段出现 `DROP COLUMN` / `DROP TABLE` / 收紧约束时，文件头必须带 `@breaking` 说明（豁免写原因）。
- **置信度**：已读代码证实（部署窗口行为依据 render.yaml 注释与 blueprint 文档对 `preDeployCommand` 的描述，未在真平台实测）

#### DB2-08｜P3｜微信登录的 `code` 没有长度上限

- **位置**：`server/src/app/wechat-auth-routes.ts:29`；`server/src/adapters/wechat/code2session.ts:43-47`；`server/src/adapters/wechat/dev-auth.ts:26`；`migrations/001_init.sql:18`
- **问题**：`z.object({ code: z.string().min(1) })` 只有下限。无鉴权入口上，客户端可以送接近 JSON body 上限长度的 `code`，它被原样拼进发往 `api.weixin.qq.com` 的查询串；开发替身下 `openid = prefix + code` 超过 `users.openid VARCHAR(64)` 时是 22001 → 50000（仅 dev/test）。
- **修复**：`.max(128)`（微信 code 实际 32 字符左右，留余量），超长 40001；契约同步 `maxLength`。补边界用例（等于上限 / 超 1）。
- **置信度**：已读代码证实（微信侧对超长 code 的反应未实测）

#### DB2-09｜P3｜上一轮之后新增 / 重写的钱与安全核心没有进逐文件覆盖率门槛

- **位置**：`vitest.coverage-gates.ts:68-318`
- **问题**：门槛表里没有 `server/src/adapters/admin-auth.ts`（登录额度与锁的全部原子语句）、`app/admin-auth-routes.ts`、`app/refund-execution.ts`、`app/mark-disputed.ts`、`app/block-user.ts`。它们只受全局 85% 约束；而本轮"第 5 次输对也被锁"正出在 `admin-auth.ts` 的一个分支上。CLAUDE.md 约束九把"关键模块 100% 门槛"列为防"靠全局均值蒙混"的机制。
- **修复**：先实测这五个文件当前的四项数值；已是 100% 的直接钉 100%，有防御分支到不了的按 §4.2 的 🟡 口径登记原因。
- **置信度**：已读代码证实（门槛表缺项）；各文件当前实际覆盖率未测

#### DB2-10｜P3｜注释 / 文档失真（本轮新出现的）

| 位置 | 问题 | 改法 |
|---|---|---|
| `.env.example:68` | "账号维度另有『连续失败 5 次锁 15 分钟』（**users 行上，迁移 014**）"——015 已把它搬到 `login_attempts`，users 两列已删 | 改为"login_attempts 表，迁移 015；键为邮箱哈希" |
| `.env.example:25-27`；`ci.yml:76-77` | 仍写"推导出 japan_shop_test"。AJ-216 之后 e2e 用 `japan_shop_e2e_test`，且 `TEST_DATABASE_URL` 里的**库名会被忽略**（只取主机与凭据，test-db.ts:89-93）——模板没说，照模板填自定义库名的人会以为生效了 | 两处补一句 |
| `render.yaml:36-37` | `preDeployCommand` 仍标"NEEDS VERIFICATION"。render.com/docs/blueprint-spec（2026-09-30 取回）：该字段适用于 web service，"runs after the service's buildCommand but before its startCommand" | 改成 `@measured(文档, 日期)` 并删掉退路说明 |
| `render.yaml:57` vs `:188` | web 的 `NODE_VERSION` 是裸数字 `22`，cron 是 `'22'`；与 `REVIEW_MODE: on`（DB-12①）同类的 YAML 类型歧义 | 统一加引号 |
| `vitest.coverage-gates.ts:35-39` 等 | 无问题，仅记录：注释与数组一致 | — |

---

## 3. 上一轮未修旧项状态（只列本分片相关的）

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B24（含 DB-08） | 仍在 | 发货的 `carrier` / `tracking_no` 仍只判非空（admin-order-routes.ts:259-264），超 32 / 64 字符仍是 22001 → 50000 |
| B51（DB-03） | 仍在 | `migrations.db.test.ts` 仍是"down 到底再 up"，015 的 down 写错同样查不出 |
| DB-07 | 仍在 | 没有新增 CHECK 迁移：`payments.dispute_status`（现在是四值）、`banners.link_type`、`products.category`、运费档正负仍无约束；金额列（orders / payments / order_items / fx_rates.rate）同样没有符号约束 |
| DB-09（CAT-11） | 部分修 | `update` 路径已加 `for update`（B23）；并发 `create(is_default=true)` 仍未见 23505 处理 |
| DB-10（ORD-11） | 仍在 | 上轮列的响应清单漏项契约原样未动；本轮新增项见 DB2-04 |
| DB-11 | 仍在 | `busboy` / `sharp` 仍在根 dependencies；`@types/node ^24`（另见 DB2-02） |
| DB-12 | 仍在 | `REVIEW_MODE: on` 仍未加引号（Render 文档对值类型没有明说，仍是疑似）；`ADMIN_OPENIDS` 注释仍写"首次登录时写入 users.is_admin" |
| DB-13（CAT-19） | 仍在 | 没有新增索引迁移 |
| DB-14 | 仍在 | 002:108-109、003:13-16、013:15-17 注释未改；`dev-up.ts:73` 的提示未改；`vitest.config.mts:8-9` 未改（e2e 文件数那句已更新为 7，属实） |
| DB-15 | 仍在 | `.gitignore` 仍不忽略 `.env.production` / `.env.staging` |
| DB-16（CAT-15） | 仍在 | `payment_channels_key_shape` 仍允许 32 字符；`FX_BUFFER_RATE` 仍不限小数位 |

已确认修好（不展开）：A1/DB-01（015 + 先扣额度）、B8/DB-04（通道解析进事务）、B31 的库名与内容闸门（内容闸门的回归见 DB2-01）、B32/DB-05（`.max(32)`）、B33/DB-06（契约 379 行与 mount.ts 注释）、B17/DB-12③（只配 ADMIN_EMAIL 可启动 + 改密 CLI）。

---

## 4. 看过但确认没问题的高风险点

- **迁移 001–015 逐条**：up / down 标记行没有被头注释误触发；015 的 down 先删表再按 014 原样补回两列与约束，全量 down 可走通；`ADD COLUMN IF NOT EXISTS … CONSTRAINT` 写法合法。没有发现会走不出去的状态或缺外键索引的新表（`login_attempts` 无外键）。
- **列宽与写入值**：`order_events.status VARCHAR(20)` 全部字面量最长 16（`dispute_released`）；`webhook_events.result VARCHAR(32)` 由 `resultValue()` 统一截断；`admin_audit.action/target` 在仓储层 `slice(0,64)` / `slice(0,128)`。
- **login_attempts 的原子性**：`insert … on conflict do update … where 未锁定` 一条语句，0 行即已锁；`clearLoginAttempt` 的"锁定时刻相等"判据在 timestamptz 微秒 / JS 毫秒之间不会失配（时刻由应用的毫秒 `now` 加整分钟得到）；清理作业只删已解锁且超 24 小时的行。
- **check-contract.mjs**：错误码登记表段解析、三组枚举双向比对、`compliance_tags` 的正则锚点（会跳过 `Product` 里那处、命中 `ProductInput`）都对；工程库与文档库两份契约当前逐字相同（`cmp` 通过）。
- **测试库分库**：`vitest.config.mts` 只给 e2e 注入 `TEST_DB_PROJECT`；unit / contract / lint 三层没有连库的用例，不会与 db 层共库并发。没有游离在五个 project 之外的测试文件。
- **seed 与测试的清表名单**：`seed-lib.ts:73` 与 `test-db.ts:284` 逐字一致；`login_attempts` 不在排除名单（按业务表清），合理。
- **npm start 的信号转发**：探针（npm 11.7.0 / macOS）——对 npm 进程发 SIGTERM，node 子进程收到并正常退出。生产是 Node 22 自带的 npm 10.9.x / Linux，**未实测**；若要彻底去掉这层不确定，`startCommand` 可直接写 `node --conditions=waselect-runtime server/dist/main.js`。
- **render.yaml**：`databaseName: japan_shop_prod` 已与开发库不同名；cron 的 `node -e` 折行后引号闭合正确、非 202 退出 1；`/api/v1/internal/jobs` 在源站校验豁免名单内。
- **checkout-build-lib**：`renderRedirects` 拒绝带路径的基址；`assertDeployApiBase` 对 localhost / 非 https 在 CF Pages 构建时失败。
- **契约方法 + 路径 + 鉴权**：37 条逐一对上；`IdemKey` 只声明在建单与发起支付两条上，实现同。
- **未能证实、不报成发现的**：Stripe 对象 ID 长度上限（`provider_ref` 等是 VARCHAR(128)）——docs.stripe.com/upgrades 现在没有关于 ID 长度的表述，无依据；Render 对 `fromService.envVarKey` 引用 `sync: false` 变量、对裸数字 / `on` 的处理——文档未写明；CI 最近是否为绿——本机无 `gh`，未查。
