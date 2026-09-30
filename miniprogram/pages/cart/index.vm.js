/**
 * 职责：购物车页（`pages/cart`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 购物车页有两组数据：本地条目（cart-store，**快照价**）与服务端报价
 *      （`POST /orders/quote`，**权威价**）。它们的关系是最容易写错的地方：
 *      拿快照价算合计 = 价格变了没人发现（cart-store.js @limitation 一）；
 *      快照价一行都不显示 = 弱网下购物车一片空白。这里的口径是：
 *      **行内展示用快照（仅参考），合计只用 quote**——且行内**不显示小计**
 *      （小计 = 单价 × 数量，是"算合计"的半成品，同一条红线）。
 *
 * @limitation 一：`priceText` 对**非整数快照价降级为空串**：旧版本写入的脏数据
 *              不该让整行渲染失败（`ws-price` 对非整数会响亮失败）；
 *              快照价只是参考信息，不值得为它炸掉一行。
 * @limitation 二：**不含报价区**——`quoteView` 住在 `utils/quote-view.js`
 *              （共享层）。确认订单页要渲染同一块报价区，从本页面 import 过去
 *              会成为"页面依赖页面"：本页改结构、确认页跟着崩，而崩处离改动隔两个页面。
 *
 * @see ../../utils/cart-store.js（本地状态真源与"快照价红线"）；
 *      ../../utils/quote-view.js（报价区视图）；contracts/api-contract.yaml（Quote）
 */
import { formatJpy } from '../../utils/price-format.js';

/**
 * 本地条目 → 行视图。
 * @param {Array} items cart-store 的条目（含快照）
 * @returns {Array<{productId: string, title: string, image: string, qty: number, priceText: string}>}
 * @why `priceText` 在这里格式化而不是 wxml 里塞 ws-price：见 @limitation 一。
 */
export function cartRows(items) {
  if (!Array.isArray(items)) return [];
  return items.map((i) => ({
    productId: typeof i.productId === 'string' ? i.productId : '',
    title: typeof i.title === 'string' ? i.title : '',
    image: typeof i.image === 'string' ? i.image : '',
    qty: Number.isInteger(i.qty) ? i.qty : 1,
    priceText: Number.isInteger(i.priceJpy) ? formatJpy(i.priceJpy) : '',
  }));
}

/**
 * 「去结算」按钮的状态与它下面那句话（B36 / AJ-219）。
 *
 * @param {{quoting?: unknown, hasTotal?: unknown, hasError?: unknown}|null|undefined} s
 *   `quoting`  报价在途中（改了数量之后、新合计还没回来）
 *   `hasTotal` 当前 quote 有权威合计（`quote.totalJpy !== null`）
 *   `hasError` 上一次报价失败了
 * @returns {{disabled: boolean, hint: string}} hint 空串 = 不渲染那行提示
 *
 * @why 以前 `checkoutHint` 是**一个写死的常量**"运费与合计还在计算中"，
 *      于是两种完全不同的状态被同一句话盖住：
 *      ① **改了数量、新合计还没回来**——此时页面上显示的合计是**上一次**的，
 *         按钮却还是可点的（旧 quote 还在），点了就带着过期的合计进结算页；
 *      ② **报价失败了**——提示仍说"还在计算中"，而它永远算不出来，
 *         用户只会一直等（@limitation 二说"下一次改动会自然重试"，
 *         但用户不知道要改一下才会重试）。
 *      这两条都是"按钮看起来能用、实际带着错的数据走"，所以按状态分别给话。
 * @why `quoting` 优先于 `hasTotal`：在途时**旧合计已经过期**，
 *      它对应的是改数量之前的那一版——放行等于把过期的 `expected_total_jpy` 带进结算页
 *      （40905 防线会被自己喂一个旧值，而结算页上看不出来）。
 * @limitation 只产出"能不能点 + 说什么"，**不做跳转、不发请求**（约束十一）。
 */
export function checkoutGate(s) {
  const a = s !== null && typeof s === 'object' ? s : {};
  if (a.quoting === true) return { disabled: true, hint: '数量已改，正在重新计算…' };
  if (a.hasError === true) return { disabled: true, hint: '合计未能获取，请稍后重试' };
  if (a.hasTotal === true) return { disabled: false, hint: '' };
  return { disabled: true, hint: '运费与合计还在计算中' };
}
