> 本文是 2026-09-29 全量逐行代码审查的 **INF 分片（运行底座）原始报告**，由分片审查助手撰写，保留全部证据与探针输出。
> 主报告 `docs/全量逐行代码审查报告-2026-09-29.md` 已跨片去重、主会话复核并重新校准严重度，**两者不一致时以主报告为准**（例如 PAY-03 / TSA-01 在主报告中定为 P2，见其 B2 的定级说明）。
> 文中 `/tmp/claude-0/…/scratchpad/review5/…` 是审查时的云端临时目录，会话结束后不保留。

# INF 分片（运行底座）审查报告

仓库全程只读，没有执行任何改变 git 状态的命令，没有读 `.env`。只跑了 unit 项目，分片相关 6 个文件共 223 条，全绿。探针脚本放在 `/tmp/claude-0/-home-claude/c7b6872c-5d17-5075-b6ca-6a8924fcbf74/scratchpad/review5/INF/*.mts`。自建库 `review_inf` 已跑完 001–014 迁移，保留着供复核，没有碰 japan_shop_test 和 postgres 库。

**结论**：这个分片没有 P0/P1。P2 共 6 条（其中 INF-05 是疑似，还缺平台实测），P3 共 10 条。

## 1. 覆盖清单（每个文件都已逐行读完）

| 文件 | 行数 |
|---|---|
| server/src/http.ts | 658 |
| server/src/config.ts | 692 |
| server/src/main.ts | 276 |
| server/src/logger.ts | 273 |
| server/src/context.ts | 89 |
| server/src/redact.ts | 420 |
| server/src/errors.ts | 115 |
| server/src/process-errors.ts | 78 |
| server/src/adapters/db.ts | 245 |
| server/src/adapters/event-bus.ts | 107 |
| server/src/adapters/clock.ts | 35 |
| server/src/adapters/ids.ts | 28 |
| server/src/adapters/idempotency.ts | 471 |
| server/src/adapters/scheduler.ts | 125 |
| server/src/app/scheduler.ts | 202 |
| server/src/app/scheduler-start.ts | 144 |
| server/src/app/unit-of-work.ts | 59 |
| server/src/app/cleanup-idempotency.ts | 57 |
| server/src/ports/idempotency.ts | 175 |
| server/src/ports/scheduler.ts | 224 |
| server/src/ports/events.ts | 75 |
| server/src/ports/clock.ts | 29 |
| server/src/ports/ids.ts | 40 |
| packages/shared/src/errors.ts | 198 |
| packages/shared/src/design-tokens.ts | 26 |
| packages/shared/src/index.ts | 17 |

合计 5082 行。另外读了 CLAUDE.md 和 COMMON.md。

分片外为下结论而读过的部分：
- pay-intent-routes.ts、pay-intent.ts 的相关段、pay-routes.ts、pay-link-routes.ts、close-session-events.ts、mount.ts
- render.yaml、fetch-client.ts、mock.ts
- node_modules 源码：body-parser 2.3.0 的 read.js、express 5.2.1 的 application.js、postgres 3.4.9 的 index.js/connection.js、zod 4.6.5 的 api.d.ts

## 2. 发现列表

### INF-01｜P2｜可靠性 / 幂等
- **位置**：`adapters/idempotency.ts:206-219`（第 209 行设置、第 219 行进入 handler）；`adapters/db.ts:110-111`
- **问题**：`runInTx` 为"占位那一步"设的 `lock_timeout = 剩余等待预算`（SET LOCAL）一直留到事务结束，handler 里自己的行锁等待也被收窄。默认约 2s，最坏到 1ms（第 208 行的 `Math.max(1, …)`），而连接默认值是 5s。
- **证据**：
  ```ts
  const remaining = Math.max(1, Math.floor(deadline - Date.now()));
  await tx`select set_config('lock_timeout', ${String(remaining)}, true)`;
  if (claimed.length === 0) return { kind: 'conflict' };
  inHandler = true;
  const result = await handler(tx);
  ```
  探针结果：handler 内 `current_setting('lock_timeout')='1999ms'`，池默认 `5s`。另一事务持同一行锁 3s 时，走执行器的 handler 在 2005ms 抛 55P03；普通事务在 2906ms 成功。
