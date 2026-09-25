/**
 * 职责：admin-web 统一请求封装（F15 单元②）——trace_id 贯穿、统一错误形状、超时、40101 通知。
 * 边界：只管"怎么发请求与怎么收敛错误"；接口路径与业务语义在 endpoints.ts，UI 在组件层。
 *
 * @why 不做封装的话，每个管理页面都要自己拼 header、自己判 `body.code`、自己想"401 要不要登出"。
 *      三处页面就会有三种判断，漏掉的那处表现为"发货按钮点了没反应，实际登录早过期了"。
 *      收敛到一个出口后：错误是可机读的 `code`（与 shared 错误码注册表同源），
 *      40101 只有一个处理点（回登录页），链路 ID 每个请求自动带上。
 *
 * @why 与小程序 `miniprogram/utils/request.js` **语义对齐**（同一项目两端同一套口径）：
 *      同样的 NETWORK_ERROR_CODE=-1、同样的"body 带 code 即业务错"判定、同样的事件名（api_ok/api_failed/…）。
 *      两端若各说各话，将来排查"管理端发货失败"与"用户端下单失败"就得记两套规则。
 *      差异只有两条，都是环境决定的：
 *      ① 传输层是浏览器 fetch 而非 wx.request（fetch 没有超时参数，要自己 AbortController）；
 *      ② 管理端**没有静默重登**——小程序能 wx.login 无感换 token，管理端必须人重新输密码，
 *      所以 40101 的出口是 `onUnauthorized` 通知（装配层清 token + 回登录页），而不是"重登+重放"。
 *
 * @limitation 一：**不做任何自动重试**（与小程序端同一红线）。5xx/超时重不重试是产品决策，
 *              POST 重试还有重复执行风险（发货/退款都是写操作），那条红线在服务端（AJ-54），
 *              客户端同样不越线。写操作的防重靠 idempotencyKey（服务端 24h 去重），不靠重试。
 * @limitation 二：超时的实现是 AbortController——它**取消的是"等待"**，服务端可能已收到并处理完
 *              请求。所以超时按失败处理后，写操作必须以幂等键重新发起（服务端会去重），
 *              而不是假定"刚才那次没生效"直接换个键再发（那可能真的执行两次）。
 * @limitation 三：埋点只走注入的 `deps.log`（默认 noop）。管理端的 `/beacon` 落库上报与
 *              小程序端同属 F5 欠账，接入前行为日志只在浏览器控制台（装配层可把 log 接到 console）。
 *
 * @tradeoff 本封装**零 React 依赖**（纯 TS + 注入 fetch）：框架是"可换零件"（ADR-28），
 *           请求封装是业务核心的一部分，不跟 UI 框架焊死。换框架时本文件一行不动。
 *
 * @see packages/shared/src/errors.ts（错误码注册表，唯一真源）；
 *      miniprogram/utils/request.js（语义对齐的另一端）；docs/地基搭建清单.md F15
 */

/**
 * 网络层失败码。服务端错误码全是 5 位正数，用负数避免撞码——
 * 否则"网络不通"会和一个真实业务错误码混淆，按码分支时会走错分支。
 * ⚠️ 与 `miniprogram/utils/request.js` 的 NETWORK_ERROR_CODE **必须同值**（两端同一口径），
 *    单测里有跨端同值断言，改了一边另一边会红。
 */
export const NETWORK_ERROR_CODE = -1;

/**
 * 未登录 / 登录过期。管理端收到它 = token 失效，唯一出路是回登录页重新输密码。
 * @see packages/shared/src/errors.ts 40101（action：重新登录——管理端无法静默完成，所以走 onUnauthorized）
 */
export const UNAUTHORIZED_CODE = 40101;

/** 默认单次超时（与小程序端 request.js 的 10s 同口径；写操作建议显式给更长的值）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 统一错误：业务错（带服务端 code）与网络错（NETWORK_ERROR_CODE）共用同一形状。 */
export class ApiError extends Error {
  /** 业务错误码（见 shared 注册表）或 NETWORK_ERROR_CODE。 */
  readonly code: number;
  /**
   * 本次请求的链路 ID（**以响应头为准**，响应头缺失时回落到本地生成的值）。
   * @why N8：管理端报障必须能给出一个 ID 让服务端按它检索日志——
   *      没有这个字段，"刚才那个报错"就只能口头描述时间点和操作，对不上日志。
   */
  readonly traceId: string;

  constructor(code: number, message: string, traceId: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = traceId;
  }
}

export interface RequestOptions {
  /** API 路径（`/api/v1/...` 开头），与构造时的 baseUrl 拼接。 */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | undefined;
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
   * ⚠️ 只接受 http(s)  absolute URL——相对路径在"管理端与 API 不同域"（D21）的部署形态下
   *    会打到静态站自己身上，表现为全部 404 且 CORS 不报错，排查方向全错。形状不符在构造时硬失败。
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

/** 构造期校验 baseUrl：http(s) absolute，尾斜杠归一（拼 path 不双斜杠）。 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/.test(trimmed)) {
    throw new TypeError(
      `baseUrl 必须是 http(s) 绝对地址，收到「${value}」——相对路径会把请求打到静态站自己身上`,
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * 创建管理端请求函数。一个 App 只建一个实例（getToken/onUnauthorized 都是会话级状态）。
 */
export function createAdminApi(deps: AdminApiDeps) {
  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((): void => {});
  const newTraceId = deps.newTraceId ?? ((): string => crypto.randomUUID());

  return async function requestApi(opts: RequestOptions): Promise<unknown> {
    const traceId = opts.traceId ?? newTraceId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
        path: opts.path,
        reason: timedOut ? 'timeout' : 'network',
      });
      throw new ApiError(
        NETWORK_ERROR_CODE,
        timedOut ? `请求超时（${timeoutMs}ms）` : '网络请求失败',
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
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }

    const code =
      typeof (body as { code?: unknown } | null)?.code === 'number'
        ? (body as { code: number }).code
        : undefined;
    // 成功 = 2xx 且 body 不带业务码（与小程序端同口径：body 带 code 一律按业务错，哪怕 2xx）
    if (res.ok && parsed && code === undefined) {
      log({ event: 'api_ok', trace_id: serverTraceId, path: opts.path, http_status: res.status });
      return body;
    }

    const errCode = code ?? NETWORK_ERROR_CODE;
    const message =
      (body as { message?: unknown } | null)?.message !== undefined &&
      typeof (body as { message?: unknown }).message === 'string'
        ? ((body as { message: string }).message as string)
        : `请求失败（HTTP ${res.status}）`;
    log({
      event: 'api_failed',
      trace_id: serverTraceId,
      path: opts.path,
      http_status: res.status,
      code: errCode,
    });
    const err = new ApiError(errCode, message, serverTraceId);
    if (errCode === UNAUTHORIZED_CODE) deps.onUnauthorized?.(err);
    throw err;
  };
}
