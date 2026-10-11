/**
 * 职责：HTTP 骨架（F6）——Express 应用工厂 + 请求上下文 + 访问日志 + 统一错误兜底。
 * 边界：只搭骨架与横切能力；业务路由在各自的模块里挂载（F6b 鉴权、I1 业务期；F6c 行走骨架已随 U6c 退役）。
 *
 * @why 这四件事必须在骨架层一次性做对，因为它们**无法靠"以后补"**：
 *      ① 请求上下文一旦漏配，全站日志就没有 trace_id，事后无法把一次下单的日志串起来；
 *      ② 错误兜底一旦漏配，未捕获异常会变成 Express 默认 HTML 500 页，前端解析不了、日志也没有 err_code；
 *      ③ 访问日志一旦漏配，"用户操作行为"这条需求就只剩业务事件，缺了请求维度（耗时/状态码/路径）；
 *      ④ raw body 顺序一旦错了，回调验签永远失败（签名必须用**未被解析的原文**验）。
 *
 * @limitation 一：`trust proxy` **层数由配置决定**（D23，`TRUST_PROXY_HOPS`，绝不是全开）——
 *              全开会信客户端自报的 `X-Forwarded-For`，req.ip 可伪造（限流与审计依赖它）。
 *              即便按层数取，ip 也只用于限流与日志，**绝不用于鉴权**。
 * @limitation 二：健康检查默认不打访问日志（Render 每 30s 探活会淹没日志），
 *              因此"服务真的收到过多少次外部请求"不能只看访问日志，要看限流与业务事件。
 * @limitation 三：raw body 路由按**路径前缀**匹配，路径写错就会静默退化成 JSON 解析（验签必然失败且不报明确错）。
 *              缓解：`rawBodyPaths` 由配置/常量集中给出，并有测试断言该路径确实拿到 Buffer。
 * @limitation 四：优雅关闭依赖 `closeIdleConnections` / `closeAllConnections`（Node 18.2+）。
 *              更低版本上这两个方法是 undefined，会退化成"只停止接新请求"，进程可能挂到 keep-alive 超时；
 *              engines 已锁 `node >=22`，实际不会遇到，但不做运行时兜底。
 *
 * @tradeoff 用 Express 而非 Fastify：生态与资料最多（团队零小程序/Node 后端经验），
 *           代价是没有内建的 schema 校验与更慢的序列化——校验由 zod 在路由层做（F6c 起），性能在日百单量级无差异。
 *
 * @see docs/可扩展架构设计（app 层）、docs/代码注释规范与日志体系设计.md（流 C 请求日志）、技术文档 v0.5 §8
 */
import type { Server } from 'node:http';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { AppError, toErrorResponse } from './errors.js';
import { CircuitOpenError } from './ports/circuit-breaker.js';
import { timingSafeEqual } from 'node:crypto';
import { newTraceId, runWithContext } from './context.js';
import type { Logger } from './logger.js';

/** 请求体大小上限：业务只传 JSON 文本，100KB 足够；超过基本是异常或攻击。 */
const JSON_BODY_LIMIT = '100kb';
/** 回调原文上限（Stripe/WeChat 回调体都很小）。 */
const RAW_BODY_LIMIT = '256kb';

/**
 * 源站校验头的名字（A2 / AJ-197）。**常量而不是配置项**：
 * @why 它由 Cloudflare Transform Rule 注入、由本进程校验，两端都是我们自己写——
 *      让它可配只会多出一个"名字对不上 → 全站 403"的失效方式，而没有任何收益
 *      （没有任何场景需要两个不同的名字）。可配的只有**值**（`ORIGIN_VERIFY_SECRET`）。
 */
const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

/**
 * 源站校验的豁免路径（平台内网直连源站的三类流量 + 支付回调，见 2c 的 @why）。
 * @why `/api/v1/internal/jobs` 用**前缀**：Cron 调的是它的子路径 `/daily`。
 * @why `/api/v1/pay/callback` 豁免（第三轮缺口 P2-18，AJ-386）：回调有**自己的签名**（比静态共享密钥强），
 *      而 Stripe Dashboard 填的 webhook 地址若是 `*.onrender.com` 直连，不经 Cloudflare、不带头 →
 *      全部 40301 → Stripe 重试 3 天后放弃，付款事件丢失。与 `pay-routes.ts` 的 `PAY_CALLBACK_PREFIX` 同值
 *      （http 层不 import app 层，写字面量；`http.unit.test.ts` 用同一路径钉住）。
 */
const ORIGIN_VERIFY_EXEMPT_PATHS: readonly string[] = [
  '/healthz',
  '/readyz',
  '/api/v1/internal/jobs',
  '/api/v1/pay/callback',
];

