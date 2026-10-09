/**
 * 职责：订单详情页（`pages/order-detail`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 订单列表只能回答"付没付、多少钱"，详情页要回答的是**"这单到底走到哪了"**——
 *      时间线、运单号、收货地址快照、建单时同意的条款版本。
 *      这些字段里有三个**错了不报错**的：
 *      ① 时间线时刻（UTC 存、JST 显）——错 9 小时没有任何异常；
 *      ② 关税行——`duty_jpy` 是**信息字段**（商品价已含关税），
 *         把它当成"另收一行"会让用户以为被收了两次；
 *      ③ 取消按钮——出现态与契约 `POST /orders/{id}/cancel` 的合法态
 *         （仅 created / pending_payment）不一致时，点了就是一个 40902，
 *         而用户读不懂那是什么。
 *
 * @why 状态词表 / 可付态**不在本文件**：真源在 `utils/order-status.js`（U-H3 下沉），
 *      页面不能 import 页面；两处各写一份的后果是"详情页说能取消、列表页没这按钮"。
 * @why 时间转换也不在 wxml / 页面 js：JST 换算是纯整数运算（`utils/jst-text.js`），
 *      它的跨年 / 跨月 / 闰日边界全有单测——放进页面 js 就一行测试都没有。
 *
 * @limitation 一：**不做 30 分钟倒计时**。倒计时要 `setInterval`（又一个要登记的宿主能力）
 *              + 时钟读数（vm 禁读），骨架期只显示 `expires_at` 的**时刻**；
 *              到期后订单列表会显示"已超时关闭"（服务端过期 job 是权威）。
 * @limitation 二：关税行在 `duty_jpy` 为整数时显示"预估关税（含在商品价内）"——
 *              契约 Order 里它是建单时记下的估值，**信息字段**（D-32 商品价已含关税），
 *              不许显示成"关税：另收"。
 * @limitation 三：`terms_version` 原样展示（如 `TOS-2026-09-20`）。
 *              它是"你当时同意的是哪一版"的唯一凭证，比"已同意"三个字值钱；
 *              链接去法务页（`pages/legal`），不在本页重复入口。
 *
 * @see ../../utils/order-status.js（状态词表与可付/可取消态真源）；
 *      ../../utils/jst-text.js（UTC → JST 纯函数）；
 *      ../../../contracts/api-contract.yaml（Order / POST /orders/{id}/cancel）
 */
import {
  PAYABLE,
  STOCK_REFUND_NOTE,
  buyerStatus,
  canPay,
  statusText,
} from '../../utils/order-status.js';
import {
  displaySubLine,
  formatCnyFen,
  formatJpy,
  formatUsdCents,
} from '../../utils/price-format.js';

/**
 * 买家可见的部分退款行（P2-12，AJ-386；服务端已滤掉 failed、隐去原因与操作人）。
 * @why 按币种用对应的最小单位格式化：退款按**支付币种**记（USD 分 / JPY 円 / CNY 分），
 *      一律按 JPY 显示会把 $12.50 写成 1,250 円。
 * @limitation 认不出的币种不编金额（"以银行账单为准"）——比按错的小数位显示一个数字安全。
 */
const MINOR_FORMATTERS = { USD: formatUsdCents, JPY: formatJpy, CNY: formatCnyFen };
function partialRefundRows(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r !== null && typeof r === 'object')
    .map((r, i) => {
      const fmt = MINOR_FORMATTERS[r.currency];
      const amountText =
        fmt !== undefined && Number.isInteger(r.amount_minor)
          ? fmt(r.amount_minor)
          : `${String(r.currency)}（金额以银行账单为准）`;
      return {
        key: `rf-${i}`,
        amountText,
        statusText: r.status === 'succeeded' ? '已退回' : '退款处理中',
        atText: timeText(r.created_at),
      };
    });
}

const LATE_PAID_NOTE = '我们已收到你的付款，但这张订单已关闭；款项会原路退回，无需重新付款。';
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';
import { addressSummary } from '../../utils/address-form.js';
import { jstDateTimeLabeled } from '../../utils/jst-text.js';
import { orderProgress } from '../../utils/order-progress.js';

