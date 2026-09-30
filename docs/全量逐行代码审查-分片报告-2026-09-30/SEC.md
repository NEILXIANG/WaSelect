# SEC 分片审查报告（第二轮，2026-09-30）——鉴权 · 身份 · 安全面 · 路由装配

审的是**工作区当前文件**（含未提交的 admin-auth 改动）。没有改动仓库、没有跑 npm 脚本/测试、没有连库、没有读 `.env`。
探针放在 `scratchpad/review2/SEC-probes/`（纯 Node，只 `require` 了仓库 node_modules 里的 express）。
⚠️ 本机 `node -v` = **v25.3.0**（项目口径是 Node 22），探针结论凡涉及 Node 行为的都注明了这一点。

## 1. 覆盖清单

| 文件 | 行数 | 状态 |
|---|---|---|
| server/src/app/auth.ts | 304 | 逐行读完 |
| server/src/app/admin-auth-routes.ts | 150 | 逐行读完（含工作区 diff） |
| server/src/app/admin-audit.ts | 106 | 逐行读完 |
| server/src/app/wechat-auth-routes.ts | 68 | 逐行读完 |
| server/src/app/wechat-login.ts | 95 | 逐行读完 |
| server/src/app/rate-limit.ts | 154 | 逐行读完 |
| server/src/app/internal-jobs-routes.ts | 108 | 逐行读完 |
| server/src/app/mount.ts | 396 | 逐行读完 |
| server/src/app/route-snapshot.ts | 208 | 逐行读完 |
| server/src/app/login-attempts-cleanup.ts | 51 | 逐行读完 |
| server/src/adapters/admin-auth.ts | 241 | 逐行读完（含工作区 diff） |
| server/src/adapters/admin-audit.ts | 28 | 逐行读完 |
| server/src/adapters/identity.ts | 133 | 逐行读完 |
| server/src/adapters/rate-limit-memory.ts | 66 | 逐行读完 |
| server/src/adapters/wechat/code2session.ts | 76 | 逐行读完 |
| server/src/adapters/wechat/dev-auth.ts | 29 | 逐行读完 |
| server/src/ports/admin-audit.ts | 30 | 逐行读完 |
| server/src/ports/rate-limit.ts | 57 | 逐行读完 |
| server/src/ports/wechat-auth.ts | 35 | 逐行读完 |
| scripts/admin-password.ts | 61 | 逐行读完 |
| scripts/admin-password-lib.ts | 74 | 逐行读完 |
| scripts/gen-admin-tokens.ts | 30 | 逐行读完 |
| **合计 22 个非测试文件** | **2500** | |

为下结论另读了（分片外）：`server/src/redact.ts` 全文 420 行；`admin-order-routes.ts` 284–473；`admin-risk-routes.ts` 60–117；
`refund-execution.ts` 的抛错点；`migrations/015_login_attempts.sql` 全文、`002_hardening.sql` 的 admin_audit 段；
`contracts/api-contract.yaml` 全部路由的 `security` 字段与三个登录/内部端点的条目；`config.ts` 规则 1e 与相关键；`main.ts` seed 段；
所有路由文件的 `app.<method>(` 注册行与守卫；`routes.contract.test.ts` 未实现清单；`auth-route-matrix.db.test.ts` 结构；
工作区 diff：`admin-auth-routes.db.test.ts`、`admin-auth-store.db.test.ts`、`admin-audit.unit.test.ts`；
`docs/自主决策记录.md` AJ-187 反向风险段与 AJ-224 全文；上一轮 SEC 分片原文与主报告 4.3 / 5.3。
`git diff 848278d..HEAD` 逐个看了分片内有变化的文件（mount.ts、internal-jobs-routes.ts 以及 3e9db99 / 9835eb8 / 73b2b7f / f9d1115 四个修复提交的落点）。

## 2. 发现

**P1：0 条。P2：1 条。P3：10 条。**

---

### SEC2-01｜P2｜可用性（单个 IP 即可把管理员登录**持续**锁死，且没有解锁出口）

