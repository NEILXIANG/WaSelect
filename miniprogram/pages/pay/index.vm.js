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
 *      ../../utils/order-status.js（PAYABLE：可付状态的唯一真源）；
 *      ../../../server/src/app/pay-intent.ts（服务端对同一件事的护栏）
 */
import { STATUS_LABELS, canPay, statusText } from '../../utils/order-status.js';

/**
 * `requestPayment` 的**取消与失败**统一文案（B35 / AJ-218）。
 *
 * @why 以前把宿主 `fail` 直接喂给 `errorMessage`，于是"用户主动取消"显示成"加载失败"——
 *      用户会以为**这次付款出了故障**，而订单其实还好端端地在 pending_payment。
 *      更糟的解读是"钱扣了但没成"，于是再点一次（服务端有幂等键，不会重复扣，
 *      但用户那一分钟的恐慌是真的）。
 * @why 统一成一句**带下一步**的话："支付未完成，可重新选择支付方式"——
 *      它同时覆盖了取消与失败，且不给出"成功还是没成功"的判断
 *      （真值在订单详情里，靠服务端回调；本页不做结论，@see ../pay/index.js @limitation 一）。
 * @limitation 不解析宿主文案去区分"取消 vs 失败"：
 *              `fail` 的 `errMsg` 是黑盒（含 "cancel"），把它当契约等于把自己的正确性
 *              押在微信不改一个字上。@see utils/wx-api.js @limitation 十（同一条口径）
 */
export const PAY_FAIL_TEXT = '支付未完成，可重新选择支付方式';

/**
 * 这一张单**还能不能走支付流程**（B35 / AJ-218）。
 *
 * @param {unknown} order `GET /orders/{id}` 响应（读 `status`）；可能是任何东西
 * @returns {{payable: boolean, closedText: string}}
 *   `payable=false` 时薄壳不列通道，`closedText` 是给用户的说明（空串 = 不渲染）
 *
 * @why 以前支付页**完全不看订单状态**，从返回栈回到一张已付/已关的单，
 *      照样列出支付方式——点下去是 40902。那是个"看起来能用、实际是坏的"按钮，
 *      而用户在支付这个动作上遇到它，第一反应是"是不是刚才没付成功"。
 * @why `status` 读不到时按**可付**处理：与 `refundGate` 对字段缺失放行的防御同口径——
 *      "读不到"不等于"不能付"，把唯一入口堵死的代价比多给一次被服务端拒绝的点击大
 *      （服务端 40902 会把原因说清楚，而前端静默不给按钮不会说任何话）。
 * @limitation 这是前端的**预判断**，不是权威：服务端状态机仍是唯一裁决
 *              （@see 本函数不改任何写路径）。
 */
export function payPageView(order) {
  const o = order !== null && typeof order === 'object' ? order : {};
  const status = typeof o.status === 'string' ? o.status : '';
  const known = typeof STATUS_LABELS[status] === 'string';
  const payable = !known || canPay(status);
  return { payable, closedText: payable ? '' : `该订单${statusText(status)}，无需再支付` };
}

/**
 * 从后台/上一页回到支付页时，要不要重新取数（B35 / AJ-218）。
 *
 * @param {{payUrl?: unknown, guideTitle?: unknown, paying?: unknown}|null|undefined} args
 * @returns {boolean}
 *
 * @why 支付完成的真值在**服务端回调**里，本页不轮询（@see ../pay/index.js @limitation 一），
 *      所以"用户去浏览器付完款再回来"这一刻，只有重新取数才能把"已付款"显示出来——
 *      否则页面还挂着支付方式按钮，点了就是 40902。
 * @why 三种情况下**不**刷新（刷新会把用户正在用的东西弄没）：
 *      ① `payUrl !== ''`：copylink 屏正在用——用户切出去就是为粘贴这个链接，
 *         刷掉短链等于把人回家的路拆了；
 *      ② `guideTitle !== ''`：任何引导屏（auto / unsupported）同理；
 *      ③ `paying === true`：发起支付在途中，再取一次会并发两个"发起"。
 * @limitation 只做"要不要刷新"的判断，**不发起请求**：薄壳调用 `load()`。
 */
export function shouldRefreshOnShow(args) {
  const a = args !== null && typeof args === 'object' ? args : {};
  if (typeof a.payUrl === 'string' && a.payUrl !== '') return false;
  if (typeof a.guideTitle === 'string' && a.guideTitle !== '') return false;
  return a.paying !== true;
}

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
/**
 * 复制短链**之后**页面该变成什么样（B34 / AJ-217）。
 *
 * @param {unknown} ok 宿主 `setClipboardData` 的 success 是否触发；任何非 `true` 都当失败
 * @returns {{copied: boolean, error: string}} 直接喂给 `setData` 的形状
 *
 * @why 支付页这一屏是**微信支付上线前唯一的付款路径**（D-49：银行卡 = 短链 →
 *      Stripe 托管页），而 `setClipboardData` 是**隐私接口**——它可能失败：
 *      用户拒绝官方隐私弹窗（errno 104）、或隐私指引里漏声明了剪切板（errno 112，
 *      对所有用户都失败）。此前这一页只调 `setClipboardData` 且**不传回调**，
 *      失败时页面毫无反应、也不展示链接文本——用户看到的是"这个按钮坏了"，
 *      而法务页与订单详情页早就有同一套兜底，唯独最要紧的这一屏没有。
 * @why 失败文案必须写**兜底动作**（"长按下方链接手动复制"），而不只是"复制失败"：
 *      只说失败等于告诉用户"走投无路"，而链接文本就在屏幕上、长按可选。
 *      这与 `pages/legal/index.js` @limitation 二是同一条口径。
 * @limitation 只产出"页面该显示什么"，**不碰剪贴板**：宿主调用在薄壳里。
 *              @see ./index.js（onCopy 传 success / fail）
 */
export function copyResult(ok) {
  if (ok === true) return { copied: true, error: '' };
  return { copied: false, error: '复制失败，请长按下方链接手动复制' };
}

export function payStartDecision(args) {
  const a = args && typeof args === 'object' ? args : {};
  const channel = typeof a.channel === 'string' ? a.channel : '';
  if (channel === '') return { kind: 'ignore' };
  if (a.hasKey !== true) return { kind: 'ignore' };
  if (a.paying === true) return { kind: 'ignore' };
  const last = typeof a.lastChannel === 'string' ? a.lastChannel : '';
  return { kind: 'start', channel, retireKey: last !== '' && last !== channel };
}
