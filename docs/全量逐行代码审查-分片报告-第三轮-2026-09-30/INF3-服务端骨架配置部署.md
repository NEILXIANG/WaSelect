# INF3 分片（服务端骨架 / 配置 / 脚本 / 部署）第三轮逐行审查报告 — 2026-09-30

## 范围与方法

- 基线：HEAD `50d490b`，工作区 clean。全程只读，未改仓库任何文件；未跑 db / e2e / gate / 迁移 / 种子。
- 逐行读完：`server/src/{config,http,main,logger,redact,context,errors,process-errors}.ts`、`express-augment.d.ts`；
  `scripts/` 全部非测试文件（`pre-commit`、`assert-node-version.mjs`、`check-contract.mjs`、`dev-up.ts`、`dev-up-lib.ts`、
  `seed.ts`、`seed-lib.ts`、`admin-password.ts`、`admin-password-lib.ts`、`assert-admin-deploy-env.ts`、`build-checkout.ts`、
  `checkout-build-lib.ts`、`gen-admin-tokens.ts`）；`render.yaml`、`.github/workflows/ci.yml`、`.github/dependabot.yml`、
  根 / server / shared / admin-web 的 `package.json`、`tsconfig.json`、`server/tsconfig.build.json`、`eslint.config.mjs`、
  `.env.example`、`.nvmrc`、`.gitignore`、`.prettierignore`、`checkout-static/**`、`migrations/016`。
- 为下结论读过的分片外代码：`app/shutdown-cleanup.ts`、`adapters/event-bus.ts`（drain）、`adapters/db.ts`（createDb/ping/closeDb）、
  `app/pay-intent.ts`（事务内调 provider）、`admin-auth-routes.ts`（额度常量）；测试：`http.unit.test.ts`（AJ-237 两条）、
  `test/config/node-version.unit.test.ts`、`test/e2e/dist-boot.e2e.test.ts`、`main.db.test.ts` 头部、`test/db/test-db.ts`（.env 加载）。
- 对照：上轮主报告、INF / DB 分片报告（已知项只标"仍存在"）。
- 探针（全部在 `scratchpad/round3/probes/`，Node 22.22.2，除注明外）：
  1. `repo-link` 软链 + 系统 Node 25.3 直接/经软链/经 npm 跑 `assert-node-version.mjs`；
  2. `pino-sync.mjs`：pino 10.3.1 默认目标 = SonicBoom `sync:false`（确认注释说法正确，不报）；
  3. `pg-end.mjs` / `pg-end-tx.mjs`：postgres.js `end()` 在有在途查询 / 在途事务时的行为（只连本机 `postgres` 管理库、只跑 `select`/`pg_sleep`）；
  4. `node --conditions=waselect-runtime` 有无 `--enable-source-maps` 时 dist 栈帧；
  5. `node scripts/check-contract.mjs`（通过：30 码 / 8 枚举 / 44 值）。

---

## 发现

### INF3-01【P2】AJ-237 之后，"排空失败"分支进入一段无上限的等待，且它恰是最可能卡住的那条分支；硬退出定时器在这之后才上膛

- **位置**：`server/src/http.ts:750-772`（AJ-237：catch 里不再 return，继续 `afterDrain`）；`http.ts:724-728`（`finish` 才设硬退出）；
  `main.ts:216-227` → `app/shutdown-cleanup.ts:48-57`（`events.drain(8s)` → `closeDb`）；`adapters/db.ts:260-262`（`db.end()` 无 timeout）；
  `app/pay-intent.ts:23,188,297`（Stripe 建会话在事务内）