- **位置**：`server/src/app/admin-auth-routes.ts:21-22`（@tradeoff）、`:44-46`（5 次 / 15 分钟）；`server/src/app/rate-limit.ts:113-117`（IP 限流 15 分钟窗口）；`server/src/config.ts:458`（`RATE_LIMIT_LOGIN_PER_15MIN` 默认 5）；`scripts/admin-password-lib.ts:65-69`（改密不清锁）。
- **问题**：文件头把"知道邮箱就能锁住真管理员"作为已接受的取舍，依据是——
  ```
  @tradeoff 锁定会被人利用来**故意锁住**真管理员（知道邮箱就能连错 5 次）。接受：锁只有 15 分钟、
       IP 限流让单个攻击源每 15 分钟只能锁一次，而换来的是口令爆破在账号维度被封顶。
  ```
  但这两个数字是**同一个周期**：IP 限流 = 每 15 分钟 5 次，锁 = 5 次尝试锁 15 分钟。"每 15 分钟只能锁一次、每次锁 15 分钟" = **一直锁着**。依据不成立。
- **触发场景**（按代码推演）：攻击者只需知道管理员邮箱、一个 IP、每 15 分钟 5 个请求。
  t0 发 5 个任意口令 → 第 5 次 `claimLoginAttempt` 置 `locked_until = t0+15min`。锁到期的那一刻已进入下一个 IP 限流窗口（窗口按时钟对齐，长度同为 15 分钟），
  攻击者又有 5 次配额 → 再发 5 个 → 再锁 15 分钟。锁定期间他的请求走 `locked` 分支，不延长锁也不需要发。
  真管理员只有"锁到期 → 攻击者下一轮 5 个请求到达"之间的毫秒级缝隙。
  AJ-187 之后键是邮箱哈希，**甚至不需要账号存在**；再加上今天复核已知的两条（A2 限流取到的可能是 CF 边缘 IP、IPv6 `::` 归一错误），实际门槛更低。
- **后果**：已登录的管理员不受影响（token 12 小时），但任何**新登录**（token 到期、换设备、改密后重登）都被挡在 42901。
  而改密脚本是唯一的"出事后出口"，它不清 `login_attempts`，全库也没有任何解锁路径（只能手工 `delete from login_attempts where key_hash=…`，而 key 是 sha256，得自己算）。
  发货、退款、处理拒付举证都在管理端——被锁期间运营停摆。
- **修复方案**：
  1. 把"5 次硬封顶"从**邮箱**维度改到**邮箱 × 来源**维度，邮箱维度另设一个更高的全局上限：
     `claimLoginAttempt` 的键改成 `sha256(lower(email) + '|' + ipKey(req.ip))`，策略 5 次 / 15 分钟；再扣一次 `sha256(lower(email))` 的全局额度（例如 30 次 / 15 分钟）。
     两次都沿用现有那条原子语句（只是 key 与 policy 不同），A1 的"扣在 bcrypt 之前"不变。单个来源锁不住别的来源；分布式爆破仍被全局额度封顶（30 次/15 分钟 ≈ 2880 次/天，对 ≥12 位口令无意义）。
  2. `scripts/admin-password-lib.ts` 的 `setAdminPassword` 成功后顺手 `delete from login_attempts where key_hash = ${loginAttemptKey(args.email)}`（改密 = 证明了库权限，清锁合理），并在 README / runbook 写明这是解锁出口。
  3. 更正 `admin-auth-routes.ts:21-22` 的 @tradeoff（现在写的量化是错的），同步 `docs/自主决策记录.md` AJ-187 反向风险 ②。
  4. 若拓扑允许，把 `/api/v1/auth/admin/login` 也放到 Cloudflare Access 之后（D-52 目前只管 admin-web 静态站）——这条需要用户拍板，不由我推定。
  5. 测试：db 用例"IP-A 连错 5 次后，IP-B 用正确口令 → 200"；"全局额度用尽后任何来源 → 42901"。
- **置信度**：已读代码证实（两个周期相等是代码里的常量；未实跑）。
- **是否已登记**：AJ-181 / AJ-187 把"可被锁 15 分钟"登记为已接受取舍，但**量化依据有误**（把"持续锁死"写成了"每 15 分钟锁一次"），且没有登记"无解锁出口"。

---

### SEC2-02｜P3｜审计完整性（两段式退款在 5xx 时不留审计，而状态已经提交）

