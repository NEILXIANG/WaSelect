/**
 * S-4（AJ-465）：建单事务内等商品行锁超时（55P03）不能折成 50000"服务器内部错误"——
 * 那是关单 / 拉黑事务正持有热销商品行的正常并发，买家该看到"请稍后再试"。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createOrderErrorFor } from './create-order.js';

describe('createOrderErrorFor', () => {
  it('55P03（lock_not_available）→ 50300 + retry_after_ms（稍后重试，不是内部错误）', () => {
    const e = createOrderErrorFor(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    );
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(50300);
    expect((e as AppError).publicData).toMatchObject({ retry_after_ms: expect.any(Number) });
  });
  it('其它错误原样返回（不吞）', () => {
    const raw = new Error('boom');
    expect(createOrderErrorFor(raw)).toBe(raw);
    const app = new AppError(40901, {});
    expect(createOrderErrorFor(app)).toBe(app);
  });
});
