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
