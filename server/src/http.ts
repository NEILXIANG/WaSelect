/**
 * 职责：HTTP 骨架（F6）——Express 应用工厂 + 请求上下文 + 访问日志 + 统一错误兜底。
 * 边界：只搭骨架与横切能力；业务路由在各自的模块里挂载（F6b 鉴权、F6c 行走骨架、I1 业务期）。
 *
 * @why 这四件事必须在骨架层一次性做对，因为它们**无法靠"以后补"**：
 *      ① 请求上下文一旦漏配，全站日志就没有 trace_id，事后无法把一次下单的日志串起来；
 *      ② 错误兜底一旦漏配，未捕获异常会变成 Express 默认 HTML 500 页，前端解析不了、日志也没有 err_code；
 *      ③ 访问日志一旦漏配，"用户操作行为"这条需求就只剩业务事件，缺了请求维度（耗时/状态码/路径）；
 *      ④ raw body 顺序一旦错了，回调验签永远失败（签名必须用**未被解析的原文**验）。
 *
 * @limitation 一：`trust proxy` 全开。Render / Cloudflare 后面 req.ip 才正确（限流与审计依赖它），
 *              但代价是 `X-Forwarded-For` 可伪造——仅用于限流与日志，**绝不用于鉴权**。
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
import { newTraceId, runWithContext } from './context.js';
import type { Logger } from './logger.js';

/** 请求体大小上限：业务只传 JSON 文本，100KB 足够；超过基本是异常或攻击。 */
const JSON_BODY_LIMIT = '100kb';
/** 回调原文上限（Stripe/WeChat 回调体都很小）。 */
const RAW_BODY_LIMIT = '256kb';

export interface CreateHttpAppOptions {
  logger: Logger;
  /**
   * 需要**原始报文**的路由前缀（回调验签）：这些路径先走 `express.raw()`，再跳过 JSON 解析。
   * 顺序不可颠倒——JSON 解析会破坏签名原文（见文件头 @why ④）。
   */
  rawBodyPaths?: readonly string[] | undefined;
  /** 不打访问日志的路径（健康检查等高频探活）。 */
  silentPaths?: readonly string[] | undefined;
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
  const silentPaths = opts.silentPaths ?? ['/healthz'];

  // 反代后面取真实客户端 IP（限流与审计用）；不得用于鉴权（@limitation 一）
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // ── 1. 请求上下文：后续所有日志自动带 trace_id / req_id ────────────────────
  app.use((req, res, next) => {
    const trace_id = traceIdFrom(req);
    const req_id = newTraceId();
    res.setHeader('x-request-id', req_id);
    res.setHeader('x-trace-id', trace_id);
    runWithContext({ trace_id, req_id, module: 'http' }, () => next());
  });

  // ── 2. 访问日志（请求维度，属用户行为流的一部分）───────────────────────────
  app.use((req, res, next) => {
    const startedAt = performance.now();
    res.on('finish', () => {
      if (silentPaths.includes(req.path)) return;
      const status = res.statusCode;
      const fields = {
        http_method: req.method,
        http_path: req.path,
        http_status: status,
        duration_ms: Math.round(performance.now() - startedAt),
        result: status >= 500 ? 'error' : status >= 400 ? 'client_error' : 'ok',
        user_agent: req.header('user-agent'),
      };
      if (status >= 500) opts.logger.error('http_request', fields);
      else if (status >= 400) opts.logger.warn('http_request', fields);
      else opts.logger.info('http_request', fields);
    });
    next();
  });

