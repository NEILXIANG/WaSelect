/**
 * 职责：订单状态文案的**唯一真源**（共享层；订单列表页与订单详情页都用）。
 *
 * @why 从 `pages/order/index.vm.js` 下沉到这里（U-H3）：详情页也要把 `OrderStatus`
 *      十态翻成中文，而**页面不能 import 页面**——从列表页 import 过去会成为
 *      "页面依赖页面"，哪天列表页改了结构，详情页跟着崩。
 *      状态文案是共享口径，不是列表页的私有逻辑（@see ./quote-view.js 同一条下沉理由）。
 *
 * @why 状态文案是**最容易两处漂移**的东西：契约有 10 态（`OrderStatus`），
 *      服务端按态流转，前端按态显示中文与"能不能继续付"。
 *      写死在 wxml 里的后果是：加一个状态要动 wxml 十处 `wx:if`，
 *      漏掉的那处表现为"这个状态的订单显示成空白"。
 *
 * @limitation 一：状态词表**与契约双向比对**（`order-status.unit.test.ts` 里从 yaml 抽 enum 校验）。
 *              缺了那条比对，服务端新增一个状态后前端会静默走 `unknown` 分支。
 * @limitation 二：`PAYABLE` 只认 `created` / `pending_payment`——
 *              与契约 `POST /orders/{id}/cancel` 的可取消态**故意一致**：
 *              两个"这个订单还能操作吗"的判断若不一致，
 *              表现为"能付但取消不了"这种说不清的半开状态。
 *
 * @see ../../contracts/api-contract.yaml（OrderStatus）；../pages/order/index.vm.js（第一个消费方）
 */

/**
 * `OrderStatus` 十态 → 展示文案。
 * @why **全部列出**（不靠 default 兜底）：兜底会让"新增状态"静默变成一个通用词，
 *      而订单上一个看不懂的状态词，等于告诉用户"我们也不知道这单怎么了"。
 *      @see @limitation 一（单测与契约比对，漏一个就红）
 */
export const STATUS_LABELS = {
  created: '待付款',
  pending_payment: '付款中',
  paid: '已付款',
  shipped: '已发货',
  delivered: '已送达',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已超时关闭',
  refunding: '退款中',
  refunded: '已退款',
};

/**
 * M-06（AJ-405 / AJ-402 Q4）：**买家视角**的当前状态文案 + "下一步会发生什么"。
 *
 * @why 与 `STATUS_LABELS` 分开两张表：`STATUS_LABELS` 是**历史**词（时间线"那时发生了什么"），
 *      这张是**现在**（状态区 / 列表行）。时间线若也用"已付款 · 日本采购中"，一张早已发货的单
 *      在时间线里还挂着"采购中"，读起来像卡住了——正是 M-06 要消除的误读。
 * @why 每一句"下一步"都要能对上已定的业务事实（出处）：
 *      created / pending_payment：超时关单（expire-orders，30 分钟窗口由服务端定，这里不写数字）；
 *      paid：代购模式（STOCK_REFUND_NOTE 同一事实）；发货邮件含承运商与运单号（mail-templates.ts `order.shipped`，AJ-369）；
 *      shipped：确认收货 + 到期自动签收（AJ-387 / auto-fulfilment.ts；天数是配置 AUTO_DELIVER_DAYS，**不写死**）；
 *      delivered：签收可能是"按时间推定"（auto-fulfilment @limitation 一），所以给"实际没收到"的出口；
 *      refunding / refunded：原路退回、5–10 个工作日（与 STOCK_REFUND_NOTE、退款邮件同口径）。
 * @why **不写送达天数**：EMS 时效未实测（AJ-402 Q2），写错的承诺比不写更糟。
 * @limitation 一：买家词表与管理端词表各一份（视角不同，允许不同）；收进 `packages/shared` 是 P1（对标分析 §3.7）。
 * @limitation 二：`paid` 的"会发邮件"只在调用方**确知**留了邮箱时出现（详情页有 contact_email；
 *              列表行 OrderSummary 没有这个字段，只能说"在订单详情查看"）。
 * @why `next` 是**详情页**口径、`nextInList` 是**列表**口径（统一结论 5.3）：详情页再说"在订单详情里…"是自指；
 *      列表行没有复制运单号 / 确认收货 / 申请售后，照搬详情页的话是叫人去找不存在的按钮。没写 `nextInList` 的状态两处同一句。
 * @limitation 三：发货时限 N（ship_within_business_days）只随**商品详情**下发，Order 里没有——
 *              所以"已付款"这里不写"N 个工作日内发出"；要写需给 Order 加字段（契约变更，未做，见 AJ-405）。
 */
