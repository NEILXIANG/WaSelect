/**
 * 职责：售后申请的小程序侧口径（AJ-420）——原因 / 状态中文、可申请的订单状态、订单详情里的售后卡片视图。
 *
 * @why 小程序没有 npm 构建，用不了 `@waselect/shared`，这里是它的**镜像**；
 *      `after-sale.unit.test.ts` 与 shared 逐项比对（原因、状态、文案、可申请状态、上限），任一处改了另一处不改就红。
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

/** 问题描述上限（字符）。 */
export const AFTER_SALE_DESCRIPTION_MAX = 500;

const OPEN = ['open', 'processing'];

/**
 * 订单详情里的售后卡片。
 * @param {unknown} order 契约 `Order`
 * @returns {{show: boolean, canApply: boolean, current: null | {reasonText: string, statusText: string,
 *   description: string, note: string, atText: string, open: boolean}}}
 *   show = 卡片出不出现；canApply = 给不给「申请售后」入口（没有进行中的申请时才给）。
 */
export function afterSaleCard(order) {
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
          open: OPEN.includes(status),
        };
  const canApply = eligible && (current === null || !current.open);
  return { show: canApply || current !== null, canApply, current };
}
