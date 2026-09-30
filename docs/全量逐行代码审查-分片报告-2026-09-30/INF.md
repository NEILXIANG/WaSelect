# INF 分片（运行底座）第二轮逐行审查报告 — 2026-09-30

审的是**工作区当前文件**（HEAD 41d40ba + 未提交改动）。仓库全程只读；没跑 npm 脚本、测试、构建；没连数据库；没读 `.env`。
只跑了 4 个纯 Node 探针（本机 Node v25.3.0，生产锁 Node 22——凡依赖探针的结论都标了这一点），脚本在
`/private/tmp/claude-501/-Users-neilxiang-Documents-me-jp-project/8203fe3d-261d-4727-8bdd-e173b66827e2/scratchpad/review2/INF-probes/`：
`a-als-close.mjs`、`b-raw-empty.mjs`、`c-canonical-depth.mjs`、`d-close-partial.mjs`。

**结论**：本分片 **P1 = 0，P2 = 2，P3 = 8**（其中 1 条疑似）。上一轮本分片的 P2（B6 / B10 的 INF 部分 / B13 / B19 / B20 主体）均已落地且读下来没有引入钱或状态上的回归；
两条 P2 都出在**修复本身没修到底**的地方（B13 的停机等待有一条分支绕过；INF-14 的访问日志补出来的那一行串不上链）。

---

## 1. 覆盖清单（全部逐行读完）

| 文件 | 行数 | 文件 | 行数 |
|---|---|---|---|
| server/src/http.ts | 794 | server/src/adapters/clock.ts | 35 |
| server/src/config.ts | 803 | server/src/adapters/ids.ts | 28 |
| server/src/main.ts | 315 | server/src/app/scheduler.ts | 202 |
| server/src/logger.ts | 273 | server/src/app/scheduler-start.ts | 144 |
| server/src/redact.ts | 420 | server/src/app/shutdown-cleanup.ts | 55 |
| server/src/errors.ts | 115 | server/src/app/unit-of-work.ts | 63 |
| server/src/context.ts | 89 | server/src/app/cleanup-idempotency.ts | 57 |
| server/src/process-errors.ts | 78 | server/src/app/business-events.ts | 43 |
| server/src/express-augment.d.ts | 19 | server/src/ports/clock.ts | 29 |
| server/src/adapters/db.ts | 262 | server/src/ports/events.ts | 99 |
| server/src/adapters/event-bus.ts | 169 | server/src/ports/idempotency.ts | 180 |
| server/src/adapters/idempotency.ts | 484 | server/src/ports/ids.ts | 40 |
| server/src/adapters/scheduler.ts | 125 | server/src/ports/scheduler.ts | 255 |
| packages/shared/src/errors.ts | 198 | packages/shared/src/index.ts | 18 |

合计 **28 个文件、5392 行**。另读：BRIEF、CLAUDE.md、上一轮 INF 分片原文、主报告的 INF 相关条目。

为下结论读过的分片外文件（只读相关段）：`app/mount.ts`（路由挂载方式）、`app/pay-routes.ts`（rawBody）、`app/order-routes.ts`、`app/pay-intent-routes.ts`（指纹素材）、`app/close-session-events.ts`（订阅者全文）、`app/rate-limit.ts` / `app/admin-audit.ts`（前缀中间件怎么结束请求）、`adapters/payment/stripe-checkout.ts` 的 `expireSession`、`render.yaml`、`http.unit.test.ts`（INF-14 用例与停机用例）、`main.db.test.ts`（停机用例）。`git diff --stat 848278d..HEAD` 看了本分片全部改动文件。

---

## 2. 发现

### P1
无。

### P2