export const BUYER_STATUS = {
  created: { title: '待付款', next: '请在截止时间前完成支付，超时订单会自动关闭。' },
  pending_payment: {
    title: '付款中',
    next: '如果已经完成付款，系统确认后这里会更新；还没付的话，请在截止时间前继续支付。',
  },
  paid: {
    title: '已付款 · 日本采购中',
    next: '我们正在日本为你采购，发出后会在本页显示承运商和运单号。',
    nextInList: '我们正在日本为你采购，发出后可在订单详情查看承运商和运单号。',
    nextWithEmail: '我们正在日本为你采购，发出后会发邮件告知承运商和运单号。',
  },
  shipped: {
    title: '已发货 · 国际运输中',
    next: '包裹已从日本发出，可复制运单号查件。收到后请点「确认收货」；没点的话，系统会在发货一段时间后自动确认。',
    nextInList:
      '包裹已从日本发出。查件、确认收货请进订单详情；没确认的话，系统会在发货一段时间后自动确认。',
  },
  delivered: {
    title: '已送达',
    next: '如果实际没有收到，或商品有问题，可以申请售后，处理结果会在本页回复。',
    nextInList: '如果实际没有收到，或商品有问题，可进订单详情申请售后。',
  },
  completed: {
    title: '已完成',
    next: '订单已完成。商品有问题可以申请售后。',
    nextInList: '订单已完成。商品有问题可进订单详情申请售后。',
  },
  cancelled: { title: '已取消', next: '订单已取消，需要的话可以重新下单。' },
  expired: { title: '已超时关闭', next: '超过支付时间，订单已自动关闭；需要的话可以重新下单。' },
  refunding: {
    title: '退款中',
    next: '退款处理中，完成后原路退回到你的付款方式，到账通常需要 5–10 个工作日，以银行为准。',
  },
  refunded: {
    title: '已退款',
    next: '款项已原路退回到你的付款方式，到账通常需要 5–10 个工作日，以银行为准。',
  },
};

/** 未知状态：不留空白（同 statusText 的口径），并给一个出口。 */
const UNKNOWN_BUYER_STATUS = { title: '状态未知', next: '如有疑问，请联系客服并提供订单号' };

/**
 * 状态 → 买家视角 `{title, next}`（M-06）。
 * @param {unknown} status 契约 `OrderStatus`；也可能是任何东西
 * @param {{email?: boolean, inList?: boolean}} [opts] `inList: true` = 订单列表行（用列表口径）；`email: true` = 确知这张单留了联系邮箱（@see BUYER_STATUS @limitation 二）
 * @returns {{title: string, next: string}}
 */
export function buyerStatus(status, opts = undefined) {
  const s = typeof status === 'string' ? status : '';
  const b = Object.prototype.hasOwnProperty.call(BUYER_STATUS, s) ? BUYER_STATUS[s] : null;
  if (b === null) return { ...UNKNOWN_BUYER_STATUS };
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  if (o.inList === true && b.nextInList) return { title: b.title, next: b.nextInList };
  return { title: b.title, next: o.email === true && b.nextWithEmail ? b.nextWithEmail : b.next };
}

/**
 * 拒付期间买家看的话（AJ-500，用户 2026-10-12 同意；服务端 `payment_dispute`，契约 0.6.82）。
 * @why 原先拒付期间只写"已付款 · 日本采购中"——买家多是没认出扣款名目就去银行争议，写明"银行正在处理、暂不发货"，
 *      误发起的会去撤回；败诉时钱已由银行退回，要说清订单不会发货，免得买家等货。
 * @limitation 只认 open / lost；胜诉 / 撤回后服务端不再下发，回到正常状态文案。
 */
export const DISPUTE_STATUS = {
  open: {
    title: '付款争议处理中',
    next: '你的银行正在处理这笔付款的争议，处理结束前我们暂不发货。如果是误会（比如没认出扣款名目），可以联系银行撤回，或联系客服。',
  },
  lost: {
    title: '货款已由银行退回',
    next: '你的银行已把这笔付款退回给你，这张订单不会发货。如有疑问请联系客服。',
  },
};

/**
 * 已发出的单被拒付时的说法（三天提交复查 2026-10-12）：包裹已在路上 / 已送达，不能再说"暂不发货 / 不会发货"。
 */
const DISPUTE_STATUS_SHIPPED = {
  open: {
    title: '付款争议处理中',
    next: '你的银行正在处理这笔付款的争议。如果是误会（比如没认出扣款名目），可以联系银行撤回，或联系客服。',
  },
  lost: {
    title: '货款已由银行退回',
    next: '你的银行已把这笔付款退回给你。如有疑问请联系客服。',
  },
};