- **问题**：AJ-237 前，排空超时 → `finish(1)` → 2 s 后硬退出，最坏约 5 + 10 + 2 = 17 s。AJ-237 后，同一分支继续执行
  `drainEventsThenClose`：先等订阅者（≤ 8 s），再 `db.end()`。而 `db.end()` **会等在途查询和在途事务**跑完（下方实测），
  排空失败又恰恰意味着"还有请求没结束"——被 `closeAllConnections` 掐断的只是 socket，handler 本身仍在跑，事务仍握着连接。
  `finish()`（硬退出定时器）要等 `afterDrain` 返回之后才调用，所以这段等待**没有任何自有上限**，只受 PG 的
  `statement_timeout 15s` / `idle_in_transaction_session_timeout 60s` 约束。
- **触发场景**：部署（SIGTERM）时刻，① 有一条"连上了但请求头/体没发完"的慢连接（INF2-01 已实测：必然撑满 `graceMs` 10 s 进超时分支），
  同时 ② 有一个发起支付请求正在事务内等 Stripe 建会话（`pay-intent.ts` 事务内调 `provider.create`，出站预算 6 s）。
  时间线：摘流 5 s → 排空超时 10 s → 等订阅者 ≤ 8 s → `db.end()` 等那条支付事务 ≤ 6 s（Stripe 慢时更久直到 PG 超时）→ 退出宽限 2 s，
  合计可达 31 s 以上，超过仓库自己写的平台停机宽限 30 s（`http.ts:571`"Render 给 30s"）。平台 SIGKILL 时：
  `shutdown_cleanup_done_after_failed_drain` 这行日志与 SonicBoom 缓冲里最后几行一起丢失，退出形态从"码 1"变成"被杀"，
  事后看不出清理做到了哪一步——AJ-237 想补的"留痕"在最需要它的场景里恰好留不下。本地 `npm run dev` 同理：第二次 Ctrl+C 被 `closing` 守卫忽略，只能 `kill -9`。
- **证据**：【实测】`probes/pg-end.mjs`、`pg-end-tx.mjs`（postgres 3.4.x，PG16）：
  ```
  在途 pg_sleep(2) 时 end()           → 'query ok @2032', 'end resolved @2032'
  事务内两条语句之间调 end()           → 'tx second stmt ok @529'（事务照常继续）
  end() 之后新发一条池查询             → 'new query err CONNECTION_ENDED @102'
  事务内空等 3s（模拟等出站 HTTP）时 end() → 'tx committed @3028', 'end resolved @3028'
  ```
  即 `end()` 的完成时间 = 最慢那个在途事务的完成时间。【读码确认】`finish()` 在 `afterDrain` 之后；`closeDb` 无超时。
  平台宽限 30 s 为【推断】（仓库注释值，无 `@measured`，与 INF2-06④ 同源）。
- **与已知项的关系**：INF-12（`db.end()` 无超时、硬退出上膛晚）与 INF2-06④（停机总预算算式漏 `graceMs`）是已知项；
  本条是**新的**：AJ-237 把"排空失败"这条原本 2 s 就退出的分支接进了这段无上限等待，而这条分支里有在途事务的概率远高于正常停机分支。
- **修复方案**：
  1. 在 `handler` 入口就设一个**总截止时刻**（例如 `SHUTDOWN_TOTAL_BUDGET_MS`，默认取平台宽限 − 3 s），到点直接 `exit(1)`（unref 定时器），不再只在 `finish` 里上膛；
  2. `closeDb` 改为 `db.end({ timeout: N })`（postgres.js 支持，到点强关连接），N 从剩余预算里算；
  3. `drainFailed` 时把 `events.drain` 的预算压短（或取剩余预算的一半），并在 `shutdown_cleanup_done_after_failed_drain` 里记 `pending` 与实际耗时；
  4. 把"平台宽限 > 总预算"写成 `crossField` 规则（与 INF2-06 合并）。
- **应补测试**：`http.unit.test.ts` 新增「🔴 排空失败 + afterDrain 永不 resolve → 总预算到点仍以码 1 退出」：注入 `close` 抛错、`afterDrain = () => new Promise(()=>{})`、
  总预算 200 ms，断言 `exits` 在 ~200 ms 内变为 `[1]`（现实现永远等不到 → 先红）。`shutdown-cleanup.unit.test.ts` 断言 `closeDb` 以带 timeout 的形式调用。

