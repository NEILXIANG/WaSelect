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
 * @limitation 二：关税说明只在 `duty_estimate === true` 且 `duty_jpy` 为整数时显示——
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
 *            totalJpy: number|null, totalText: string, totalSub: string, hints: Array<string>,
 *            splitRequired: boolean}}
 *          `splitRequired` = 服务端的 `split_hint`（**已超**单笔上限）。
 *          @why 单独给一个布尔而不是让页面去读 `split_hint`：它是**提交闸门的输入**
 *          （超了就不能提交，B38 / AJ-221），让调用方自己解析同一个字段会导致
 *          "有的地方拦、有的地方不拦"。
 */
/**
 * 关税说明句（MP-11，第二轮审计 2026-10-11）：放在合计**下方**，不与商品合计 / 运费并列成一行。
 * @why 并列成第三行时"商品 + 运费 + 关税"三行相加 ≠ 合计——标签写着"含在商品价内"，版式却在说"这是另一笔"，
 *      买家会以为算错或被多收。改成"其中…"一句，读法与数字关系一致。
 * @why 购物车 / 结算页（本文件 hints）与订单详情（order-detail vm `dutyNote`）共用这一句，两处说法不会漂移。
 * @param {number} jpy 整数円（调用方先判 Number.isInteger）
 */
export function dutyNoteText(jpy) {
  return `其中预估关税 ${formatJpy(jpy)}（已含在商品价内）`;
}

export function quoteView(quote) {
  const q = quote && typeof quote === 'object' ? quote : {};
  const lines = [];
  if (Number.isInteger(q.items_jpy))
    lines.push({ label: '商品合计', value: formatJpy(q.items_jpy) });
  if (Number.isInteger(q.shipping_jpy))
    lines.push({ label: '运费', value: formatJpy(q.shipping_jpy) });
  const hasTotal = Number.isInteger(q.total_jpy);
  const totalJpy = hasTotal ? q.total_jpy : null;
  const totalText = hasTotal ? formatJpy(q.total_jpy) : '';
  const totalSub = displaySubLine(q.display);

  const hints = [];
  // @see @limitation 二（关税只是信息字段）；MP-11：说明在合计下方的第一句
  if (q.duty_estimate === true && Number.isInteger(q.duty_jpy)) {
    hints.push(dutyNoteText(q.duty_jpy));
  }
  if (Number.isInteger(q.free_shipping_remaining_jpy) && q.free_shipping_remaining_jpy > 0) {
    hints.push(`再买 ${formatJpy(q.free_shipping_remaining_jpy)} 免运费`);
  }
  if (q.split_hint === true) {
    // B38 / AJ-221：⚠️ 服务端 `splitHint` 是 `total > maxOrderJpy`——**已经超了**，
    // 旧文案写"接近上限，建议拆成两单"是**把既成事实写成提醒**，还放行提交，
    // 于是用户提交必然吃 40906。措辞必须说"已超过"，且页面必须**不放行**（见 splitRequired）。
    // ⚠️ 不提"申报"：为规避申报而拆单的措辞有审核与合规敏感性，只说"单笔上限"。
    hints.push('已超过单笔上限，请分两单下单');
  }
  /**
   * `hasTotal` 是给 wxml 的开关：合计交给 `ws-price`（口径组件），
   * 而它对非整数会**响亮失败**（空白 + 控制台报错）——那是"报价缺字段"时不该付的代价。
   * @why 不由 wxml 自己写 `!== null` 判断：WXML 表达式的能力边界各家写法不一，
   *      把判断留在可测的纯函数里更安全。
   */
  return {
    lines,
    hasTotal,
    totalJpy,
    totalText,
    totalSub,
    hints,
    splitRequired: q.split_hint === true,
  };
}
