# PAY3 分片报告（第三轮，2026-09-30）：支付与外部集成适配器

## 范围与方法

- **基线**：HEAD 50d490b，工作区干净。第二轮 PAY/SEC 分片审的是 35c3561 前后的工作区（含未提交的 AJ-222），此后本分片的实质改动只有 **913a76d（AJ-243 登录分桶 + 迁移 016）**，以及 AJ-222 的正式提交。
- **逐行读完的源文件**（共 16 个）：
  - `server/src/adapters/payment/`：stripe-checkout.ts、channels.ts、mock.ts、registry.ts
  - `server/src/adapters/http/`：fetch-client.ts、circuit-breaker.ts
  - `server/src/adapters/`：admin-auth.ts、rate-limit-memory.ts、storage.ts、storage-fs.ts、storage-memory.ts、image-resize.ts
  - `server/src/adapters/wechat/`：code2session.ts、dev-auth.ts
  - `migrations/016_login_attempts_scope.sql`（连同 015 一起读）
  - `test/contract/payment-provider.contract.ts`、`test/factories/stripe.ts`、`test/helpers/fake-stripe-http.ts`
- **读过的对应测试**：
  - 全部读完：admin-auth.unit、circuit-breaker.unit、fetch-client.unit 里 AJ-222 新增的两条
  - 读了用例清单：stripe-checkout.unit、rate-limit-memory.unit、storage-fs.unit、storage-memory.unit、image-resize.unit、code2session.unit
  - admin-auth-routes.db.test.ts：读了 AJ-243 的四条用例
- **为下结论读的分片外代码**：
  - `ports/circuit-breaker.ts`、`ports/http-client.ts`（shouldRetry / classify）
  - `app/admin-auth-routes.ts`、`app/rate-limit.ts`（ipKey）、`app/admin-upload-routes.ts:96-125`、`app/http-outbound.ts`
  - `config.ts` 相关键、`redact.ts` maskText、`render.yaml:50-75`、地基清单 ⑦-0、契约 `/auth/admin/login` 段
- **跑过的测试**：Node 22.22.2，`npx vitest run --project unit`，只跑本分片 13 个文件，**235/235 通过**。没有跑 db / e2e / gate。
- **探针**（`scratchpad/round3/PAY-probes/`，都不连外网）：
  - `p1-body-timeout.mjs`：`AbortSignal.timeout` 能不能打断正在读的响应体。结论是能，300ms 后抛 TimeoutError，所以 fetch-client 的单次超时对"头回了、体挂住"同样有效，这一项没有问题。
  - `p2-fs-root.mjs`：fs 驱动根目录带尾斜杠时，前缀判定的结果。
  - `p3-long-image.mts`：长图走 `resizeToTiers` 的结果（用仓库自带的 tsx 与 sharp）。

---

## 发现

### PAY3-01【P2】AJ-243 的"单个来源只能锁住自己"，在 IPv6 与当前部署拓扑下都不成立；"放到 Cloudflare Access 之后"这道防线可以从源站直连绕过

- **位置**：
  - `server/src/app/admin-auth-routes.ts:25-27`（@tradeoff 里的论证）、`:99`（来源取 `ipKey(req.ip)`）
  - `server/src/app/rate-limit.ts` 的 `ipKey` @limitation（原文："持有 /48 或 /56 前缀的来源仍有 256～65536 个 /64 可用"）
  - `render.yaml:60-67`（`TRUST_PROXY_HOPS=1`，没有 `ORIGIN_VERIFY_SECRET`）
  - `docs/地基搭建清单.md` ⑦-0