- **触发场景与后果**：
  - pay-intent 在事务里调 Stripe（`pay-intent.ts:23-29`，订单行锁最长约 6s）。同一单用新键再发起一次支付，handler 在约 2s 抛 55P03。
  - 没有任何路由映射 55P03，于是变成 50000，外加 `unhandled_error` 级错误日志。连接默认 5s 本可覆盖的等待被提前打断。
  - 事务会回滚，不会造成资金损失，但会多出 5xx。
  - 注释（第 202、207 行）说这份预算只管"占位那一步 / 别人正在做"，与实际作用范围不符。
- **解决方案**：
  - 在第 217 行之后、`inHandler = true` 之前加 ``await tx`set local lock_timeout to default` ``。已实测：`PGOPTIONS='-c lock_timeout=5s'`，`set_config('lock_timeout','1999',true)` 之后 `SET LOCAL … TO DEFAULT`，`show` 得到 `5s`。
  - 补 db 测试：handler 内 `current_setting('lock_timeout')` 等于连接默认值。
  - 注意：现有用例 `idempotency.db.test.ts:599-622` 依赖这次泄漏（waitMs=300、持锁 600ms、期望 55P03），修复后要改成持锁超过连接级 lock_timeout，或者给该用例的 `createDb` 传一个小的 `lockTimeoutMs`。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-02｜P2｜可靠性 / 错误归类（对应 CLAUDE.md 七类必查项 G）
- **位置**：`http.ts:368-375`（isBodyParseError）、`http.ts:330-336`；`http.ts:160-164`、`http.ts:273-277`；`pay-routes.ts:103-108`
- **问题**：任何客户端都能稳定制造 500 和 error 级 `unhandled_error` 日志，绕开了"客户端畸形请求不进 5xx"的设计（D6/D13）。有两个来源：
  - 只有 SyntaxError 和 `entity.too.large` 被当作客户端错误。body-parser 的其它 4xx（`charset.unsupported` 415、`encoding.unsupported` 415、坏 gzip 流 400、`request.aborted` 400）都落进 500 分支。
  - Express 路由匹配不区分大小写，但 rawBody 与 CORS 的前缀匹配区分大小写。
- **证据**（探针实测）：
  - `charset=x-evil` → 500 + `unhandled_error`（UnsupportedMediaTypeError）
  - `content-encoding: xyz` → 500
  - 坏 gzip 流 → 500 `incorrect header check`
  - `POST /API/V1/PAY/CALLBACK/stripe` → 路由命中但 `isBuf:false`，于是 `rawBody()` 抛 50000
- **触发场景与后果**：扫描器或攻击者用一个请求头就能刷 5xx 告警和错误预算，真实故障被淹没；这正是 40103 注释里点名要防的形态。`request.aborted`（弱网中途断开）同样会记成 error 级日志。
- **解决方案**：
  - 判定改为 `typeof e.type==='string' && e.expose===true && e.status>=400 && e.status<500`（http-errors 在 status<500 时 `expose=true`）。
  - `parseErrorReason` 按 type 给出原因；415 归 40001，或新登记一个码（需要同步 shared、技术文档 §7、契约）。
  - 另加 `app.set('case sensitive routing', true)`，或者前缀比较两边都转小写。
  - 补 http.unit 用例 4 条：charset、encoding、gzip 各断言 400 且 warn；大写回调路径断言 404。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-03｜P2｜可靠性 / 注释失真 / 事件丢失
- **位置**：
  - `ports/events.ts:14-20`、`ports/events.ts:41-45`
  - `adapters/event-bus.ts:11-12`、`17-27`、`67-77`
  - `app/unit-of-work.ts:20-24`
  - `main.ts:186-188`
  - 分片外：`close-session-events.ts:64-107`
- **问题**：多处注释说"订阅者必须同步 / 目前只做日志 / 请求返回时订阅者已跑完"，事实不成立。`close-session-events` 是异步订阅者：先用池连接 `voidInitiatedPayment`，再 `select payments`，再调机构 `expireSession`。总线对它是发出后不等（fire-and-forget）。停机流在 `afterDrain` 里直接 `closeDb`，不等在途订阅者，它后续的池查询会被拒。
- **证据**：
  ```ts
  if (r instanceof Promise) r.catch((e: unknown) => logFailed(event, e));   // event-bus.ts:73
  afterDrain: async () => { await closeDb(db); },                           // main.ts:186
  ```
  `ports/events.ts:19`："对 MVP 可接受：订阅者目前只做日志"。探针结果：`db.end()` 在 252ms 返回后，订阅者的下一条查询得到 `CONNECTION_ENDED`。