#### INF2-01｜P2｜优雅停机：排空超时分支直接 `return`，跳过 `afterDrain`——B13 的"等订阅者再关库"在这条分支上不生效
- **位置**：`server/src/http.ts:747-757`（`handler` 的第一个 try/catch）；`http.ts:619-627`（`closeServer` 超时 reject）；`main.ts:216-227`（`afterDrain` = `drainEventsThenClose`）
- **问题**：`started.close()` 超时（默认 `graceMs=10s`）会 reject，外层 catch 记 `server_stop_failed` 后 `finish(1); return;`——**第二个 try（`hooks.afterDrain`）永远不执行**。于是：① `events.drain()` 没被调用，在途的异步订阅者（`close-session-events`：作废机构会话）没人等；② `closeDb` 没调，连接池没关，进程靠 2s 硬退出 `exit(1)` 结束，在途事务被直接掐断；③ 一次例行部署以退出码 1 结束。
- **证据**：
  ```ts
  // http.ts:747-757
        await started.close();
        hooks.logger.info('server_drained', { signal, duration_ms: duration() });
      } catch (e) {
        hooks.logger.error('server_stop_failed', { ... });
        finish(1);
        return;            // ← afterDrain（drain 事件 + 关库）被整段跳过
      }
      try {
        await hooks.afterDrain?.();
  ```
  超时有多容易触发——探针 D（`d-close-partial.mjs`，照抄 `closeServer` 的"先清一次 + 100ms 清扫 + 到点 closeAllConnections"）：
  ```
  空连接（什么都没发）       → TIMEOUT→reject  1501ms
  只发了半截请求头           → TIMEOUT→reject  1501ms
  头发完、body 只发一半      → TIMEOUT→reject  1500ms
  ```
  即 `closeIdleConnections()` **不清**"连上了但还没发完一个请求"的连接（Node 把它们算作活跃，受 `headersTimeout` 60s / `requestTimeout` 300s 约束，本仓库没改这两个默认值），只要停机时刻有一条这样的连接，就必然走满 10s 并进超时分支。
- **触发场景与后果**：部署（SIGTERM）时刻恰有一条慢请求（弱网上传中的 body、经代理流式转发的慢客户端、超过 10s 的请求），或任何一条建了连接没发完请求的连接。后果是 B13 描述的那个窗口原样回来：刚提交的取消/过期/付款事件，其订阅者被硬退出打断 ⇒ 机构会话没作废，已取消的单在会话自然过期前仍可付款；同时日志只有一条 `server_stop_failed`，没有 `event_drain_timeout`，事后看不出有订阅者被打断。条件是"停机窗口 + 慢连接 + 恰有在途订阅者"三者同时成立，概率不高，但它是 B13 修复声称已覆盖的"优雅停机"路径上的一个洞。
- **没有用例守着**：`http.unit.test.ts` 的停机用例全部走排空成功；`main.db.test.ts:228-230` 还特意注明要避开 `server_stop_failed` 分支。
- **修复方案**：`http.ts` 的 handler 里，排空失败后**不要 return**：记 `server_stop_failed`、把最终退出码记为 1，然后照常执行 `afterDrain`（`closeAllConnections` 已经把连接断了，此时等订阅者、关库都是安全的）。形如：
  ```ts
  let code = successExitCode;
  try { …await started.close(); … } catch (e) { log server_stop_failed; code = 1; }
  try { await hooks.afterDrain?.(); if (code === 0) log server_stopped; finish(code); }
  catch (e) { log shutdown_cleanup_failed; finish(1); }
  ```
  补一条 http.unit 用例：挂一个永不结束的请求 + 小 `graceMs`，断言 `afterDrain` 仍被调用且退出码为 1（注回 `return` 应变红）。顺带可在 `listen()` 里把 `server.headersTimeout` / `requestTimeout` 调到与 `graceMs` 相称的值，减少超时分支的触发面。
- **置信度**：已读代码证实（跳过 afterDrain）+ 已探针证实（半截连接撑满超时；Node 25.3，Node 22 同一套 `ConnectionsList` 机制，未在 22 上重跑）
- **是否已登记**：新发现（与 INF-12"硬退出定时器上膛太晚"是同一段代码的另一条分支，不是同一件事）

#### INF2-02｜P2（偏低，诊断类；主会话可降 P3）｜INF-14 补出来的 `client_aborted` 访问日志**没有 trace_id / req_id**，且业务后来的真实结果被去重吞掉；用例把后者钉成了正确
- **位置**：`server/src/http.ts:305-340`（`emit` / `res.on('close', emit)`）；`logger.ts:204`（上下文取自 ALS）；`http.unit.test.ts:525-547`
- **问题**：
  1. `close` 事件由 socket 句柄的回调触发，不在 `runWithContext` 建的异步链里，`currentContext()` 拿到的是空对象 ⇒ 这条 `http_request`（`result:'client_aborted'`）**不带 trace_id、req_id、user_id**。而 AJ-206 的目的正是"让被用户中断的那次首发请求可查"——它现在有一行日志，但和同一请求的业务日志（建单、退款、审计，都带 trace_id）**串不起来**。
  2. `logged` 去重让 `close` 先到时把后续的 `prefinish` 吞掉：handler 稍后真正写出的状态码（201 建单成功 / 500）永远不进访问日志，`duration_ms` 记的也是"断开那一刻"而不是业务耗时。"这次被中断的请求最后成没成"只能去翻业务日志——而第 1 点又让它对不上号。