- **问题**：邮箱桶上限是 30 次 / 15 分钟，所以锁死管理员需要"凑够 6 个来源"。这件事在下面三种现实条件下都很便宜，SEC2-01（单个攻击者就能持续锁死管理员登录）在这些条件下仍然成立。
  1. **IPv6**：来源按 /64 归一。一台持有 /56 的主机（常见的家宽前缀委派；HE 隧道免费给 /48）就有 256 个以上的来源，每个来源还各有一份 5 次 / 15 分钟的 IP 限流额度。单机每 15 分钟打 30 次就能让邮箱桶一直处于锁定。
  2. **经 Cloudflare 且 `TRUST_PROXY_HOPS=1`**（A2 未定的现状）：`req.ip` 取到的是 CF 边缘 IP。同一攻击者的请求会散在多个边缘出口上，于是：
     - 来源桶与 IP 限流一起被稀释；
     - 管理员与同地区的攻击者可能落在同一个边缘 IP 的来源桶里，攻击者的失败会锁住管理员的来源。
  3. **Access 可被绕过**：清单 ⑦-0 与路由头注释都写"部署时放到 Cloudflare Access 之后，外部根本碰不到这个接口"。但 Access 只拦经过 CF 的流量。Render 服务的 `*.onrender.com` 源站地址是公网可达的；`ORIGIN_VERIFY_SECRET` 没配时，`http.ts` 的源站闸门不生效，直连源站就绕过了 Access。这一点属推断：Render 默认子域可达是平台常识，本次未实测。
- **触发场景**：
  - 攻击者知道管理员邮箱，从一个 IPv6 /56 里轮换 6 个 /64；
  - 或者直接对 onrender.com 源站发请求；
  - 每 15 分钟发 30 个错口令。
  - 结果：邮箱桶持续锁定，管理员任何来源都拿到 42901，唯一出口是跑改密脚本。
- **证据**：
  - 【读码确认】分桶逻辑、/64 粒度（rate-limit.ts 的 @limitation 自己写明了）、render.yaml 里没有 `ORIGIN_VERIFY_SECRET`、清单 ⑦-0 没把源站闸门列为前提。
  - 【推断】攻击者持有 /56 的成本；Render 默认子域可直连。
- **修复**：
  1. 清单 ⑦-0 把"`ORIGIN_VERIFY_SECRET` 已配 + `TRUST_PROXY_HOPS` 按 staging 实测定值（A2）"写成 Access 生效的**前提**；路由头注释里"外部根本碰不到"改成有条件的说法。
  2. `config.ts` 加一条组合规则：生产环境 `ORIGIN_VERIFY_SECRET` 为空时拒启，至少打 error。这属于七类必查的 C 类。
  3. 来源桶对 IPv6 改用更粗的前缀（例如 /56）。这只作用于**登录额度**，不改全站限流粒度。或者承认"IPv6 下 6 个来源不设防"，把 SEC2-01 在报告里改回 ◐。
- **应补的测试**：
  - admin-auth-routes.db.test：在 `2001:db8:1:0::/56` 内取 6 个不同的 /64，各错 5 次，然后管理员从 `203.0.113.9` 输对口令。
  - 修复前断言 `status === 429`（钉住现状，先红的是修复后的期望 200）；按方案 3 修复后断言 200。
  - config.unit：生产 + 空 `ORIGIN_VERIFY_SECRET` → 期望 issues 含该键。修复前为空，先红。

### PAY3-02【P2】详情长图（高度超过 16383px）上传一律报"图片解码失败"（40001）

- **位置**：`server/src/adapters/image-resize.ts:44-49`；`server/src/app/admin-upload-routes.ts:108-114`（这里把一切异常归成 `image_decode_failed`）
- **问题**：
  - 三档只按宽度缩放，并且 `withoutEnlargement: true`。
  - 宽度小于档宽的长图，高度原样保留。WebP 的单边上限是 16383px，于是编码阶段抛错。
  - 路由把它翻成 40001 `image_decode_failed`，运营看到的是"图坏了"，而这张图完全合法。
