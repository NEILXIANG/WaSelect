/**
 * 职责：售后申请 / 处理的输入校验（AJ-420）。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseAfterSaleInput, parseAfterSaleResolve } from './after-sale-input.js';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError)
      return `${e.code}:${String((e.details as { reason?: string } | undefined)?.reason)}`;
    throw e;
  }
  return 'no-throw';
}

describe('parseAfterSaleInput（买家申请）', () => {
  it('🔴 合法：原因在枚举内、描述去首尾空白后 1–500 字', () => {
    expect(
      parseAfterSaleInput({ reason: 'damaged', description: '  盒子压扁了，铁壶盖子有裂痕  ' }),
    ).toEqual({
      reason: 'damaged',
      description: '盒子压扁了，铁壶盖子有裂痕',
    });
    expect(
      parseAfterSaleInput({ reason: 'other', description: 'x'.repeat(500) }).description,
    ).toHaveLength(500);
    // 按字符计：500 个 emoji（1000 个 UTF-16 码元）照收——与前端计数、库里 char_length 同口径
    expect(
      parseAfterSaleInput({ reason: 'other', description: '😀'.repeat(500) }).description,
    ).toHaveLength(1000);
    expect(parseAfterSaleResolve({ status: 'resolved', note: '😀'.repeat(500) }).note).toHaveLength(
      1000,
    );
  });

  it('🔴 原因不在枚举 / 描述空白 / 超 500 字 / body 不是对象 → 40001 + 各自 reason', () => {
    expect(reasonOf(() => parseAfterSaleInput({ reason: 'refund_please', description: 'x' }))).toBe(
      '40001:reason_invalid',
    );
    expect(reasonOf(() => parseAfterSaleInput({ reason: 'damaged', description: '   ' }))).toBe(
      '40001:description_required',
    );
    expect(
      reasonOf(() => parseAfterSaleInput({ reason: 'damaged', description: 'x'.repeat(501) })),
    ).toBe('40001:description_too_long');
    expect(reasonOf(() => parseAfterSaleInput(null))).toBe('40001:body_shape');
  });
});

describe('parseAfterSaleResolve（运营处理）', () => {
  it('🔴 processing 可以不写说明；resolved / rejected 必须写（买家会看到这句话）', () => {
    expect(parseAfterSaleResolve({ status: 'processing' })).toEqual({
      status: 'processing',
      note: null,
    });
    expect(parseAfterSaleResolve({ status: 'resolved', note: '已补发一件，运单号见订单' })).toEqual(
      {
        status: 'resolved',
        note: '已补发一件，运单号见订单',
      },
    );
    expect(reasonOf(() => parseAfterSaleResolve({ status: 'rejected', note: ' ' }))).toBe(
      '40001:note_required',
    );
  });

  it('目标状态只收 processing / resolved / rejected（不能改回 open）；说明超 500 字 → 40001', () => {
    expect(reasonOf(() => parseAfterSaleResolve({ status: 'open' }))).toBe('40001:status_invalid');
    expect(
      reasonOf(() => parseAfterSaleResolve({ status: 'resolved', note: 'x'.repeat(501) })),
    ).toBe('40001:note_too_long');
  });
});
