/**
 * 职责：售后申请的**共享口径**（AJ-420，小程序电商对比分析"售后入口最小闭环"）——原因 / 状态枚举、中文文案、状态流转。
 *
 * @why 三端共用一份：服务端校验、管理端处理按钮、小程序原因选择与进度文案都从这里取；
 *      各写一份时最先漂移的是"文案"——买家选的是"商品破损"，运营看到的是英文 damaged。
 * @why 原因只给五个**事实类**选项（没收到 / 破损 / 发错 / 质量 / 其它），不给"我要退款"之类的**诉求**选项：
 *      诉求由运营与买家沟通后定（退款 / 补发 / 部分退款），让买家先选诉求会把"处理方式"变成买家单方面的期待。
 * @why 可申请的订单状态只有 已发货 / 已签收 / 已完成：付款后发货前的问题（想取消、改地址）走客服，
 *      那是"订单还能改"的阶段，不是"售后"；已取消 / 已退款的单没有可售后的东西。
 * @limitation 一：不带图片（MVP）；需要照片时运营在处理说明里请买家通过客服发送。
 * @limitation 二：结案（resolved / rejected）后不能再改；同一订单可以**再开一条**新申请（上一条已结案）。
 * @see contracts/api-contract.yaml（AfterSaleRequest，0.6.56）；migrations/038_after_sale_requests.sql
 */

export const AFTER_SALE_REASONS = [
  'not_received',
  'damaged',
  'wrong_item',
  'quality',
  'other',
] as const;
export type AfterSaleReason = (typeof AFTER_SALE_REASONS)[number];

export const AFTER_SALE_REASON_LABELS: Readonly<Record<AfterSaleReason, string>> = {
  not_received: '没有收到货',
  damaged: '商品破损',
  wrong_item: '发错商品',
  quality: '质量问题',
  other: '其它问题',
};

export const AFTER_SALE_STATUSES = ['open', 'processing', 'resolved', 'rejected'] as const;
export type AfterSaleStatus = (typeof AFTER_SALE_STATUSES)[number];

export const AFTER_SALE_STATUS_LABELS: Readonly<Record<AfterSaleStatus, string>> = {
  open: '已提交，等待处理',
  processing: '处理中',
  resolved: '已处理',
  rejected: '未通过',
};

/** "进行中"：同一订单同时只能有一条（DB 部分唯一索引同口径）。 */
export const AFTER_SALE_OPEN_STATUSES = ['open', 'processing'] as const;

/** 可以发起售后的订单状态（@why 第三条）。 */
export const AFTER_SALE_ORDER_STATUSES = ['shipped', 'delivered', 'completed'] as const;

/**
 * 已完成的订单还能申请售后的天数（从 completed_at 算，审计 BUG-10，2026-10-14，AJ-530）。
 * @why 原先只看状态，completed 的单永远可申请；而自动完成（签收后 AUTO_COMPLETE_DAYS 天）本意就是"售后窗口收口"。
 *      再给 7 天：签收后约两周内都能报问题，与常见电商"签收后 7–15 天"口径一致；超期走客服。
 */
export const AFTER_SALE_DAYS_AFTER_COMPLETE = 7;

/** 问题描述 / 处理说明的长度上限（字符）。 */
export const AFTER_SALE_DESCRIPTION_MAX = 500;

const NEXT: Readonly<Record<AfterSaleStatus, readonly AfterSaleStatus[]>> = {
  open: ['processing', 'resolved', 'rejected'],
  processing: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

/** 运营能否把一条申请从 `from` 改成 `to`（结案后不能再改，也不能退回 open）。 */
export function afterSaleTransitionAllowed(from: AfterSaleStatus, to: AfterSaleStatus): boolean {
  return NEXT[from].includes(to);
}