- **触发场景**：运营上传一张 750×20000 的商品详情长图（中日电商最常见的详情图形态）→ 40001。
  - 宽 1200、高 17000 的图同样失败。
  - 750×16000 能过，但 detail 档输出仍是 750×16000，小程序端单张图过高的问题另论。
- **证据**【实测】`p3-long-image.mts`：
  ```
  750x16000 ok thumb=200x4267 card=600x12800 detail=750x16000
  750x20000 THROW Processed image is too large for the WebP format
  1200x17000 THROW Processed image is too large for the WebP format
  ```
- **修复**：二选一，并补一条明确的错误码。
  - 在 `resize` 里同时给 `height: 16383, fit: 'inside'`，按比例限高；
  - 或者上传时先读 metadata，高度超过上限返回独立的 40001 reason（如 `image_too_tall`），并写明上限，由 admin-web 提示运营切图。
- **应补的测试**：image-resize.unit 加用例"750×20000 → 三档都产出且高度 ≤ 16383"。修复前 rejects，先红。

### PAY3-03【P2】Stripe 托管页没有显式关闭 Adaptive Pricing：账户若开着它，外币付款人的会话回调币种与订单不符，钱到了、单不落账

- **位置**：`server/src/adapters/payment/stripe-checkout.ts:403-437`（create 表单）、`:553-560`（回带的是会话上的 `amount_total` / `currency`）
- **问题**：
  - 适配器把会话对象上的 `currency` / `amount_total` 原样回带，落账管线按"币种 → 金额"严格核对。
  - Stripe 的 Adaptive Pricing（Checkout 按付款人所在地换成本币展示并扣款）在账户层面开启时，会话与 PI 上的币种和金额可能变成付款人的本币。按我对文档的记忆，它对部分账户是默认开启的，**本次未实测**。
  - 表单里没有 `adaptive_pricing[enabled]=false`，所以本系统的行为取决于 Dashboard 设置——与文件里"显式白名单只收卡，防 Dashboard 配置漂移"是同一类风险，但没被同样对待。
- **触发场景**：
  - 美国订单按 USD 建会话，付款人持非美卡，Checkout 向他展示并按本币扣款。
  - `checkout.session.completed` 的 `currency` 不是 USD，管线判币种不符，订单停在 pending_payment 直到过期，并发出 error 告警。
  - 钱已经扣了，只能人工退款。方向是 fail-closed，不会错置 paid。
- **证据**：
  - 【读码确认】表单确实没有该参数，回带字段取的是会话对象。
  - 【推断】Adaptive Pricing 的默认状态，以及开启后会话 `currency` 的取值口径。按约束十，这条必须先在 Stripe 测试模式实测，再定是否修。
- **修复**：
  1. 在 Stripe 测试模式建一次会话、用外币测试卡付款，把 `checkout.session.completed` 的 `currency` / `amount_total` / `currency_conversion` 原样记成 `@measured`。
  2. 若实测证实，create 表单固定加 `adaptive_pricing[enabled]: 'false'`（参数名同样要实测），与卡白名单并列，写进 D-49 三项的注释。
- **应补的测试**：stripe-checkout.unit 的"表单字段"用例加断言 `form.get('adaptive_pricing[enabled]') === 'false'`。修复前为 null，先红。

### PAY3-04【P3】AJ-243：邮箱桶已锁时，管理员自己的来源桶照样被扣额度，锁定比全局锁多出最长 15 分钟

- **位置**：`server/src/app/admin-auth-routes.ts:108-124`
- **问题**：
  - 先无条件扣来源桶，再扣邮箱桶。
  - 邮箱桶已锁时，来源桶那次已扣掉了，请求却在没比对口令的情况下被 42901 拒掉。
  - 管理员在全局锁期间重试 5 次，第 5 次就把自己的来源桶锁上，到期时刻是第 5 次重试之后的 15 分钟，晚于全局锁到期。
  - 注释写"来源桶在前：攻击者被锁在自己的来源上时，不再消耗邮箱桶"，只考虑了反方向。
