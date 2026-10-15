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
 * @limitation 二：关税在 `duty_jpy` 为整数时于合计下方说"其中预估关税 X（已含在商品价内）"（MP-11 起不再与
 *              商品合计 / 运费并列成一行）——契约 Order 里它是建单时记下的估值，**信息字段**（D-32 商品价已含关税），
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
  ORDER_NOT_FOUND_TEXT,
  PAYABLE,
  STOCK_REFUND_NOTE,
  buyerStatus,
  canPay,
  disputeStatus,
  timelineText,
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
// 审计 CPY-08：人民币带「人民币」三字（D-36：裸 ¥ 紧挨日元金额会被读成日元，见 price-format displaySubLine）
const MINOR_FORMATTERS = {
  USD: formatUsdCents,
  JPY: formatJpy,
  CNY: (fen) => `人民币 ${formatCnyFen(fen)}`,
};
function partialRefundRows(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r !== null && typeof r === 'object')
    .map((r, i) => {
      const fmt = MINOR_FORMATTERS[r.currency];
      const amountText =
        fmt !== undefined && Number.isInteger(r.amount_minor)
          ? fmt(r.amount_minor)
          : typeof r.currency === 'string' && r.currency !== ''
            ? `${r.currency}（金额以银行账单为准）`
            : '金额以银行账单为准';
      return {
        key: `rf-${i}`,
        amountText,
        statusText: r.status === 'succeeded' ? '已退回' : '退款处理中',
        atText: timeText(r.created_at),
      };
    });
}

const LATE_PAID_NOTE = '我们已收到你的付款，但这张订单已关闭；款项会原路退回，无需重新付款。';

/**
 * 迟到付款要在**顶部**说的状态（OPS-4，第二轮审计 2026-10-11）：订单已关闭、钱还没退。
 * @why 原先这两态顶部的下一步是"如需购买请重新下单"、底栏给「再次购买」，页底却说"无需重新付款"——
 *      同一屏两种相反的指引，买家可能再付一笔，然后等两笔里的一笔退回来。
 *      关闭态把说明提到顶部（替换那句"请重新下单"）、收起「再次购买」；退款中 / 已退款讲的是钱的进度，说明留在页底。
 */
const LATE_PAID_TOP_STATUSES = ['expired', 'cancelled'];

/**
 * 取消 / 确认收货失败后的去向（MP-7，第二轮审计 2026-10-11）。
 * @why 40902（状态已变）/ 40904（已过期）说明的是"页面上的按钮已经过期"——错误码注册表给的动作就是"刷新订单"。
 *      原先只摆出服务端原文"订单状态不允许此操作"、按钮原样留着，再点还是同一个错。改为重取订单 + 一句人话。
 * @why 40902 的话留了"如仍无法操作请联系客服"：确认收货遇到拒付冻结也是 40902（reason 不下发给买家），
 *      重取后按钮还在——只说"已刷新"会让人以为再点一次就好。
 * @limitation 其余错误（网络 / 5xx / 拉黑）不接管，仍走页面的通用错误态。
 * @param {unknown} err 请求封装抛出的错误
 * @returns {{reload: boolean, note: string}}
 */
const ACTION_STALE_NOTES = {
  40902: '订单状态有更新，已为你刷新到最新状态；如仍无法操作，请联系客服',
  40904: '订单已超过支付时间，已为你刷新到最新状态',
};
export function actionFailure(err) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  const hit =
    Number.isInteger(code) && Object.prototype.hasOwnProperty.call(ACTION_STALE_NOTES, code);
  return hit ? { reload: true, note: ACTION_STALE_NOTES[code] } : { reload: false, note: '' };
}
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';
import { dutyNoteText } from '../../utils/quote-view.js';
import { addressSummary } from '../../utils/address-form.js';
import { jstDateTimeLabeled } from '../../utils/jst-text.js';
import { orderProgress } from '../../utils/order-progress.js';
import { AFTER_SALE_ORDER_STATUSES, afterSaleCard } from '../../utils/after-sale.js';