  // ── 3. 报文解析：raw 优先（回调验签），其余走 JSON ────────────────────────
  const rawParser = express.raw({ type: () => true, limit: RAW_BODY_LIMIT });
  app.use((req, res, next) => {
    if (rawBodyPaths.some((p) => req.path === p || req.path.startsWith(p)))
      return rawParser(req, res, next);
    next();
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT, type: 'application/json' }) as RequestHandler);

  // ── 4. 健康检查（骨架自带，业务模块不用各写一个）────────────────────────────
  // 只报"进程活着"，不查依赖（DB 探活走 /readyz，F7 接入）——K8s/Render 的存活探针
  // 若绑死 DB，一次 DB 抖动会导致整个服务被重启，把小故障放大成全站不可用。
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
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
    if (isBodyParseError(err)) {
      // 客户端可控输入导致的失败：不是我们的故障 → warn 级，且 normalizeError 已确保不带堆栈
      opts.logger.warn('request_rejected', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else if (!(err instanceof AppError)) {
      // 未知异常：这是需要人看的，必须 error 级且带原始堆栈（只在日志里）
      opts.logger.error('unhandled_error', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else if (normalized.status >= 500) {
      opts.logger.error('request_failed', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    } else {
      opts.logger.warn('request_rejected', {
        http_method: req.method,
        http_path: req.path,
        ...normalized.logFields,
      });
    }
    if (res.headersSent) return;
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
 * @limitation 依赖 express 内部错误对象的形状（body-parser 约定）。
 *              升级 express 大版本时应重跑本文件的"报文解析错误"用例确认标记未变。
 */
function isBodyParseError(err: unknown): boolean {
  const e = err as { type?: string; status?: number; statusCode?: number } | null;
  if (e?.type === 'entity.too.large') return true;
  return (
    err instanceof SyntaxError &&
    (e?.type === 'entity.parse.failed' || e?.status === 400 || e?.statusCode === 400)
  );
}

/**
 * 解析错误的日志摘要。**刻意不带原始 message**——
 * SyntaxError 的 message 里含请求体片段（`Unexpected token a in JSON at position 12`），
 * 而请求体是客户端可控内容：可能含卡号、地址、姓名。把原文写进日志等于绕过 redact。
 */
function parseErrorReason(err: unknown): string {
  return (err as { type?: string } | null)?.type === 'entity.too.large'
    ? '请求体超过大小上限'
    : 'JSON 格式错误';
}

/** 把各类异常归一成 {status, body, logFields}：解析错误也要有业务码，不能裸 500。 */
function normalizeError(err: unknown): {
  status: number;
  body: { code: number; message: string };
  logFields: Record<string, unknown>;
} {
  if (isBodyParseError(err)) {
    const appErr = new AppError(40001, { reason: parseErrorReason(err) });
    const { status, body } = toErrorResponse(appErr);
    return {
      status,
      body,
      logFields: { err_code: appErr.code, err_message: appErr.message, reason: appErr.details },
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
  /** 关闭监听**之前**要做的事（关 DB 池、停调度器定时器）。 */
  beforeClose?: (() => Promise<void>) | undefined;
  /**
   * 退出函数。**仅为测试注入**（process.exit 会把 vitest 进程一起杀掉，无法断言）。
   * @limitation 生产代码不要传这个参数。
   */
  exit?: ((code: number) => void) | undefined;
  /** 设置退出码后到真正 exit 的宽限时间（默认 2000ms，给日志排空；测试注入 10ms 缩短等待）。 */
  exitDelayMs?: number;
}

/**
 * 注册 SIGTERM / SIGINT 优雅关闭，返回卸载函数。
 *
 * @why Render/容器停止实例时发的是 SIGTERM，默认行为是**立刻**终止进程——
 *      正在进行的事务、正在写的回调应答会直接消失。支付回调丢了虽然能靠重放补，
 *      但关单/发货这类我们自己发起的写操作没有重放者，必须由我们自己在退出前收尾。
 * @limitation 一：只处理 SIGTERM/SIGINT。**不处理 SIGKILL**（OS 级，无法捕获）——
 *              OOM 被杀时本函数无效，靠 order_events（流 B）事后对账。
 * @limitation 二：退出用 `process.exitCode` 而不是 `process.exit()`，让 Node 自然排空 stdout
 *              （pino 走 sonic-boom 异步写，立即 exit 会丢最后几条日志）。
 *              代价：若有句柄忘了关（DB 池没 end），进程会挂住——因此加了 2s 硬退出的兜底定时器。
 * @returns uninstall（测试用；生产一般不卸载）
 */
export function installShutdownHandlers(started: StartedServer, hooks: ShutdownHooks): () => void {
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const exit = hooks.exit ?? process.exit;
  const delayMs = hooks.exitDelayMs ?? 2000;
  let closing = false;

  /** 先设 exitCode 让进程自然退出（不丢日志），delayMs 后若仍未退出则强制 exit。 */
  const finish = (code: number): void => {
    process.exitCode = code;
    const hard = setTimeout(() => exit(code), delayMs);
    hard.unref();
  };

  const handler = (signal: string): void => {
    // 平台常连发多次信号（SIGTERM 后紧跟 SIGINT），第二次必须忽略，否则会重复关 DB 池并覆盖退出码
    if (closing) return;
    closing = true;
    void (async () => {
      const startedAt = performance.now();
      const duration = (): number => Math.round(performance.now() - startedAt);
      try {
        await hooks.beforeClose?.();
        await started.close();
        hooks.logger.info('server_stopped', { signal, duration_ms: duration() });
        finish(0);
      } catch (e) {
        hooks.logger.error('server_stop_failed', {
          signal,
          duration_ms: duration(),
          err: e instanceof Error ? e : new Error(String(e)),
        });
        finish(1);
      }
    })();
  };

  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