/**
 * ISO → 买家可见的 JST 串（**带时区标注**）；解析失败回落原串（数据不能丢，宁可难看）。
 *
 * @why 带"（日本时间）"（MP3-02 / AJ-250）：收货人是美国地址的用户，
 *      不给时区时"请在 22:30 前完成支付"会被读成本地时间（PDT 与 JST 差 16 小时）；
 *      用户以为还有一整天，回来时订单已超时关闭——不会报任何错，只会白丢一单。
 */
function timeText(iso) {
  return jstDateTimeLabeled(iso) ?? (typeof iso === 'string' ? iso : '');
}

/**
 * 「再次购买」出现的状态（A7，AJ-416）：订单已经走完（送达 / 完成）或没买成（取消 / 超时 / 已退款）。
 * @why 进行中的单不给：已付款 / 已发货的单再买一份多半是误点，且会和「确认收货」挤在同一条底栏里。
 */
const BUY_AGAIN_STATUSES = ['delivered', 'completed', 'cancelled', 'expired', 'refunded'];

/**
 * 「再次购买」要放回购物车的条目（A7，AJ-416）。
 * @returns {Array<{productId: string, qty: number, title: string, image: string}>}
 * @why **不带价格**：订单里是当时的成交价，放进购物车当快照会让人以为还是这个价——
 *      价格以购物车重新报价为准（cart-store @limitation 一）。下架的商品照样放回，由报价标出"已下架，请移除"。
 */
export function buyAgainItems(order) {
  const o = order && typeof order === 'object' ? order : {};
  if (!Array.isArray(o.items)) return [];
  return o.items
    .filter((i) => i && typeof i.product_id === 'string' && i.product_id !== '')
    .map((i) => ({
      productId: i.product_id,
      qty: Number.isInteger(i.qty) && i.qty >= 1 ? i.qty : 1,
      title: typeof i.title === 'string' ? i.title : '',
      image: imageUrl(i.image),
    }));
}

/**
 * 行项目（**含单价**：详情页是"这单当时买了什么"的凭据，与结算页"行里不带价格"相反——
 * 那里的价格会过期，这里的是快照，恰恰是它存在的意义）。
 */
export function itemRows(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.product_id === 'string' && i.product_id !== '')
    .map((i) => {
      const hasPrice = Number.isInteger(i.unit_price_jpy);
      const url = imageUrl(i.image);
      return {
        productId: i.product_id,
        title: typeof i.title === 'string' ? i.title : '',
        qty: Number.isInteger(i.qty) ? i.qty : 1,
        unitPriceJpy: hasPrice ? i.unit_price_jpy : null,
        unitPriceText: hasPrice ? formatJpy(i.unit_price_jpy) : '',
        image: url !== '' ? url : PLACEHOLDER_IMAGE,
      };
    });
}

/**
 * 金额行（**不含合计**：合计交给 `ws-price`，@see quote-view.js 同一理由）。
 * @param {unknown} order 契约 `Order`
 */
export function amountLines(order) {
  const o = order && typeof order === 'object' ? order : {};
  const lines = [];
  if (Number.isInteger(o.items_jpy))
    lines.push({ label: '商品合计', value: formatJpy(o.items_jpy) });
  if (Number.isInteger(o.shipping_jpy))
    lines.push({ label: '运费', value: formatJpy(o.shipping_jpy) });
  // @see @limitation 二：关税是信息字段（含在商品价内），不是另收的一行
  if (Number.isInteger(o.duty_jpy)) {
    lines.push({ label: '预估关税（含在商品价内）', value: formatJpy(o.duty_jpy) });
  }
  return lines;
}

/** 时间线行：状态中文 + JST 时刻。 */
export function timelineRows(timeline) {
  if (!Array.isArray(timeline)) return [];
  return (
    timeline
      .filter((t) => t && typeof t.status === 'string' && t.status !== '')
      // ⚠️ `key` 是给 wxml 的 `wx:key` 用的：行里没有一个天然唯一且稳定的字段
      //    （同一状态理论上可能出现两次），`wx:key="index"` 会被开发者工具告警。
      .map((t, i) => ({ key: `tl-${i}`, statusText: statusText(t.status), atText: timeText(t.at) }))
  );
}