/** 比共享密钥（先比长度再走 timingSafeEqual，不借长度差泄露信息）。 */
function secretMatches(got: string, want: string): boolean {
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * CORS 配置（D21）。
 * @why 管理端是**独立 Web**（ADR-21），域名与 API 不同源，跨域是必然的；
 *      而小程序请求走的是微信客户端、回调来自机构服务器，**都不需要 CORS**——
 *      所以这里刻意按路径前缀收窄到管理端，而不是全局开放。全局开等于白送一张"任意站点可调用"的门票。
 */
export interface CorsOptions {
  /** 允许的来源（**精确匹配**，不支持通配）。 */
  origins: readonly string[];
  /** 生效的路径前缀，默认 `['/api/v1/admin', '/api/v1/auth/admin']`（业务 + 管理端登录）。 */
  pathPrefixes?: readonly string[] | undefined;
}

export interface CreateHttpAppOptions {
  logger: Logger;
  /**
   * 需要**原始报文**的路由前缀（回调验签）：这些路径先走 `express.raw()`，再跳过 JSON 解析。
   * 顺序不可颠倒——JSON 解析会破坏签名原文（见文件头 @why ④）。
   */
  rawBodyPaths?: readonly string[] | undefined;
  /** 不打访问日志的路径（健康检查等高频探活）。 */
  silentPaths?: readonly string[] | undefined;
  /** CORS 白名单；不传 = 完全不开放跨域（D21）。 */
  cors?: CorsOptions | undefined;
  /**
   * 就绪探针：返回 false 时 `/readyz` 给 503，平台据此不再把流量打进来（D21）。
   * @limitation 不传时 `/readyz` 等价于 `/healthz`（只代表进程活着）——
   *             真正的价值在装配层把 DB 探活接进来之后（main.ts）。
   */
  readiness?: (() => Promise<boolean>) | undefined;
  /**
   * 可信反代层数（D23）。默认 **1**。
   * @why `true` 表示"信任 X-Forwarded-For 的每一跳"，客户端自己加一个 `X-Forwarded-For: 1.1.1.1`
   *      就能让服务端把伪造值当真（实测：层数=true 取最左 = 客户端可控；层数=1 取最右 = 可信代理写的那一跳）。
   *      将来按 IP 做限流 / 登录锁定时，伪造 IP 就是一秒钟绕过。
   * @limitation 层数**少于**实际代理数时，取到的是中间代理的 IP（错，但至少不可伪造）；
   *              层数多于实际时才会重新变得可伪造。所以这个数宁小勿大，按平台实际拓扑配（Render=1）。
   * @why 不传时的兜底由 1 改为 **0**（A2 / AJ-197）：与 `config.ts` 的 schema 默认值对齐——
   *      两处各写一个数就是口径漂移，而漂移的方向又是"可伪造"（§2 第 60 条）。
   *      生产走 config → 恒有值；这里的 0 只服务"没传这个选项"的调用方（测试与骨架单测）。
   */
  trustProxyHops?: number | undefined;
  /**
   * 源站校验密钥：**传了就只接受带 {@link ORIGIN_VERIFY_HEADER} 且值相等的请求**，不传 = 不校验。
   * @see config.ts ORIGIN_VERIFY_SECRET（为什么需要它、为什么配了才生效、为什么豁免健康检查与每日作业）
   */
  originVerifySecret?: string | undefined;
  /**
   * 挂载业务路由；在兜底中间件之前调用。
   * 显式声明 `| undefined`：`exactOptionalPropertyTypes` 下调用方传 `{ mount: maybe }` 会被判不兼容，
   * 与其让调用方到处写条件展开，不如在接口处一次说清"可以不传，也可以传 undefined"。
   */
  mount?: ((app: Express) => void) | undefined;
}

/**
 * 上游 `x-trace-id` 允许的字符集与长度。
 * @why 曾经只判"非空就用"，等于把**客户端完全可控的字符串**直接写进每一条日志。实际风险有三条：
 *      ① 超长值污染日志、撑爆检索字段；② 客户端把任意内容（邮箱、手机号、内部标识）塞进我们的日志系统——
 *      这些内容不受 redact 保护（键名叫 trace_id，不在敏感名单里，值又是"合法"字符串）；
 *      ③ 链路串不起来（上游传了垃圾值，整条链的日志都挂在同一个垃圾 ID 上，等于没有 ID）。
 *      形状不符一律丢弃并新建——链路断在这一跳，也比让可控内容进日志好。
 *
 * @limitation 一：**换行注入不由本校验兜住**。含裸换行的头值在到达本进程前就被 Node 的 HTTP 解析器
 *              （llhttp）按协议非法拒绝了——测试里用 fetch 发这种头会直接抛错，根本发不出来。
 *              所以本校验解决的是"合法字节但形状危险"，不是"协议层攻击"。这一点写清楚，
 *              免得后来者以为有了这个正则就不需要别的防护（或反过来，以为它没用）。
 * @limitation 二：丢弃**不记日志**：否则攻击者可以用畸形头刷满日志（拒绝服务）。
 *              代价是"上游传了但被丢弃"这件事在本地不可见，只能靠响应头里的 x-trace-id 是否为新值来判断。
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * 取响应字节数（D22）：读 `content-length`，读不到就是 undefined。
 * @why 用响应头而不是 `socket.bytesWritten`：后者是**连接级累计值**，
 *      keep-alive 下第二条请求会把第一条的字节数一起算上，数字随连接复用次数增长，完全是错的。
 * @limitation 分块传输（chunked）时 Express 不发 content-length，此时无此字段——
 *             可接受：我们的响应都是 `res.json()`，长度已知。
 */
function responseBytes(res: Response): number | undefined {
  const header = res.getHeader('content-length');
  const value = typeof header === 'number' ? header : Number(header);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * CORS 中间件（D21）：只对管理端路径、只对白名单来源。
 *
 * @why 手写而不用 `cors` 包：我们只需要"精确白名单 + 固定路径前缀 + 不发送凭证"这一小片行为，
 *      引一个包就要跟着它的默认策略（默认 `*`、`preflightContinue` 等）走，反而更容易开错。
 * @why 不在白名单时**不回任何 CORS 头**而不是回 403：跨域失败应该由浏览器判定并拦下，
 *      服务端在预检阶段就报错会让前端看到"网络错误"而不是"CORS 被拒"，更难排查。
 * @limitation 不支持通配（`*.example.com`）：子域名枚举是常见的越权来源。
 *             需要多域名就在配置里逐个列全，`CORS_ORIGINS` 是逗号分隔的。
 */
/**
 * 收敛路径参数为一个非空字符串。
 *
 * @why 放在**骨架层**而不是每个路由各写一份：Express 5 的类型里 `req.params.x` 是
 *      `string | string[]`（通配/重复参数会产生数组），`noUncheckedIndexedAccess` 下还可能是
 *      `undefined`。直接拼进 SQL 或传给机构有两种静默后果：
 *      ① `undefined` 被 postgres.js 当 NULL → 查询返回空，错误从 400 变成 404，排查方向全错；
 *      ② 数组被转成字符串 → 查到一个根本不存在的 id。
 *      这类"不报错但查错东西"的写法散在各处时，改一处漏一处只是时间问题。
 *
 * @limitation 只保证"是一个非空字符串"，**不校验字符集**（如单号格式、UUID 形状）。
 *              形状校验属于各自的领域规则，放这里会让这个函数变成一个什么都往里塞的校验器。
 * @throws {AppError} 40001（缺少或非法路径参数）
 */
export function paramId(value: string | string[] | undefined): string {
  const one = Array.isArray(value) ? value[0] : value;
  if (typeof one !== 'string' || one.length === 0) {
    throw new AppError(40001, { reason: '缺少或非法路径参数' });
  }
  return one;
}

/**
 * 路径前缀匹配（CORS 与 raw-body 共用）。
 * @why 不能是裸 `startsWith(p)`（基座自查 P1-3）：`/api/v1/adminx` 会命中 `/api/v1/admin`、
 *      `/pay/callback/stripe-v2` 会命中 `/pay/callback/stripe`——前者给非管理端路径发跨域通行证，
 *      后者让 handler 拿到 Buffer 而不是解析后的 JSON。两种都不报错，只在"将来加了名字相近的路由"
 *      那天才爆。所以必须要求前缀后**恰好是路径分隔符**（或完全相等）。
 */
function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalized);
}

