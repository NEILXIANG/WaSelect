/**
 * 职责：把请求封装抛出的错误变成**用户可读的一行文案**。
 *
 * @why 首页与详情页都要显示错误，而错误形状（`ApiError{code,message}`、网络层负数码、
 *      以及"抛出来的根本不是 Error"）只有一种正确读法。两处各写一遍的结果是
 *      "A 页显示 `50003 汇率缺失`、B 页显示 `undefined`"——用户对后者的解读是"这个站坏了"。
 *
 * @why `code` 保留在文案里：它可机读，真机排障时截图就能对照错误码表，
 *      比"加载失败"四个字值钱得多（@see docs/代码注释规范与日志体系设计.md 流 A）。
 *
 * @limitation 不做重试 / 不做跳转：**行动**是页面的决定（哪些错误值得重试是产品决策，
 *            request.js 的 @limitation 一 写明了为什么不自动重试）。这里只负责"说清楚"。
 *
 * @see ../utils/request.js（错误形状真源：ApiError / NETWORK_ERROR_CODE）
 */

/**
 * @param {unknown} err 请求封装抛出的错误，也可能是任何东西（不要假设形状）
 * @returns {string} `code message` 或 `message` 或兜底文案；永不为空串
 */
export function errorMessage(err) {
  const isObj = err !== null && typeof err === 'object';
  const code = isObj && Number.isInteger(err.code) ? String(err.code) : '';
  const raw = isObj && typeof err.message === 'string' ? err.message.trim() : '';
  const msg = raw === '' ? '加载失败' : raw;
  return code === '' ? msg : `${code} ${msg}`;
}
