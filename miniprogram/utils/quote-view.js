/**
 * 职责：`POST /orders/quote` 响应 → **报价区视图**（共享层；购物车页与确认订单页都用）。
 *
 * @why 从 `pages/cart/index.vm.js` 下沉到这里：确认订单页也要渲染同一块报价区，
 *      从购物车页 `import` 过去会成为"页面依赖页面"——哪天购物车页改了结构，
 *      确认页跟着崩，而崩的地方离改动隔着两个页面。
 *      报价区是**共享视图**，不是购物车页的私有逻辑。
 *
 * @why 这里的判断全是"错了不报错"的：
 *      ① 合计缺失 → 不能把 `null` 塞给 `ws-price`（它对非整数**响亮失败**：空白 + 控制台报错）；
 *      ② 关税在估值都没有时显示"—" → 用户会读成"没算关税 = 不收关税"。
 *
 * @limitation 一：对**缺字段降级**：运费/合计缺失只影响对应行，不让整个报价区消失
 *              （AJ-108 浏览降级同一条原则；报价失败由页面错误态管）。
 * @limitation 二：关税行只在 `duty_estimate === true` 且 `duty_jpy` 为整数时显示——
 *              契约明说它是**信息字段**（D-32：商品价已含关税），估值都没有时
 *              显示"关税：—"只会让用户以为"没算关税 = 不收关税"。
 *
 * @see ./price-format.js（金额格式化与副行）；../../../contracts/api-contract.yaml（Quote）
 */
import { displaySubLine, formatJpy } from './price-format.js';

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
   *      把判断留在可测的纯函数里更安全。
   */
  return { lines, hasTotal, totalJpy, totalText, totalSub, hints };
}