- **触发场景与后果**：部署或重启窗口内，用户取消订单或换通道后付款，事务提交后收到 SIGTERM，订阅者被中断：库内支付行没作废，Stripe 会话没失效。在会话自然过期（最长 30 分钟）之前，用户还能付这张已取消的单，或者重复付款，最后只能人工退款。另外 `unit-of-work.ts:23` 写的升级触发条件"订阅者开始做网络调用时"已经满足。
- **解决方案**：
  - 总线维护 `inflight:Set<Promise>`，端口新增 `drain(timeoutMs)`。
  - `main.ts` 的 afterDrain 先 `await events.drain(5000)` 再 `closeDb`；超时记 `event_subscribers_drain_timeout`，带未完成数量。
  - 改正上面三处注释；把 outbox 升级写成已触发的欠账。
  - 补测：总线 drain 单测；`main.db.test` 里挂一个慢异步订阅者，触发停机后断言它的 DB 写入已完成。
- **置信度**：已读代码证实，并对 `db.end` 行为做了探针
- **是否已登记**：已登记但描述有误。`全量代码独立审查报告-2026-09-28.md:251` 把 outbox 列为"未来阶段"，但它依据的触发条件已经成立；停机时中断订阅者这一点是新发现。

### INF-04｜P2｜安全 / 配置
- **位置**：`config.ts:339`；对照 `config.ts:117-127`（optionalSecret）和 `config.ts:515-528`（规则 3b）
- **问题**：`MOCK_CALLBACK_SECRET` 是生产审核模式下伪造"支付成功"回调的 HMAC 密钥，却用 `optionalText()`，没有长度下限。N11 自己的论断"配了但很短比没配更危险"在这里没有落实。
- **证据**：
  ```ts
  MOCK_CALLBACK_SECRET: optionalText(),
  INTERNAL_JOB_SECRET: optionalSecret(32, 'INTERNAL_JOB_SECRET'),
  ```
  探针：`NODE_ENV=production`、`PAYMENT_CHANNELS=mock`、`REVIEW_MODE=on`、`MOCK_CALLBACK_SECRET=a`，配置加载通过。
- **触发场景与后果**：审核期生产环境配了一个短密钥，在线枚举几十次就能拿到合法签名，把审核期的订单置为 paid（发货即白送）。
- **解决方案**：
  - 改为 `optionalSecret(32,'MOCK_CALLBACK_SECRET')`，同步 `.env.example`。
  - 补 config.unit 用例：短密钥拒启。
  - 先检查测试里传入的 mock 密钥长度；开发占位值是 42 位，不受影响。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-05｜P2（疑似）｜安全 / 可用性 / 未实测的平台行为
- **位置**：`config.ts:216-224`；`http.ts:75-82`、`http.ts:223`；`render.yaml:60-61`
- **问题**："Render 前一层 = 1"没有 `@measured`。已实测的只是 Express 在 true 和 1 两种设置下的取值行为，平台的真实跳数没有测过，不符合约束十。
- **证据**：`TRUST_PROXY_HOPS: int(1, 0)`；render.yaml 注释写"Render 前置一层反代（D23）"，没有实测记录。
- **触发场景与后果**：
  - 如果实际跳数是 2（例如前面还有 CDN），`req.ip` 取到的是边缘节点 IP，publicWrite 30 次/分钟/IP 的限流桶被大量用户共用，出现大面积 429。
  - 如果实际跳数少于 1，IP 可以伪造，限流可被绕过。
- **解决方案**：
  - 在 staging 临时记录 `x-forwarded-for`、`socket.remoteAddress`、`req.ips`，用已知出口 IP 发请求核对，把真实输出写进 `@measured`。
  - schema 默认值改为 0（符合"宁小勿大"），生产由 render.yaml 显式给值。
- **置信度**：疑似。缺真平台实测
- **是否已登记**：新发现

### INF-06｜P2（潜伏）｜幂等指纹 / 钱与状态（跨分片）
- **位置**：`ports/idempotency.ts:99-104`；`pay-intent-routes.ts:86-93`；重放路径 `adapters/idempotency.ts:247-255`
- **问题**：发起支付的幂等作用域和指纹都不包含路径参数 orderId。同一个键用在另一张单上，会通过指纹校验，把前一张单的支付意图重放出来。
- **证据**：
  ```ts
  key: scopeKey({ userId: sub, route: 'orders.pay', clientKey }),
  route: 'orders.pay',
  request: req.body,   // 只有 {channel}；orderId 在路径里
  ```