- **位置**：`server/src/app/admin-audit.ts:8-9`、`:27`、`:84`；`server/src/app/admin-order-routes.ts:299-385`；`server/src/app/refund-execution.ts:103-105`。
- **问题**：审计只写 2xx，头注释的理由是"4xx / 5xx 不写（没有发生的改动不该出现在审计里）""反过来的错误（审计了但没改）不会发生"。但退款是两段：
  第一段事务把订单迁到 `refunding` 并提交；第二段调机构，失败/结果未知时 `throw await fail(deps, plan, 'provider_error', e)` → 5xx。
  ```ts
  if (res.statusCode < 200 || res.statusCode >= 300) return;   // admin-audit.ts:84
  ```
- **后果**：最需要留痕的那种退款——"机构超时、钱可能已退"——`admin_audit` 里没有这次操作（`order_events` 有 refunding 事件与 actor，所以不是完全无痕；但流 B 的"谁在什么时候发起了退款"查不到）。管理员若不再重试，这一行永远不会补上。
- **修复方案**：在退款路由第一段事务提交后调用一个新导出的 `markAuditCommitted(res)`（写 `res.locals`），中间件的判定改成 `2xx || res.locals[AUDIT_COMMITTED_KEY] === true`，并在 entry 里带上最终状态码（after 里加 `_status`，或 action 后缀）。同步改头注释 `:8-9` 与 `:27`。补用例：provider 抛错 → 5xx → `admin_audit` 有一行。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### SEC2-03｜P3｜审计生命周期（"prefinish 必然触发"有一个例外：管线化请求 + 断开）

- **位置**：`server/src/app/admin-audit.ts:14-16`（"回了 2xx 必然经过 end() ⇒ prefinish 必然触发，与客户端死活无关——没有需要兜的洞"）、`:81`。
- **证据**（探针 `SEC-probes/prefinish2.cjs`，express 5.2.1，Node v25.3.0）：
  ```
  abort case:           #1 close → handler res.json → #1 prefinish（单请求中断：成立，B15 的修复有效）
  pipelined abort case: #2 close → handler → #2 prefinish → handler → "#3 end() called, writableEnded=true socket=null"
  ```
  同一连接上管线化的第二个请求，在第一个响应写完之前连接断开：第二个 handler 照常执行并 `res.json()`，但它的 response 从未拿到 socket，**`prefinish` / `finish` / `close` 一个都不触发** → 业务已提交、审计无行、访问日志也无行。
- **触发场景**：需要能直连 Node 且用 HTTP/1.1 管线化的客户端。经 Render / Cloudflare 反代时一般不会把管线化透传到源站，所以生产上大概率触发不了；但它是"持有管理员 token 的人想做一次不留痕的写操作"的可构造路径（先发一个慢请求，紧跟要隐藏的写请求，然后断开）。
- **修复方案**：不依赖事件，改为在中间件里包一层 `res.end`（调用原 `end` 后执行一次性的审计写入，用标志位防重入）——`end()` 被调用这件事与 socket 是否就位无关。或保留 `prefinish` 并在 `end` 包装里兜底（`!fired` 时补写）。把探针改写成 `admin-audit.unit.test.ts` 的一条用例。头注释 `:14-16` 去掉"必然"。
- **置信度**：已探针证实（Node 25.3；Node 22 需在目标版本复跑）；生产拓扑下是否可达为疑似。
- **是否已登记**：新发现。

### SEC2-04｜P3｜可控输入进 error 日志（内部作业端点未配密钥时，任何人带一个请求头就能刷 error）

- **位置**：`server/src/app/internal-jobs-routes.ts:59-69`；`server/src/config.ts:465`（`INTERNAL_JOB_SECRET` 在生产也是可选）。
- **问题**：
  ```ts
  if (got.length === 0) throw new AppError(40101);     // 注释：防匿名请求刷 error 日志
  if (secret === undefined) { deps.logger.error('internal_job_disabled', …); throw new AppError(50000); }
  ```
  "先拒没带头的"挡不住任何人：请求里加 `X-Internal-Job-Secret: x` 就越过第一道判断。本路由不挂限流（文件头 @tradeoff），未配密钥的环境里每个请求一条 error 级日志 + 一个 50000（全局兜底可能再记一条）。
