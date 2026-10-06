/**
 * 职责：`GET /support` → 客服联系方式展示行（剩余清单 4-2）。纯函数，「我的」与订单详情共用。
 *
 * @why 只出服务端给了的字段：客服账号确定前服务端回空对象，页面据此**不显示**客服卡——
 *      写一个假的微信号比没有更贵（用户会真的去加，原「我的」页 @limitation 一）。
 * @why 微信号在前：买家在微信里，加微信是最近的那条路；邮箱是兜底。
 * @limitation 不接小程序原生客服（`<button open-type="contact">`）：要在公众平台开通客服并绑定 AppID，属外部阻塞。
 * @see ../../server/src/app/product-routes.ts（GET /support）
 */
const ROWS = [
  { key: 'wechat', label: '客服微信', copyable: true },
  { key: 'email', label: '客服邮箱', copyable: true },
  { key: 'hours', label: '服务时间', copyable: false },
];

/** @returns {Array<{key: string, label: string, value: string, copyable: boolean}>} */
export function supportRows(res) {
  const o = res !== null && typeof res === 'object' && !Array.isArray(res) ? res : {};
  return ROWS.filter((r) => typeof o[r.key] === 'string' && o[r.key].trim() !== '').map((r) => ({
    key: r.key,
    label: r.label,
    value: o[r.key].trim(),
    copyable: r.copyable,
  }));
}
