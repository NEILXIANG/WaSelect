/**
 * 职责：`admin-order-utils.ts` 的单元测试。
 *
 * @why gateError 是 6 处 AdminGateResult → AppError 转换的**唯一公共构造处**，
 *      必须钉住 "reason 默认只进日志、显式 flag 才进响应体" 这个行为边界——
 *      否则某次重构把默认值改成 true，ship / refund / address / partial-refund 端点
 *      会无意识地对外暴露 reason，而契约还没承诺它。
 */
import { describe, expect, it } from 'vitest';
import { gateError } from './admin-order-utils.js';

describe('gateError', () => {
  const gate = { ok: false as const, code: 40902 as const, reason: 'status_paid' };

  it('🔴 默认把 reason 写进 details（只进日志），但不写进 publicData', () => {
    const err = gateError(gate, { order_id: 'o-1' });
    expect(err).toBeInstanceOf(Error);
    expect((err as { details?: Record<string, unknown> }).details).toEqual({
      order_id: 'o-1',
      reason: 'status_paid',
    });
    expect((err as { publicData?: Record<string, unknown> }).publicData).toBeUndefined();
  });

  it('🔴 publicReason=true 时 reason 同时进 publicData（契约已承诺的端点）', () => {
    const err = gateError(gate, { order_id: 'o-1' }, true);
    expect((err as { details?: Record<string, unknown> }).details).toEqual({
      order_id: 'o-1',
      reason: 'status_paid',
    });
    expect((err as { publicData?: Record<string, unknown> }).publicData).toEqual({
      reason: 'status_paid',
    });
  });

  it('ctx 可以只有 reason，不强制带 order_id', () => {
    const err = gateError(gate);
    expect((err as { details?: Record<string, unknown> }).details).toEqual({
      reason: 'status_paid',
    });
    expect((err as { publicData?: Record<string, unknown> }).publicData).toBeUndefined();
  });
});