### INF3-02【P3】Node 版本闸门在"经软链路径直接执行"时静默放行（AJ-238）

- **位置**：`scripts/assert-node-version.mjs:54`
- **问题**：入口判断是 `fileURLToPath(import.meta.url) === process.argv[1]`。ESM 主模块的 `import.meta.url` 是**真实路径**，
  `argv[1]` 是调用者给的路径（只做 `resolve`，不解软链）。两者不等时整段检查不执行、退出码 0——闸门 fail-open，且没有任何输出。
  这正是 `main.ts:264-282` 的 N21 已经吃过的亏（`isSelfEntry` 两边都过 `realpathSync`），此处没有复用。
- **触发场景**：仓库位于软链目录下（macOS `/tmp`→`/private/tmp`、`~/code`→外置盘、CI 的软链工作区），或 IDE / 脚本用绝对软链路径调用
  `node <link>/scripts/assert-node-version.mjs`：在 Node 25 上照样 exit 0。经 `npm run check:node` 调用时不受影响（npm 的 cwd 是物理路径，相对路径 resolve 后相等）。
- **证据**：【实测】系统 Node 25.3.0：
  ```
  node /Users/…/jp_project/scripts/assert-node-version.mjs            → ✗ Node 主版本不对… exit=1
  node ./repo-link/scripts/assert-node-version.mjs（软链）             → （无输出）exit=0
  node /tmp/…/repo-link/scripts/assert-node-version.mjs               → （无输出）exit=0
  cd repo-link && npm run check:node                                   → exit=1
  ```
- **修复方案**：改为 `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`（失败按"是入口"处理——闸门应 fail-closed，与 main.ts 相反）；
  或更简单：把检查逻辑放进一个默认导出函数，由 `package.json` 用 `node -e "import('./scripts/assert-node-version.mjs').then(m=>m.run())"` 调用，不再靠入口判断。
- **应补测试**：`node-version.unit.test.ts` 加子进程用例：在临时目录建指向仓库的软链，用 Node 22 以外的 `process.versions` 不可控——改为断言"经软链调用与直接调用的退出码与输出相同"（用一个 `.nvmrc` 写成 `99` 的临时副本制造必红），现实现软链那一侧 exit 0 → 先红。

### INF3-03【P3】AJ-237 留下的注释失真：`shutdown_cleanup_failed` 分支写"排空已成功"

- **位置**：`server/src/http.ts:775-776`；同时 `http.ts:671-672` 的 afterDrain `@limitation`
- **问题**：AJ-237 后 `afterDrain` 在排空失败时也会执行，它抛错时同样落进这个 catch（`http.unit.test.ts:1018` 的用例正是这条路径），
  但注释仍写"排空已成功，但清理没干净"。日志事件名 `shutdown_cleanup_failed` 也不带 `drain_failed` 字段，检索时分不出两种情形。
- **触发场景**：排空超时 + `db.end()` 抛错 → 日志两行 `server_stop_failed` + `shutdown_cleanup_failed`，读注释的人会以为后者只发生在排空成功之后。
- **证据**：【读码确认】
- **修复方案**：注释改为"清理没干净（排空可能成功也可能已失败，见 drain_failed 字段）"，并在该日志里加 `drain_failed: drainFailed`。
- **应补测试**：`http.unit.test.ts:1018` 用例补断言 `sink.find('shutdown_cleanup_failed')[0]?.drain_failed === true`（现无此字段 → 先红）。

### INF3-04【P3】契约与 .env 模板仍写"同一账号连续失败 5 次锁 15 分钟"，AJ-243 已改成两层额度