- **修复方案**（二选一）：① 未配密钥时对外一律 40101，`internal_job_disabled` 改成**装配期打一次** warn（mount 时判断）；② 给本路由挂 `rateLimitRules(config).publicWrite('internal.jobs')`。另在 config 规则里加"生产必须配 `INTERNAL_JOB_SECRET`"（否则 daily 作业静默不跑，只有 B11 的看门狗事后报）。
- **置信度**：已读代码证实。
- **是否已登记**：新发现（2026-09-26 那次修复的补丁不完整）。

### SEC2-05｜P3｜运维安全（改密脚本：不报目标库、不清锁、"立刻失效"不成立、注释自相矛盾）

- **位置**：`scripts/admin-password.ts:18-19,28-35,43,49-51`；`scripts/admin-password-lib.ts:15-16,44-46,65-69`。
- **问题**（四点，都已读代码证实）：
  1. **不显示连的是哪个库**。脚本先 `process.loadEnvFile('.env')` 再读 `DATABASE_URL`（探针证实：shell 里已有的变量优先，`PROBE_VAR= from_shell`，所以用法第二行是对的）。但只跑用法第一行时连的是本机 `.env` 的开发库，照样打印"已重设口令…旧 token 已失效"。这个脚本的使用场景是"口令泄露后轮换"——以为生产已轮换而实际改的是本地库，是最坏的失败方式。
  2. **不清 `login_attempts`**（见 SEC2-01）：账号正被锁时改密成功也登不进。
  3. **"旧 token 已失效"不是立刻**：服务进程里的身份缓存 60 秒（`identity.ts` TTL），脚本是另一个进程，调不到 `invalidate`。`admin-password-lib.ts:15-16` 写"改密之后旧 token 必须**立刻**失效"，输出写"旧 token 已失效"，实际是"最迟 60 秒"。
  4. **注释自相矛盾**：`admin-password-lib.ts:44-46` 说"参数至少不会落进 history 文件"，`admin-password.ts:9` 说"口令会出现在 shell history 与 ps 输出里"。后者是对的（命令行参数会进 history）。另外 `admin-password.ts:43` 在"没有这个管理员"时把完整邮箱打到 stderr，而 `:48` 写"完整邮箱不进任何输出"。
- **修复方案**：成功/失败输出都带 `new URL(url).host` 与库名（不带凭据）；host 不是 localhost 时要求显式 `--yes`；成功后清该邮箱的 `login_attempts` 行；输出改成"token_ver=N，旧 token 最迟 60 秒内失效"；口令改为从 stdin 不回显读取（注释里已登记为待办），并删掉 lib 里那句错误的 history 说法。
- **置信度**：已读代码证实；`loadEnvFile` 优先级已探针证实（Node 25.3）。
- **是否已登记**：第 4 点里的"交互式输入"已登记为待办，其余新发现。

### SEC2-06｜P3｜身份缓存（token_ver 变更后重新登录，最长 60 秒内新 token 被旧缓存拒成 40101）

- **位置**：`server/src/app/admin-auth-routes.ts:139-144`；`server/src/adapters/identity.ts:105-113`；`server/src/app/auth.ts:217-221`；`server/src/app/mount.ts:88-93`（注释里点名过这个症状）。
- **问题**：改密脚本把 `token_ver` 从 1 改成 2。管理员用新口令登录，`findAdminCredential` 读到的是库里的 2，签出 `ver=2`；但同一进程的身份缓存里这个 sub 还是 `{tokenVer:1}`（60 秒内访问过就在），
  `record.tokenVer !== principal.ver` → `40101 token_version_mismatch` → admin-web 按"登录过期"跳回登录页 → 再登还是被拒，直到缓存条目过期。命中缓存时只调整 LRU 位置、不刷新 `at`，所以上界是 60 秒。
- **后果**：改密（多半是应急场景）之后管理员看到的是"刚登录就过期"的循环，容易被误判成改密失败。
- **修复方案**：`AdminAuthRoutesDeps` 增加 `identity: IdentityCheck`，签 token 之前 `deps.identity.invalidate?.(cred.id)`；`mount.ts` 传入同一份实例。`wechat-login` 同理（将来买家侧有 bump token_ver 的路径时同样会撞）。补 db 用例：预热缓存 → 库里 `token_ver+1` → 登录 → 立即访问受保护路由 = 200。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### SEC2-07｜P3｜登录额度键（JS `toLowerCase()` 与 PG `lower()` 不是同一个函数——AJ-224 ③ 已登记待查，这里补证据与修法）