- **证据**：探针 A（`a-als-close.mjs`，同样的"ALS 中间件 → prefinish/close 双挂 + 去重"）：
  ```
  {"via":"prefinish","url":"/fast","ctx":{"trace_id":"T-/fast"},"writableEnded":true,"status":200}
  {"via":"close","url":"/slow","ctx":null,"writableEnded":false,"status":200}      ← 中断：上下文为空
  {"handlerDone":true,"ctx":{"trace_id":"T-/slow"}}                                 ← handler 后来照常跑完
  {"via":"prefinish","dup":true,"url":"/slow"}                                      ← 真实结果被去重丢弃
  ```
  用例 `http.unit.test.ts:538-546` 断言"服务端后来写出的 200 没有补出第二条"、`http_status=0`，**没有**断言 trace_id。
- **触发场景与后果**：用户在退款/发货/建单的等待窗口里关页或网关先超时（注释自己说这是常态）。排障时看到一条没有任何 ID 的 `client_aborted`，无法回答"是哪个用户的哪次操作、最后成功了没有"——约束七要求的"谁、做了什么、系统怎么响应"三样缺两样。
- **修复方案**：
  - 在访问日志中间件里**进入时**抓一份上下文：`const ctx = currentContext();`（此刻在 ALS 链内），`emit` 内用 `runWithContext(ctx, () => httpLog.xxx(...))` 包住——`close` 分支就带上同一个 trace_id / req_id 了（`patchContext` 改的是同一个对象，登录后补的 `user_id` 也在）。
  - 中断时不要用同一个 `logged` 把最终结果吞掉：`close` 先到 → 记 `http_request_aborted`（warn）；之后 `prefinish` 到 → 仍记一条 `http_request`，带真实 `http_status`、真实 `duration_ms` 和 `client_gone: true`。可用性统计按 `client_gone` 过滤即可，不必靠把状态码写成 0。
  - 用例补断言：中断那条的 `trace_id` 等于响应头/请求头里的那个；handler 完成后能查到最终状态。
- **置信度**：已探针证实（Node 25.3；生产 Node 22 未重跑，机制相同）
- **是否已登记**：新发现（AJ-206 修复的遗漏；`app/admin-audit.ts` 用的是同一形态，归 SEC 分片核对）

### P3

#### INF2-03｜P3｜幂等指纹的 `canonical()` 是无深度上限的递归：登录用户一个 6KB 的请求体就能稳定打出 500 + error 级 `unhandled_error`
- **位置**：`server/src/ports/idempotency.ts:49-58`、`:67-69`；调用点 `app/order-routes.ts:123`（`request: req.body`）、`app/pay-intent-routes.ts:102`（`...(body ?? {})`）；`adapters/idempotency.ts:75`、`:212`（指纹在 try 之外算）
- **问题**：两条路由都把**未经白名单裁剪**的请求体交给指纹（`parseBody` / `channel` 校验只看自己要的键，不拒未知键）。`canonical` 对数组/对象递归，没有深度上限。
- **证据**：探针 C（`canonical` 原样抄录）：
  ```
  1000 层  2034 字节  parse ok, fingerprint ok
  3000 层  6034 字节  parse ok, fingerprint 抛 RangeError Maximum call stack size exceeded
  45000 层 90034 字节 parse ok, fingerprint 抛 RangeError …
  ```
  `JSON.parse` 能吃下（100kb 上限内），炸在 `requestFingerprint`；RangeError 不是 AppError → `http.ts:430-436` 记 `unhandled_error`（error 级带栈）+ 50000。
- **触发场景与后果**：任何已登录用户 `POST /api/v1/orders`（或 `/orders/:id/pay`），body 里多带一个 `"x":[[[[…]]]]`。与 B20 同一类（客户端可控输入进 5xx，七类必查项 G），只是要登录且受 30 次/分钟限流，所以定 P3。
- **修复方案**：`canonical` 加深度参数，超过（如 32 层）抛 `AppError(40001, { reason: 'body_too_deep' })`；或者更彻底——两个调用点只把**解析后的白名单字段**交给指纹（建单：`items` + `address_id` + `terms_version` + `expected_total_jpy` + `contact_email`），未知键不参与。补 unit 用例：3000 层嵌套 → 40001。
- **置信度**：已探针证实
- **是否已登记**：新发现