function corsMiddleware(opts: CorsOptions): RequestHandler {
  // ⚠️ `/api/v1/auth/admin`（管理端登录）必须在内：它是 admin-web 的**第一个**跨域调用，
  //    漏了它，管理端连登录预检都过不去——而业务路由一条条加的时候没人会想起登录（体检 P1-1）。
  const prefixes = opts.pathPrefixes ?? ['/api/v1/admin', '/api/v1/auth/admin'];
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin === undefined) {
      next();
      return;
    }
    if (!prefixes.some((p) => pathMatchesPrefix(req.path, p))) {
      next();
      return;
    }
    // 只要按 Origin 变化响应，就必须声明 Vary——否则 CDN/浏览器缓存会把给 A 源的响应发给 B 源
    res.appendHeader('vary', 'Origin');
    if (!opts.origins.includes(origin)) {
      next();
      return;
    }
    res.setHeader('access-control-allow-origin', origin);
    // expose-headers 要挂在**真实响应**上（预检响应带它也合法）：
    // 管理端前端需要读到 x-trace-id 才能报障（N8）；x-request-id 同理。
    // retry-after（SEC2-08）：429 的"还要等多久"只在这个头里，而它是 **CORS 非简单响应头**——
    //   不进这个列表时，跨域的 JS 读不到它（`headers.get('retry-after')` 恒为 null），
    //   服务端"设了头"与前端"能读到"是两件事。全站 429（限流 / 登录锁定 / 回调 503）都受益。
    //   ⚠️ 契约 0.6.20 写的是"锁定期 429 / 42901 + Retry-After"，不带这一条等于只兑现了一半。
    res.setHeader('access-control-expose-headers', 'x-trace-id, x-request-id, retry-after');
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    // PUT 必须在列：契约里管理端有 PUT 路由（如地址/商品更新），缺了预检直接拦（体检 P1-2）
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    // idempotency-key 必须在列（N8）：管理端写操作（发货/退款）按规范要带幂等键，
    // 预检不放行它，浏览器在预检阶段就把请求拦下——管理端连试错的余地都没有
    res.setHeader(
      'access-control-allow-headers',
      'authorization,content-type,x-trace-id,idempotency-key',
    );
    res.setHeader('access-control-max-age', '600');
    res.status(204).end();
  };
}

/** 安全响应头（剩余清单 5-1）；值的理由见 createHttpApp 内第 0 段。 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['content-security-policy', "default-src 'none'; frame-ancestors 'none'"],
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['cross-origin-opener-policy', 'same-origin'],
];

/** 从请求头取链路 ID：符合形状才沿用，否则新建。 */
function traceIdFrom(req: Request): string {
  const header = req.header('x-trace-id');
  if (header === undefined) return newTraceId();
  const trimmed = header.trim();
  return TRACE_ID_PATTERN.test(trimmed) ? trimmed : newTraceId();
}

