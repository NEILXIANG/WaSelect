/**
 * 职责：记住"这张单刚在浏览器里发起过银行卡付款"（W-02），供支付页与订单详情判断要不要显示"确认中"。
 *
 * @why 银行卡走"复制链接 → 浏览器付款"。用户付完切回小程序时，支付机构的通知往往还没到，
 *      订单仍是"待付款"——页面若照常给出"继续支付 / 取消订单"，用户会以为没付上而去重付或取消。
 *      微信支付有 success 回调可以带 `justPaid=1`，浏览器付款没有任何回调，只能记下"发起过"。
 * @why 纯函数、时间由调用方传入（约束十一同口径）：存放在 `app.globalData` 由薄壳负责。
 * @limitation 只是**假设**不是事实：用户可能复制了链接却没付。所以只在付款窗口内生效，
 *              且使用方（订单详情）重查两次仍未确认就放弃这个假设，把按钮还给用户。
 */

/** 与订单的支付窗口同量级（30 分钟）：超过它订单本来就该关了，不再认作"刚付过"。 */
export const EXTERNAL_PAY_WINDOW_MS = 30 * 60 * 1000;

/**
 * @param {unknown} memo 现有记录 `{ [orderId]: 发起时刻 ms }`
 * @param {string} orderId
 * @param {number} nowMs
 * @returns {Record<string, number>} 新对象（不改写传入的）
 */
export function markExternalPay(memo, orderId, nowMs) {
  const base = memo !== null && typeof memo === 'object' && !Array.isArray(memo) ? memo : {};
  return { ...base, [orderId]: nowMs };
}

/**
 * @param {unknown} memo
 * @param {string} orderId
 * @param {number} nowMs
 * @returns {boolean} 窗口内发起过外部付款
 */
export function recentExternalPay(memo, orderId, nowMs) {
  if (memo === null || typeof memo !== 'object') return false;
  const at = /** @type {Record<string, unknown>} */ (memo)[orderId];
  return typeof at === 'number' && nowMs - at >= 0 && nowMs - at < EXTERNAL_PAY_WINDOW_MS;
}
