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
    next: '我们正在日本为你采购，发出后可在订单详情查看承运商和运单号。',
    nextWithEmail: '我们正在日本为你采购，发出后会发邮件告知承运商和运单号。',
  },
  shipped: {
    title: '已发货 · 国际运输中',
    next: '包裹已从日本发出，可复制运单号查件。收到后请点「确认收货」；没点的话，系统会在发货一段时间后自动确认。',
  },
  delivered: {
    title: '已送达',
    next: '如果实际没有收到，或商品有问题，请联系客服并提供订单号。',
  },
  completed: { title: '已完成', next: '订单已完成。商品有问题请联系客服并提供订单号。' },
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
 * @param {{email?: boolean}} [opts] `email: true` = 确知这张单留了联系邮箱（@see BUYER_STATUS @limitation 二）
 * @returns {{title: string, next: string}}
 */
export function buyerStatus(status, opts = undefined) {
  const s = typeof status === 'string' ? status : '';
  const b = Object.prototype.hasOwnProperty.call(BUYER_STATUS, s) ? BUYER_STATUS[s] : null;
  if (b === null) return { ...UNKNOWN_BUYER_STATUS };
  const email = opts !== null && typeof opts === 'object' && opts.email === true;
  return { title: b.title, next: email && b.nextWithEmail ? b.nextWithEmail : b.next };
}

/** 可以继续支付的状态（@see @limitation 二）。 */
export const PAYABLE = ['created', 'pending_payment'];

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
  '我们会在日本为你采购这些商品。如果采购不到，会整单全额退款，原路退回到你的付款方式（约 5–10 个工作日到账）。';
