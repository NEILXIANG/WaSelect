/**
 * 职责：把 `AdminGateResult` 转成 `AppError` 的公共构造器。
 *
 * @why 此前 6 处转换写法各自为政：2 处把 `reason` 写进 publicData（第 3 参），4 处只写进
 *      details（第 2 参）。调用方靠 "data 里有没有 reason" 判断就会出错（42901 两成因的教训）。
 *      统一构造处，reason 参数位置就只有一份事实来源。
 * @param publicReason 是否同时把 `reason` 写进响应体 `data`。默认 false，保持 ship / refund /
 *      address / partial-refund 端点的现有行为；true 用于契约已承诺 `data.reason` 的端点
 *      （`/admin/orders/{id}/shipment/revert`）。
 *
 * @see domain/admin-order-actions.ts（AdminGateResult 与守卫）
 * @see errors.ts（AppError 三参数签名：code, details, publicData）
 */
import { AppError } from '../errors.js';
import type { AdminGateResult } from '../domain/admin-order-actions.js';

export function gateError(
  gate: Extract<AdminGateResult, { ok: false }>,
  ctx: Record<string, unknown> = {},
  publicReason = false,
): Error {
  const details = { ...ctx, reason: gate.reason };
  return publicReason
    ? new AppError(gate.code, details, { reason: gate.reason })
    : new AppError(gate.code, details);
}