- **位置**：`contracts/api-contract.yaml:262`（`/auth/admin/login` summary）；`.env.example:69`（另见已知 DB2-10：还写着"users 行上，迁移 014"）
- **问题**：913a76d（AJ-243）起额度是「邮箱 × 来源」5 次 + 「邮箱」30 次（`admin-auth-routes.ts:51,58`，迁移 016），契约 0.6.16 没有同步这句行为描述。
  契约是 admin-web 与客服话术的依据：照契约，"换个网络再试"不会解锁；按实现，换来源会（直到邮箱桶 30 次）。
- **触发场景**：管理员在公司网络连错 5 次被锁，客服按契约告诉他"等 15 分钟"，而实际换手机热点就能立刻登录；反之安全评估按契约以为全局上限是 5 次，实际是 30 次。
- **证据**：【读码确认】`check-contract.mjs` 只比错误码与三组枚举，不比描述，所以 gate 绿。
- **修复方案**：契约 summary 改为两层额度的准确描述并升 0.6.17（文档库副本同步，双副本比对会拦）；`.env.example:69` 同步改。
- **应补测试**：`test/contract/` 加一条"契约里出现的登录额度数字 = `ADMIN_LOGIN_MAX_FAILURES` / `ADMIN_LOGIN_GLOBAL_MAX_FAILURES` / `ADMIN_LOGIN_LOCK_MINUTES`"（约束九"文档里的数字直接写进断言"），现契约缺 30 → 先红。

### INF3-05【P3】生产启动不开 source map：错误栈指向 `dist/*.js`，而构建产物里 `.map` 已经生成

- **位置**：`package.json:38`（`start`）；`server/tsconfig.build.json`（`sourceMap: true`）；`main.ts:11-13`（"不用打包器是因为打包器栈追踪错行"）
- **问题**：`sourceMap: true` 产出了 `.js.map`，但 `npm start` 没有 `--enable-source-maps`，Node 不会用它们。
  `unhandled_error` / `fatal` 日志里的 `err_stack` 全部是编译后 JS 的行号，与源码对不上——main.ts 为此拒绝打包器的理由，在不打包的方案里以另一种形式存在。
- **触发场景**：生产 `unhandled_error` 带栈 `…/server/dist/http.js:86:15`，排障者打开 `server/src/http.ts:86` 看到的是注释，而真正的抛出点在第 182 行。
- **证据**：【实测】同一调用：
  ```
  node --conditions=waselect-runtime …           → at Module.paramId (file:///…/server/dist/http.js:86:15)
  node --enable-source-maps --conditions=…       → at Module.paramId (/…/server/src/http.ts:182:11)
  ```
- **修复方案**：`start` 改为 `node --enable-source-maps --conditions=waselect-runtime server/dist/main.js`（或 `NODE_OPTIONS`）；
  注意开启后构造栈有额外开销，本项目量级可忽略。
- **应补测试**：`dist-boot.e2e.test.ts`（或一条 unit 读 package.json）断言 `scripts.start` 含 `--enable-source-maps`，现不含 → 先红；更好的是 dist-boot 里触发一条 `unhandled_error` 断言 `err_stack` 含 `server/src/`。

### INF3-06【P3】`npm run dev -- --full` 在已有数据的库上不灌完整目录，用法说明仍承诺"灌完整商品目录"（AJ-242）

- **位置**：`scripts/dev-up.ts:7`（用法）；`scripts/dev-up-lib.ts:90-102`（`seedStep`）
- **问题**：AJ-242 后"库里已有商品就跳过"的判断**先于** `--full`：`--full` 不带 `--reseed` 时，只要库里已有 demo 的 4 个商品就直接跳过，
  返回的提示只说"要清空重灌请加 --reseed"，没说 `--full` 被忽略了。
