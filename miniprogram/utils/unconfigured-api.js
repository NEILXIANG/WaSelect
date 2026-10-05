/**
 * 职责：**未配置服务地址**时的替身请求器（manifest placeholder 不成立时的唯一出口）。
 *
 * @why 存在：`resolveApiBase` 在域名没配时会**抛**（刻意不静默补默认值，
 *      见 `config.js` @limitation 一）。而它是在 `app.js` 的 `onLaunch` 里被调的——
 *      抛出来之后 `onLaunch` 剩下的装配全部不执行，`globalData.api` 保持 `null`。
 *      页面执行 `app.globalData.api({...})` 就得到
 *      **`TypeError: app.globalData.api is not a function`**——
 *      那条路径绕过了页面自己的 `catch → showError`，最终形态是**白屏**，
 *      而真正的原因（"`API_BASES.release` 是空的"）只存在于实时日志里。
 *      白屏 + 只有日志 != 响亮失败：**用户与审核员都看不到任何解释。**
 *
 * @why 给替身而不是留 `null`：本项目在服务端已经有一套成型的纪律——
 *      "脏数据必须在读侧降级，不许整页 500"（AJ-357 / AJ-359）。
 *      这里是同一条纪律的客户端形态：**不可用必须在能被展示的那一层降级**，
 *      而不是让调用方先崩在一个与本因无关的 TypeError 上。
 *      给了必然 reject 的替身之后，各页**已有的**错误处理分支会把原因显示出来。
 *
 * @why 它是"必然失败的请求器"，**不是默认地址**：它不拼 URL、不发 `wx.request`，
 *      所以不存在"偷偷打到某个环境（尤其生产）"的风险——
 *      那正是"不静默补默认值"这条口径真正要守的东西。
 *
 * @limitation 一：替身**什么都不做**，包括不重放、不重登：
 *              地址都没有的时候，任何重试都必然失败，而且是同一种失败。
 * @limitation 二：错误形状复用 `ApiError`（`code` + `message`），而不是自定义对象：
 *              页面的读取方式（`typeof e?.code === 'number'`、取 `e?.message`）与
 *              `error-text.js` 的码表查表都依赖这个形状，这里是同一套。
 *
 * @see ../config.js（`resolveApiBase` 与"不静默补默认值"）；../app.js（唯一调用方）；
 *      ./request.js（`ApiError` 与错误形状）
 */
import { ApiError } from './request.js';

/**
 * 未配置服务地址的专用错误码。
 *
 * @why 复用 `request.js` 的负数约定（网络层 -1，这里 -2）：服务端业务码全是 5 位正数，
 *      负数保证不会和任何一个真实业务码撞车——撞了的表现是"前端按码走错了分支"。
 */
export const UNCONFIGURED_CODE = -2;

/**
 * 造一个"每次调用都明确失败"的请求器。
 *
 * @param {string} reason 给人看的原因（来自 `resolveApiBase` 抛出的 message）
 * @returns {Function} 签名与 `createRequester` 产出的 `requestApi` 一致
 */
export function createUnconfiguredApi(reason) {
  const message = reason === '' ? '尚未配置服务地址' : reason;
  return function unconfiguredApi(opts) {
    void opts; // 一律不看参数：地址都没配，参数不需要参与判断
    return Promise.reject(new ApiError(UNCONFIGURED_CODE, message));
  };
}