/**
 * 「刚刚付过款，但服务端还没确认」的窗口（第三轮审查 MP3-04，P1）。
 *
 * @why 这个窗口是真实存在的：买家在 Stripe 托管页付完款、切回微信**只要几秒**，
 *      而 `checkout.session.completed` 常常还没到。此刻服务端眼里订单仍是"待付款"，
 *      `detailView` 按常规口径会同时给出「继续支付」和「取消订单」——
 *      用户以为刚才没付上，点取消，订单关了、库存还了，钱几秒后才到 → 只能人工退款。
 * @why 判据是 `justPaid`（支付页传来的**事实**）而不是"距 expires_at 还有多久"之类的猜测：
 *      谁刚付过只有支付页知道，从订单数据里推不出来。
 * @limitation 它是**一次性**的假设：状态一旦不再是可付态（服务端确认了）就自动失效；
 *              薄壳最多复核两次，之后放弃这个假设、恢复常规按钮——
 *              "刚刚付过"若为假（其实没付成），不能把人永久锁在确认屏上。
 */
function confirmingJustPaid(payable, justPaid) {
  return justPaid === true && payable;
}

/**
 * `GET /orders/{id}` → 详情页视图。
 * @param {unknown} order 契约 `Order`；也可能是任何东西
 * @param {unknown} [opts] `{ justPaid?: boolean, nowMs?: number }`——刚从支付页过来（MP3-04，见上）；`nowMs` = 当前时刻（截止判定用，不传则不判）。
 *       可选：不传与传脏值都等于"没刚付过"（存量调用方不必改）。
 * @returns 见各字段注释
 */
