> 本文是 2026-09-29 全量逐行代码审查的 **SEC 分片（鉴权·身份·安全面·路由装配）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# SEC 分片审查报告（鉴权、身份、安全面与路由装配）

我没有改动仓库（`git status` 为空）。探针脚本放在 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/SEC/`。验证 SQL 用的独立库 `review_sec` 用完已 drop。分片内 5 个单测文件共 67 条，全部通过。

## 1. 覆盖清单

| 文件 | 行数 | 状态 |
|---|---|---|
| server/src/app/auth.ts | 304 | 已逐行读完 |
| server/src/app/admin-auth-routes.ts | 125 | 已逐行读完 |
| server/src/app/admin-audit.ts | 99 | 已逐行读完 |
| server/src/app/wechat-login.ts | 95 | 已逐行读完 |
| server/src/app/wechat-auth-routes.ts | 68 | 已逐行读完 |
| server/src/app/rate-limit.ts | 113 | 已逐行读完 |
| server/src/app/internal-jobs-routes.ts | 104 | 已逐行读完 |
| server/src/app/mount.ts | 387 | 已逐行读完 |
| server/src/app/route-snapshot.ts | 208 | 已逐行读完 |
| server/src/adapters/identity.ts | 133 | 已逐行读完 |
| server/src/adapters/admin-auth.ts | 116 | 已逐行读完 |
| server/src/adapters/admin-audit.ts | 28 | 已逐行读完 |
| server/src/adapters/rate-limit-memory.ts | 66 | 已逐行读完 |
| server/src/adapters/wechat/code2session.ts | 76 | 已逐行读完 |
| server/src/adapters/wechat/dev-auth.ts | 29 | 已逐行读完 |
| server/src/ports/rate-limit.ts | 57 | 已逐行读完 |
| server/src/ports/wechat-auth.ts | 35 | 已逐行读完 |
| server/src/ports/admin-audit.ts | 30 | 已逐行读完 |
| server/src/express-augment.d.ts | 19 | 已逐行读完 |
| **合计 19 个文件** | **2092** | |

为了下结论，还读了分片外的以下部分：
- **全文**：CLAUDE.md、errors.ts、context.ts、admin-upload-routes.ts、address-routes.ts、quote-routes.ts。
- **config.ts**：95–244、340–399、415–617 行。
- **http.ts**：120–413 行。
- **main.ts**：95–159 行。
- **redact.ts**：1–140 行。
- **node_modules/router/index.js**（2.2.0）：150–345 行。
- **其余路由文件的守卫段**：admin-order-routes 230–400、admin-risk-routes 55–120、product-routes 80–180、order-query-routes 40–110、order-routes 180–210。
- **fetch-client**：safeUrl、重试、熔断键三处。
- **配置与文档**：render.yaml、.env.example、契约的 security 字段、AJ-181/183、jp《技术文档》里 Cloudflare 相关几段。

## 2. 发现列表

### SEC-01｜P1｜安全（管理员登录防爆破）
- **位置**：admin-auth-routes.ts:74-95；adapters/admin-auth.ts:62-81
- **问题**：锁定只在请求开始时读一次。并发突发的请求都能通过锁检查并完成 bcrypt 比对，所以"账号维度每 15 分钟 5 次"的上限不成立；锁定之后到达的正确口令同样能登录成功。
- **证据**：
  ```ts
  const cred = await findAdminCredential(deps.db, email);          // 只在这里读锁
  if (cred?.lockedUntil != null && cred.lockedUntil > now) { … 42901 }
  const ok = await verifyPassword(password, cred?.passwordHash ?? DUMMY_HASH); // ~100ms
  … await recordLoginFailure(…)                                     // 事后才计数
  ```
- **触发与后果**：探针 `lock-race-probe3.mts` 关掉 IP 限流后，模拟 20 个 IP 各发 1 次，第 13 个是正确口令。连跑 3 次，结果都是：锁已触发（库里 `login_locked_until` 已设），但同一轮突发里有 9–12 个错误口令被完整比对（401），正确口令返回 **200**。`lock-race-probe.mts` 单次突发有 19 个错误口令被比对。攻击者用 N 个 IP（正是头注释防范的"住宅代理池"）每 15 分钟能试 N 次，上限只剩服务器 bcrypt 的吞吐（约 5–10 次/秒）。同时大量 bcrypt 会占满 0.5 核 CPU，拖垮全站。头注释"口令爆破在账号维度被封顶"与 AJ-181 依据中的并发实测，只证明了"锁一次"，没证明"封顶次数"。
- **解决方案**：
  - 在 `adapters/admin-auth.ts` 新增 `chargeLoginAttempt(db, id, now, policy)`，**先扣次数再比对**：
    `update users set failed_login_count = case when failed_login_count+1 >= $max then 0 else failed_login_count+1 end, login_locked_until = case when failed_login_count+1 >= $max then $now + make_interval(mins=>$lock) else login_locked_until end where id=$id and (login_locked_until is null or login_locked_until <= $now) returning failed_login_count`。
  - 返回 0 行按已锁处理，返回 42901，并且不做 bcrypt。
  - 路由在 bcrypt 之前调用它。成功后仍调 `recordLoginSuccess` 清零；失败分支不再调 `recordLoginFailure`。
  - 补 db 测试：限流关闭，20 个错误口令加 1 个正确口令并发，断言 401 不超过 5 个、其余全是 42901，正确口令只要在第 5 次扣次数之后到达就不是 200。
- **置信度**：已探针证实
- **是否已登记**：新发现（AJ-181 的依据表述不完整）

### SEC-02｜P1｜安全 / 配置（限流键与 trust proxy）
- **位置**：render.yaml:60-61；config.ts:216-224；http.ts:223；rate-limit.ts:92
- **问题**：jp《技术文档》:481 和 :571、契约 :256 都写明 "api 前挂 Cloudflare 代理"，而生产配置 `TRUST_PROXY_HOPS=1`（注释写"Render 前一层 = 1"）。这样 `req.ip` 拿到的是 Cloudflare 边缘节点的 IP，不是客户端 IP。
- **证据**：
  ```yaml
  - key: TRUST_PROXY_HOPS
    value: 1 # Render 前置一层反代（D23）
  ```
  探针 `ip-probe.cjs`：`X-Forwarded-For: 198.51.100.7, 172.70.1.1`，hops=1 → `req.ip = "172.70.1.1"`（Cloudflare 网段）。
- **触发与后果**：
  - 所有按 IP 的限流桶都按 CF 出口 IP 划分。
  - `auth.admin.login:<CF IP>` 5 次/15 分钟：同 PoP 任何人发 5 次，就能把经同一出口的真管理员登录挡掉 15 分钟。
  - 报价、建单、支付、小程序登录、短链的 30 次/分钟配额由同 PoP 全体买家共享，中等流量就会成片返回 42901。
  - 访问日志的 `client_ip` 失去意义。
  - 反过来，如果直接改成 2 而源站 `*.onrender.com` 仍可直连，攻击者直连时伪造的 XFF 最左值会被采信，又可以伪造 IP。
- **解决方案**：
  - 先定拓扑：api.<domain> 是否走 CF 代理。
  - 如果走 CF：`TRUST_PROXY_HOPS=2`，并且源站只接受 CF 来的请求。例如 CF Transform Rule 注入一个密钥头，由 http.ts 校验，没有该头的请求一律拒绝，或至少不采信 XFF。
  - 在 staging 上打一次完整 XFF 链的 @measured，写回 config.ts / render.yaml 注释。
  - 补 http 单测：XFF 为 "client, cf" 且 hops=2 时 `req.ip` = client。
- **置信度**：疑似。Express 取值已探针证实，拓扑有文档证据；Render + CF 下的真实 XFF 形态没有实测。
- **是否已登记**：新发现

### SEC-03｜P2｜安全（管理员邮箱枚举）
- **位置**：admin-auth-routes.ts:76-85；AJ-181 依据 ⑥（"42901 与 IP 限流同码，也不额外暴露'这个账号存在'"）
- **问题**：只有真实存在的账号会被锁。换一个出口 IP，就能用"429 还是 401"判断某个邮箱是不是管理员。
- **证据**：探针 `enum-probe.mts`，使用真实限流器，limit=5：
  ```
  ops@example.com    IP-A x5: 401×5 | IP-B x1: 429/ra=900
  nobody@example.com IP-A x5: 401×5 | IP-B x1: 401
  ```
- **触发与后果**：两个 IP、6 次请求就能确认管理员邮箱，而管理员邮箱正是 SEC-01 的攻击前提。另外 Retry-After 的取值也不同：账号锁是精确的 900，IP 限流是到窗口末尾的秒数。已存在账号还多一次 UPDATE 往返，时序上也有微弱信号。
- **解决方案**：二选一。
  - ① 锁定键改为 `sha256(lower(email))`，放进新表 `admin_login_attempts(email_hash pk, failed_count, locked_until)`，不存在的邮箱同样计数、同样上锁（与 SEC-01 的先扣次数合并实现）。
  - ② 锁定期不做 bcrypt、一律返回 40101。这样没有口令对错的信号，代价是管理员不知道自己被锁，用 warn 日志弥补。
  - 同时更正 AJ-181 ⑥ 的表述，补"两个 IP 枚举"的 db 测试。
- **置信度**：已探针证实
- **是否已登记**：已登记但描述有误（AJ-181 称不暴露账号是否存在）

### SEC-04｜P2｜可靠性 / 审计（AJ-183 漏记）
- **位置**：admin-audit.ts:74-96（同样问题也在 http.ts:247 的访问日志，那部分属于 HTTP 分片）
- **问题**：审计挂在 `res.on('finish')` 上。客户端在 handler 提交之后、响应写出之前断开时，`finish` 永远不会触发，于是业务改了却没有审计行，而且**没有任何日志**。
- **证据**：探针 `finish-probe.cjs`（Node 22.22.2）：`["close writableFinished=false","handler: business committed, calling res.json"]`，没有 finish。`finish-probe2.cjs` 显示此时 `prefinish` 仍会触发，且 `statusCode` 为最终值。
- **触发与后果**：`POST /admin/orders/:id/refund` 要同步调 Stripe（最长 6 秒预算）。管理员关掉页签、网络断开，或 CF 524 超时，退款已经执行，但 admin_audit 没有记录，也没有 `admin_audit_write_failed`。头注释 @tradeoff 只提到"库在两次写之间断开"这一种漏记，低估了风险。
- **解决方案**：
  - 把 `res.on('finish', …)` 改为 `res.on('prefinish', …)`（逻辑不变）。
  - 另挂 `res.on('close')`：`!res.writableFinished && !prefired` 时打 warn `admin_audit_skipped_aborted`，覆盖 handler 还没结束就断开的情况。
  - 补 db 测试：测试装配里挂一条延迟 200ms 的 /api/v1/admin 写路由，客户端 50ms 后 `destroy()`，断言 admin_audit 有一行。
- **置信度**：已探针证实
- **是否已登记**：新发现

### SEC-05｜P2｜PII 落永久表（AJ-183 脱敏）
- **位置**：admin-audit.ts:30-38、53-61；admin-audit.unit.test.ts:11（测试反而钉住了"邮编保留"）
- **问题**：审计脱敏自己维护了一份 7 个键名的精确匹配清单，与全库唯一的 `redact.ts` 分类（AJ-33）不一致。`postal_code`（含 ZIP+4）、`openid`、`token`、`api_key`、`contactEmail`、`Password` 都会原样写进 append-only、删不掉的 admin_audit。
- **证据**：探针 `audit-pii-probe.mts`：
  ```
  {"recipient":"[redacted]",…,"postal_code":"78701-1234","openid":"oAbc123","api_key":"sk","contactEmail":"a@b.com","Password":"x"}
  classifyKey: postal_code→pii, openid→identifier, api_key→secret, contactEmail→identifier, Password→secret
  ```
- **触发与后果**：每次 `POST /admin/orders/:id/address` 都把买家的 ZIP+4、州、城市永久写入（redact.ts 注释："美国地址行+邮编+姓氏即可指向具体住户"）。APPI/CCPA 删除请求无法兑现。以后任何管理端写接口只要带 `openid`/`token` 这类键，都会明文落库。这正是约束九说的"第二份实现漂移"。
- **解决方案**：
  - 删除 `PII_KEYS`。`redact()` 改为：`const c = classifyKey(k); out[k] = c === undefined ? redact(x) : c === 'url' ? maskUrl(String(x)) : '[redacted]'`。
  - 改 admin-audit.unit.test：邮编、openid、token、api_key、大小写变体都必须是 `[redacted]`。
  - 头注释 @limitation 补一句：退款 `reason` 这类自由文本无法按键名脱敏。
- **置信度**：已探针证实
- **是否已登记**：新发现（AJ-183 反向风险 ② 只提到"要补键名"，没提到与 redact.ts 分裂）

### SEC-06｜P2｜运维 / 安全（初始管理员口令无法轮换）
- **位置**：.env.example:19；render.yaml "ADMIN_INITIAL_PASSWORD … 首次登录后应改密"；AJ-181 下游"建号后可删后者"；config.ts:488-493（规则 1e）
- **问题**：文档说建号后可以删掉 `ADMIN_INITIAL_PASSWORD`，但规则 1e 要求 ADMIN_EMAIL 和 ADMIN_INITIAL_PASSWORD 必须成对，只删口令会**拒绝启动**。全库也没有任何改密路径（`password_hash` 只有 seed 会写），"首次登录后应改密"无法执行。
- **证据**：探针 `seed-env-probe.mts`，只配 ADMIN_EMAIL：`email-only: REJECTED -> 配置校验失败，服务拒绝启动`。
- **触发与后果**：
  - 运维照文档删掉口令变量，下一次部署或重启时生产直接起不来。
  - 不删的话，初始口令就永久留在 Render 环境变量里，而且永远无法轮换，泄露后只能手工改库。
- **解决方案**：
  - 规则 1e 改成单向：只配口令不配邮箱才报错；只配邮箱时跳过 seed，并记 `admin_seed{result:'skipped_no_password'}`。
  - 补一个改密入口（`POST /admin/me/password`：校验旧口令、`hashPassword`、`token_ver + 1`；或者先做一个本机 CLI 脚本）。
  - 同步修改 .env.example、render.yaml 和 AJ-181 下游描述。
  - 补 config 单测覆盖"只配邮箱可启动"。
- **置信度**：已探针证实
- **是否已登记**：新发现

### SEC-07｜P2｜安全（IPv6 让限流失效）
- **位置**：rate-limit.ts:92-93；rate-limit-memory.ts:51-61
- **问题**：限流键用的是完整 IPv6 地址。一台主机的 /64 有 2^64 个地址，每个都是独立的桶。它还能配合 fail-open 驱逐（上限 1 万个 key），把别人的计数清零。
- **证据**：`const w = deps.store.hit(\`${rule.routeKey}:${ip}\`, …)`。探针 `ip-probe.cjs`：`2001:db8:1:2::a` 和 `…::b` 得到两个不同的 `req.ip`。
- **触发与后果**：只要入口接受 IPv6（CF 代理默认接受），管理员登录的 IP 限流和公开写接口限流对 IPv6 攻击者就是无限的；刷满 1 万个 key 还会驱逐其它来源的计数。
- **解决方案**：在 rate-limit.ts 加 `ipKey(ip)`：IPv4 原样；`::ffff:a.b.c.d` 转成 IPv4；其余 IPv6 取前 4 个 hextet（/64）作为键（参考 express-rate-limit v7 的 ipv6Subnet）。补单测：同一 /64 的两个地址共享一个桶。
- **置信度**：疑似。代码行为已证实，要看生产入口是否放行 IPv6，与 SEC-02 的拓扑相关。
- **是否已登记**：新发现

### SEC-08｜P3｜并发（拉黑后身份缓存被旧数据回写，F-06）
- **位置**：identity.ts:105-131
- **问题**：`invalidate()` 挡不住"invalidate 之前已经发出的回源查询"。这类查询返回后会把拉黑前的状态写回缓存，被拉黑者最长还能用 60 秒。
- **证据**：探针 `cache-race-probe.mts`：`inner calls: 1 next load blockedAt: null`（请求 A 回源在途，期间拉黑并 invalidate，A 回写后下一次 load 命中旧缓存）。
- **触发与后果**：被拉黑用户的并发请求恰好在拉黑事务提交前发起回源，AJ-183 声称的"即时生效"就会失效。窗口是毫秒级。
- **解决方案**：加一个每个 sub 的代数计数 `gen: Map<string, number>`。load 在 await 之前记下 `g`，回写前只有 `gen.get(sub) === g` 才 set；invalidate 时 `gen.set(sub, g+1)`（这个 Map 与缓存一起受上限约束）。把探针改写成 identity 的单测。
- **置信度**：已探针证实
- **是否已登记**：新发现

### SEC-09｜P3｜健壮性（微信登录 code 无上限，错误码归类）
- **位置**：wechat-auth-routes.ts:29；code2session.ts:32；dev-auth.ts:26；migrations/001 `openid VARCHAR(64)`
- **问题**：
  - `code: z.string().min(1)` 没有上限。约 100KB 的 code 会被拼进出站 URL，微信返回 414 → 普通 Error → 50000，并记一条 error 级 `unhandled_error`。匿名请求每个 IP 每分钟能刷 30 条（内部作业端点已按同样理由修过，这里没修）。
  - dev 替身下，openid = 前缀 + code，超过 64 字符 → 22001 → 50000。
  - 微信文档里的 40226（"高风险用户登录拦截"）属于用户侧，却被归入 50000 并记 error。
- **证据**：`const bodySchema = z.object({ code: z.string().min(1) }).strict();`；`USER_FAULT_ERRCODES = new Set([40_029, 40_163])`
- **解决方案**：`code` 加 `.max(128)`（真机拿到 AppID 后用 @measured 确认实际长度）。核对官方 errcode 表后，把 40226 映射为 40301 或 40101 并记 warn。
- **置信度**：前两项已读代码证实；40226 为疑似（需对照官方文档，文件自身也标了 NEEDS VERIFICATION）
- **是否已登记**：新发现

### SEC-10｜P3｜可观测性（报价限流的挂载方式）
- **位置**：mount.ts:208-211；rate-limit.ts:100-103
- **问题**：报价限流用 `app.use('/api/v1/orders/quote', …)` 挂载，中间件里的 `req.path` 被裁成 `/`，所以 `rate_limited` 日志的 `http_path` 永远是 `/`。另外它对所有方法生效，`GET /api/v1/orders/quote`（即 `GET /orders/:id`，id=quote）也会消耗报价配额。另外四条限流都挂在路由层，写法不一致。
- **证据**：探针 `path-probe.cjs`：`use-mounted req.path=/ originalUrl=/api/v1/orders/quote`（POST 和 GET 两次都命中）。
- **解决方案**：把 limiter 作为依赖传进 `mountQuoteRoutes`，在 `app.post(path, quoteLimiter, requireRole…)` 上挂载。或者 rate-limit.ts 的日志改记 `req.baseUrl + req.path`。补断言：日志里的 http_path 等于完整路径。
- **置信度**：已探针证实
- **是否已登记**：新发现

### SEC-11｜P3｜注释与实现不符（内部作业密钥比较）
- **位置**：internal-jobs-routes.ts:38-46
- **问题**：注释说"长度不一致也安全…不借长度差泄露信息"，但 `a.length === b.length &&` 的短路本身就会通过时序泄露**精确长度**，不是"32 以上"这个公开口径。
- **证据**：`return a.length === b.length && timingSafeEqual(a, b);`
- **解决方案**：对两边分别算 `createHash('sha256').update(x).digest()`（或者用一把启动时随机生成的 HMAC 密钥），再对两个 32 字节摘要做 `timingSafeEqual`，去掉长度分支，同步改注释。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### SEC-12｜P3｜审计完整性（创建类操作 target 为空）
- **位置**：admin-audit.ts:79-83
- **问题**：`target` 只取路径参数 `:id`。`POST /admin/products`、`POST /admin/banners`、`POST /admin/fx` 这类新建操作的 target 永远是 null，无法按对象回答"谁建了商品 X"，只能按动作加时间去翻。
- **解决方案**：与 `setAuditBefore` 同样的做法，增加 `setAuditTarget(res, id)`；创建类路由拿到新 id 后调用它，中间件优先读 `res.locals`。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### SEC-13｜P3｜注释与实现不符（约束六，合并）
- auth.ts:195：注释说"`aud` 由 jose 在验签阶段强制比对，比'验完再看 role'早一步拒绝"。实际上 jose 只比对 aud ∈ {mp, admin}，按期望角色比对 aud 是在 :148 验签之后手工做的，与 :119-123 的 @tradeoff 自相矛盾。
- auth.ts:18-19 的 @tradeoff "换来零 DB 读 … 代价就是无法即时失效" 已过时：现在有回源和 invalidate。:8-10 写"改密 … 最迟 60 秒生效"，但改密功能根本不存在（见 SEC-06）。
- auth.ts:181-182：写"生产装配必须传（main.ts）"，实际在 mount.ts。
- auth.ts:47：`AuthConfig.issuer` 说"用于隔离环境（dev/stg/prod 互不信任）"，但 mount.ts 的 13 处全部写死 `'waselect'`，也没有对应配置项。环境隔离实际只靠 JWT_SECRET 不同，外加身份回源查不到对方的 sub。
- identity.ts:66：写"只查两列"，实际 `select token_ver, blocked_at, is_admin` 查三列。:18 的 `@see server/src/auth.ts` 路径不对。
- rate-limit-memory.ts:57-58：写"第一个就是最老的… 当前 key 刚被 set/更新过，不会排在第一个"。对已存在的 key 调 `Map.set` 不会改变插入顺序，`count += 1` 也不会，所以驱逐按"创建顺序"而不是"最近使用"，当前 key 完全可能排在第一个（被 `oldest !== key` 挡住，于是本次不驱逐、Map 超出上限 1 个）。
- express-augment.d.ts:4："'没经过守卫的路由访问 req.auth'在类型层面就不成立"说过头了。它只是可选类型，任何路由都能读到 `undefined`。

**解决方案**：逐条改注释；auth.ts:195 改为"aud 与期望角色在验签后比对（→40301）"。**置信度**：已读代码证实。**是否已登记**：新发现。

### SEC-14｜P3｜约束 F10 与装配一致性
- `signToken`（auth.ts:101）和 `withIdentityCache`（identity.ts:107）直接用 `Date.now()`。admin-auth-routes 注入了 `clock`，但 token 的 iat/exp 不走它，假时钟测不到过期。
- internal-jobs-routes.ts:70-71 直接用 `systemClock` / `systemIdGen`，没有注入。
- `QuoteRoutesDeps.identity` 和 `AddressRoutesDeps.identity` 是可选类型，管理端的同类依赖是必填。以后装配时漏传不会编译报错，但会悄悄失去封禁和 token_ver 的回源。
- **解决方案**：`signToken(principal, cfg, nowSec?)` 由调用方传入时钟；缓存接收 `clock`；identity 一律改为必填。
- **置信度**：已读代码证实
- **是否已登记**：新发现

**高风险分支缺测试（只点名）**：
- 并发突发下的锁定封顶（SEC-01）
- 两个 IP 枚举（SEC-03）
- 客户端中断时的审计（SEC-04）
- 邮编 / openid 脱敏（SEC-05，现有测试断言的方向是反的）
- invalidate 竞态（SEC-08）
- XFF 两跳取值（SEC-02）

## 3. 看过但不是问题的疑点

- **守卫齐全**：44 条路由逐条对了契约的 `security`。
  - 20 条 `/admin/*` 全部挂 `requireRole('admin')`，在 6 个文件里各有一个 `guard` 实例。
  - 12 条买家接口全部挂 `requireRole('user')`。
  - 公开接口：auth ×2、fx、terms、products ×2、pay/channels、pay/callback、pay/link、healthz、readyz。
  - internal/jobs 用共享密钥。
  - 与契约完全一致。`auth-route-matrix.db.test.ts` 有矩阵覆盖。
- **买家归属**：地址的 update/remove 在 WHERE 里带 `user_id`；订单用 `findOwnedOrder` / `lockOwnedOrderForCancel` / `lockOwnedOrderForPay`；越权统一返回 40400，不泄露存在性。
- **JWT**：
  - 算法白名单只有 HS256；`requiredClaims` 含 exp/iat；issuer 固定。
  - aud 限定在 {mp, admin}，并在验签后按期望角色比对（不符返回 40301）；签发时 aud 由 role 推出，两者不会不一致。
  - `ver` 回源比对，封禁返回 403 而不是 401，避免重登风暴。
  - 管理端路由会回源查 `is_admin`（N9）。回源抛出的异常会透传成 50000，不会被折叠成 40101。
- **DUMMY_HASH**：是合法的 `$2b$10$`，cost 与真哈希一致。实测平均 108ms 对 94ms，时序已拉平；哈希损坏时会瞬间返回，但当前的值没问题。
- **finish 回调里的 `req.route` / `req.params`**：router 2.2.0 只在匹配到路由时赋值、只在 `done()` 时恢复。handler 发出响应且不调 next 时两者保持为该路由的值；4xx、404、OPTIONS、GET 都不会记审计，不会误记。
- **`recordLoginFailure`**：单条 UPDATE 在库内原子地读改写，RETURNING 返回的是新行值，锁定判定正确。seed 的 `where not exists` 加上 23505 兜底，能正确处理并发启动。
- **dev 登录的两道闸门**：配置层拒绝 staging/production；装配层只在 development/test 注册；配了真 AppID 时优先用真实登录。
- **code2session**：
  - 出站日志的 `safeUrl` 会去掉查询串，secret 和 js_code 不会进日志。
  - 熔断按 host 分；4xx 不计入熔断。
  - GET 超时重试后微信返回 40163，映射为 40101，前端重新取 code 即可。
  - session_key 不会流出适配器。
- **CORS**：精确白名单，带 `Vary: Origin`，前缀匹配要求后面紧跟分隔符，预检返回 204，不发 credentials，非白名单来源不回任何 CORS 头；大小写或路径变体一律失败关闭。
- **内部作业端点**：没带密钥头先返回 40101，不刷 error 日志；异步 Promise 已 catch。
- **错误响应**：不带 `details`；报文解析错误只看 body-parser 自己的标记，业务里的 `JSON.parse` 失败会正确落到 50000。
- **限流判定**：先计数后判定；Retry-After 至少 1 秒；按入口分桶。
- **wechat-login**：ON CONFLICT 加回读，并发首登安全；签发的是当前 `token_ver`。
- **route-snapshot**：双向比对，并有豁免和未实现清单的自洁规则。当前没有嵌套 Router，`app.use` 挂的中间件天然不会被计入路由。
