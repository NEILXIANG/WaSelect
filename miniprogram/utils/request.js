/**
 * 职责：小程序端统一的请求封装（F6c 壳）——trace_id 贯穿、统一错误形状、行为埋点出口。
 * 边界：只管"怎么发请求与怎么收敛错误"；具体接口地址与业务语义在各页面 / service 里。
 *
 * @why 不做封装的话，每个页面都要自己拼 header、自己判 `res.data.code`、自己想"401 要不要跳登录"。
 *      三处页面就会有三种判断，漏掉的那处表现为"这个页面报错弹了个 undefined"。
 *      收敛到一个出口后：错误是可机读的 `code`，前端按 `action` 提示（见 shared 错误码注册表）。
 *
 * @limitation 一：**只对 40101 做"重登 + 重放一次"**（F14 第二单元），其余一律不自动重试。
 *              @why 40101 是唯一一个"必然能通过重放修好"的错：token 过期是客户端状态问题，
 *              不是请求本身有问题——重放一定得到正确结果（前提是新 token 有效）。
 *              而 5xx / 超时重不重试是**产品决策**（用户愿不愿意多等），不能在这里替页面决定；
 *              且 POST 重试有重复扣款风险，那条红线在服务端（AJ-54），客户端同样不该越线。
 *              ⚠️ **重放只做一次**，且重放的结果若还是 40101 就直接抛出（记 `api_relogin` / `replay_still_401`）
 *              ——不做递归，否则登录接口本身异常时会变成无限循环。
 *              ⚠️ 重放**复用同一个 trace_id**：重登与重放属于同一次用户操作，
 *              拆成两条链路会让"用户点了之后发生了什么"在日志里断成两截。
 *              ⚠️ `relogin` 与 `setToken` 要**成对**提供：`relogin` 拿到的新 token 只有经
 *              `setToken` 写回，`getToken` 才会在重放时返回它。只给 `relogin` 不给 `setToken`
 *              的表现是"每次都重登成功、每次重放还是 40101"——能看出来，但会绕一圈。
 *              （刻意不在构造时强校验：token 也可能由外部 store 持有，`relogin` 自己已写回。）
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

/**
 * 需要"静默重登并重放"的业务码。
 *
 * ⚠️ 这里是**硬编码**，没有 import shared 的错误码表：小程序的 `nodeModules` 默认是 false，
 *    引入包要走"构建 npm"，为一个常量付这个成本不划算。
 *    代价是它与 `packages/shared/src/errors.ts` 有两处真值——
 *    靠 `request.unit.test.ts` 里一条断言把它**绑回注册表**（断言该码的 action 确实是
 *    "静默重新登录并重放请求"），改了一边另一边会红。
 *
 * @see packages/shared/src/errors.ts（码与 action 的唯一真源）
 */
export const RELOGIN_CODE = 40101;

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
 * @param {Function} [deps.setToken] 写入新 token；**只在重登成功后被调用**
 * @param {Function} [deps.relogin] 静默重登：`() => Promise<string>` 返回新 token。
 *                   不传 → 收到 40101 时**不重放**（原样抛出）：没有重登手段时重放注定还是 40101
 * @param {Function} [deps.log] 埋点出口，收到 `{ event, ...fields }`
 */
export function createRequester(deps = {}) {
  const wxApi = deps.wx ?? createWxApi();
  const getToken = deps.getToken ?? (() => '');
  const setToken = deps.setToken;
  const relogin = deps.relogin;
  const log =
    deps.log ??
    ((fields) => {
      const rt = wxApi.getRealtimeLogManager();
      rt?.info?.(fields.event ?? 'api', JSON.stringify(fields));
    });

  /**
   * **进行中的重登**（single-flight 的共享句柄）。`null` = 当前没有在重登。
   *
   * @why 必须共享：一个页面进屏时常常并发发 3~5 个请求，它们会**同时**收到 40101。
   *      各登一次的结果是 ① 打 5 次登录接口（可观的无效流量）；
   *      ② 5 个 token 先后写回，最后写的不一定是最后一个返回的——
   *      **token 会倒退**，表现为"刚登录完又 401"，而且极难复现。
   * @limitation 它是**每个 requester 实例**一份（不是模块级全局）。
   *      一个 App 只建一个 requester（见 app.js），所以语义上就是"全局一个"。
   */
  let relogining = null;

  /**
   * 触发一次重登；若已有在途的，复用它。
   * @returns {Promise<string>} 新 token
   */
  function ensureRelogin() {
    if (relogining !== null) return relogining;
    const task = (async () => {
      const token = await relogin();
      // ⚠️ 写回是 setToken 的职责，但**只有重登成功才写**：
      //    失败时若把旧 token（或空串）写回去，等于把用户登出——那不是我们要的行为。
      setToken?.(token);
      return token;
    })();
    relogining = task;
    // ⚠️ 成功与失败**都要清**：只在成功时清的话，一次失败会让后续所有请求
    //    永远复用那个已 rejected 的 Promise——表现为"重登失败一次之后再也不重试"，
    //    而错误信息还是最开始那一次，排查方向会被引到第一次失败的原因上。
    const clear = () => {
      relogining = null;
    };
    task.then(clear, clear);
    return task;
  }

  /**
   * 发**一次**请求（不含重登逻辑）。
   * @returns {Promise<object>}
   */
  function attempt(opts, traceId) {
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
  }

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
  return async function requestApi(opts) {
    const traceId = opts.traceId ?? newTraceId();
    let firstErr;
    try {
      return await attempt(opts, traceId);
    } catch (err) {
      // ⚠️ 不是 40101、或没配 relogin → 原样抛出，一个字节都不改（保持旧行为）
      if (!(err instanceof ApiError) || err.code !== RELOGIN_CODE) throw err;
      if (relogin === undefined) throw err;
      firstErr = err;
    }

    log({ event: 'api_relogin', result: 'started', trace_id: traceId, url: opts.url });
    try {
      await ensureRelogin();
    } catch (e) {
      log({
        event: 'api_relogin',
        result: 'failed',
        trace_id: traceId,
        url: opts.url,
        err_msg: e?.message ?? String(e),
      });
      // ⚠️ 交出**原始的 40101**，不是重登失败的原因：
      //    调用方（与错误码表里的 action）要的是"没登录"，重登为什么失败是另一件事（已记在日志里）。
      throw firstErr;
    }
    log({ event: 'api_relogin', result: 'ok', trace_id: traceId, url: opts.url });

    // 重放**一次**（不递归：这里直接调 attempt，失败就抛出，不会再触发重登）
    try {
      return await attempt(opts, traceId);
    } catch (err) {
      if (err instanceof ApiError && err.code === RELOGIN_CODE) {
        log({
          event: 'api_relogin',
          result: 'replay_still_401',
          trace_id: traceId,
          url: opts.url,
        });
      }
      throw err;
    }
  };
}