- **触发场景与后果**：
  - 客户端 bug 让键跨订单复用：对单 A 发起后，再用同一个键对单 B 发起。
  - 结果重放 A 的响应：`charge.amount` 是 A 的；redirect 或 in_app 模式下 `payload` 原样是 A 的会话，用户以为在付 B，实际付的是 A；copylink 模式下拼成"A 的金额 + B 的短链"。
  - D4（40908）本来就是为拦这种客户端复用键而设的，这里没拦住。
  - 目前小程序每次点击都生成新键（`miniprogram/pages/pay/index.js:121`），所以是潜伏问题。
- **解决方案**：
  - `request: { order_id: orderId, ...req.body }`，或者 route 改为 `orders.pay:${orderId}`。
  - 端口文档改为"含影响结果的**路径参数** / query"。
  - 补 db/e2e 用例：同一个键、不同订单，期望 40908。
- **置信度**：已读代码证实
- **是否已登记**：新发现（建议与 PAY 分片合并处置）

### INF-07｜P3｜配置 / 注释与实现不符
- **位置**：`config.ts:423`、`config.ts:652-676`；`main.ts:250-257`
- **问题**：zod 4 在对象字段校验失败时跳过 `superRefine`。"issues 列出全部问题 / 一次列全"只对字段级错误成立。
- **证据**：探针 `PORT=abc` 加上生产开 mock，只报 `PORT: … NaN`，跨字段那两条不出现；去掉 PORT 错误后，跨字段两条才出现。
- **触发场景与后果**：运维修完字段错误重启，才看到跨字段错误，要多重启一轮。
- **解决方案**：
  - `superRefine(fn, { when: () => true })`（探针证实两类都会列出），同时规则体里要做防御性判断，比如 `Array.isArray(c.PAYMENT_CHANNELS)`。
  - 或者只改注释。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-08｜P3｜配置边界（CLAUDE.md B/C）
- **位置**：`config.ts:56-77`、`config.ts:224`、`config.ts:299`、`config.ts:507-513`、`config.ts:577-601`
- **问题**（探针实测）：
  - ① 纯空白串被 `Number(' ')` 解析成 0：`FX_BUFFER_RATE=' '` 静默变 0，`CALLBACK_ORDER_GRACE_MS`、`TRUST_PROXY_HOPS` 同理。
  - ② 定时器类整数没有上限：`SCHEDULER_TICK_MS > 2^31-1` 时 Node 把间隔夹成 1ms（探针 200ms 内触发 162 次），正是注释点名要防的"打满 CPU"。
  - ③ 生产 DB 本机判定可被绕过：`postgresql:///db`（空主机，postgres.js 回落到 PGHOST 或 localhost，`index.js:438`）、`localhost.`、`2130706433`、`0x7f000001`、`[::ffff:127.0.0.1]` 全部放行。
  - ④ 只拦了 MOCK 与 JWT 相同，没拦 `INTERNAL_JOB_SECRET == JWT_SECRET`（前者要经 fromService 发给 cron 服务）。
- **解决方案**：
  - 预处理用 `String(v).trim()===''` 判未设置。
  - 毫秒类字段加 `.max(2_147_483_647)`。
  - 主机先用 `new URL('http://'+host)` 规范化（实测 `2130706433` 和 `0x7f000001` 都会变成 127.0.0.1），再按空主机、去尾点、IPv4 映射地址判定。
  - 补一条"密钥两两不同"规则。
  - 各配一条 config.unit 用例。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-09｜P3｜注释宣称的脱敏防护不成立
- **位置**：`app/scheduler.ts:129-141`；`app/scheduler-start.ts:116-125`；`errors.ts:101-106`；`ports/scheduler.ts:196-198`
- **问题**：
  - 调度器用 `oneLineError` 覆盖 `err_message`，声称这样能兜住"日志层兜不住的内容"。但 `errorLogFields` 的 `err_stack` 首行就含完整原文，而且不截断。
  - `oneLineError` 用的 `maskText` 和 logger 的 redact 是同一个函数，没有额外防护。
  - `ports/scheduler.ts:197` 写"logger 不做自动脱敏（已核实）"，与事实相反。
- **证据**：探针 `err_message.len=516`，`err_stack.len=2016`，而且 stack 里包含原始 message。
- **解决方案**：
  - 调度器同时覆盖 `err_stack`（maskText 后截断），或者给 `errorLogFields` 加截断选项。
  - 改正 ports 注释。
  - "单行上限采集器会丢超长行"的顾虑同样适用于 stack。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-10｜P3｜日志脱敏名单缺口与信息丢失