/**
 * ISO → 买家可见的 JST 串（**带时区标注**）；解析不出来 → 空串（页面那一行不显示）。
 *
 * @why 带"（日本时间）"（MP3-02 / AJ-250）：收货人是美国地址的用户，
 *      不给时区时"请在 22:30 前完成支付"会被读成本地时间（PDT 与 JST 差 16 小时）；
 *      用户以为还有一整天，回来时订单已超时关闭——不会报任何错，只会白丢一单。
 *
 * @why 解析不出来时**不回落原串**（审计 CPY-03）：原串（`2026-09-27T15:04:26.000Z`、
 *      乃至 `soon` 这种脏值）换没换算过、带不带时区全看服务端那天给什么，
 *      而页面上每一行时刻旁边都写着"下单时间 / 截止"——摆出来的就是一个**没标注时区的时间**，
 *      正是上面那条要防的事。`pages/order/index.vm.js` 与 `utils/after-sale.js` 都是 `?? ''`，
 *      这里跟着同一口径：换不出来就不显示，而不是显示一个可能读错的值。
 * @limitation 只影响"服务端给了解析不了的时刻"这一支（脏数据 / 契约变更），正常数据不走这里。
 */
function timeText(iso) {
  return jstDateTimeLabeled(iso) ?? '';
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
 * 金额行（**不含合计、不含关税**：合计交给 `ws-price`，@see quote-view.js 同一理由；关税见 `dutyNote`）。
 * @param {unknown} order 契约 `Order`
 */
export function amountLines(order) {
  const o = order && typeof order === 'object' ? order : {};
  const lines = [];
  if (Number.isInteger(o.items_jpy))
    lines.push({ label: '商品合计', value: formatJpy(o.items_jpy) });
  if (Number.isInteger(o.shipping_jpy))
    lines.push({ label: '运费', value: formatJpy(o.shipping_jpy) });
  return lines;
}

/**
 * 关税说明（MP-11）：合计下方一句；`duty_jpy` 不是整数（null = 无法估算）→ 空串，不显示。
 * @see @limitation 二：关税是信息字段（含在商品价内），不是另收的一笔；句子与购物车 / 结算页同源（quote-view.js）
 * @param {unknown} order 契约 `Order`
 */
export function dutyNote(order) {
  const o = order && typeof order === 'object' ? order : {};
  return Number.isInteger(o.duty_jpy) ? dutyNoteText(o.duty_jpy) : '';
}

/**
 * 取订单失败是不是"订单不存在"（40400，全入口点击测试 2026-10-11）。
 * @why 原先"请求的资源不存在"+ 40400 + 「重试」——重试一万次也一样；改为说人话、按钮去订单列表、不出错误码（同支付页）。
 * @param {unknown} err
 * @returns {{notFound: boolean, error?: string, errorRef?: string}} 喂给 setData；不是 40400 时只给 notFound:false
 */
export function orderNotFound(err) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  if (code !== 40400) return { notFound: false };
  return { notFound: true, error: ORDER_NOT_FOUND_TEXT, errorRef: '' };
}

/**
 * 时间线行：事件词（`TIMELINE_LABELS`）+ JST 时刻。
 * @why 后面已有「付款成功」时丢掉「发起支付」行（全入口点击测试 2026-10-11）：两行相隔约 1 秒，付成了之后对买家没有信息；
 *      没付成时保留——那时它说明"支付发起过、还没完成"。
 */
