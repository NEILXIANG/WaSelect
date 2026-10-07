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