#### INF2-04｜P3｜（跨片，B10 修复的漏口）发起支付的指纹里，body 自带的 `order_id` 会覆盖路径参数
- **位置**：`server/src/app/pay-intent-routes.ts:102`；契约说明在 `ports/idempotency.ts:100-108`
- **问题**：`request: { order_id: orderId, ...(body ?? {}) }`——展开在后，body 里若有 `order_id` 键就把路径里的那个盖掉。AJ-195 要防的"同一把键跨订单复用 → 重放另一张单的支付意图"，在客户端 body 里带固定 `order_id` 时仍然成立。
- **证据**：探针 C 末行：`{order_id:'ORDER-A', ...{channel:'stripe', order_id:'Z'}}` 与 `{order_id:'ORDER-B', …}` 指纹相等 → `true`。
- **触发场景与后果**：需要客户端 body 多带一个 `order_id` 且跨单复用键；小程序现在只发 `{ channel }`（`miniprogram/pages/pay/index.js:201`），所以是潜伏项，且只影响用户自己的两张单。但它是一行就能关掉的口子。
- **修复方案**：改为 `{ ...(body ?? {}), order_id: orderId }`（路径参数最后写），或只取 `{ order_id: orderId, channel }`。补用例：body 带 `order_id` 的同键跨单 → 40908。
- **置信度**：已读代码 + 已探针证实
- **是否已登记**：新发现（建议并入 PAY 分片处置）

#### INF2-05｜P3｜`/readyz` 是一个免鉴权、免源站校验、不打访问日志、每次都查库的端点，没有任何缓存或限流
- **位置**：`server/src/http.ts:397-407`（每次请求 `await opts.readiness()`）；`http.ts:57-61`（源站校验豁免）；`http.ts:253`、`:311`（静默路径）；`main.ts:166`（`ping(db)` = `select 1`）
- **问题**：四个性质叠在一起：谁都能打（豁免了 `ORIGIN_VERIFY_SECRET`，可直连 `*.onrender.com` 绕过 Cloudflare 的防护）、每次占一条池连接、不限流、成功时**一行日志都没有**。连接池只有 10 条。
- **触发场景与后果**：对 `/readyz` 做并发请求，`select 1` 排在池队列里和业务查询抢连接；业务侧表现为全站变慢/超时，而访问日志里看不到任何来源（静默路径）。平台本身并不读 `/readyz`（render.yaml 用的是 `/healthz`），所以这个端点目前只有成本没有消费者。
- **修复方案**：readiness 结果做 1–2 秒的进程内缓存 + 单飞（同一时刻最多一次 `ping`）；或把 `/readyz` 从源站校验豁免名单里拿掉（平台只探 `/healthz`）。二选一即可，前者更稳。补用例：并发 50 次 `/readyz` 只触发 1 次 readiness 回调。
- **置信度**：已读代码证实
- **是否已登记**：新发现

#### INF2-06｜P3｜配置的"组合缺位"与停机预算口径（七类必查项 C）
- **位置**：`server/src/config.ts:266-288`、`:370-386`、`:483`、`:529-728`；`http.ts:587`；`app/close-session-events.ts:87-113`
- **问题**（都是注释里写了"必须成对/必须大于"，但 `crossField` 里没有对应规则）：
  1. `config.ts:271-275` 写"层数取 2 + 源站只认 Cloudflare 注入的头，两件事必须成对出现"，render.yaml:64 也这么写——但 `TRUST_PROXY_HOPS >= 2` 且 `ORIGIN_VERIFY_SECRET` 为空时照常启动。那正是注释点名的"XFF 可伪造、限流与封禁可任意绕过"的组合。
  2. `config.ts:378-379` 写"等得比出站总预算短等于注定等不到"——`SHUTDOWN_EVENT_DRAIN_MS < HTTP_TOTAL_BUDGET_MS` 没有规则拦（两者都可独立调）。
  3. "8s = 6s + 2s"只对**一个会话**成立：`close-session-events.ts:87-113` 对一张单的每个未成功会话**串行** `await expireSession`，换过通道的单有两个会话就是最坏 12s，超过默认 8s。
  4. `config.ts:382-384` 写停机总时长"合计约 15s"，漏了 `listen()` 的 `graceMs` 10s：最坏是 5（摘流等待）+ 10（排空）+ 8（等订阅者）+ 2（退出宽限）= 25s，外加无上限的 `db.end()`（旧 INF-12）。`http.ts:571` 自己写的平台宽限是 30s，余量只有 5s，而注释让人以为有 15s。
