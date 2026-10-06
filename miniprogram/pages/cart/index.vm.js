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
 * @param {{quoting?: unknown, hasTotal?: unknown, hasError?: unknown,
 *          errorCode?: unknown, splitRequired?: unknown}|null|undefined} s
 *   `quoting`       报价在途中（改了数量之后、新合计还没回来）
 *   `hasTotal`      当前 quote 有权威合计（薄壳传 `hasTotal(quote)`）
 *   `hasError`      上一次报价失败了
 *   `errorCode`     失败的业务错误码（MP3-09：区分"重试就好"与"必须改购物车"）
 *   `splitRequired` 服务端 `split_hint`：**已超过**单笔上限（B38 / AJ-221）
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
/**
 * 「重试也没用」的报价失败码（MP3-09）。
 *
 * @why 这三个码的共同点是：**服务端不会自己变好**，只有用户改了购物车才会变——
 *      商品下架（40401）不会重新上架、超重（40912）与超金额上限（40906）不会自己变轻。
 *      对它们说"请稍后重试"是把用户按在一个永远不会成功的动作上：
 *      错误条上明明写着"请拆单"，按钮下却写着"稍后重试"，两句话方向相反。
 * @why 库存不足（40901）**不**在里面：库存会被别人的取消回补，重试是真的可能成功的。
 *      @tradeoff 分错类的代价是"多等一次"，把 40901 归进来则是"明明能成却拦住"——后者更糟。
 */
const MUST_CHANGE_CART = new Set([40401, 40906, 40912]);

/** 报价失败提示：区分"稍后重试就好"与"必须改购物车"（MP3-09）。 */
export function quoteErrorHint(code) {
  return MUST_CHANGE_CART.has(code)
    ? '报价未通过，请调整数量或移除商品'
    : '合计未能获取，请稍后重试';
}

export function checkoutGate(s) {
  const a = s !== null && typeof s === 'object' ? s : {};
  if (a.quoting === true) return { disabled: true, hint: '数量已改，正在重新计算…' };
  // ⚠️ 失败提示要看**码**：确定性失败（下架 / 超重 / 超上限）说"稍后重试"是句谎话（MP3-09）
  if (a.hasError === true) return { disabled: true, hint: quoteErrorHint(a.errorCode) };
  // B38 / AJ-221：已超单笔上限 → 结算页会 40906，在购物车就把入口关掉
  // （让用户在**能改数量**的这一页解决，而不是跳过去再被弹回来）
  if (a.splitRequired === true) return { disabled: true, hint: '已超过单笔上限，请分两单下单' };
  if (a.hasTotal === true) return { disabled: false, hint: '' };
  return { disabled: true, hint: '运费与合计还在计算中' };
}

/** 能定位到某一件的报价失败码 → 那一行的提示（剩余清单 4-7）。 */
const INVALID_TEXT = {
  40401: '已下架或不存在，请移除',
  40901: '库存不足，请减少数量',
};

/**
 * 报价失败时标出是哪一件（剩余清单 4-7 / M10）：服务端在错误响应 `data.product_id` 里指出那一件。
 * @why 购物车里五件商品、报价回"商品不存在或已下架"，用户只能逐件删掉试；标出那一行，一步就能改对。
 * @why 拿不到 id、码不认识、id 不在车里 → **清空**所有标记，不猜：标错一行比不标更糟（用户会删掉一件好好的商品）。
 * @returns {Array} 新的行数组（每行带 `invalidText`，空串 = 不标）
 */
export function markInvalid(rows, productId, code) {
  const list = Array.isArray(rows) ? rows : [];
  const text = INVALID_TEXT[code];
  const hit =
    typeof productId === 'string' &&
    text !== undefined &&
    list.some((r) => r.productId === productId);
  return list.map((r) => ({ ...r, invalidText: hit && r.productId === productId ? text : '' }));
}