- **触发场景**：新人按用法第 7 行先 `npm run dev`（灌了 demo），想看完整目录再跑 `npm run dev -- --full` → 服务起来，商品还是 4 个；提示里没有出现"full"。
- **证据**：【读码确认】
- **修复方案**：`parseDevUpArgs` 里 `--full` 无 `--reseed` 时，`seedStep` 跳过分支的文案明确写"已有数据，--full 未生效；要换成完整目录请用 --full --reseed"；或 `--full` 隐含"库里商品数 < 完整目录时重灌"。用法第 7 行同步。
- **应补测试**：`dev-up-lib.db.test.ts`：灌 demo 后 `seedStep(db,{full:true,reseed:false})`，断言返回文案含 `--full` 与 `--reseed`（现不含 `--full` → 先红）。

### INF3-07【P3】提交钩子不查格式，而 gate 第二步就是 `format:check`

- **位置**：`scripts/pre-commit:10-13`；`package.json:46`
- **问题**：钩子跑 `check:node → lint → typecheck → test:fast`，不跑 `format:check`（全仓 `prettier --check`，秒级）。
  上轮主报告 §八 记录了"1 轮 gate 因新文件未过 Prettier 而红"——那个文件就是这样提交进去的。钩子自己的注释（N18）说"提交时绿、CI 才红的反馈环慢几十分钟"，同一理由对格式成立。
- **触发场景**：新增一个未格式化的 `.ts` → `git commit` 通过 → 交付前 `npm run gate` 在第二步红；若直接推 main，CI 红。
- **证据**：【读码确认】+ 上轮 §八 的实际记录。
- **修复方案**：钩子在 `check:node` 之后加 `npm run format:check`（或只查暂存文件 `prettier --check $(git diff --cached --name-only --diff-filter=ACM)`）。
- **应补测试**：`node-version.unit.test.ts` 的"闸门接线"组加断言：pre-commit 的 `npm run` 行包含 `format:check`（现不含 → 先红）。

---

## 看过、确认没问题的高风险点

1. **AJ-237 主逻辑**：`drainFailed` 只决定退出码，`afterDrain` 必执行；两条新用例覆盖"清理成功 / 清理也失败"；`server_stopped` 不在失败分支出现。问题只在预算（INF3-01）与注释（INF3-03）。
2. **AJ-238 接线**：gate 与 pre-commit 第一行都是 `check:node`；`.nvmrc` / engines / CI / render 两处的同源断言存在且正确；`.nvmrc` 读不懂时 fail-closed。
3. **AJ-242**：`seedStep` 只在无商品或 `--reseed` 时调用 `seedOnce`；内容闸门仍在清表之前；`--no-seed` 与 `--reseed` 互斥报错；未迁移库不会进 seed（迁移步骤在前）。seed-lib 的"is_test 只可能为 true"错误前提已改写。
4. **配置组合**：生产 mock 仅"列出 + REVIEW_MODE=on + 独立 ≥32 位密钥"一条路；审核模式只许 mock；生产 stripe 必须 live key + webhook + 短链域名；dev 登录在 production/staging 拒启；生产 DB 本机判定覆盖 `0.0.0.0`/`[::]`；CORS 值拒通配/路径并归一 origin。（`TRUST_PROXY_HOPS≥2` 无源站密钥不拒启、毫秒类无上限等为已知项。）
5. **源站闸门**：放在报文解析前；豁免只有 `/healthz` `/readyz` `/api/v1/internal/jobs` 且按分隔符前缀匹配；比较先比长度再 `timingSafeEqual`；严格路由下大小写变体既不豁免也不命中路由。
6. **trace_id**：`^[A-Za-z0-9._:-]{8,64}$`，重复头被 Node 合并为 `a, b` 后必不匹配 → 新建；不回显非法值。
7. **pino 异步写**：探针确认默认 SonicBoom `sync:false`，`http.ts @limitation 二`"立即 exit 会丢日志"的说法成立，`exitCode + 2s unref 定时器`的做法与之匹配。
8. **脱敏覆盖面**：地址对象（`recipient`→首字母、`phone`→尾 4、`line1/line2/postal_code/address*`→`***`、`city/state` 明文为刻意设计）、`contact_email`、`openid(s)`、`token/secret/signature/nonce`、`pay_url/link/href`、自由文本里的邮箱 / 卡号(Luhn+号段+GTIN) / +国际电话 / 28 位 openid / `sk_|whsec_|cs_live_` / Bearer / JWT；访问日志只记 `req.path`（短链 `?t=` 不进日志）。
9. **check-contract.mjs**：实跑通过；错误码登记表双向、三组枚举双向、其余整词；文档库副本逐字比对在本机生效、CI 自动跳过。
10. **部署**：`buildCommand` 带 `--include=dev`；`preDeployCommand` 先迁移；016 是纯加列加索引（部署窗口内旧实例不受影响）；cron 走私网 + 共享密钥，非 202 退出 1；`databaseName` 带 `_prod`；server dist 不含任何测试代码或 `test/` 引用。
11. **checkout-static**：三张页不读 URL 参数、无外链资源（不会经 Referer 泄露回跳参数）；`_redirects` 拒带路径基址；CF Pages 构建强制 https 公网基址；admin-web 构建同款闸门。