- **修复方案**：`crossField` 加两条：生产/预发下 `TRUST_PROXY_HOPS >= 2 && ORIGIN_VERIFY_SECRET === undefined` → 拒启；`SHUTDOWN_EVENT_DRAIN_MS !== 0 && SHUTDOWN_EVENT_DRAIN_MS < HTTP_TOTAL_BUDGET_MS` → 拒启。订阅者里多个会话改 `Promise.allSettled` 并发作废。把 `config.ts:382-384` 的算式改成含 `graceMs` 的 25s，并把"平台宽限必须 > 25s"写进 render.yaml 的待实测项。各配一条 config.unit 用例。
- **置信度**：已读代码证实
- **是否已登记**：新发现（第 1 点是 A2 修复引入的新组合；A2"层数未实测"本身是已知项，不重复）

#### INF2-07｜P3｜订阅者失败日志只有一句 message，且 `err` 字段在全仓有两种类型
- **位置**：`server/src/adapters/event-bus.ts:76-81`；同形态 `adapters/idempotency.ts:322-327`；分片外 `app/close-session-events.ts:106-111`
- **问题**：`err: e instanceof Error ? e.message : String(e)`——丢了错误类型、栈、PG 的 SQLSTATE。订阅者失败是"静默只落日志"的那类代码（文件头自己说的），这条日志是唯一线索，却只有一行文本。另外别处 `err` 传的是 Error 对象，经 `redact` 摊成 `{err_type, err_message, err_stack}`；这里是字符串。同一个键两种类型，按字段建索引的日志后端会对其中一种报映射冲突或丢字段。
- **修复方案**：三处都改成 `err: e instanceof Error ? e : new Error(String(e))`（`redact` 会统一摊平并过 `maskText`）。`event-bus.unit.test.ts` 补断言 `err.err_type` 存在。
- **置信度**：已读代码证实
- **是否已登记**：新发现

#### INF2-08｜P3｜修复提交留下的注释漂移（合并一条）
- `http.ts:101`：`trustProxyHops` 的 JSDoc 首句仍写"默认 **1**"，同一段下面（:107-109）和代码（:257 `?? 0`）都是 0；:106"按平台实际拓扑配（Render=1）"与 `config.ts:259`"至今没有 @measured"相矛盾（`config.ts:256` 同样还写着"Render 前一层 = 1"）。
- `http.ts:464`：`isBodyParseError` 的第一段 @why 仍写"现在只认解析器自己打的标记（`type` / `status=400`），其余一律落到 50000"，而 B20 之后判据是 `expose === true && 4xx`，**不再看 `type`**——任何带这两个标记的非 AppError 都会被归成 40001"请求体无法解析"。目前全仓只有 body-parser / raw-body 会抛这种形状，所以没有误判；但第一段 @why 描述的防线已经不是代码的样子了（"快递解析器"也是笔误）。
- `adapters/event-bus.ts:2`、`:21-23`：文件头"同步分发"和 @tradeoff"换来'发布返回时订阅者已跑完'这个好测的语义"，与同文件 @limitation 二（async 订阅者发后不等）直接矛盾——B13 只改了后者。
- `config.ts:389-390`、`:427-445`：`TERMS_VERSION` 与 `MOCK_CALLBACK_SECRET` 各有两段 JSDoc 叠在一起（旧的没删）；`crossField` 里有两条都叫"1d"的规则（:559、:581）。
- `ports/events.ts:95-96`："先摘流量（publish 不再被新请求调用）再 drain"——调度器的在途 tick 与 daily 作业仍会 publish，措辞过满。
- **置信度**：已读代码证实
- **是否已登记**：新发现（均为 09-29 之后的修复提交带出来的）

