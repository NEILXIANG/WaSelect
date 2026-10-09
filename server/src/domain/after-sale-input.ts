/**
 * 职责：售后申请（买家）与售后处理（运营）的输入校验（AJ-420）。纯函数，不查库、不取时钟。
 *
 * @why 描述 / 说明按**字符**计长（`[...s].length`），与前端输入框的计数口径一致；
 *      按 UTF-16 码元计时 emoji 会多算一位，前端显示"还能输 1 字"、服务端却拒——用户只会觉得"坏了"。
 * @why 结案（resolved / rejected）必须写说明：买家在订单详情里看到的就是这句话；
 *      "未通过"却没有原因，等于把问题推回给客服。processing 可以不写（只是"我们在看了"）。
 * @limitation 只校验形状；"这单能不能申请""这条能不能这样改"要查库，在路由里判（40902）。
 * @see packages/shared/src/after-sale.ts（枚举与流转的唯一真源）
 */
import {
  AFTER_SALE_DESCRIPTION_MAX,
  AFTER_SALE_REASONS,
  type AfterSaleReason,
  type AfterSaleStatus,
} from '@waselect/shared';
import { AppError } from '../errors.js';

const RESOLVE_TARGETS = ['processing', 'resolved', 'rejected'] as const;
type ResolveTarget = (typeof RESOLVE_TARGETS)[number];

const charLength = (s: string): number => [...s].length;

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(40001, { reason: 'body_shape' });
  }
  return body as Record<string, unknown>;
}

/** 买家发起售后。 */
export function parseAfterSaleInput(body: unknown): {
  reason: AfterSaleReason;
  description: string;
} {
  const b = asObject(body);
  const reason = b['reason'];
  if (typeof reason !== 'string' || !(AFTER_SALE_REASONS as readonly string[]).includes(reason)) {
    throw new AppError(40001, { reason: 'reason_invalid' });
  }
  const description = typeof b['description'] === 'string' ? b['description'].trim() : '';
  if (description === '') throw new AppError(40001, { reason: 'description_required' });
  if (charLength(description) > AFTER_SALE_DESCRIPTION_MAX) {
    throw new AppError(40001, { reason: 'description_too_long' });
  }
  return { reason: reason as AfterSaleReason, description };
}

/** 运营处理（改状态 + 说明）。 */
export function parseAfterSaleResolve(body: unknown): {
  status: Extract<AfterSaleStatus, ResolveTarget>;
  note: string | null;
} {
  const b = asObject(body);
  const status = b['status'];
  if (typeof status !== 'string' || !(RESOLVE_TARGETS as readonly string[]).includes(status)) {
    throw new AppError(40001, { reason: 'status_invalid' });
  }
  const note = typeof b['note'] === 'string' ? b['note'].trim() : '';
  if (charLength(note) > AFTER_SALE_DESCRIPTION_MAX)
    throw new AppError(40001, { reason: 'note_too_long' });
  if (note === '' && status !== 'processing')
    throw new AppError(40001, { reason: 'note_required' });
  return { status: status as ResolveTarget, note: note === '' ? null : note };
}