export function createHttpApp(opts: CreateHttpAppOptions): Express {
  const app = express();
  const rawBodyPaths = opts.rawBodyPaths ?? [];
  // /readyz 与 /healthz 一样会被平台高频轮询，默认不打访问日志（失败另有 warn）
  const silentPaths = opts.silentPaths ?? ['/healthz', '/readyz'];

  // 反代后面取真实客户端 IP（限流与审计用）；不得用于鉴权（@limitation 一）
  // 层数而非 true：见 trustProxyHops 的 @why（D23，伪造 IP 可绕过未来的限流/锁定）
  app.set('trust proxy', opts.trustProxyHops ?? 0);
  app.disable('x-powered-by');
  /**
   * 路由**区分大小写**（B20 / AJ-210）。
   * @why Express 默认不区分：`POST /API/V1/PAY/CALLBACK/stripe` 会命中真实回调路由，
   *      但 raw-body 的前缀匹配（`pathMatchesPrefix`）是**区分**的 ⇒ 拿不到原始字节、
   *      验签必然失败 ⇒ 50000 + error 级 `unhandled_error`。
   *      一个请求头就能稳定制造 5xx，扫描器一天几百条，真实的 5xx 被淹没。
   *      开启之后大写路径直接落到兜底 404（40400 + warn），与"没这个路由"同形。
   * @why 选"严格路由"而不是"两侧统一小写"：小写化会把 `/API/...` 变成"真的能用的路由"——
   *      那等于承认大小写都行，而 raw-body、CORS、源站豁免三处前缀匹配都得跟着改，
   *      任何一处漏改就退化成今天这个洞（约束九：第二份判定必然漂移）。
   *      严格路由是**一处决定、三处同时生效**。
   * @limitation 大小写写错的客户端现在拿到 40400 而不是 500——这是有意的：
   *              它本来就不是我们的路由，报"不存在"比报"服务器内部错误"更接近事实。
   */
  app.set('case sensitive routing', true);

  /**
   * 骨架自己的日志器：绑定 `module: 'http'`。
   * @why 曾经是往**请求上下文**里写 `module: 'http'`，结果请求内所有业务日志的 module 全被压成 http
   *      ——支付模块报的错在日志里显示为 http 模块，按模块过滤彻底失效（复现缺陷 D9）。
   *      module 属于"这段代码属于谁"，应该由**写这行日志的 logger** 声明，而不是由传输层中间件声明。
   */
  const httpLog = opts.logger.child({ module: 'http' });

  /**
   * ── 0. 安全响应头（剩余清单 5-1 / O11）：挂在最前面，404 与错误响应同样带上 ──
   * @why API 只回 JSON / 302、从不回 HTML（2026-10-06 全库扫描无 res.send / text/html）：
   *      最严的 CSP（default-src 'none'）与禁止被嵌入都没有副作用，却能挡住"某条错误路径意外回了可执行内容"与点击劫持。
   * @why HSTS 不判断当前是不是 https：TLS 在平台反代处终结，这里看到的是 http；浏览器对 http 响应里的 HSTS 本就忽略。
   * @limitation 不发 Permissions-Policy / CORP：前者对 JSON API 无意义；后者会影响管理端跨域读取（CORS 已单独控制）。
   * @tradeoff 不引 helmet：六个固定头一个中间件即可，引依赖换不来什么（完全自研）。
   */
  app.use((_req, res, next) => {
    for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
    next();
  });

  // ── 1. 请求上下文：后续所有日志自动带 trace_id / req_id ────────────────────
  app.use((req, res, next) => {
    const trace_id = traceIdFrom(req);
    const req_id = newTraceId();
    res.setHeader('x-request-id', req_id);
    res.setHeader('x-trace-id', trace_id);
    // 刻意**不写 module**：module 的归属见上方 httpLog（D9）
    runWithContext({ trace_id, req_id }, () => next());
  });

  /**
   * ── 2. 访问日志（请求维度，属用户行为流的一部分）─────────────────────────
   *
   * @why 挂 **`prefinish`** 而不是 `finish`（INF-14 / AJ-206，与 admin-audit 同一条根因）：
   *      `finish` 表示"响应已交给操作系统"，客户端在业务已提交之后断开时**不触发**——
   *      于是"用户以为没成功而重试"的那个**首次请求**恰好没有任何访问日志，
   *      排障时看到的是一次凭空出现的重试。退款、发货这类同步调外部的请求最长 6 秒，
   *      用户/网关在这个窗口里断开是常态（Cloudflare 524 就是 100 秒也照样有人等不到）。
   * @why 另挂 `close` 兜底：连接被销毁且从未 `end()` 时也要留一条
   *      `result: 'client_aborted'`（http_status 用 0 表示"没有真实状态码"，
   *      不用默认的 200——200 会把中断伪装成成功，污染可用性统计）。
   */
  app.use((req, res, next) => {
    const startedAt = performance.now();
    let logged = false;
    const emit = (): void => {
      if (logged) return;
      logged = true;
      if (silentPaths.includes(req.path)) return;
      const aborted = !res.writableEnded;
      const status = aborted ? 0 : res.statusCode;
      const fields = {
        http_method: req.method,
        http_path: req.path,
        http_status: status,
        duration_ms: Math.round(performance.now() - startedAt),
        result: aborted
          ? 'client_aborted'
          : status >= 500
            ? 'error'
            : status >= 400
              ? 'client_error'
              : 'ok',
        user_agent: req.header('user-agent'),
        // D22：限流按 IP 计时、风控看来源、审计要还原"谁从哪来"——三者都靠 client_ip。
        // 注意它**只在访问日志里出现**，不进业务事件，避免 PII 扩散到各处。
        client_ip: req.ip,
        resp_bytes: responseBytes(res),
      };
      if (aborted) httpLog.warn('http_request', fields);
      else if (status >= 500) httpLog.error('http_request', fields);
      else if (status >= 400) httpLog.warn('http_request', fields);
      else httpLog.info('http_request', fields);
    };
    res.on('prefinish', emit);
    res.on('close', emit);
    next();
  });

  // ── 2b. CORS（管理端跨域，D21）────────────────────────────────────────────
  if (opts.cors !== undefined) app.use(corsMiddleware(opts.cors));

  /**
   * ── 2c. 源站校验：只接受经 Cloudflare 的流量（A2 / AJ-197）─────────────────
   *
   * @why 放在**报文解析之前**：被拒的请求不该先花力气解析 body。
   * @why 支付回调另有豁免（签名把关，见 ORIGIN_VERIFY_EXEMPT_PATHS 的 @why，P2-18）。
   * @why 豁免 `/healthz` `/readyz` 与 `/api/v1/internal/jobs`：这三类是**平台内网直连源站**的
   *      （Render 的存活探针与 Cron 不经过 Cloudflare）。把它们一起挡掉的结果是
   *      "实例被判死"或"每日作业静默停跑"——后者正是 B11 那类**没有任何报错**的失效，
   *      代价远大于"少校验一个入口"（每日作业另有 INTERNAL_JOB_SECRET 把关）。
   * @limitation 校验的是**静态共享密钥**而不是签名（config.ts @limitation 二）：
   *             它只回答"是否经过 Cloudflare"这一个问题，泄露后换值即可。
   */
  const originSecret = opts.originVerifySecret ?? '';
  if (originSecret !== '') {
    app.use((req, _res, next) => {
      if (ORIGIN_VERIFY_EXEMPT_PATHS.some((p) => pathMatchesPrefix(req.path, p))) {
        next();
        return;
      }
      const got = req.header(ORIGIN_VERIFY_HEADER);
      if (got === undefined || !secretMatches(got, originSecret)) {
        next(new AppError(40301, { reason: 'origin_not_verified' }));
        return;
      }
      next();
    });
  }

  // ── 3. 报文解析：raw 优先（回调验签），其余走 JSON ────────────────────────
  const rawParser = express.raw({ type: () => true, limit: RAW_BODY_LIMIT });
  app.use((req, res, next) => {
    if (rawBodyPaths.some((p) => pathMatchesPrefix(req.path, p))) return rawParser(req, res, next);
    next();
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT, type: 'application/json' }) as RequestHandler);

  // ── 4. 健康检查（骨架自带，业务模块不用各写一个）────────────────────────────
  // 只报"进程活着"，不查依赖（DB 探活走 /readyz，F7 接入）——K8s/Render 的存活探针
  // 若绑死 DB，一次 DB 抖动会导致整个服务被重启，把小故障放大成全站不可用。
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * ── 4b. 就绪探针 /readyz（D21）─────────────────────────────────────────
   * 与 /healthz 的区别是**语义**，不是实现细节：
   *   /healthz = 进程活着吗？死了就重启（不查依赖，避免 DB 抖动引发全站重启）
   *   /readyz  = 能接流量吗？不能就把我从负载均衡里摘出去（查依赖）
   * 两者混用的典型事故：把存活探针绑到 DB 上，一次 DB 抖动把整个服务重启一轮。
   *
   * @limitation 只反映"探针此刻的结果"，不做连续失败 N 次才置为不就绪的抖动抑制——
   *             那属于平台侧策略（Render 有自己的健康检查阈值），此处不重复实现。
   */
  app.get('/readyz', (_req, res) => {
    void (async () => {
      try {
        const ok = (await opts.readiness?.()) ?? true;
        res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' });
      } catch (e) {
        httpLog.warn('readiness_failed', { err: e instanceof Error ? e : new Error(String(e)) });
        res.status(503).json({ status: 'degraded' });
      }
    })();
  });

  // ── 5. 业务路由 ──────────────────────────────────────────────────────────
  opts.mount?.(app);

  // ── 5. 兜底 404：未匹配路由也必须返回统一错误形状，否则前端拿到 Express 默认 HTML ──
  app.use((req, _res, next) => {
    next(new AppError(40400, { http_method: req.method, http_path: req.path }));
  });

  // ── 6. 兜底错误：统一形状 + 落日志 ────────────────────────────────────────
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const normalized = normalizeError(err);
    // ⚠️ 判定顺序不能改：必须先判"是不是报文解析错"，再判"是不是 AppError"。
    //    解析错的**原始** err 是 SyntaxError（不是 AppError），若按 `instanceof AppError` 先判，
    //    它会落进 unhandled_error 的 error 通道——客户端畸形请求天天有，直接淹没真实的 5xx。
    // ⚠️ 两个"客户端可控"的分支共用 warn 通道（不改这里的话，SQLSTATE 22 类会被
    //    `err instanceof AppError` 判否 → 落进下面的 error 级 `unhandled_error`，
    //    修复了响应码却没修复告警噪声，那正是 ORD3-04 要去掉的一半）。
    // URIError = 路径参数解码失败（S-05），同属客户端可控输入
    if (isBodyParseError(err) || sqlDataExceptionCode(err) !== null || err instanceof URIError) {
      // 客户端可控输入导致的失败：不是我们的故障 → warn 级，且 normalizeError 已确保不带堆栈
      httpLog.warn('request_rejected', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else if (err instanceof CircuitOpenError) {
      // 熔断拒绝（AJ-414）：上游在恢复期、我们主动没打——不是我方故障，也不是未知异常。
      //    errors.ts 已把它映射成 50300 / 503；fetch-client 另有 `http_outbound_circuit_open` 留痕。
      //    落进下面的 `unhandled_error`（error 级 + 堆栈）会让一次上游故障期内每个请求都多一条告警，真 5xx 被淹没。
      httpLog.warn('upstream_unavailable', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else if (!(err instanceof AppError)) {
      // 未知异常：这是需要人看的，必须 error 级且带原始堆栈（只在日志里）
      httpLog.error('unhandled_error', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else if (normalized.status >= 500) {
      httpLog.error('request_failed', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else {
      httpLog.warn('request_rejected', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    }
    // P2-27（AJ-386）：头已发出就无法再改状态码；断开连接让客户端看到"中断"，
    // 而不是挂到超时（Express 默认处理器同样是 destroy）。
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(normalized.status).json(normalized.body);
  });

  return app;
}

/**
 * 是否**报文解析**阶段抛的错（JSON 语法错 / 体积超限）。
 *
 * @why 曾经只判 `err instanceof SyntaxError`——那会把**业务代码里任何一处** `JSON.parse` 失败、
 *      甚至动态 `import()` 的语法错，全都归成 40001（参数格式错误）。
 *      后果：一个真实的后端 bug 会被当成"用户传参有问题"报给用户和监控，
 *      于是线上出现 40001 时没人会去查服务端，真正的 bug 就长期潜伏。
 *      现在只认快递解析器自己打的标记（`type` / `status=400`），其余一律落到 50000。
 *
 * @why **判据放宽到"body-parser 自己声明的 4xx"**（B20 / AJ-210）：此前逐个枚举 `type`，
 *      漏掉的每一个都是"一个请求头就能刷 5xx"——`charset=x-evil`（415）、
 *      `content-encoding: xyz`（415）、坏 gzip 流、`request.aborted`（400）全部落进
 *      `unhandled_error` + 500。扫描器一天几百条，真实的 5xx 就被淹没了（与上面 @why 同一条理由，
 *      只是这次漏的是**另一半**客户端错）。
 *      判据取 `expose === true && 400 ≤ status < 500`——`expose` 正是 body-parser 用来
 *      标记"这个错的详情可以给客户端看"的字段，等价于"我认为这是客户端的问题"。
 *      比逐个枚举 type 更抗升级（新增一种 4xx 自动纳入），且不会误吞 5xx。
 * @limitation 仍然依赖 body-parser 的错误对象形状（`expose` / `status`）。
 *              升级 express 大版本时应重跑本文件的"报文解析错误"用例确认标记未变。
 * @limitation 响应码统一是 **40001（400）**而不是 body-parser 给的 415：
 *              契约里没有 415 的错误码，且"请求体不合规格"在我方是同一类参数错误。
 *              具体原因走 `reason`（见 {@link parseErrorReason}），不靠状态码区分。
 */
function isBodyParseError(err: unknown): boolean {
  // AppError 是我们自己的业务错，哪怕 status 落在 4xx 也不属于"报文解析"
  if (err instanceof AppError) return false;
  const e = err as { type?: string; status?: number; statusCode?: number; expose?: boolean } | null;
  if (e?.expose !== true) return false;
  const status = e?.status ?? e?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * 解析错误的日志摘要。**刻意不带原始 message**——
 * SyntaxError 的 message 里含请求体片段（`Unexpected token a in JSON at position 12`），
 * 而请求体是客户端可控内容：可能含卡号、地址、姓名。把原文写进日志等于绕过 redact。
 *
 * @why 按 `type` 给原因而不是一律"JSON 格式错误"（B20 / AJ-210）：
 *      "统一原因"在这里是**有害**的——运营看到 40001 时若原因永远是"JSON 格式错误"，
 *      遇到"我们不支持这种压缩编码"的真实客户会一路查错方向。
 *      原因必须能让"客户端改什么"这件事可推断，所以逐类给，未识别的给兜底文案。
 */
function parseErrorReason(err: unknown): string {
  const type: string | undefined = (err as { type?: string } | null)?.type;
  switch (type) {
    case 'entity.too.large':
      return '请求体超过大小上限';
    case 'entity.parse.failed':
      return 'JSON 格式错误';
    case 'charset.unsupported':
      return '不支持的字符集';
    case 'encoding.unsupported':
      return '不支持的内容编码';
    case 'entity.verify.failed':
      return '请求体校验失败';
    case 'request.aborted':
      return '请求体传输中断';
    case 'parameters.too.many':
      return '参数过多';
    // `type` 缺失（不是 body-parser 抛的、或它没标类型）与"认不出的新类型"走同一兜底：
    // 都是"报文不合规格但说不出是哪一类"，不能因为说不出就不给 40001。
    case undefined:
    default:
      return '请求体无法解析';
  }
}

/**
 * SQLSTATE **22 类（Data Exception）**：库**拒收这个值**本身（NUL 字符 / 超长 / 形状不对）。
 *
 * @returns SQLSTATE（形如 `22021`）；不是这一类 → null
 *
 * @why 客户端把 PG 拒收的字符送进来时（最典型是 **NUL**：`%00` 被 Express 原样解码，
 *      而 PG 的 `text` 不接受 `0x00`，报 `22021 invalid byte sequence`），
 *      我们没有映射任何 SQLSTATE，于是它落成 **50000 + error 级 `unhandled_error`**——
 *      一个不需要登录的入口（`GET /pay/link/%00?t=…`）就能被扫描器稳定刷出 5xx 告警。
 *      这类错的**性质**是"客户端送了一个库不收的值"，与报文解析错同类：warn 级 + 40001。
 *      放在兜底层一处映射，胜过在每个入口各判一次"字符串里有没有控制字符"
 *      （各判一次必然漏，而漏了的那个入口就是下一个 5xx）。
 * @why 判 **22 类**而不是只判 `22021`：22 类的全部子码都是"值本身有问题"
 *      （`22001` 超长、`22003` 数值越界、`22P02` 文本转不成目标类型——`page=1e300` 那类
 *      分页参数溢出就是它），没有一个是"系统故障"。相反 5xx 才是"我们这边坏了"，
 *      把 22 类留在 500 里等于把"参数没校验好"表现成"服务挂了"。
 * @limitation `22P02` 也可能是**我们**把没校验过的形状交给了 PG（校验缺失而不只是输入脏）——
 *              那时 40001 会把它表现成"客户端的问题"。所以 reason 里**带上 SQLSTATE**，
 *              运维按 `sql_data_exception:22P02` 能一眼区分，而不是淹没在泛化的 40001 里。
 */
function sqlDataExceptionCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length === 5 && code.startsWith('22') ? code : null;
}

/**
 * 22 类里只有这几种是"客户端送了库不收的值"（S-3 / AJ-463）：字符串超列宽、文本转数值 / 日期失败、日期越界、
 * 文本里的非法字节（22021：PG text 拒收 0x00——无鉴权的 `/pay/link/%00` 就能触发，pay-link-routes.db.test 钉住）。
 * 其余（22003 溢出、22012 除零、22023 参数非法…）是我们自己算错或拼错——折成 40001 + warn 会把服务端 bug
 * 伪装成客户端错误，且进不了 Sentry（只收 error）。
 */
const CLIENT_DATA_SQLSTATES: ReadonlySet<string> = new Set([
  '22001',
  '22P02',
  '22007',
  '22008',
  '22021',
]);
export function sqlDataExceptionAppCode(sqlstate: string): 40001 | 50000 {
  return CLIENT_DATA_SQLSTATES.has(sqlstate) ? 40001 : 50000;
}

/** 把各类异常归一成 {status, body, logFields}：解析错误也要有业务码，不能裸 500。 */
function normalizeError(err: unknown): {
  status: number;
  body: { code: number; message: string };
  logFields: Record<string, unknown>;
} {
  // 路径参数里的非法百分号编码（S-05）：Express 5 解码参数失败抛 URIError（status=400、无 expose），
  // 不单独处理就落进下面的"非 AppError"分支 → 500 + error 日志——任何匿名请求都能刷 5xx 与告警。
  // @measured(express 5, 2026-10-05)：GET /x/%E0%A4%A → URIError「Failed to decode param '%E0%A4%A'」，status 400。
  if (err instanceof URIError) {
    const appErr = new AppError(40001, { reason: 'path_param_malformed' });
    const { status, body } = toErrorResponse(appErr);
    return {
      status,
      body,
      logFields: { err_code: appErr.code, err_message: appErr.message, reason: appErr.details },
    };
  }
  if (isBodyParseError(err)) {
    // S-9（AJ-482）：超限单独成 413 / 41301；其余报文问题仍是 40001（原因照旧逐类给）
    const tooLarge = (err as { type?: string } | null)?.type === 'entity.too.large';
    const appErr = new AppError(tooLarge ? 41301 : 40001, { reason: parseErrorReason(err) });
    const { status, body } = toErrorResponse(appErr);
    return {
      status,
      body,
      logFields: { err_code: appErr.code, err_message: appErr.message, reason: appErr.details },
    };
  }
  const sqlClass22 = sqlDataExceptionCode(err);
  if (sqlClass22 !== null && sqlDataExceptionAppCode(sqlClass22) === 40001) {
    // ⚠️ 与上面同一条理由（客户端送了库不收的值），但 reason 带 SQLSTATE 以便区分（见 @limitation）
    const appErr = new AppError(40001, { reason: `sql_data_exception:${sqlClass22}` });
    const { status, body } = toErrorResponse(appErr);
    return {
      status,
      body,
      logFields: {
        err_code: appErr.code,
        err_message: appErr.message,
        reason: appErr.details,
        sqlstate: sqlClass22,
      },
    };
  }
  const { status, body } = toErrorResponse(err);
  const e = err as Error | undefined;
  return {
    status,
    body,
    logFields:
      err instanceof AppError
        ? { err_code: err.code, err_message: err.message, details: err.details }
        : { err_type: e?.name ?? typeof err, err_message: e?.message, err_stack: e?.stack },
  };
}

/**
 * 默认监听地址。
 *
 * @why 曾经硬绑 `127.0.0.1`：本地测试一切正常，但 Render / 任何容器平台是从**宿主机外部**探端口的，
 *      绑回环地址意味着外部永远连不上 → 表现是"部署成功但健康检查超时/发布失败"，
 *      且本地无法复现（本地就是本机连本机）。这类"只在部署环境才暴露"的缺陷必须靠默认值消除，
 *      而不是靠部署文档里的一行提醒。
 * @limitation 监听 0.0.0.0 等于对机器所在网络的**所有网卡**开放；
 *              端口暴露面由平台防火墙（Render/安全组）控制，不由本进程控制——不要把它当访问控制手段。
 */
export function defaultHost(): string {
  const fromEnv = process.env.HOST;
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : '0.0.0.0';
}

export interface ListenOptions {
  /** 0 = 由系统分配空闲端口（测试用）。 */
  port?: number;
  /** 缺省取 {@link defaultHost}。 */
  host?: string;
  /** 优雅关闭等待存量请求的上限（毫秒），超时强制断开。默认 10s（Render 给 30s，留足余量）。 */
  graceMs?: number;
}

export interface StartedServer {
  port: number;
  host: string;
  /** 优雅关闭：停止接新请求 → 断开空闲长连接 → 等存量请求结束；超时则强制断开并抛错。 */
  close: () => Promise<void>;
}

/**
 * 启动监听（测试与生产共用同一条路径，避免"测试用 supertest、生产用 listen"两套行为）。
 */
export async function listen(app: Express, opts: ListenOptions = {}): Promise<StartedServer> {
  const host = opts.host ?? defaultHost();
  const graceMs = opts.graceMs ?? 10_000;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port ?? 0, host, () => resolve(s as unknown as Server));
    s.on('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取监听端口');
  return {
    port: address.port,
    host,
    close: () => closeServer(server, graceMs),
  };
}

/**
 * 优雅关闭。
 * @why 直接 `server.close()` 在 HTTP keep-alive 下会一直等**（浏览器/小程序复用连接），
 *      进程不退出 → 平台判定"停止失败"后发 SIGKILL，正在处理的下单/回调请求被腰斩。
 *      所以必须先 `closeIdleConnections()` 断掉空闲连接，再等存量请求。
 * @limitation 超时后是**强制断开**而非等待：此时正在处理的请求会被中断（应答写不回去）。
 *              这是刻意的取舍——宁可丢一个请求，也不要让部署永远卡住；
 *              真正需要"绝不能断"的写操作（支付回调）应靠幂等 + 回调重放来恢复，而不是靠等。
 */
async function closeServer(server: Server, graceMs: number): Promise<void> {
  // 先清一次：此刻就空闲的 keep-alive 连接直接断开
  server.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // @why 光在开头清一次**不够**：存量请求处理完那一刻连接才变空闲，而那之后没人再清，
    //      `server.close()` 就要一直等到客户端自己超时（实测 undici 默认 keep-alive 约 4s → 关闭耗时 3.1s，
    //      部署窗口被白白占掉）。所以按 100ms 反复清扫，直到 close 回调触发。
    const sweeper = setInterval(() => server.closeIdleConnections?.(), 100);
    const timer = setTimeout(() => {
      settled = true;
      // ⚠️ 必须在这里清 sweeper（P3-4，曾漏）：done() 看到 settled=true 会早退、不再清理，
      //      于是这条每秒 10 次的 interval 会一直挂到进程退出——生产里进程随即退出所以无症状，
      //      但测试/长生命周期调用方会残留 open handle。
      clearInterval(sweeper);
      server.closeAllConnections?.();
      reject(new Error(`优雅关闭超时（${graceMs}ms）：仍有请求未结束，已强制断开连接`));
    }, graceMs);
    const done = (e?: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearInterval(sweeper);
      clearTimeout(timer);
      if (e) reject(e);
      else resolve();
    };
    server.close((e) => done(e ?? undefined));
  });
}

export interface ShutdownHooks {
  logger: Logger;
  /**
   * 排空**之前**：**摘流量**——把就绪状态置为不可用、让调度器不再接新任务。
   *
   * @why `close()` 只停止**接受新连接**并等存量请求，它管不到"平台还在往我这儿发新请求"
   *      （Render 有自己的 drain 窗口，SIGTERM 之后仍会路由一段时间）。
   *      所以必须先对外声明"我不再接了"，否则表现为"关了半天还在进新请求"，排空永远结束不了。
   * @limitation `/readyz` 已实现（见上文 4b，D21）：装配层（main.ts）把"翻转为 503"
   *              挂在这个钩子上。它不内置默认实现——"什么叫不想接流量"只有装配层知道。
   */
  beforeDrain?: (() => Promise<void>) | undefined;
  /**
   * N7：摘流量之后、close 之前的等待毫秒数（缺省/0 = 不等）。
   *
   * @why `beforeDrain` 只把 /readyz 翻成 503——但平台健康检查有**周期**（秒级），
   *      立即 close 的话 503 窗口≈0，平台是靠"连接失败"而不是 503 发现摘流的，
   *      窗口内的新请求会被腰斩。等这一段，是给平台一个"按 503 优雅摘流"的机会。
   * @tradeoff 等待会拉长每次发布的停机耗时（默认 5s × 每次部署）。
   *           换来发布窗口内几乎不丢请求——对支付回调这类"丢了要靠重放补"的流量值得。
   * @limitation 平台不读 /readyz（或健康检查周期远大于此值）时这段等待纯属成本；
   *             是否有效取决于平台行为，所以做成配置项（SHUTDOWN_READY_DELAY_MS）可不发版调整。
   */
  readyDelayMs?: number | undefined;
  /**
   * 排空**之后**：**关资源**——关 DB 池、关 HTTP 客户端、flush 日志。
   *
   * @why 顺序绝不能反：若把"关 DB 池"放在排空之前，正在处理的请求会拿到
   *      「连接池已关闭」，表现为**部署窗口内一批 500**（本地永远复现不了，
   *      因为本地没有"发布时被 SIGTERM"这回事）。曾经的 `beforeClose` 就是这个名字——
   *      名字本身在暗示"关之前"，于是调用方很自然地把关 DB 池写进去了。
   * @limitation 这里失败不会回滚已经完成的排空（进程已经不接请求了），
   *              只记 `shutdown_cleanup_failed` 并以退出码 1 结束，便于平台察觉"清理没干净"。
   */
  afterDrain?: (() => Promise<void>) | undefined;
  /**
   * 退出函数。**仅为测试注入**（process.exit 会把 vitest 进程一起杀掉，无法断言）。
   * @limitation 生产代码不要传这个参数。
   */
  exit?: ((code: number) => void) | undefined;
  /** 设置退出码后到真正 exit 的宽限时间（默认 2000ms，给日志排空；测试注入 10ms 缩短等待）。 */
  exitDelayMs?: number;
  /**
   * INF3-01：从**收到信号那一刻**起算的停机总预算（毫秒）；0 / 不传 = 不设预算（旧行为）。
   *
   * @why AJ-237 之后"排空失败"这条分支会继续走 `afterDrain`（这是对的——清理必须做），
   *      但那条分支里 `db.end()` 会等在途事务跑完，**没有任何自有上限**；
   *      而 `finish`（硬退出定时器）要等 `afterDrain` 返回之后才上膛。
   *      于是最坏停机时长从 17s 变成 31s+，超过平台宽限 30s ⇒ 被 SIGKILL ⇒
   *      `shutdown_cleanup_done_after_failed_drain` 这行日志根本来不及写出，
   *      退出形态从"码 1"变成"被杀"——AJ-237 想补的"留痕"在最需要它的场景里恰好留不下。
   * @why 放在**入口**上膛而不是 `finish` 里：只有从入口起算才覆盖得到那段等待。
   * @limitation 到点是 `exit(1)`（硬退），不是"温和地跳过某一步"：
   *             预算已经耗尽时再讲优雅没有意义，平台 3 秒后本来就要 SIGKILL。
   *             代价是在途事务被 PG 侧中断，但我们留下了"是被预算打断的"这条可检索日志。
   */
  totalBudgetMs?: number | undefined;
  /** 总预算到点后、真正 exit 之前的日志 flush 窗口（默认 200ms；比 exitDelayMs 短，因为此刻已超预算）。 */
  budgetFlushMs?: number | undefined;
}

/** installShutdownHandlers 的返回：卸载 + 内部触发通道。 */
export interface ShutdownControl {
  /** 卸载信号处理器（测试用；生产一般不卸载）。 */
  uninstall: () => void;
  /**
   * 不走 OS 信号、直接触发**同一条**优雅停机流（摘流量 → 排空 → 关资源）。
   *
   * @why N25：uncaughtException / unhandledRejection 也必须走这条流收尾（见 process-errors.ts），
   *      但它们不是 OS 信号、且退出码必须非 0——否则平台把崩溃当正常退出，
   *      不按异常重启策略告警。这个通道让"进程级错误"与"平台信号"共用一套收尾代码，
   *      避免两条停机流漂移（关 DB 池的顺序只有一份才可信）。
   * @param signal 写入日志的来源名（如 'uncaughtException'），与 OS 信号名同字段
   * @param successExitCode 停机**成功**时的退出码（fatal 场景传 1；默认 0）。
   *        失败路径（排空/清理抛错）恒为 1，不受此参数影响。
   */
  trigger: (signal: string, successExitCode?: number) => void;
}

/**
 * 注册 SIGTERM / SIGINT 优雅关闭，返回 ShutdownControl。
 *
 * @why Render/容器停止实例时发的是 SIGTERM，默认行为是**立刻**终止进程——
 *      正在进行的事务、正在写的回调应答会直接消失。支付回调丢了虽然能靠重放补，
 *      但关单/发货这类我们自己发起的写操作没有重放者，必须由我们自己在退出前收尾。
 * @limitation 一：只处理 SIGTERM/SIGINT。**不处理 SIGKILL**（OS 级，无法捕获）——
 *              OOM 被杀时本函数无效，靠 order_events（流 B）事后对账。
 * @limitation 二：退出用 `process.exitCode` 而不是 `process.exit()`，让 Node 自然排空句柄。
 *              （原注"pino 异步写、立即 exit 会丢日志"已被实测推翻：生产形态是同步写，见 logger.ts
 *              @limitation 三的 @measured；保留 exitCode 写法是为了让 DB 池等句柄正常收尾。）
 *              代价：若有句柄忘了关（DB 池没 end），进程会挂住——因此加了 2s 硬退出的兜底定时器。
 */
export function installShutdownHandlers(
  started: StartedServer,
  hooks: ShutdownHooks,
): ShutdownControl {
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const exit = hooks.exit ?? process.exit;
  const delayMs = hooks.exitDelayMs ?? 2000;
  const totalBudgetMs = hooks.totalBudgetMs ?? 0;
  const flushMs = hooks.budgetFlushMs ?? 200;
  let closing = false;
  /** 总预算定时器句柄（`finish` 里要清掉，避免正常停机被它抢先）。 */
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;

  /** 先设 exitCode 让进程自然退出（不丢日志），delayMs 后若仍未退出则强制 exit。 */
  const finish = (code: number): void => {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    process.exitCode = code;
    const hard = setTimeout(() => exit(code), delayMs);
    hard.unref();
  };

  const handler = (signal: string, successExitCode = 0): void => {
    // 平台常连发多次信号（SIGTERM 后紧跟 SIGINT），第二次必须忽略，否则会重复关 DB 池并覆盖退出码
    if (closing) return;
    closing = true;
    void (async () => {
      const startedAt = performance.now();
      const duration = (): number => Math.round(performance.now() - startedAt);
      let drainFailed = false;
      // ⚠️ 总预算**在入口**上膛（INF3-01）：覆盖"排空失败 → afterDrain → db.end()"那段无上限等待。
      //    `finish` 要等 afterDrain 返回才调用，那时已经太晚。已 done 的清理不受影响——
      //    它只保证进程**一定会**在预算内带着退出码 1 走人，而不是被平台 SIGKILL 后什么都不留。
      if (totalBudgetMs > 0) {
        budgetTimer = setTimeout(() => {
          hooks.logger.error('shutdown_budget_exhausted', {
            signal,
            duration_ms: duration(),
            budget_ms: totalBudgetMs,
            drain_failed: drainFailed,
          });
          process.exitCode = 1;
          const hard = setTimeout(() => exit(1), flushMs);
          hard.unref();
        }, totalBudgetMs);
        budgetTimer.unref();
      }
      try {
        // ── ① 摘流量 → ①.5 等平台发现（N7）→ ② 排空存量请求 → ③ 关资源 ──────
        //    顺序反了（先关资源再排空）的表现是"部署窗口内一批 500"，本地无法复现。
        await hooks.beforeDrain?.();
        const readyDelayMs = hooks.readyDelayMs ?? 0;
        if (readyDelayMs > 0) {
          // /readyz 已是 503，但平台健康检查有周期——给它时间真的把流量摘走再 close
          await new Promise((r) => setTimeout(r, readyDelayMs));
          hooks.logger.info('drain_ready_waited', { signal, delay_ms: readyDelayMs });
        }
        await started.close();
        hooks.logger.info('server_drained', { signal, duration_ms: duration() });
      } catch (e) {
        hooks.logger.error('server_stop_failed', {
          signal,
          duration_ms: duration(),
          err: e instanceof Error ? e : new Error(String(e)),
        });
        // ⚠️ **不在这里 return**（AJ-237）：排空失败之后仍要走下面的 `afterDrain`。
        //    原来是 `finish(1); return;`——事件订阅者没人等、连接池没关、2 秒后硬退出：
        //    刚提交的"取消 / 过期"事件，其作废机构会话的订阅者被掐断，
        //    已取消的单在会话自然过期前仍可付款。排空失败只决定**退出码**，不决定要不要收尾。
        drainFailed = true;
      }
      try {
        await hooks.afterDrain?.();
        if (drainFailed) {
          // 清理做了要留痕，但不能记成 `server_stopped`：那是"干净停机"的信号，监控按它判断部署是否平滑
          hooks.logger.warn('shutdown_cleanup_done_after_failed_drain', {
            signal,
            duration_ms: duration(),
          });
          finish(1);
          return;
        }
        hooks.logger.info('server_stopped', { signal, duration_ms: duration() });
        finish(successExitCode);
      } catch (e) {
        // 排空已成功，但清理没干净：单独记一条，别和"排空失败"混成一个事件
        hooks.logger.error('shutdown_cleanup_failed', {
          signal,
          duration_ms: duration(),
          err: e instanceof Error ? e : new Error(String(e)),
        });
        finish(1);
      }
    })();
  };

  /**
   * ⚠️ 绝不能写成 `process.on(s, handler)`：Node **真实投递**信号时回调入参是两个值
   *    `(信号名, 信号编号)`（实测 Node 22.22 / 25.3：`('SIGTERM', 15)`、`('SIGINT', 2)`），
   *    第二个入参会顶掉 `successExitCode` 的默认值 0——OS 信号触发的**正常**停机
   *    会以退出码 15/2 结束，平台（Render）会把每次例行部署误判成异常退出。
   *    （dist-boot e2e 抓到的真缺陷：`finish(15)`。）
   *    所以包一层箭头函数，只把信号名喂给 handler；
   *    `successExitCode` 只允许经 `trigger()` 由代码显式给出（如进程级错误传 1）。
   */
  const wrapped: Array<readonly [(typeof signals)[number], () => void]> = signals.map((s) => {
    const fn = (): void => handler(s);
    process.on(s, fn);
    return [s, fn] as const;
  });
  return {
    uninstall: () => {
      for (const [s, fn] of wrapped) process.off(s, fn);
    },
    trigger: (signal, successExitCode) => handler(signal, successExitCode),
  };
}