- **触发场景**：
  - 攻击者从 6 个来源把邮箱桶打满，锁到 G。
  - 管理员在 G 之前 10 分钟连试 5 次，全是 429；admin-web 目前不读 Retry-After（SEC2-08）。
  - 到了 G，攻击停止，管理员仍然 429，还要再等约 5 分钟。
- **证据**【读码确认】：`byEmail` 只在 `bySource.kind !== 'locked'` 时才去扣；`bySource` 的扣减不会回滚。
- **修复**：两种都行。
  - 扣来源桶之前先只读邮箱桶的 `locked_until`：已锁直接 42901，不扣任何额度。这不影响原子封顶，封顶仍由 claim 保证。
  - 或者邮箱桶返回 locked 时，把来源桶这次扣减退回（`failed_count - 1`，且不动已置的锁）。
- **应补的测试**（db）：
  - 先让邮箱桶锁住：把 `login_attempts` 行 `locked_until` 设为 now+15min。
  - 管理员从新来源连试 5 次，再把邮箱桶锁改为已到期，然后输对口令。
  - 期望 200。现状是 429，先红。

### PAY3-05【P3】fs 存储驱动：根目录带尾斜杠或写成 `.` 时，所有上传都被判"路径不安全"

- **位置**：`server/src/adapters/storage-fs.ts:38-43`
- **问题**：
  - 前缀用的是 `normalize(rootDir) + sep`。`normalize('/tmp/up/')` 保留尾斜杠，于是前缀变成 `/tmp/up//`。
  - 而 `normalize(join(root, key))` 会折叠成 `/tmp/up/…`，`startsWith` 永远为假。
  - 同理，`.` 的前缀是 `./`，而拼出来的路径是 `products/…`。
- **触发场景**：开发者在 `.env` 里写 `STORAGE_FS_DIR=./var/uploads/`（带尾斜杠是常见写法），此后每次上传都失败，错误是 `object_key_unsafe`，排障方向会被带去查 key。只影响 development 驱动。
- **证据**【实测】`p2-fs-root.mjs`：
  ```
  "./var/uploads/" root= "var/uploads//" … ok= false
  "/tmp/up/"       root= "/tmp/up//"      … ok= false
  "."              root= "./"             … ok= false
  ```
- **修复**：`const root = resolve(rootDir) + sep`（`resolve` 会去掉尾斜杠并转成绝对路径），`full = resolve(root, key)`。
- **应补的测试**：storage-fs.unit 加"rootDir 带尾斜杠 → put 成功且文件落在 rootDir/key"。现状抛 `object_key_unsafe`，先红。

### PAY3-06【P3】AJ-243 留下的注释与契约漂移

【读码确认】

- `server/src/adapters/admin-auth.ts:7-12`：文件头仍写"计数与锁落的键是 `sha256(lower(email))`……有没有这个人都按同一个键计数、同一把锁"。AJ-243 之后是两层桶，来源桶的键混入了来源。
- `server/src/app/admin-auth-routes.ts:5-10`：
  - 仍写"② 账号锁定（连续失败 ADMIN_LOGIN_MAX_FAILURES 次…）挡换 IP 慢慢试同一个账号"。现在 `ADMIN_LOGIN_MAX_FAILURES` 是**每来源** 5 次，挡"换 IP 慢慢试"的是邮箱桶的 30 次。
  - 同样仍写"锁定的键是 sha256(lower(email))"。