---

## 统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 1 | INF3-01 |
| P3 | 6 | INF3-02 ～ INF3-07 |

## 上轮遗留状态（本分片相关，已知项只列一行）

| 编号 | 状态 |
|---|---|
| A2 `TRUST_PROXY_HOPS` 未实测、源站闸门未开 | 仍存在（render.yaml:67 仍为 1） |
| INF2-01 排空超时跳过 afterDrain | 已修（AJ-237）；其预算副作用见 INF3-01，注释见 INF3-03 |
| INF2-02 `client_aborted` 访问日志无 trace_id、真实结果被去重吞掉 | 仍存在（http.ts:305-340） |
| INF2-05 `/readyz` 免鉴权免源站校验每次查库 | 仍存在 |
| INF2-06 组合缺位（HOPS≥2 无源站密钥、drain<预算、多会话串行、15s 算式） | 仍存在（config.ts:389-391 仍写"合计约 15s"） |
| INF2-07 订阅者失败日志 `err` 为字符串 | 仍存在（event-bus.ts:79、idempotency.ts:325、close-session-events.ts:110） |
| INF2-08 注释漂移（http.ts:101"默认 1"、:464"快递解析器"等） | 仍存在 |
| INF2-09 访问日志路径 / UA 无长度上限 | 仍存在 |
| INF2-10 未设 keepAliveTimeout / headersTimeout | 仍存在（且 headersTimeout 默认值正是 INF2-01/INF3-01 排空超时的触发面） |
| INF-07 / INF-08 / INF-10 / INF-11 / INF-12 / INF-13 / INF-15 / INF-16 | 仍存在（INF-12 的影响面因 AJ-237 扩大，见 INF3-01） |
| DB2-01 dev 内容闸门挡死日常开发 | 已修（AJ-242）；残留见 INF3-06 |
| DB2-02 本机 Node 25 | 已修（AJ-238）；`@types/node ^24` 与 dependabot 无 major ignore 仍存在；软链 fail-open 见 INF3-02 |
| DB2-05 改密 CLI 回显口令 / 不显示目标库 / 无审计 | 仍存在（admin-password.ts:43 失败分支仍打完整邮箱） |
| DB2-07 破坏性迁移无 expand→contract 纪律 | 仍存在 |
| DB2-10 `.env.example:69`、`render.yaml:36` NEEDS VERIFICATION、`NODE_VERSION` 引号不一致 | 仍存在（`.env.example:69` 因 AJ-243 进一步失真，见 INF3-04） |
| DB-11 busboy/sharp 在根 dependencies | 仍存在 |
| DB-12 `REVIEW_MODE: on` 未加引号、`ADMIN_OPENIDS` 注释 | 仍存在（render.yaml:109、:115） |
| DB-15 `.gitignore` 不忽略 `.env.production` | 仍存在 |
