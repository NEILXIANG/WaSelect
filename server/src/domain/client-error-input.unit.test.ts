/**
 * 管理端前端报错上报的输入校验（AJ-421）。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  CLIENT_ERROR_MESSAGE_MAX,
  CLIENT_ERROR_STACK_MAX,
  parseClientError,
} from './client-error-input.js';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError)
      return `${String(e.code)}:${String((e.details as { reason?: string } | undefined)?.reason)}`;
    throw e;
  }
  return 'no-throw';
}

describe('parseClientError', () => {
  it('🔴 合法：kind 三选一；message 去首尾空白；stack / page 可选', () => {
    expect(
      parseClientError({
        kind: 'render',
        message: '  Cannot read properties of undefined (reading "items")  ',
        stack: 'TypeError: …\n    at OrdersPage (OrdersPage.tsx:42:7)',
        page: 'orders',
      }),
    ).toEqual({
      kind: 'render',
      message: 'Cannot read properties of undefined (reading "items")',
      stack: 'TypeError: …\n    at OrdersPage (OrdersPage.tsx:42:7)',
      page: 'orders',
    });
    expect(parseClientError({ kind: 'rejection', message: 'x' })).toEqual({
      kind: 'rejection',
      message: 'x',
      stack: null,
      page: null,
    });
  });

  it('🔴 kind 不在枚举 / message 空白 / 超长 / page 形状不对 / body 不是对象 → 40001 + 各自 reason', () => {
    expect(reasonOf(() => parseClientError({ kind: 'warn', message: 'x' }))).toBe(
      '40001:kind_invalid',
    );
    expect(reasonOf(() => parseClientError({ kind: 'error', message: '   ' }))).toBe(
      '40001:message_required',
    );
    expect(
      reasonOf(() =>
        parseClientError({ kind: 'error', message: 'x'.repeat(CLIENT_ERROR_MESSAGE_MAX + 1) }),
      ),
    ).toBe('40001:message_too_long');
    expect(
      reasonOf(() =>
        parseClientError({
          kind: 'error',
          message: 'x',
          stack: 's'.repeat(CLIENT_ERROR_STACK_MAX + 1),
        }),
      ),
    ).toBe('40001:stack_too_long');
    for (const page of ['Orders', '../x', 'a'.repeat(33), 3]) {
      expect(reasonOf(() => parseClientError({ kind: 'error', message: 'x', page }))).toBe(
        '40001:page_invalid',
      );
    }
    expect(reasonOf(() => parseClientError(null))).toBe('40001:body_shape');
  });

  it('边界：message 恰好上限放行；stack 恰好上限放行', () => {
    expect(
      parseClientError({ kind: 'error', message: 'x'.repeat(CLIENT_ERROR_MESSAGE_MAX) }).message,
    ).toHaveLength(CLIENT_ERROR_MESSAGE_MAX);
    expect(
      parseClientError({ kind: 'error', message: 'x', stack: 's'.repeat(CLIENT_ERROR_STACK_MAX) })
        .stack,
    ).toHaveLength(CLIENT_ERROR_STACK_MAX);
  });
});