- `contracts/api-contract.yaml:156-157、262`：仍写"同一账号连续失败 5 次锁 15 分钟"。这是 SEC2-11② 的原条目，AJ-243 之后偏差更大：实际是同邮箱同来源 5 次，或同邮箱合计 30 次。
- `test/factories/stripe.ts:15-17`：@limitation 一写"F11 会用官方 SDK 的 `constructEvent`"。适配器已明确决定不引 SDK（stripe-checkout.ts:224-227）。
- `test/factories/stripe.ts:18-20、259-261`：说 `charge.dispute.closed` "尚未造样本"。但 `STRIPE_EVENT_TYPES` 已列入它，`dispute({status})` 也造得出来，`STRIPE_EVENTS_NOT_SAMPLED` 里也没有它。两处注释与豁免名单互相矛盾。
- **修复**：逐条改。契约那条需要升小版本并跑 `check-contract`。

### PAY3-07【P3】微信 code2session 在网络错误后会重试 GET，而 code 是一次性的：第二次拿回 40163，被当成用户侧失败（40101）

- **位置**：
  - `server/src/adapters/wechat/code2session.ts:49`（没有任何选项，按默认 GET 重试）
  - `:62-64`（40163 → 40101）
  - `ports/http-client.ts:155`（`TypeError` 一律按 network 可重试）
- **问题**：
  - GET 被当成"天然幂等"而可以重试，但 jscode2session 并不幂等，微信侧会消耗 code。
  - 第一次请求已送达并被处理、只是响应在路上断了（ECONNRESET / socket hang up，undici 抛 `TypeError: fetch failed`）时，重试会拿回 40163。
  - 对外变成 40101"登录失败"，日志里 reason 是 `wechat_code_rejected`，排障方向会指向用户或客户端。
  - 超时不会触发：默认单次超时 10s 大于总预算 6s，第一次超时就把预算用完了。
- **触发场景**：微信接口返回途中连接被重置。低频，但登录是小程序第一跳。
- **证据**【读码确认】：未探针。连接重置在本机可以造，但属于"重试会发生"的行为，已由 fetch-client 现有用例覆盖。
- **修复**：
  - 给 `HttpRequest` 加一个 `retry: false`（或 `maxAttempts: 1`）选项，code2session 传入；
  - 或者 code2session 自己把 40163 且"本次调用发生过重试"的情形归为 50000。前者更干净。
- **应补的测试**：code2session.unit 用计数替身，第一次抛 `TypeError('fetch failed')`，第二次回 `{errcode:40163}`。期望 `send` 只被调用 1 次。现状由真实 fetch-client 驱动时会调 2 次，先红。这需要用真实 `createFetchClient` 加注入的 fetch 来测。

---

## 看过、确认没有新问题的高风险点

- **Stripe 验签**：
  - 按原始字节拼接；多个 v1 任一命中；先比长度再 `timingSafeEqual`。
  - NaN 时间戳被拦；容差双向 300s，用注入时钟。
  - v0 被忽略。
  - 与第二轮结论一致，代码自上轮以来未变。
- **事件类型**：`OUTCOME_BY_TYPE` 之外一律 unknown。
  - `completed` 且 `payment_status` 不是 paid 时降为 unknown。
  - `constructor` 这类原型键理论上会命中 `Object.prototype`，但报文先要过 HMAC，入站方无法构造，不报。
- **mock 通道在生产的可达性**：
  - config 1a / 1b / 2b 与 `channels.ts:154-156` 两道闸都在：生产未列出 mock 时不注册，也不允许残留密钥。
  - 生产列出 mock 必须 REVIEW_MODE=on，且此时只允许 mock。
  - 自签确认只认布尔 true。
- **R-01 / AJ-222 的修复本身**：
  - `attempt > 0` 被拒时的 settle、half_open 下 unknown 退回名额、探测超时出口，三处都有"注回即红"的用例。
  - 我逐条推演过删除修复后的状态：分别停在 `circuit_open` 只有 1 条，以及立即被拒。
  - 未发现修复引入的新卡死路径。只剩上轮 PAY2-06 的两处（cooldown 可配成 0；退名额时不重置 `openedAtMs`）。