#### INF2-09｜P3｜访问日志与 404 日志里的客户端可控字段没有长度上限
- **位置**：`server/src/http.ts:314-331`（`http_path`、`user_agent`）；`http.ts:414`（40400 的 details 又带一遍 `http_path`）；`http.ts:425-448`
- **问题**：`req.path` 与 `user-agent` 原样进日志，上限只有 Node 的请求头总长（默认 16KB）。一次未知路径请求产生两行（`request_rejected` + `http_request`），各带一份路径。`x-trace-id` 当年就是因为"超长值污染日志"加了 64 字符上限（:126-140），同一理由对路径和 UA 同样成立；`ports/scheduler.ts:77` 还写着"有单行上限的采集器会整条丢弃超长行"。
- **修复方案**：访问日志里 `http_path`、`user_agent` 截到固定长度（如 512 / 256）并在截断时带 `truncated: true`；40400 的 details 复用同一个截断函数。
- **置信度**：已读代码证实
- **是否已登记**：新发现

#### INF2-10｜P3（疑似，需平台实测）｜`listen()` 没设 `keepAliveTimeout`，Node 默认 5s 可能短于前置反代的空闲超时
- **位置**：`server/src/http.ts:585-599`
- **问题**：Node HTTP server 默认 `keepAliveTimeout = 5000`。若前置反代（Render / Cloudflare）复用到源站连接的空闲时长大于 5s，就会出现"反代刚要复用、源站恰好关连接"的竞态，表现为零星 502，且源站没有任何日志。这是**凭经验提出的疑点**，Render 反代的实际空闲超时我没有实测依据。
- **修复方案**：staging 上实测反代到源站的连接复用行为后，在 `listen()` 里显式设置 `server.keepAliveTimeout`（大于反代空闲超时）与 `server.headersTimeout`（再大一点），并把实测值写成 `@measured`。与 A2 / B18 的 staging 实测一起做。
- **置信度**：疑似需实跑
- **是否已登记**：新发现

---

## 3. 上一轮未修项状态（只列本分片相关的）

| 编号 | 是否仍在 | 一句话 |
|---|---|---|
| INF-07 | 仍在 | `config.ts:529` `schema.superRefine` 无 `when`，字段错时跨字段规则不跑；`main.ts:292-294` 仍称"一次列全" |
| INF-08 ① | 仍在 | `num/int/optionalInt` 只判 `v === ''`，纯空白串仍被 `Number(' ')` 解析成 0 |
| INF-08 ② | 仍在 | 毫秒类配置无上限（新增的 `SHUTDOWN_EVENT_DRAIN_MS` 同样没有） |
| INF-08 ③ | 仍在 | 生产 DB 本机判定仍是字面量名单（`config.ts:692-702`） |
| INF-08 ④ | 仍在 | 只拦 MOCK==JWT；`INTERNAL_JOB_SECRET`、新增的 `ORIGIN_VERIFY_SECRET` 与 JWT 相同不拦 |
| INF-09 | 仍在 | `app/scheduler.ts:134`、`scheduler-start.ts:118` 的 `err_stack` 仍是未截断原文；`ports/scheduler.ts:229`"logger 不做自动脱敏（已核实）"仍与事实相反（app 层两处注释已改对） |
| INF-10 | 仍在 | 短语表仍整键相等；Date/Map → `{}`；`Error.cause` 与 PG 错误的 `code`（SQLSTATE）仍被丢 |
| INF-11 | 仍在 | fatal 路径仍走 5s 摘流等待并继续接请求；平台仍只读 `/healthz` |
| INF-12 | 仍在 | `closeDb` 仍是无超时的 `db.end()`；硬退出定时器仍在 afterDrain 之后才上膛（B13 又在前面加了最多 8s） |
| INF-13 | 仍在 | `http.ts:589` listen 回调仍忽略 err；`s.on('error', reject)` 仍常驻 |
| INF-14 | 已修，但见 INF2-02 | 改挂 prefinish + close；补出来的那行没有 trace_id |
| INF-15 | 仍在 | `logger.ts:54-55` 注释与合并顺序相反；`opts.base` 仍不过 redact |
| INF-16 | 大部分仍在 | `ports/ids.ts:20-21`"D32 待办"、`http.ts:230` 管理端幂等键说法、`shared/errors.ts:173` Retry-After（50300 仍不设该头）、`errors.ts:28` data 说法、CircuitOpenError 仍以 error 级 `unhandled_error` 记录、`TICK_LOCK_KEY` 默认值未被生产使用——均未动；仅 `idempotency.ts` @limitation 二 已补登记例外 |
| B6（INF-01） | 已修 | `adapters/idempotency.ts:239` 抢到占位后 `set local lock_timeout to default`；位置在 `inHandler = true` 之前，55P03 归类不受影响（本轮未连库复测） |
| B10（INF-06） | INF 部分已修 | 指纹已含 `order_id`；漏口见 INF2-04；"补发短链前不核对通道"属已知待修，不展开 |
| B13（INF-03） | 已缓解 | `drain` + `drainEventsThenClose` 已接线；绕过分支见 INF2-01；outbox 仍是登记在案的欠账 |
| B19（INF-04） | 已修 | `MOCK_CALLBACK_SECRET` 用 `optionalSecret(32)` |
| B20（INF-02） | 主体已修 | 4xx 判据放宽 + 严格路由；坏百分号路径仍 500 属已知待修 |
| A2（INF-05） | 已知待实测 | 默认值改 0、源站校验已备；平台跳数仍无 `@measured` |

