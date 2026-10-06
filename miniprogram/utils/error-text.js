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
 *
 * @why `message` 读不到时兜底读 **`errMsg`**（B35 / AJ-218）：宿主回调（`wx.*` 的
 *      `fail`）给的形状是 `{errMsg}`，不是 `{message}`。以前一律回落到"加载失败"，
 *      于是宿主说 `navigateTo:fail webview count limit exceed` 时页面只显示"加载失败"——
 *      ⚠️ 排障时**唯一**的信息（宿主给的原因）在这一层被扔掉了，
 *      而它恰恰是能被机读、能对照官方文档的那一段。
 *      @limitation 兜底只用于**读不到 message 时**：`ApiError` 有 `message`，
 *                  不会被宿主形状顶掉（顺序固定，不是"谁新谁赢"）。
 */
export function errorMessage(err) {
  const isObj = err !== null && typeof err === 'object';
  // 剩余清单 4-6：网络层失败（负数码）给人话；宿主原始串（request:fail timeout）只进 errorRef 小字
  if (isObj && Number.isInteger(err.code) && err.code < 0 && err.code !== UNCONFIGURED_CODE) {
    return NETWORK_TEXT;
  }
  const fromMessage = isObj && typeof err.message === 'string' ? err.message.trim() : '';
  const fromErrMsg =
    fromMessage === '' && isObj && typeof err.errMsg === 'string' ? err.errMsg.trim() : '';
  const msg = fromMessage || fromErrMsg;
  return msg === '' ? '加载失败' : msg;
}

/** 网络层失败的人话（剩余清单 4-6）。 */
const NETWORK_TEXT = '网络不太稳定，请检查网络后重试';
/** "服务地址没配"（unconfigured-api，-2）的 message 本身就是给人看的说明，不替换。 */
const UNCONFIGURED_CODE = -2;

/**
 * 报障小字（剩余清单 4-6 / M9）：`错误码 40002 · 链路 abcdef12`（网络层再附宿主原因）。
 * @why 主文案给人看、小字给客服看：用户截图发给客服时，客服凭链路号能在日志里找到这一次请求的全部记录；
 *      而把码与英文原因拼进主文案，用户读到的是一串看不懂的东西。
 * @why 链路号只取前 8 位：够在日志里检索（trace_id 前缀匹配），又不至于一行放不下。
 * @returns {string} 空串 = 没有可报的信息（页面不显示小字）
 */
export function errorRef(err) {
  if (err === null || typeof err !== 'object' || !Number.isInteger(err.code)) return '';
  const parts = [`错误码 ${String(err.code)}`];
  if (typeof err.traceId === 'string' && err.traceId !== '')
    parts.push(`链路 ${err.traceId.slice(0, 8)}`);
  if (err.code < 0 && typeof err.message === 'string' && err.message.trim() !== '') {
    parts.push(err.message.trim());
  }
  return parts.join(' · ');
}

/**
 * 页面一次写入主文案与小字：`setData({...errorFields(e)})` → `{error, errorRef}`。
 * @param {string} [key] 主文案的键名（默认 error；保存错误用 saveError → 同时给 saveErrorRef）
 */
export function errorFields(err, key = 'error') {
  return { [key]: errorMessage(err), [`${key}Ref`]: errorRef(err) };
}