- **fetch-client 超时**：`AbortSignal.timeout` 能打断正在读的响应体（探针 p1），不存在"头回了、体挂住就无限等"。
- **admin-auth `ownLockUntil` 在两层桶下仍成立**：
  - 两个桶各自独立 claim，"时间戳相等即我上的锁"的论证逐桶成立。
  - 来源桶键用换行分隔，邮箱正则排除空白，不会与邮箱桶或其他邮箱的键冲突。
  - 迁移 016 的 CHECK 与索引齐全；`deleteLoginAttemptsForEmail` 按 `key_hash OR scope_hash` 一次清两层。
- **密码比对时序**：DUMMY_HASH 与真实哈希同为 cost 10（auth.ts:80）；锁定分支对已知与未知账号都不跑 bcrypt。
- **上传路径穿越**：key 白名单外加拒 `..`、`//`、`\` 以及前缀判定，穿越不可行（尾斜杠问题只会误拒，不会放行，见 PAY3-05）。
- **密钥与 PII 进日志**：
  - `safeUrl` 去掉查询串，所以微信 secret 不进出站日志。
  - Stripe 密钥只在请求头里。
  - 上游错误体截 200 字后经 `maskText` 脱敏邮箱、电话、卡号、凭证；地址类不在掩码范围内，但本次找不到能让 Stripe 回显地址的具体触发，不报。

---

## 统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 3 | PAY3-01（AJ-243 在 IPv6 与现网拓扑下失效 / Access 可绕过）、PAY3-02（长图上传误报解码失败）、PAY3-03（Adaptive Pricing 币种，需实测） |
| P3 | 4 | PAY3-04、PAY3-05、PAY3-06、PAY3-07 |

证据等级：
- 【实测】：PAY3-02、PAY3-05
- 【读码确认】：PAY3-04、PAY3-06、PAY3-07，以及 PAY3-01 的代码部分
- 【推断】：PAY3-01 的攻击者资源与 Render 直连部分；PAY3-03

## 上轮遗留在本分片的状态

| 编号 | 状态 |
|---|---|
| R-01（熔断卡死） | 已修，修复有效（见上） |
| SEC2-01（单 IP 锁死管理员） | 代码侧已按 AJ-243 分桶；**在 IPv6 与现网拓扑下仍成立**，见 PAY3-01 |
| PAY2-01 | 仍存在（stripe-checkout.ts:285-295、511-552） |
| PAY2-02 | 仍存在（stripe-checkout.ts:515-517） |
| PAY2-05 | 仍存在（stripe-checkout.ts:310-314、360-364、667-671 三处 GET 都没带 `retryAdviceHeader`） |
| PAY2-06 | 仍存在（config.ts:494 `int(30_000, 0)`；circuit-breaker.ts:142-144 退名额不重置 `openedAtMs`） |
| PAY2-07 | 仍存在（ports/http-client.ts:155） |
| PAY2-10 | 仍存在：fetch-client.ts:14-15、ports/circuit-breaker.ts:89-91 与 173-175、stripe-checkout.ts:525-528 |
| PAY-14 | 仍存在（stripe-checkout.ts:436 商品名写死；mock.ts:130 自编 30 分钟） |
| PAY-16 | 仍存在（stripe-checkout.ts:312 PI 未编码；:593 随机 `gen-uuid`） |
| B29（大图 OOM） | 仍存在（image-resize.ts:42 未设 `limitInputPixels`） |
| B48（DUMMY_HASH 计时无测试） | 仍存在 |
| SEC2-07（İ 大小写） | 仍存在，且同样作用于新的来源桶键（admin-auth.ts:46、59、94） |
| SEC2-11② | 仍存在，AJ-243 后偏差扩大（见 PAY3-06） |
| SEC2-11④ | 仍存在（admin-auth.ts:160-161） |
| SEC-13（rate-limit-memory.ts:57-58 注释） | 仍存在 |
| SEC-09 / B24（code 无上限） | 仍存在（在路由侧，code2session.ts 本身原样透传） |
