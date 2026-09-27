/**
 * 职责：订单列表页（`pages/order`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 状态文案是**最容易两处漂移**的东西：契约有 10 态（`OrderStatus`），
 *      服务端按态流转，前端按态显示中文与"能不能继续付"。
 *      写死在 wxml 里的后果是：加一个状态要动 wxml 十处 `wx:if`，
 *      漏掉的那处表现为"这个状态的订单显示成空白"。
 *
 * @limitation 一：状态词表**与契约双向比对**（单测里从 yaml 抽 enum 校验）。
 *              缺了那条比对，服务端新增一个状态后前端会静默走 `unknown` 分支。
 * @limitation 二：`canPay` 只认 `created` / `pending_payment`——
 *              与契约 `POST /orders/{id}/cancel` 的可取消态**故意一致**：
 *              两个"这个订单还能操作吗"的判断若不一致，
 *              表现为"能付但取消不了"这种说不清的半开状态。
 *
 * @see ../../utils/price-format.js（金额与副行）；
 *      ../../../contracts/api-contract.yaml（OrderStatus / OrderSummary）
 */
import { displaySubLine, formatJpy } from '../../utils/price-format.js';

/**
 * `OrderStatus` 十态 → 展示文案。
 * @why **全部列出**（不靠 default 兜底）：兜底会让"新增状态"静默变成一个通用词，
 *      而列表页上一个看不懂的状态词，等于告诉用户"我们也不知道这单怎么了"。
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
const PAYABLE = ['created', 'pending_payment'];

/**
 * `GET /orders` 的 items → 列表行。
 * @param {unknown} items 契约 `OrderSummary[]`
 * @returns {Array<{orderId: string, orderNo: string, totalJpy: number|null, totalText: string,
 *                  totalSub: string, statusText: string, canPay: boolean}>}
 * @why 同时给 `totalJpy`（整数，交给 `ws-price`）与 `totalText`（已格式化串）：
 *      `ws-price` 只收整数（对非整数**响亮失败**：空白 + 控制台报错），
 *      而"没有合计"的订单连组件都不该渲染——所以整数是 null 而不是 0
 *      （`0 円` 会被读成"这单不要钱"）。
 */
export function orderRows(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((o) => o && typeof o.order_id === 'string' && o.order_id !== '')
    .map((o) => {
      const status = typeof o.status === 'string' ? o.status : '';
      const hasTotal = Number.isInteger(o.total_jpy);
      return {
        orderId: o.order_id,
        orderNo: typeof o.order_no === 'string' ? o.order_no : '',
        totalJpy: hasTotal ? o.total_jpy : null,
        totalText: hasTotal ? formatJpy(o.total_jpy) : '',
        totalSub: displaySubLine(o.display),
        // ⚠️ 不在词表里的状态给 '状态未知' 而不是空串：
        //    空串在真机上就是一个空白的标签，用户无法区分"没状态"和"渲染错了"
        statusText: STATUS_LABELS[status] ?? '状态未知',
        canPay: PAYABLE.includes(status),
      };
    });
}

/**
 * 空态开关。
 * @why 与地址列表同一条口径：请求失败时**不能**说"还没有订单"
 *      （用户会以为订单丢了，那是最坏的暗示）。
 */
export function emptyState(rows, error) {
  return { showEmpty: Array.isArray(rows) && rows.length === 0 && error === '' };
}