/** 已经发出的状态（拒付说法不再提"发货"）。 */
const SHIPPED_STATUSES = ['shipped', 'delivered', 'completed'];

/**
 * `payment_dispute` → `{title, next}`；没有 / 认不出 → null。
 * @param {unknown} raw `payment_dispute`
 * @param {unknown} [status] 订单状态：已发出的单不说"暂不发货 / 不会发货"
 */
export function disputeStatus(raw, status) {
  if (raw !== 'open' && raw !== 'lost') return null;
  return SHIPPED_STATUSES.includes(/** @type {string} */ (status))
    ? DISPUTE_STATUS_SHIPPED[raw]
    : DISPUTE_STATUS[raw];
}

/** 可以继续支付的状态（@see @limitation 二）。 */
export const PAYABLE = ['created', 'pending_payment'];

/**
 * 迟到付款（关单后才到的钱）的说明——订单列表与详情**同一份**（第二轮审查【1】，2026-10-16 收口）。
 * @why 列表原先认不出迟到付款，对这类单说"需要的话可以重新下单"，而详情说"无需重新付款"：同一事实两页两种指引，
 *      列表又是买家付完款回微信的第一落点——这句话会把人引向付第二笔。
 */
export const LATE_PAID_NOTE =
  '我们已收到你的付款，但这张订单已关闭；款项会原路退回，无需重新付款。';

/** 迟到付款要替换"重新下单"那句的状态：订单已关闭、钱还没退（退款中 / 已退款讲的是钱的进度，另有说法）。 */
export const LATE_PAID_CLOSED_STATUSES = ['expired', 'cancelled'];

/**
 * 订单不存在（或不是本人的，40400）时给买家的话（全入口点击测试 2026-10-11；支付页与订单详情共用）。
 * @why 原先两页都显示通用文案"请求的资源不存在"+ 错误码 + 「重试」；40400 也覆盖"他人的单"（防存在性探测），两种都说到。
 */
export const ORDER_NOT_FOUND_TEXT =
  '链接可能已失效，或这张订单不在当前微信账号下。可以在「订单」里查看你的全部订单';

/**
 * 时间线的事件词（全入口点击测试 2026-10-11）。
 * @why 时间线讲"那时发生了什么"，原先直接用状态词（待付款 / 付款中 / 已付款），读起来像三个状态而不是三件事；
 *      主流订单页的时间线写事件（提交订单 / 付款成功 / 已发货）。与 `STATUS_LABELS` 同一组键，单测比对。
 */
export const TIMELINE_LABELS = {
  created: '提交订单',
  pending_payment: '发起支付',
  paid: '付款成功',
  shipped: '已发货',
  delivered: '已送达',
  completed: '交易完成',
  cancelled: '订单已取消',
  expired: '超时未付款，订单关闭',
  refunding: '开始退款',
  refunded: '退款完成',
};

/**
 * 时间线事件词；不在词表里的给"状态未知"（同 `statusText` 的理由）。
 * @param {unknown} status
 * @returns {string}
 */
export function timelineText(status) {
  const s = typeof status === 'string' ? status : '';
  return TIMELINE_LABELS[s] ?? '状态未知';
}

/**
 * 状态 → 展示文案。
 * @param {unknown} status 契约 `OrderStatus`；也可能是任何东西
 * @returns {string}
 * @why 不在词表里的状态给 '状态未知' 而不是空串：
 *      空串在真机上就是一个空白的标签，用户无法区分"没状态"和"渲染错了"。
 */
export function statusText(status) {
  const s = typeof status === 'string' ? status : '';
  return STATUS_LABELS[s] ?? '状态未知';
}

/**
 * 能否继续支付。
 * @param {unknown} status
 * @returns {boolean}
 * @why 与可取消态**故意一致**（@see @limitation 二）。
 */
export function canPay(status) {
  return PAYABLE.includes(typeof status === 'string' ? status : '');
}

/**
 * 缺货整单退款说明（剩余清单 4-10 / A40）。
 * @why 本店是"付款后去日本采购"：偶尔会买不到。用户付了款、几天后收到全额退款，没有任何说明的话读起来像"被取消了"。
 *      与服务端口径一致：缺货 → 管理端全额退款，原路原币原额退回（refund 政策页同一句话）。
 * @why 住在共享层（P2-39，从 `pages/order-detail/index.vm.js` 下沉）：结算页与订单详情页都要显示它，
 *      结算页从详情页 vm import 是"页面依赖页面"（同 STATUS_LABELS 的下沉理由，见文件头）。
 */
export const STOCK_REFUND_NOTE =
  '我们会在日本为你采购这些商品。采购不到的商品全额退款（整单都采购不到就整单退），原路退回到你的付款方式（约 5–10 个工作日到账）。';
