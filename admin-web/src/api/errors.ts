/**
 * 职责：admin-web 请求层的**错误形状与口径常量**（F15 单元②，自 client.ts 拆出）。
 * 边界：只定义"错误长什么样"；怎么发请求、怎么判定成功在 client.ts。
 *
 * @why 独立成模块：错误形状的消费者（endpoints.ts 的形状校验、LoginForm 的展示、
 *      装配层的 40101 分支）不该被迫 import 整个请求机——
 *      拆开后"错误口径"与"请求执行"各自演化，且两个模块都在约束二的行数上限内。
 *
 * @why 与小程序 `miniprogram/utils/request.js` **语义对齐**（同一项目两端同一套口径）：
 *      同样的 NETWORK_ERROR_CODE=-1、同样的"业务错与网络错共用同一形状"。
 *      两端若各说各话，排查"管理端发货失败"与"用户端下单失败"就得记两套规则。
 *
 * @see packages/shared/src/errors.ts（业务错误码注册表，唯一真源）；
 *      ./client.ts（这些错误的抛出方）；miniprogram/utils/request.js（对齐的另一端）
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

/** 上游熔断打开（`data.retry_after_ms` 给出退避时长）。@see packages/shared/src/errors.ts 50300 */
export const UPSTREAM_UNAVAILABLE_CODE = 50300;

/**
 * 解析 `retry-after` 头（只认非负整数秒）。
 * @why 单独导出：头缺失、空串、HTTP-date、负数都要回 undefined，而不是 `Number('')` 的 0（"0 分钟后再试"是错话）。
 */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

/** 从 ApiError 取 50300 的退避秒数（向上取整；没有就 undefined）。 */
export function retryAfterMsSec(err: unknown): number | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const ms = err.data?.['retry_after_ms'];
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
    ? Math.ceil(ms / 1000)
    : undefined;
}

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
  /**
   * 错误体里的 `data`（服务端统一错误形状的可选附加字段，如 50300 的 `retry_after_ms`）。
   * @why 第三轮缺口 P2-49：50300（上游熔断）要告诉运营"约 N 秒后可重试"，这个数只在 `data` 里；
   *      之前封装层把它丢了，页面只能说一句泛化的"服务暂不可用"。不是对象时为 undefined。
   */
  readonly data: Record<string, unknown> | undefined;
  /**
   * 响应头 `retry-after`（秒）解析出的等待时长；缺失 / 不是非负整数时为 undefined。
   * @why 42901（登录锁定）的"还要等多久"只在这个头里（服务端 http.ts 已把它列进 expose-headers，SEC2-08）。
   * @limitation 只认"秒数"形态，不认 HTTP-date 形态（服务端只发秒数，见 admin-auth-routes.ts）。
   */
  readonly retryAfterSec: number | undefined;

  constructor(
    code: number,
    message: string,
    traceId: string,
    extra?: { data?: unknown; retryAfterSec?: number | undefined },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = traceId;
    const d = extra?.data;
    this.data =
      typeof d === 'object' && d !== null && !Array.isArray(d)
        ? (d as Record<string, unknown>)
        : undefined;
    this.retryAfterSec = extra?.retryAfterSec;
  }
}
