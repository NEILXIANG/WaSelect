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
 * @limitation 一：`quoteView` 对**缺字段降级**：运费/合计缺失只影响对应行，
 *              不让整个报价区消失（AJ-108 浏览降级同一条原则；报价失败由页面错误态管）。
 * @limitation 二：关税行只在 `duty_estimate=true` 且 `duty_jpy` 为整数时显示——
 *              契约明说它是**信息字段**（D-32：商品价已含关税），估值都没有时
 *              显示"关税：—"只会让用户以为"没算关税 = 不收关税"。
 *
 * @see ../../utils/cart-store.js（本地状态真源与"快照价红线"）；
 *      contracts/api-contract.yaml（Quote / OrderItemsInput 形状）
 */

import { formatJpy } from '../../utils/price-format.js';
import { displaySubLine } from '../../utils/price-format.js';

/**
 * 本地条目 → 行视图。
 * @param {Array} items cart-store 的条目（含快照）
 * @returns {Array<{productId: string, title: string, image: string, qty: number, priceText: string}>}
 * @why `priceText` 在这里格式化而不是 wxml 里塞 ws-price：快照价**可能**不是整数
 *      （旧版本写入的脏数据），`ws-price` 对非整数会响亮失败 = 整行空白；
 *      快照价只是参考信息，不值得为它炸掉一行——非整数就**不显示**（降级同 @limitation 一）。
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
 * Quote 响应 → 报价区视图。
 * @param {unknown} quote 契约 `Quote`；null/undefined = 还没报价（调用方不渲染报价区）
 * @returns {{lines: Array<{label: string, value: string}>, hasTotal: boolean,
 *            totalJpy: number|null, totalText: string, totalSub: string, hints: Array<string>}}
 */
export function quoteView(quote) {
  const q = quote && typeof quote === 'object' ? quote : {};
  const lines = [];
  if (Number.isInteger(q.items_jpy))
    lines.push({ label: '商品合计', value: formatJpy(q.items_jpy) });
  if (Number.isInteger(q.shipping_jpy))
    lines.push({ label: '运费', value: formatJpy(q.shipping_jpy) });
  // @see @limitation 二（关税只是信息字段）
  if (q.duty_estimate === true && Number.isInteger(q.duty_jpy)) {
    lines.push({ label: '预估关税（含在商品价内）', value: formatJpy(q.duty_jpy) });
  }
  const hasTotal = Number.isInteger(q.total_jpy);
  const totalJpy = hasTotal ? q.total_jpy : null;
  const totalText = hasTotal ? formatJpy(q.total_jpy) : '';
  const totalSub = displaySubLine(q.display);

  const hints = [];
  if (Number.isInteger(q.free_shipping_remaining_jpy) && q.free_shipping_remaining_jpy > 0) {
    hints.push(`再买 ${formatJpy(q.free_shipping_remaining_jpy)} 免运费`);
  }
  if (q.split_hint === true) {
    hints.push('单笔金额接近出口申报上限，建议拆成两单');
  }
  /**
   * `hasTotal` 是给 wxml 的开关：合计交给 `ws-price`（口径组件），
   * 而它对非整数会**响亮失败**（空白 + 控制台报错）——那是"报价缺字段"时不该付的代价。
   * @why 不由 wxml 自己写 `!== null` 判断：WXML 表达式的能力边界各家写法不一，
   *      把判断留在 vm（可测）更安全。
   */
  return { lines, hasTotal, totalJpy, totalText, totalSub, hints };
}
