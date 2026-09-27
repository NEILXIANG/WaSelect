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