export function detailView(order, opts = undefined) {
  const o = order && typeof order === 'object' ? order : {};
  const options = opts && typeof opts === 'object' ? opts : {};
  const status = typeof o.status === 'string' ? o.status : '';
  // 截止已过（审查 2026-10-09）：关单作业每分钟才跑一次，到点后最多约 1 分钟状态仍是待付款——
  //   这时给「继续支付」，点进去支付页立刻是关闭屏，自相矛盾。时间由入参给（vm 不读时钟，约束十一）。
  const expiresMs = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : Number.NaN;
  const expired =
    Number.isFinite(options.nowMs) && Number.isFinite(expiresMs) && options.nowMs >= expiresMs;
  const payable = canPay(status) && !expired;
  const confirming = confirmingJustPaid(payable, options.justPaid === true);
  const hasTotal = Number.isInteger(o.total_jpy);
  const trackingNo = typeof o.tracking_no === 'string' ? o.tracking_no.trim() : '';
  const contactEmail = typeof o.contact_email === 'string' ? o.contact_email : '';
  // M-06（AJ-405）：状态区用买家视角词表；时间线仍用 statusText 短词（历史，@see utils/order-status.js BUYER_STATUS @why）
  const buyer = buyerStatus(status, { email: contactEmail !== '' });
  const showPay = payable && !confirming;
  const showCancel = PAYABLE.includes(status) && !confirming && !expired;
  const showConfirmReceipt = status === 'shipped';
  const showBuyAgain = BUY_AGAIN_STATUSES.includes(status);

  return {
    orderId: typeof o.order_id === 'string' ? o.order_id : '',
    orderNo: typeof o.order_no === 'string' ? o.order_no : '',
    statusText: buyer.title,
    /**
     * "下一步会发生什么"（M-06）。确认中（justPaid）不给：pending 的下一步是"请继续支付"，
     * 与"支付结果确认中"的提示正相反——用户刚付过，再引导他付就是第二笔钱（MP3-04 同一条）。
     */
    nextText: confirming
      ? ''
      : expired && canPay(status)
        ? '支付时间已到，订单将自动关闭；如需购买请重新下单'
        : buyer.next,
    // ⚠️ 确认中不给出「继续支付」：用户刚付过一次，再点就是第二笔钱（MP3-04）。
    canPay: showPay,
    /**
     * 可取消态与可付态**故意同源**（PAYABLE，@see utils/order-status.js @limitation 二）：
     * 两边各写一份的话，"能付但取消不了"这种半开状态没有任何测试能抓住。
     * ⚠️ 唯一的例外就是"刚付过款未确认"：那时本地状态仍是可付/可取消，
     *    但取消会把一张可能已付款的单关掉——这一支由 `confirming` 单独排除。
     */
    canCancel: showCancel,
    /** 确认屏：告诉用户"钱在确认中"，而不是让他自己猜刚才付没付上。 */
    confirming,
    confirmHint: confirming ? '支付结果确认中，请稍后刷新' : '',
    /** 薄壳据此退避重查（最多两次，见 vm 的 @limitation）。 */
    needsRecheck: confirming,
    createdAtText: timeText(o.created_at),
    // ⚠️ 截止时刻只在可付时显示（@see @limitation 一：骨架期不做倒计时）
    expiresAtText: payable ? timeText(o.expires_at) : '',
    items: itemRows(o.items),
    amountLines: amountLines(o),
    totalJpy: hasTotal ? o.total_jpy : null,
    /** 只有还能付的单才叫"应付合计"（W-04）；已付 / 已退的单写"应付"会被读成"还要再付"。 */
    totalLabel: payable ? '应付合计' : '订单合计',
    totalSub: displaySubLine(o.display),
    address: o.address !== null && typeof o.address === 'object' ? addressSummary(o.address) : null,
    contactEmail,
    termsVersion: typeof o.terms_version === 'string' ? o.terms_version : '',
    carrier: typeof o.carrier === 'string' ? o.carrier : '',
    trackingNo,
    hasTracking: trackingNo !== '',
    /**
     * 官方查件链接（剩余清单 3-5，服务端按单号形态生成）。小程序不能直接打开外部网页（需业务域名），
     * 所以只给"复制链接"，买家粘贴到浏览器打开。只收 https：防御服务端以外的脏值被当链接复制出去。
     */
    trackingUrl:
      typeof o.tracking_url === 'string' && o.tracking_url.startsWith('https://')
        ? o.tracking_url
        : '',
    timeline: timelineRows(o.timeline),
    /** 只在"已付款、还没发货"时说（剩余清单 4-10）：那是唯一可能因缺货而退款的阶段。 */
    stockRefundNote: status === 'paid' ? STOCK_REFUND_NOTE : '',
    /** 部分退款（P2-12）：成功 / 处理中；服务端已滤掉失败的那几笔。 */
    partialRefunds: partialRefundRows(o.partial_refunds),
    /** 关单后才到的付款（P2-11）：钱已扣，告诉买家会原路退回，别再下一单。 */
    latePaidNote: o.late_paid === true ? LATE_PAID_NOTE : '',
    /**
     * 确认收货（P2-13）：只在已发货时给。拒付中的单服务端回 40902（买家视图不含 has_dispute，不在前端猜）。
     * 不点也没关系：发货满 30 天系统自动签收。
     */
    canConfirmReceipt: showConfirmReceipt,
    /**
     * 底部操作栏出不出现（A2，AJ-416）：三个动作任一可做才出栏。
     * @why 没有动作时也留一条空栏，等于在屏幕底部白占一截，还让人以为"按钮没加载出来"。
     */
    hasActions: showPay || showCancel || showConfirmReceipt || showBuyAgain,
    /** A7（AJ-416）：结束了的单给「再次购买」（同样的商品与数量放回购物车）。 */
    canBuyAgain: showBuyAgain,
    /**
     * 进度条（M-12，AJ-408）：五步 + 终态分支，算法在 utils/order-progress.js（纯函数，逐态单测）。
     * 时间线保留在下方（进度条不带时刻，见 order-progress @tradeoff）。
     */
    progress: orderProgress(o),
  };
}