- **位置**：`server/src/adapters/admin-auth.ts:45-47`（键）、`:79-80`（查人）。
- **证据**（探针，JS 侧）：
  ```
  lower(İ)= "i̇" [ '69', '307' ]          // U+0130 在 JS 里变成 i + 组合点
  key plain 258d8dc916db  key İ 1348ab70b342  key upper 258d8dc916db
  regex ok: true                          // bodySchema 的邮箱正则放行 admİn@…
  ```
  PG 侧未实测（不许连库）：libc 类 collation（如 `en_US.UTF-8`）下 `lower('İ')` 通常是单个 `i`。若如此，`admİn@example.com` 能查到 `admin@example.com` 这个人，却落在**另一个额度桶**——邮箱里每有一个 `i` 就多一倍桶数（2^n × 5 次/15 分钟）。
- **修复方案**：不需要先查清 PG 的行为，让两边用同一个归一结果即可：`const norm = email.trim().toLowerCase()`，键用 `sha256(norm)`，查人改成 `where lower(email) = ${norm}`（不再对入参调 PG 的 `lower`）。这样 `admİn@…` 归一成 `admi̇n@…`，与库里的 `admin@…` 不相等 → 查无此人。或更简单：`bodySchema` 的 email 限定为 ASCII。补一条 db 用例钉住。
- **置信度**：JS 侧已探针证实；PG 侧疑似需实跑。
- **是否已登记**：已登记（AJ-224 反向风险 ③，"未实测、未改"）。

### SEC2-08｜P3｜契约兑现（锁定的第二条出口不带 Retry-After；浏览器端也读不到这个头）

- **位置**：`server/src/app/admin-auth-routes.ts:121-128`；对照 `:91-95`；`contracts/api-contract.yaml:248`（"锁定期 429 / 42901 + Retry-After"）；`server/src/http.ts:223`。
- **问题**：`claim.kind === 'locked'` 分支设了 `retry-after`，`cleared === 'locked'`（比对期间被别的请求上锁）分支直接抛 42901，没有设头——同一个错误码两种响应形状。另外 CORS 只 `expose-headers: x-trace-id, x-request-id`，admin-web 跨域时 JS 读不到 `Retry-After`（全站 429 同理；admin-web 目前也没读它）。
- **修复方案**：`clearLoginAttempt` 返回 `locked` 时把回读到的 `locked_until` 一并带回（改成判别联合），路由同样设 `retry-after`；`http.ts` 的 expose 列表加 `retry-after`。补断言。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### SEC2-09｜P3｜防复发（`setAuditBefore` 的值不经脱敏直接进 append-only 表）

- **位置**：`server/src/app/admin-audit.ts:52-54`、`:91-92`。
- **问题**：`after` 走 `auditPayload → redact`，`before` 是 `res.locals[AUDIT_BEFORE_KEY]` 原样落库。现有三个调用点（汇率上一条、运费整表、`{has_dispute:true}`）都不含 PII，所以**当前没有泄露**；但 09-29 的 SEC-12 / CAT-22 建议给"改价""改址"补 before——按现在的实现，改址的 before 会把旧地址明文永久写进删不掉的表，正是 B16 刚修掉的那类事故。
- **修复方案**：`before: res.locals[…] === undefined ? undefined : redact(res.locals[…])`（或在 `setAuditBefore` 里就 redact），单测加一条"before 里的 postal_code / phone 被掩码"。
- **置信度**：已读代码证实。
- **是否已登记**：新发现。

### SEC2-10｜P3｜测试有效性（今天改写的并发用例，其"与到达顺序无关"的不变量并不完全无关）

- **位置**：`server/src/app/admin-auth-routes.db.test.ts:147-172`（工作区）。
- **问题**：断言 `bad + ok <= ADMIN_LOGIN_MAX_FAILURES`，注释称它"与顺序无关"。但今天的修复让"持有触发额度的正确口令"能把行清成 `{0, null}`——清零之后才执行 claim 的请求会拿到**新一轮**额度。若正确口令恰好是第 5 个额度、且有请求的 claim 晚于它的 bcrypt 完成（~100ms，机器忙时可能），就会出现 `bad + ok > 5`。
  这在产品上是对的（成功登录本来就重置计数），但用例会偶发红；概率很低（claim 是毫秒级、bcrypt 是百毫秒级）。