- **位置**：`redact.ts:56-69`、`redact.ts:116-127`、`redact.ts:163-175`、`redact.ts:353-359`、`redact.ts:369-374`
- **问题**（`classifyKey` 实测）：
  - 下列键名**不脱敏**：`x-api-key`、`stripe_api_key`、`wechatApiKey`、`mail_provider_api_key`、`R2_ACCESS_KEY_ID`、`accessKeyId`、`stripeKey`、`pwd`、`pass`、`passphrase`、`jwt`、`auth`、`paySign`、`sign`、`code`。原因是短语表只做整键相等匹配。
  - `Date`、`URL`、`Map` 被转成 `{}`。
  - `Error.cause` 被丢弃：出站失败只剩 `fetch failed`，根因（例如 `ENOTFOUND`）只在 cause 里（已实测），而 fetch-client 正是用 `err: e` 记日志的。
  - 目前没有找到现成的泄露路径：配置打印走 SECRET_KEYS 名单，微信支付还没实现。
- **解决方案**：
  - 短语改为后缀匹配（`squeezed.endsWith(p)`）并补 `accesskeyid`、`pwd`、`passphrase`、`jwt`、`paysign`。
  - Date 转 `toISOString`；Error 摊平时带上有深度上限的 cause 链。
  - 每一项在 `redact.unit.test.ts` 加断言。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-11｜P3｜停机摘流与平台配置矛盾；fatal 路径仍接新请求
- **位置**：`render.yaml:39-44`；`http.ts:516-527`、`http.ts:604-610`；`config.ts:300-306`；`process-errors.ts:8-11`
- **问题**：
  - render.yaml 明确选用 `healthCheckPath: /healthz`，平台根本不读 `/readyz`。
  - 但 N7 的理由（`http.ts:519-521`、`config.ts:302`）是"给平台一个按 503 摘流的机会"，所以 5s 等待没有任何消费方。
  - uncaughtException 也走这 5s，期间服务照常接新请求，与 process-errors 文件头"进程在未知状态继续接请求，不可接受"矛盾。
- **解决方案**：
  - `trigger()` 增加跳过 readyDelay 的参数，供 fatal 路径使用。
  - 统一注释口径；在平台实测之前，考虑把 `SHUTDOWN_READY_DELAY_MS` 设为 0。
- **置信度**：已读代码证实
- **是否已登记**：新发现

### INF-12｜P3｜停机兜底不完整
- **位置**：`http.ts:574-577`、`http.ts:588-592`、`http.ts:622-634`；`db.ts:242-245`
- **问题**：2s 硬退出定时器只在 `afterDrain` 成功或失败之后才上膛。`db.end()` 没有超时，会等所有连接结束；遇到网络黑洞时可以一直挂住。注释说的"DB 池没 end 靠 2s 兜底"在这种情况下不成立。
- **解决方案**：
  - `closeDb` 用 `db.end({ timeout: 5 })`。
  - `handler` 入口处就上一个总期限定时器（readyDelay + grace + 5s）。
- **置信度**：已读 postgres.js 源码证实
- **是否已登记**：新发现

### INF-13｜P3｜listen 错误被吞
- **位置**：`http.ts:452-457`
- **问题**：
  - Express 5 的 `app.listen` 会把 `error` 传给回调（`application.js:601-603`）。这里的回调忽略参数直接 resolve，随后 `address()` 返回 null，只抛"无法获取监听端口"，EADDRINUSE 的原因丢了（已探针证实）。
  - `s.on('error', reject)` 常驻在 server 上，运行期的 server `error`（例如 accept 时 EMFILE）被静默吞掉。
- **解决方案**：
  ```ts
  app.listen(port, host, (err) => err ? reject(err) : resolve(s))
  ```
  listen 成功后换成一个记日志的 error 监听。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-14｜P3｜访问日志在客户端中途断开时丢失（约束七）