---

## 4. 看过、确认没问题的高风险点

1. **回调路径的空 body**：`express.raw({type: () => true})` 对"无 body / content-length: 0 / chunked 空体"的 POST 都给 `Buffer(0)`，不会落进 `rawBody()` 的 50000 分支（探针 B：5 种形态全部 `isBuf:true`；express 5.2.1 + body-parser 2.3.0）。
2. **严格路由是否真的生效**：`case sensitive routing` 只作用于 app 自己的路由器；子 `express.Router()` 有独立选项。全仓非测试代码**没有**子 Router（grep 为空），路由全部直接挂在 app 上，`app.use(前缀, 中间件)` 的前缀层也继承该设置——B20 的修法成立。
3. **访问日志里的 `req.path` 会不会被前缀挂载截短**：只有两处 `app.use(前缀, …)`（限流、管理端审计），二者都走 `next()` / `next(AppError)`，Express 在 `next` 时恢复 `req.url`，不会出现日志路径变成 `/` 的情况。
4. **`isBodyParseError` 放宽后的误吞**：判据是 `expose===true && 4xx` 且排除 AppError；全仓只有 body-parser / raw-body 会抛这种形状。Express 路由的坏百分号错误没有 `expose`，仍是 500（已知项）。
5. **B6 复位的位置**：`set local lock_timeout to default` 在占位成功之后、`inHandler = true` 之前；若这一句本身失败，仍按"占位阶段"处理，不会把 handler 的 55P03 误判成冲突。冲突返回路径不受影响。
6. **`drain` 循环**：`tracked.finally(delete)` 先于 `allSettled` 的回调注册，集合清空后才进入下一轮，不会空转；定时器在 finally 里清；`timeoutMs=0` 直接返回在途数。
7. **停机时在途的调度器 tick**：`beforeDrain` 只停定时器，但默认 5s 摘流等待 + 排空远长于一轮 tick（毫秒级），tick 提交后发出的订阅者会被 `drain` 计入。只有 `SHUTDOWN_READY_DELAY_MS=0` 且 tick 恰在跑时才有毫秒级窗口，不单列。
8. **源站校验豁免的路径穿越**：`/api/v1/internal/jobs/../admin/…` 能过豁免前缀，但 Express 不折叠点段，匹配不到任何路由，落 404。密钥比较先比长度再 `timingSafeEqual`。
9. **信号处理器入参**：`process.on(s, () => handler(s))` 包了一层，OS 投递的信号编号不会顶掉 `successExitCode`。
10. **启动配置日志**：`redactConfig` 后再过 logger 的 `redact`，`ADMIN_EMAIL` 按邮箱掩码、`ADMIN_OPENIDS` 整体 `***`、`CHECKOUT_BASE_URL` 走 `maskUrl`；`SENTRY_DSN` 的 key 段被邮箱正则顺带掩掉。
11. **幂等执行器的钱路径**：单事务模式下占位、业务写、结果写回同事务，崩溃即回滚；跨用户撞键与指纹不符都走 40908；清理只删已完成行。没有发现重复执行或重放错结果的新路径（INF2-04 的漏口除外）。
12. **调度器**：子任务事件只在 savepoint 成功后登记、整轮提交后分发；失败不动 `last_success_at`；锁是事务级，回滚即释放。
13. **`shared/errors.ts`**：码表、`httpStatusOf`、`isErrorCode` 本轮无改动，读下来无新问题（50300 的 action 文案见旧 INF-16）。