- **修复方案**：把不变量写全——`ok === 0` 时 `bad <= max`；`ok === 1` 时只断言 `bad <= 2*max - 1` 与 `ok <= 1`；或让正确口令不参与突发，另起一条确定性用例（已有"错 4 次、第 5 次输对"）。
- **置信度**：疑似（按代码推演，未实跑）。
- **是否已登记**：新发现。

### SEC2-11｜P3｜契约漂移与注释不符（合并）

1. `contracts/api-contract.yaml:244`：`/auth/wechat/login` 的 responses 只有 200 / 401 / 429；实现对空 code、多余字段（`.strict()`）回 **40001**（`wechat-auth-routes.ts:50`），未配置回 50000（`:47`）。契约缺 400 与 500。
2. `contracts/api-contract.yaml:248`："**同一账号**连续失败 5 次锁 15 分钟"。AJ-187 之后键是邮箱哈希，不存在的邮箱也锁；且计的是"尝试额度"而非"失败次数"。契约文字没跟上（0.6.11 之后未改）。
3. `admin-auth-routes.ts:63`：`password: z.string().min(12).max(1024)` 两个字面量。12 有共享常量 `ADMIN_PASSWORD_MIN_LENGTH`（config 与改密脚本都用它），1024 有 `PASSWORD_MAX_CHARS`（auth.ts:255）。三处里只有登录口没接——改了常量，脚本能设出登录口拒收的口令（40001），或反之。改成引用常量。
4. `adapters/admin-auth.ts:144-145`："此时行一定存在且锁已生效…这个值是稳定的（锁只会到期、不会延长）"。今天加了 `ownLockUntil` 后锁可以被触发者**清掉**，0 行与回读之间行可能已是 `locked_until = null`（代码用 `?? now` 兜住了，行为没问题，注释过时）。
5. `admin-audit.ts:8-9,27`：见 SEC2-02。`admin-audit.ts:14-16`：见 SEC2-03。`admin-auth-routes.ts:21-22`：见 SEC2-01。
6. `auth.ts:181-182`：同一段注释前一行写"见 mount.ts"，后一行仍写"生产装配必须传（main.ts）"——上一轮 SEC-13 只改了一半。

- **修复方案**：逐条改；第 1、2 条要升契约小版本并跑 `check-contract`。
- **置信度**：已读代码证实。

## 3. 上一轮未修旧项的当前状态（不展开）

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| B48 | 仍在 | DUMMY_HASH 计时防线与失败路径日志脱敏仍无测试（只有"claim 在 verifyPassword 之前"的源码顺序断言）。 |
| B24（本分片部分 = SEC-09） | 仍在 | `wechat-auth-routes.ts:29` 的 `code` 仍无上限；`code2session.ts:32` 仍只认 40029 / 40163。 |
| SEC-08 | 仍在 | `identity.ts:114-126` 回写前不核对代数，`invalidate` 挡不住在途回源；B28 把拉黑与关单放进同一事务后，这个窗口的后果多了一项"刚被拉黑的人 60 秒内还能再建单"。 |
| SEC-10 | 仍在 | `mount.ts:214-217` 报价限流仍用 `app.use` 前缀挂载，`rate_limited` 的 `http_path` 仍是 `/`。 |
| SEC-11 | 仍在 | `internal-jobs-routes.ts:40-48` 的长度短路与注释均未改。 |
| SEC-12 | 仍在 | 没有 `setAuditTarget`，新建类操作的 `target` 仍为 null；商品 PUT / Banner DELETE 仍无 before（补 before 前先做 SEC2-09）。 |
| SEC-13 | 大部分仍在 | `auth.ts:18-19,47,195`、`identity.ts:18,66`、`rate-limit-memory.ts:57-58` 未改；`auth.ts:181-182` 改了一半；`auth.ts:8-10` 的"改密"因 B17 有了 CLI 而成立。`express-augment.d.ts` 本轮不在分片内，未复核。 |
| SEC-14 | 仍在 | `auth.ts:101`、`identity.ts:107` 仍直接 `Date.now()`；`internal-jobs-routes.ts:72-73` 仍直接用 systemClock / systemIdGen；`QuoteRoutesDeps.identity` 与 `AddressRoutesDeps.identity` 仍是可选。 |