- **位置**：`http.ts:244-267`
- **问题**：访问日志只监听 `finish`。客户端超时断开后，handler 照样执行完（例如单已经建了），却没有任何访问日志。"用户以为没成功而重试"的首个请求，恰恰就是这一条。
- **证据**：探针 `handlerDone=true`，`/slow` 的访问日志 0 行。
- **解决方案**：改用 `on-finished`（已是依赖），或者同时监听 `close`；未写完时记 `result:'client_aborted'`。补对应用例。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-15｜P3｜logger 注释与实现不符
- **位置**：`logger.ts:54-55` 对照 `logger.ts:221-226`；`logger.ts:170`
- **问题**：
  - `@limitation 二` 说上下文里的 `order_id` 优先、调用点的值被静默忽略；实现是调用点的值覆盖上下文（探针输出 `CALL-B`）。
  - `opts.base` 直接进 pino 的 base，不经过 redact，与文件头"强制脱敏，无处可绕"不符。目前没有调用方传 base。
- **解决方案**：改正注释，或者按注释调整合并顺序；base 先过 `redact()`。
- **置信度**：已探针证实
- **是否已登记**：新发现

### INF-16｜P3｜其它注释漂移（合并一条）
- `ports/ids.ts:20-22` 写"冲突重试属仓储层、D32 待办"，实际已在 `app/create-order.ts:188-196` 用 savepoint 实现。
- `http.ts:196-197` 写"管理端写操作（发货/退款）按规范要带幂等键"，与契约 0.6.10 ⑥（只有建单和发起支付认这个头）矛盾，没有任何管理端路由读它。
- `shared/errors.ts:170-174` 50300 的 action 写"按 Retry-After 退避"，但全仓没有为 50300 设置 `Retry-After` 头（契约写的是 `data.retry_after_ms`）。
- `errors.ts:29-32` 说 `ErrorBody.data` 可带"字段级校验结果"，但 AppError 没有携带 data 的通道。
- `http.ts:330-336`：CircuitOpenError 本是设计内的暂时态（503），却每次都按 `unhandled_error` 以 error 级带 stack 记录。
- `ports/scheduler.ts:39` 的默认值 `TICK_LOCK_KEY='scheduler:tick'` 在生产没用上：`main.ts:165` 传的是 `'tick'`，将来谁漏传 lockKey 就不会与生产 tick 互斥。
- `adapters/idempotency.ts:177-179` 说 runInTx 的 handler 只做 DB 写入，但 pay-intent 在 runInTx 里调 Stripe（`pay-intent.ts:23-29` 写的是"已知代价"），两处口径冲突。
- **置信度**：已读代码证实
- **是否已登记**：新发现

**高风险分支没有测试覆盖（只点名）**：
- body-parser 的 415、encoding、gzip、aborted 分支
- runInTx 里 handler 的 lock_timeout
- 停机时在途的异步订阅者
- 客户端断开时的访问日志
- 字段错误与跨字段错误同时存在时的列出行为
- 跨订单复用幂等键

## 3. 看过但不是问题的疑点

1. **ALS 上下文**：经过 JSON 与 raw 解析、到 `finish` 回调、到 handler，trace_id 都还在（探针全部为 Y）。
2. **回调路径被二次解析**：raw 解析后 json 不会再读流，因为 body-parser 的 `onFinished.isFinished(req)` 会跳过，探针 `isBuf:true`。
3. **短链 token 进日志**：token 在 `?t=` 里，访问日志和 404 只记 `req.path`，不会记录。
4. **PostgresError 的 detail/parameters 泄露 PII**：redact 摊平 Error 时只保留 name/message/stack，这些字段不会进日志。
5. **tick 挂死**：job 挂死最多被 `idle_in_transaction_session_timeout`（60s）杀连接，postgres.js 的 `begin` 用 `connection.onclose = reject` 解锁，`running` 随即复位。savepoint 各自有独立的 `uncaughtError`，单个 job 失败不会污染外层事务（已读源码）。
6. **advisory lock**：是事务级的，回滚自动释放；tick 与 daily 用不同的键，是刻意设计。
7. **NODE_ENV 默认 development 是失效即放开的默认值**：已有 `render-env.unit.test.ts:187` 断言 render.yaml 显式写了 production。
8. **启动配置日志**：经 redactConfig 再过 redact，`ADMIN_EMAIL` 变成 `b***@corp.jp`，`ADMIN_OPENIDS` 变成 `***`，`DATABASE_URL` 变成 `***`。
9. **x-trace-id 重复头**：Node 会用 `", "` 拼接，不符合正则，于是新建 trace_id。
10. **幂等清理**：`created_at` 有索引（`idx_idempotency_keys_created`），只删已完成的行。
11. **大写管理端路径**：CORS 在这种情况下不下发放行头（探针 ACAO 为 null），属于安全失效，不是越权。
12. **design-tokens**：与 app.wxss 的五色一致，有同源断言守着。
