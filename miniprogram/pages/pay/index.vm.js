/**
 * 职责：支付页（`pages/pay`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页的坏法全是"点了之后看起来成功了"：连点发起两次、换通道却沿用旧幂等键
 *      （拿到上一个通道的支付凭据）。这两条都不会报错，只会静默多一次请求或付错入口。
 *      所以把"点一下该做什么"收成一个纯函数，让它可以被单测逐分支钉住。
 *
 * @why **不含**通道渲染与"下一步做什么"：那些住在 `utils/pay-plan.js`——
 *      确认页要预取、支付页要执行，两边共用同一份才不会出现"确认页说支持、支付页不显示"。
 *
 * @see ../../utils/pay-plan.js（通道渲染 / 实扣金额 / 下一步）；
 *      ../../utils/idempotency.js（幂等键生命周期）；
 *      ../../../server/src/app/pay-intent.ts（服务端对同一件事的护栏）
 */

/**
 * 点"用这个方式支付"之后的决定。
 *
 * @param {{paying: boolean, channel: unknown, lastChannel: string, hasKey: boolean}|null|undefined} args
 *   传 null / undefined 也算"不该发起"（wxml 传错形态时页面只是不动，不能炸）。
 *   `paying`      上一次发起是否还在途中（B6 / AJ-201 的在途守卫）；
 *   `channel`     wxml `data-channel` 原值（可能是任何东西，不能直接信）；
 *   `lastChannel` 页面记住的上一次通道（空串 = 还没发起过）；
 *   `hasKey`      幂等键生命周期器是否已就绪。
 * @returns {{kind: 'ignore'} | {kind: 'start', channel: string, retireKey: boolean}}
 *
 * @why `paying` 那条守卫（B6 / AJ-201）：上一次发起还没回来就再点，会多打一次
 *      `POST /orders/{id}/pay`。服务端有幂等键兜底（同键不会建第二个会话），
 *      但仍然白占一次连接与一次订单行锁——发起支付这条路要调机构，一次最长 6s，
 *      连接池只有 10 条时"连点"就是自己把自己排队。
 *      ⚠️ 挡的是**浪费**，正确性仍由服务端负责：本函数不做任何重试判断。
 * @why `retireKey`（换通道必须作废键）：同键重放会被服务端判成"上一个通道的 intent"，
 *      用户点了 B 却拿到 A 的支付凭据——同键同参才算重放，参数不同就不是。
 * @limitation 只做"要不要发起 / 要不要换键"这两个判断，**不碰宿主 API、不读时间、
 *              不发起请求**：键的 acquire/retire 与 `requestPayment` 全在薄壳里。
 */
export function payStartDecision(args) {
  const a = args && typeof args === 'object' ? args : {};
  const channel = typeof a.channel === 'string' ? a.channel : '';
  if (channel === '') return { kind: 'ignore' };
  if (a.hasKey !== true) return { kind: 'ignore' };
  if (a.paying === true) return { kind: 'ignore' };
  const last = typeof a.lastChannel === 'string' ? a.lastChannel : '';
  return { kind: 'start', channel, retireKey: last !== '' && last !== channel };
}