今天已知、按规则不重复报的（本分片内）：IPv6 `::` 压缩写法归一错误（`rate-limit.ts:76-77`）、A2 `TRUST_PROXY_HOPS` 未实测。

## 4. 看过并确认没有问题的高风险点

- **今天的 `ownLockUntil`（`adapters/admin-auth.ts:174-192` + `admin-auth-routes.ts:120`）没有引入新洞**。逐条核对：
  - `claimLoginAttempt` 返回非 null 的 `lockedUntil` **只有**触发锁定那一次（insert 分支要 `1 >= max`；update 分支的 `else la.locked_until` 在 WHERE"未锁定"成立时只可能是 null 或被第二个 WHEN 清成 null）。所以"时间戳相等 ⇔ 我上的锁"成立。
  - 传 null 时 `locked_until = NULL::timestamptz` 为 NULL（假），不会误清。
  - 要走到 `clearLoginAttempt` 必须口令正确，攻击者拿不到这个例外；持有第 1–4 次额度的正确口令在别人上锁后仍是 42901（既定取舍）。
  - 精度：`now` 是 JS Date（毫秒），`timestamptz + make_interval(mins)` 不引入亚毫秒，往返相等（AJ-224 已写明"换库时钟会失效"的反向风险）。
  - 锁到期边界：到期后第一次 claim 把 `locked_until` 清成 null、计数从 0 到 1，不会"到期后错一次又锁"。
- **路由守卫 × 契约 `security` 逐条一致**：当前 43 条挂载路由（含 `/healthz`、`/readyz`；按 `app.<method>(` 注册行逐条数过）。
  21 条 `/admin/*`（比上一轮多 `POST /admin/orders/:id/dispute/release`）全部 `requireRole('admin')`；
  10 条买家路由（地址 ×4、报价、建单、取消、订单列表、订单详情、发起支付）全部 `requireRole('user')`，与契约里走默认 `bearerAuth` 的 10 条一一对应；
  契约标 `security: []` 且已实现的 11 条在代码里确实无守卫（auth ×2、fx、terms、products ×2、pay/channels、pay/callback、pay/link、健康检查 ×2）；`/internal/jobs/daily` 用共享密钥；`GET /home` 契约有、代码无、已在未实现清单。
  `auth-route-matrix.db.test.ts` 的路由清单取自 `collectAppRoutes`，新路由自动进矩阵。
- **审计中间件的位置**：`mount.ts:232` 在所有 `/admin` 路由之前；`app.use` 前缀与路由匹配同为大小写不敏感，不存在"路由命中而审计前缀不命中"的写法。
- **B15 的修复有效**：单请求中断场景 `prefinish` 触发且 `req.route` / `req.params` / `statusCode` 都是最终值（探针，见 SEC2-03 的第一行）。
- **B16 的修复没有过度脱敏到失真**：管理端各写接口的字段名过了一遍 `classifyKey`——`tracking_no`、`image_key`、`hs_code`、`reason`、`rate`、`price_jpy` 不命中；地址类按预期掩码。请求体 100KB 上限约束了单行审计的大小。
- **拉黑后的缓存作废**在事务提交**之后**调用（`admin-risk-routes.ts:91-99`），不是事务内。
- **改密脚本**：只按 `is_admin = true` 定位、`token_ver + 1`、口令下限与 config 同源；`loadEnvFile` 不覆盖 shell 已有变量（探针）。
- **login_attempts 清理**：只删"已解锁且 24h 未动"的行，不会给正在生效的锁开后门；基准时刻取作业开始时刻。
- **dev 微信登录**的两道闸门（配置层拒 staging / production + 装配层只在 development / test 注册）仍在，真 AppID 优先。
- **wechat-login**：`ON CONFLICT DO NOTHING` + 回读，永远签 `role:'user'`，签当前 `token_ver`；openid 不进日志。
- **mount.ts 自 848278d 以来的三处改动**（`markOrderDisputed` 多传 logger、`mountProductRoutes` 多传 logger、风控路由多传 events / clock）都只是依赖透传，没有改守卫或挂载顺序。
