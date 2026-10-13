/**
 * 职责：admin-web 统一请求封装（F15 单元②）——trace_id 贯穿、统一错误收敛、超时、40101 通知。
 * 边界：只管"怎么发请求与怎么收敛错误"；错误形状在 errors.ts，baseUrl 校验在 config.ts。
 *
 * @why 不做封装的话，每个管理页面都要自己拼 header、自己判 `body.code`、自己想"401 要不要登出"，
 *      漏掉的那处表现为"发货按钮点了没反应，实际登录早过期了"。
 *      与小程序 `utils/request.js` **语义对齐**（理由见 errors.ts 抬头），差异只有两条，
 *      都是环境决定的：① 传输层是 fetch 而非 wx.request（没有超时参数，要自己 AbortController）；
 *      ② 管理端**没有静默重登**（小程序能 wx.login 无感换 token，管理端必须人重新输密码），
 *      所以 40101 的出口是 `onUnauthorized` 通知（装配层清 token + 回登录页），而不是"重登+重放"。
 *
 * @limitation 一：**不做任何自动重试**（与小程序端同一红线）。POST 重试有重复执行风险
 *              （发货/退款都是写操作，红线在服务端 AJ-54）；写操作防重靠 idempotencyKey，不靠重试。
 * @limitation 二：超时的实现是 AbortController——它**取消的是"等待"**，服务端可能已处理完请求。
 *              写操作超时后必须以**同一幂等键**重发（服务端会去重），换个键再发可能真的执行两次。
 * @limitation 三：埋点只走注入的 `deps.log`（默认 noop）；`/beacon` 落库上报属 F5 欠账。
 *
 * @tradeoff **零 React 依赖**（纯 TS + 注入 fetch）：框架是"可换零件"（ADR-28），换框架时本文件不动。
 *
 * @see ./errors.ts（错误形状）；./config.ts（baseUrl 校验）；docs/地基搭建清单.md F15
 */
import { ApiError, NETWORK_ERROR_CODE, UNAUTHORIZED_CODE, parseRetryAfter } from './errors.js';
import { normalizeBaseUrl } from './config.js';

/** 默认单次超时（与小程序端 request.js 的 10s 同口径；写操作建议显式给更长的值）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface RequestOptions {
  /** API 路径（`/api/v1/...` 开头），与构造时的 baseUrl 拼接。 */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  /** 请求体（自动 JSON 序列化）；GET 不传。 */
  body?: unknown;
  /** 幂等键（写操作必传；服务端 24h 内同键返回原响应，40908 防键复用不同内容）。 */
  idempotencyKey?: string | undefined;
  /** 复用已有链路 ID；不传则新建（同一次用户操作的多个请求应复用）。 */
  traceId?: string | undefined;
  /** 单次超时（毫秒），默认 {@link DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number | undefined;
}

export interface AdminApiDeps {
  /**
   * API 根地址（如 `http://localhost:3000`；生产 `https://api.<domain>`）。
   * ⚠️ 只接受 http(s) absolute URL（形状校验在 config.ts 的 `normalizeBaseUrl`，本处只消费）。
   */
  baseUrl: string;
  /** 取当前 token；无 token 返回空串（此时不带 authorization 头，与小程序端同口径）。 */
  getToken: () => string;
  /** 传输层（测试注入假 fetch；生产不传走全局 fetch）。 */
  fetchImpl?: typeof fetch | undefined;
  /**
   * 40101 时的通知出口（同步调一次，随后原样抛出 ApiError）。
   * 装配层在这里清 token + 渲染登录页。**刻意不替调用方吞掉错误**——
   * 发起请求的页面仍应收到失败（停止 loading 态），登出动作与错误传播是两件事。
   */
  onUnauthorized?: ((err: ApiError) => void) | undefined;
  /** 埋点出口；默认 noop（@limitation 三）。 */
  log?: ((fields: Record<string, unknown>) => void) | undefined;
  /** 链路 ID 生成器（测试注入固定值；生产默认 crypto.randomUUID，形状过服务端 TRACE_ID_PATTERN）。 */
  newTraceId?: (() => string) | undefined;
}

