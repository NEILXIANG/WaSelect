/**
 * 职责：小程序端统一的请求封装（F6c 壳）——trace_id 贯穿、统一错误形状、行为埋点出口。
 * 边界：只管"怎么发请求与怎么收敛错误"；具体接口地址与业务语义在各页面 / service 里。
 *
 * @why 不做封装的话，每个页面都要自己拼 header、自己判 `res.data.code`、自己想"401 要不要跳登录"。
 *      三处页面就会有三种判断，漏掉的那处表现为"这个页面报错弹了个 undefined"。
 *      收敛到一个出口后：错误是可机读的 `code`，前端按 `action` 提示（见 shared 错误码注册表）。
 *
 * @limitation 一：**不做自动重试**。40101 的 action 是"静默重新登录并重放请求"，
 *              但重放需要页面配合（重新取数），在封装里静默重试会让用户看到"点了没反应"。
 *              因此这里只把 code 抛出去，重放策略由页面决定。
 * @limitation 二：**不再直接引用 `wx`**——宿主能力一律走 `utils/wx-api.js` 的封装
 *              （F14 第一单元）。此前本模块自己写了 `typeof wx !== 'undefined'` 守卫，
 *              那是"每个用到 wx 的模块各发明一套绕法"的第三条，现在收敛成一条：
 *              测试注入 `createWxApi({ request })`，生产不传就走真实宿主。
 *              这也是"只有第三方才 mock"的边界——`wx` 是宿主能力，
 *              业务代码不为可测性抽象自己的 HTTP 接口，但**宿主本身**要有且只有一个入口。
 * @limitation 三：埋点只走 `deps.log`（默认用封装里的 `getRealtimeLogManager`）。
 *              ADR-29 要求的 `/beacon` 落库上报尚未接入（F5 补完时接），
 *              在此之前小程序端行为只有实时日志，不上报到我们自己的库。
 *
 * @see packages/shared/src/errors.ts（码与 action）；ADR-29（流 C 用户行为）；./wx-api.js（宿主入口）
 */
import { newTraceId } from './trace.js';
import { createWxApi } from './wx-api.js';

/**
 * 网络层失败码。服务端错误码全是 5 位正数，用负数避免撞码——
 * 否则"网络不通"会和一个真实的业务错误码混淆，前端按码分支时会走错分支。
 */
export const NETWORK_ERROR_CODE = -1;

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * 创建请求函数。
 * @param {object} [deps] 依赖注入（测试用；生产不传）
 * @param {object} [deps.wx] 宿主能力入口（**覆盖就覆盖这一整层**，见 `wx-api.js`）；
 *                 不传则用 `createWxApi()` 走真实宿主
 * @param {Function} [deps.getToken] 取当前 token；无 token 返回空串
 * @param {Function} [deps.log] 埋点出口，收到 `{ event, ...fields }`
 */
export function createRequester(deps = {}) {
  const wxApi = deps.wx ?? createWxApi();
  const getToken = deps.getToken ?? (() => '');
  const log =
    deps.log ??
    ((fields) => {
      const rt = wxApi.getRealtimeLogManager();
      rt?.info?.(fields.event ?? 'api', JSON.stringify(fields));
    });

  /**
   * 发一个请求。
   * @param {object} opts
   * @param {string} opts.url 完整 URL
   * @param {string} [opts.method] 默认 GET
   * @param {object} [opts.data]
   * @param {object} [opts.header] 额外请求头
   * @param {string} [opts.idempotencyKey] 幂等键（写操作必传，防重复下单）
   * @param {string} [opts.traceId] 复用已有链路 ID；不传则新建（**同一次用户操作的多个请求应复用**）
   * @returns {Promise<object>} 成功时 resolve 响应体
   * @throws {ApiError} 业务错误（带 code）或网络错误（NETWORK_ERROR_CODE）
   */
  return function requestApi(opts) {
    const traceId = opts.traceId ?? newTraceId();
    const header = { 'content-type': 'application/json', ...(opts.header ?? {}) };
    header['x-trace-id'] = traceId;
    const token = getToken();
    if (token) header.authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) header['idempotency-key'] = opts.idempotencyKey;

    return new Promise((resolve, reject) => {
      wxApi.request({
        url: opts.url,
        method: opts.method ?? 'GET',
        data: opts.data,
        header,
        timeout: opts.timeout ?? 10000,
        success: (res) => {
          const status = res.statusCode;
          const body = res.data;
          const code = typeof body?.code === 'number' ? body.code : undefined;
          const ok = status >= 200 && status < 300 && code === undefined;
          if (ok) {
            log({ event: 'api_ok', trace_id: traceId, url: opts.url, http_status: status });
            resolve(body);
            return;
          }
          const errCode = code ?? NETWORK_ERROR_CODE;
          const message = body?.message ?? `请求失败（HTTP ${status}）`;
          log({
            event: 'api_failed',
            trace_id: traceId,
            url: opts.url,
            http_status: status,
            code: errCode,
          });
          reject(new ApiError(errCode, message));
        },
        fail: (err) => {
          log({
            event: 'api_network_error',
            trace_id: traceId,
            url: opts.url,
            err_msg: err?.errMsg,
          });
          reject(new ApiError(NETWORK_ERROR_CODE, err?.errMsg ?? '网络请求失败'));
        },
      });
    });
  };
}