export function timelineRows(timeline) {
  if (!Array.isArray(timeline)) return [];
  const rows = timeline.filter((t) => t && typeof t.status === 'string' && t.status !== '');
  return (
    rows
      .filter(
        (t, i) =>
          t.status !== 'pending_payment' || !rows.slice(i + 1).some((n) => n.status === 'paid'),
      )
      // ⚠️ `key` 是给 wxml 的 `wx:key` 用的：行里没有一个天然唯一且稳定的字段
      //    （同一状态理论上可能出现两次），`wx:key="index"` 会被开发者工具告警。
      .map((t, i) => ({
        key: `tl-${i}`,
        statusText: timelineText(t.status),
        atText: timeText(t.at),
      }))
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
 * 有售后申请时状态区的"下一步"（三端联动模拟 2026-10-10）。
 * @why 已送达 / 已完成的提示是"可以申请售后"——申请过还这么说，与正下方的售后卡片（"处理中"）打架，
 *      买家会以为上次没提交成功。只在售后卡片认出了申请（`current` 非空）时接管，其余照旧走订单状态。
 * @param {string} status 订单状态：只在 AFTER_SALE_ORDER_STATUSES（发货后三态）接管
 * @returns {string|null} null = 不接管
 */
function afterSaleNext(card, status) {
  // 只在发货后三态接管（严格检查 2026-10-10）：退款中 / 已退款讲钱的进度更要紧，且没有申请入口；与列表同口径
  if (card.current === null || !AFTER_SALE_ORDER_STATUSES.includes(status)) return null;
  return card.current.open
    ? '售后申请处理中，处理结果会在本页回复。'
    : '售后已有处理结果（见下方）；还有问题可以再次申请。';
}

/**
 * `GET /orders/{id}` → 详情页视图。
 * @param {unknown} order 契约 `Order`；也可能是任何东西
 * @param {unknown} [opts] `{ justPaid?: boolean, recheckGaveUp?: boolean, nowMs?: number }`——刚从支付页过来（MP3-04，见上）；
 *       `recheckGaveUp` = 薄壳重查两次仍未确认、已放弃 justPaid 假设；`nowMs` = 当前时刻（截止判定用，不传则不判）。
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
  // 审计 BUG-001（2026-10-15）：售后 7 天窗口要拿"现在"跟完成时刻比；时刻由入参给（vm 不读时钟，约束十一），
  //   没给就不判——与服务端"completed_at 为空不拦"同口径，证据不足时不静默关掉入口。
  const afterSale = afterSaleCard(o, options.nowMs);
  // 审计 BUG-09（2026-10-14）：售后进行中不给确认收货（服务端同样拒 40902 after_sale_open）
  const showConfirmReceipt = status === 'shipped' && afterSale.current?.open !== true;
  // OPS-4：迟到付款的关闭单（钱还没退）不给「再次购买」，说明提到顶部
  const latePaidTop = o.late_paid === true && LATE_PAID_TOP_STATUSES.includes(status);
  const showBuyAgain = BUY_AGAIN_STATUSES.includes(status) && !latePaidTop;
  const dispute = disputeStatus(o.payment_dispute, o.status);

  return {
    orderId: typeof o.order_id === 'string' ? o.order_id : '',
    orderNo: typeof o.order_no === 'string' ? o.order_no : '',
    // AJ-500：拒付期间状态与下一步都换成拒付的话（不再说"日本采购中"）
    statusText: dispute?.title ?? buyer.title,
    /**
     * "下一步会发生什么"（M-06）。确认中（justPaid）不给：pending 的下一步是"请继续支付"，
     * 与"支付结果确认中"的提示正相反——用户刚付过，再引导他付就是第二笔钱（MP3-04 同一条）。
     */
    nextText: confirming
      ? ''
      : dispute !== null
        ? dispute.next
        : latePaidTop
          ? LATE_PAID_NOTE
          : expired && canPay(status)
            ? '支付时间已到，订单将自动关闭；如需购买请重新下单'
            : (afterSaleNext(afterSale, status) ?? buyer.next),
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
    /**
     * 确认屏的提示；重查两次仍未确认（`recheckGaveUp`）后按钮已还给用户，但要说清"可能只是还没到账"——
     * 统一结论 5.3：原先放弃后直接恢复「继续支付」、一句话都不说，用户只会以为没付上、再付一次。
     * （同通道再点「继续支付」服务端复用同一个付款链接，已付过的会话付不了第二次——pay-intent.ts 第 4 步；这句话防的是人先慌。）
     */
    confirmHint: confirming
      ? '支付结果确认中，请稍后刷新'
      : options.recheckGaveUp === true && payable
        ? '还没收到付款结果。若刚才已完成付款，到账可能要几分钟，请勿重复付款，稍后下拉刷新查看'
        : '',
    /** 薄壳据此退避重查（最多两次，见 vm 的 @limitation）。 */
    needsRecheck: confirming,
    createdAtText: timeText(o.created_at),
    // ⚠️ 截止时刻只在可付时显示（@see @limitation 一：骨架期不做倒计时）；
    //    确认中（刚付过）也不显示（F1，第二轮审计 2026-10-11）：刚付过的人读到"请在…前完成支付"会以为没付上
    expiresAtText: payable && !confirming ? timeText(o.expires_at) : '',
    // 全入口点击测试 2026-10-11：剩余分钟（买家在美国，只给日本时间的截止时刻要自己换算）；向上取整，不出现"0 分钟"
    //   时间到了（≤0）不写"请在 0 / -3 分钟内"，交给薄壳重取（服务端会关单）
    payLeftText:
      payable &&
      !confirming &&
      Number.isFinite(options.nowMs) &&
      Number.isFinite(expiresMs) &&
      expiresMs > options.nowMs
        ? `请在 ${String(Math.ceil((expiresMs - options.nowMs) / 60_000))} 分钟内完成支付`
        : '',
    items: itemRows(o.items),
    amountLines: amountLines(o),
    /** MP-11：关税说明（合计下方一句；空串 = 不显示）。 */
    dutyNote: dutyNote(o),
    totalJpy: hasTotal ? o.total_jpy : null,
    /**
     * 只有还能付的单才叫"应付合计"（W-04）；已付 / 已退的单写"应付"会被读成"还要再付"。
     * 确认中同理（F1）：钱可能已经付了，只是还没确认下来。
     */
    totalLabel: payable && !confirming ? '应付合计' : '订单合计',
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
    /**
     * 查件引导（第 24 项，2026-10-10）：小程序里打不开外部网页，复制之后要去手机浏览器——原先只写"点运单号复制"，没说下一步。
     * @why 不写"也可以去 USPS 查"之类：那是没实测过的外部事实（约束十），说错了买家会去一个查不到的地方。
     */
    trackingHint:
      typeof o.tracking_url === 'string' && o.tracking_url.startsWith('https://')
        ? '点「复制查件链接」，在手机浏览器（Safari / Chrome）里粘贴打开——是承运商官网的查件页'
        : '点运单号旁的「复制」，到承运商官网粘贴查询',
    timeline: timelineRows(o.timeline),
    /**
     * 改地址的出路（联动走查·熟手买家 2026-10-10）：只在"已付款、还没发货"时说。
     * @why 买家端没有自助改址（管理端有「改址」，发货前可改）；付款后发现地址写错的买家在页面上找不到任何说法，
     *      不知道还能不能改、找谁改。待付款的单可以取消重下，已发货的改不了，所以只在 paid 说。
     */
    addressChangeHint:
      status === 'paid' ? '发货前需要改地址，请联系客服并提供订单号；发货后无法更改。' : '',
    /** 只在"已付款、还没发货"时说（剩余清单 4-10）：那是唯一可能因缺货而退款的阶段。 */
    stockRefundNote: status === 'paid' ? STOCK_REFUND_NOTE : '',
    /** 部分退款（P2-12）：成功 / 处理中；服务端已滤掉失败的那几笔。 */
    partialRefunds: partialRefundRows(o.partial_refunds),
    /**
     * 关单后才到的付款（P2-11）：钱已扣，告诉买家会原路退回，别再下一单。
     * 关闭态已在顶部下一步说过（OPS-4），页底不再重复。
     */
    latePaidNote: o.late_paid === true && !latePaidTop ? LATE_PAID_NOTE : '',
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
    progress:
      dispute === null
        ? orderProgress(o)
        : { ...orderProgress(o), branch: { status: 'dispute', title: dispute.title } },
    /**
     * 售后卡片（AJ-420）：已发货 / 已签收 / 已完成的单给「申请售后」入口；有申请时显示最新一条的进度与处理说明。
     * 不放进底栏：底栏已有确认收货 / 再次购买，售后是"出了问题才找"的低频入口。
     */
    afterSale,
  };
}

