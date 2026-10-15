/**
 * 职责：售后申请的小程序侧口径（AJ-420）——原因 / 状态中文、可申请的订单状态、订单详情里的售后卡片视图。
 *
 * @why 小程序没有 npm 构建，用不了 `@waselect/shared`，这里是它的**镜像**；
 *      `after-sale.unit.test.ts` 与 shared 逐项比对（原因、状态、文案、可申请状态、售后天数、上限），任一处改了另一处不改就红。
 * @why 放在 utils 不放页面 vm：订单详情页（卡片）与售后申请页（表单）都要用，页面不能 import 页面。
 * @limitation 卡片只展示**最新一条**（服务端 `Order.after_sale` 就只给这一条）；历史申请买家看不到。
 * @see packages/shared/src/after-sale.ts；contracts/api-contract.yaml（AfterSaleRequest，0.6.56）
 */
import { jstDateTimeLabeled } from './jst-text.js';

/** 原因（顺序即申请页的展示顺序）。 */
export const AFTER_SALE_REASON_ROWS = [
  { value: 'not_received', label: '没有收到货' },
  { value: 'damaged', label: '商品破损' },
  { value: 'wrong_item', label: '发错商品' },
  { value: 'quality', label: '质量问题' },
  { value: 'other', label: '其它问题' },
];

export const AFTER_SALE_STATUS_LABELS = {
  open: '已提交，等待处理',
  processing: '处理中',
  resolved: '已处理',
  rejected: '未通过',
};

/** 可以申请售后的订单状态。 */
export const AFTER_SALE_ORDER_STATUSES = ['shipped', 'delivered', 'completed'];

/**
 * 已完成的订单还能申请售后的天数（从 `completed_at` 算）。
 * @why 镜像 shared `AFTER_SALE_DAYS_AFTER_COMPLETE`：服务端用它拒超期申请（40902 after_sale_window_closed），
 *      这里用它判断要不要给入口——两边不是一个数字就会出现"能进、提交必被拒"。
 * @see ./after-sale.unit.test.ts（与 shared 比对）
 */
export const AFTER_SALE_DAYS_AFTER_COMPLETE = 7;

/**
 * 超期时卡片上写的话（不是把入口变灰了事）。
 * @why 用户填完一整页才被服务端拒，如果页面上什么都不说，他只会以为系统坏了。
 */
export const AFTER_SALE_WINDOW_CLOSED_NOTE = `已完成订单需在完成后 ${AFTER_SALE_DAYS_AFTER_COMPLETE} 天内申请售后，这单已超时限；有问题请在「我的」里联系客服`;

/** 问题描述上限（字符）。 */
export const AFTER_SALE_DESCRIPTION_MAX = 500;

/**
 * "进行中的售后"（申请尚未结案）。
 * @why 导出并**沿用 shared 的名字**（`AFTER_SALE_OPEN_STATUSES`）：这条规则在服务端决定"能不能再申请 / 能不能撤销发货"，两边必须是同一个集合。
 *      它原先是个没名没注释的局部量 `OPEN`（规律②：同一条规则多份实现，四处各写一份）——
 *      名字对不上时没人会想到它要与 shared 比对，`after-sale.unit.test.ts` 的逐项镜像检查也就漏掉了它。
 * @see ./after-sale.unit.test.ts（与 shared 比对）
 */
export const AFTER_SALE_OPEN_STATUSES = ['open', 'processing'];

/**
 * 已完成的订单是否已经超出售后时限。
 * @returns true = 超期、不能申请；拿不到完成时刻或拿不到当前时刻都返回 false（**不拦**）。
 * @why 与服务端"completed_at 为空的老数据不拦"同一个取舍：宁可让用户提交，
 *      也不在证据不足时把入口静默关掉——那是比"填完被拒"更坏的结果（用户连原因都看不到）。
 */
function afterSaleWindowClosed(order, nowMs) {
  if (order.status !== 'completed') return false;
  const completedMs =
    typeof order.completed_at === 'string' ? Date.parse(order.completed_at) : Number.NaN;
  if (!Number.isFinite(completedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - completedMs > AFTER_SALE_DAYS_AFTER_COMPLETE * 86_400_000;
}

/**
 * 订单详情里的售后卡片。
 * @param {unknown} order 契约 `Order`
 * @param {number} [nowMs] 当前时刻（服务端时钟，含偏差校正）；不传 = 不判 7 天窗口（见 {@link afterSaleWindowClosed}）
 * @returns {{show: boolean, canApply: boolean, windowNote: string, current: null | {reasonText: string, statusText: string,
 *   description: string, note: string, atText: string, open: boolean}}}
 *   show = 卡片出不出现；canApply = 给不给「申请售后」入口（没有进行中的申请、且未超期时才给）；
 *   windowNote = 超期说明（卡片仍出，给用户一个为什么没有入口的交代）。
 */
export function afterSaleCard(order, nowMs = undefined) {
  const o = order && typeof order === 'object' ? order : {};
  const eligible = AFTER_SALE_ORDER_STATUSES.includes(o.status);
  const a = o.after_sale && typeof o.after_sale === 'object' ? o.after_sale : null;
  const status = a !== null && typeof a.status === 'string' ? a.status : '';
  const current =
    a === null || !Object.prototype.hasOwnProperty.call(AFTER_SALE_STATUS_LABELS, status)
      ? null
      : {
          reasonText: AFTER_SALE_REASON_ROWS.find((r) => r.value === a.reason)?.label ?? '其它问题',
          statusText: AFTER_SALE_STATUS_LABELS[status],
          description: typeof a.description === 'string' ? a.description : '',
          note: typeof a.resolution_note === 'string' ? a.resolution_note : '',
          atText: jstDateTimeLabeled(a.created_at) ?? '',
          open: AFTER_SALE_OPEN_STATUSES.includes(status),
        };
  const windowClosed = afterSaleWindowClosed(o, nowMs);
  const canApply = eligible && (current === null || !current.open) && !windowClosed;
  return {
    // 超期也出卡片：不出的话用户看不到任何入口也看不到原因，只剩"这单好像不能售后"
    show: canApply || current !== null || windowClosed,
    canApply,
    windowNote: windowClosed ? AFTER_SALE_WINDOW_CLOSED_NOTE : '',
    current,
  };
}
