/**
 * 职责：管理端订单列表的"待处理"筛选（`GET /admin/orders?attention=`，AJ-425，契约 0.6.58）——三类"有人负责却没人看得到"的单。
 *
 * - `after_sale`：有进行中的售后申请（open / processing）；
 * - `late_paid`：关单后才到账、钱已扣，尚未退款（不含退款中 / 已退款）；
 * - `blocked`：下单人已被拉黑、订单已付款未发货（拉黑只连带取消在途单，已付单由运营判断退款还是照发——block-user.ts @limitation 一）；
 * - `ship_overdue`（AJ-484）：已付款、付款超过 SHIP_WITHIN_BUSINESS_DAYS 个工作日（JST 周一至周五）仍未发货（shared `shipOverdueCutoff`）。
 * - `dispute_open`（AJ-485）：支付上的拒付还开着（`payments.dispute_status = 'open'`）——要去 Stripe 后台举证，有截止期。
 *   胜诉 / 败诉 / 撤回都不算（结了就没有动作可做；败诉仍锁退款发货，那由 `has_dispute` 标记显示）。
 * - `partial_refund`（AJ-454，AJ-483 收窄）：部分退款还在处理中（initiated / pending / unknown）——要去同步结果。
 *   已成功的不算：那是历史，不是待办（订单详情金额区照样显示退过多少）。
 *
 * @why 三端共用一份取值：服务端白名单、管理端待办格与筛选提示都从这里取，避免"后台多一类、前端没跟上"。
 * @see server/src/adapters/orders-admin.ts（筛选 SQL）；admin-web/src/orders/TodoBar.tsx
 */
export const ORDER_ATTENTIONS = [
  'ship_overdue',
  'dispute_open',
  'after_sale',
  'late_paid',
  'blocked',
  'partial_refund',
] as const;
export type OrderAttention = (typeof ORDER_ATTENTIONS)[number];

export const ORDER_ATTENTION_LABELS: Readonly<Record<OrderAttention, string>> = {
  ship_overdue: '超时未发货',
  dispute_open: '拒付待处理',
  after_sale: '售后待处理',
  late_paid: '迟到付款待退',
  blocked: '拉黑用户的已付单',
  partial_refund: '部分退款处理中',
};

export function isOrderAttention(v: unknown): v is OrderAttention {
  return typeof v === 'string' && (ORDER_ATTENTIONS as readonly string[]).includes(v);
}
