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
 *
 * @tradeoff 用 Express 而非 Fastify：生态与资料最多（团队零小程序/Node 后端经验），
 *           代价是没有内建的 schema 校验与更慢的序列化——校验由 zod 在路由层做（F6c 起），性能在日百单量级无差异。
 *
 * @see docs/可扩展架构设计（app 层）、docs/代码注释规范与日志体系设计.md（流 C 请求日志）、技术文档 v0.5 §8
 */
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

/** 从请求头取链路 ID：上游（小程序 / 定时任务）传来的要沿用，否则新建。 */
function traceIdFrom(req: Request): string {
  const header = req.header('x-trace-id');
  return header !== undefined && header.trim().length > 0 ? header.trim() : newTraceId();
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
    if (!(err instanceof AppError)) {
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

/** 把各类异常归一成 {status, body, logFields}：解析错误也要有业务码，不能裸 500。 */
function normalizeError(err: unknown): {
  status: number;
  body: { code: number; message: string };
  logFields: Record<string, unknown>;
} {
  // JSON 解析失败 / 体积超限：express 抛的是带 status 的普通错误，按 40001（参数格式错误）归一
  if (
    err instanceof SyntaxError ||
    (err as { type?: string } | null)?.type === 'entity.too.large'
  ) {
    const appErr = new AppError(40001, { reason: (err as Error).message });
    const { status, body } = toErrorResponse(appErr);
    return { status, body, logFields: { err_code: appErr.code, err_message: appErr.message } };
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
 * 启动监听（测试与生产共用同一条路径，避免"测试用 supertest、生产用 listen"两套行为）。
 * @returns 实际端口与关闭函数（优雅关闭：先停止接新请求，再等存量请求结束）
 */
export async function listen(
  app: Express,
  port = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取监听端口');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