/**
 * 交给售后申请页的订单摘要（全入口点击测试 2026-10-11）。
 * @why 售后申请页原先不显示是哪一单 / 哪件商品，买家会怀疑点错了单；主流售后页顶部都有商品缩略图 + 订单号。
 *      由详情页交过去（`app.globalData.afterSaleBrief`，读走即清），售后页不另发请求。
 * @param {string} orderId 内部订单 id（售后页据此认领，别的单留下的不用）
 * @param {unknown} view `detailView` 的输出
 * @returns {{orderId: string, orderNo: string, title: string, moreText: string, image: string}|null} 没有商品 → null
 */
export function afterSaleBrief(orderId, view) {
  const v = view !== null && typeof view === 'object' ? view : {};
  const items = Array.isArray(v.items) ? v.items : [];
  if (items.length === 0) return null;
  const first = items[0] ?? {};
  return {
    orderId,
    orderNo: typeof v.orderNo === 'string' ? v.orderNo : '',
    title: typeof first.title === 'string' ? first.title : '',
    // 种数不是件数（规律排查 2026-10-12；与订单列表"等 N 种商品"同口径）
    moreText: items.length > 1 ? `等 ${String(items.length)} 种商品` : '',
    image: typeof first.image === 'string' ? first.image : '',
  };
}