/** 创建管理端请求函数。一个 App 只建一个实例（getToken/onUnauthorized 是会话级状态）。 */
export function createAdminApi(deps: AdminApiDeps) {
  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((): void => {});
  const newTraceId = deps.newTraceId ?? ((): string => crypto.randomUUID());

  return async function requestApi(opts: RequestOptions): Promise<unknown> {
    const traceId = opts.traceId ?? newTraceId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 日志只记路径、不记 query：列表的 keyword 常常就是买家邮箱 / 收件人（约束七脱敏红线，审查 2026-10-09 #8）
    const logPath = opts.path.split('?')[0] ?? opts.path;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-trace-id': traceId,
    };
    const token = deps.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;

    // fetch 没有超时参数：AbortController 到时取消（@limitation 二：取消的是等待，不是服务端执行）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${opts.path}`, {
        method: opts.method ?? 'GET',
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch {
      // 不用 reject 的具体原因分类：超时与否看 signal.aborted 更可靠（undici 网络错形态随版本变）
      const timedOut = controller.signal.aborted;
      log({
        event: 'api_network_error',
        trace_id: traceId,
        path: logPath,
        reason: timedOut ? 'timeout' : 'network',
      });
      throw new ApiError(
        NETWORK_ERROR_CODE,
        timedOut
          ? `请求超时（等了 ${timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))} 秒` : `${String(timeoutMs)} 毫秒`}），请稍后重试`
          : '网络请求失败',
        traceId,
      );
    } finally {
      clearTimeout(timer);
    }

    // 响应头里的 x-trace-id 优先：服务端对形状不合法的上游值会重建（http.ts），以它为准才对得上日志
    const serverTraceId = res.headers.get('x-trace-id') ?? traceId;

    // 统一错误形状保证是 JSON；非 JSON（平台 502 HTML 页等）按网络层失败归类，
    // 但 message 带上 HTTP 状态——"Render 502"与"DNS 不通"是两种排查方向，不能混成一句"网络失败"
    let body: unknown = null;
    let parsed = true;
    // 204 / 空体（契约的 DELETE → 204）：没有 JSON 可解析不等于"非 JSON 响应"（三审 P2-2）；
    // 旧写法把成功的空响应当成网络失败，管理员删完商品看到"请求失败"、重试再拿 40400
    const noContent = res.status === 204 || res.headers.get('content-length') === '0';
    if (!noContent) {
      try {
        body = await res.json();
      } catch {
        parsed = false;
      }
    }

    const code =
      typeof (body as { code?: unknown } | null)?.code === 'number'
        ? (body as { code: number }).code
        : undefined;
    // 成功 = 2xx 且 body 不带业务码（与小程序端同口径：body 带 code 一律按业务错，哪怕 2xx）
    if (res.ok && parsed && code === undefined) {
      log({ event: 'api_ok', trace_id: serverTraceId, path: logPath, http_status: res.status });
      return body;
    }

    const errCode = code ?? NETWORK_ERROR_CODE;
    const bodyMessage = (body as { message?: unknown } | null)?.message;
    const message =
      typeof bodyMessage === 'string' ? bodyMessage : `请求失败（HTTP ${res.status}）`;
    log({
      event: 'api_failed',
      trace_id: serverTraceId,
      path: logPath,
      http_status: res.status,
      code: errCode,
    });
    // data 与 retry-after 原样带出（P2-43 / P2-49）：50300 的退避时长、42901 的锁定剩余都在这两处
    const err = new ApiError(errCode, message, serverTraceId, {
      data: (body as { data?: unknown } | null)?.data,
      retryAfterSec: parseRetryAfter(res.headers.get('retry-after')),
    });
    if (errCode === UNAUTHORIZED_CODE) deps.onUnauthorized?.(err);
    throw err;
  };
}
