/**
 * 职责：退款原因预设的拼接与校验（AJ-400）。
 * @see ./refund-reason.ts
 */
import { describe, expect, it } from 'vitest';
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { composeRefundReason } from './refund-reason.js';

describe('composeRefundReason', () => {
  it('预设 + 说明 → `预设：说明`；只选预设 → 预设本身；说明去首尾空白', () => {
    expect(composeRefundReason({ preset: '缺货', note: ' 抹茶粉断货 ' })).toEqual({
      ok: true,
      reason: '缺货：抹茶粉断货',
    });
    expect(composeRefundReason({ preset: '买家取消', note: '   ' })).toEqual({
      ok: true,
      reason: '买家取消',
    });
  });

  it('没选预设 / 认不出的预设 → 拦（不放行纯自由文本）', () => {
    expect(composeRefundReason({ preset: '', note: '随便写' })).toEqual({
      ok: false,
      error: '请选择退款原因',
    });
    expect(composeRefundReason({ preset: '没货', note: '' }).ok).toBe(false);
  });

  it('「其它」必须写说明', () => {
    expect(composeRefundReason({ preset: '其它', note: '' })).toEqual({
      ok: false,
      error: '选「其它」时请写明原因',
    });
    expect(composeRefundReason({ preset: '其它', note: '海关退运' })).toEqual({
      ok: true,
      reason: '其它：海关退运',
    });
  });

  it('长度按拼好后的整串算：恰好等于上限放行，多一个字拦', () => {
    const fit = 'あ'.repeat(REFUND_REASON_MAX_LENGTH - '破损：'.length);
    expect(composeRefundReason({ preset: '破损', note: fit }).ok).toBe(true);
    const over = composeRefundReason({ preset: '破损', note: `${fit}あ` });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toContain(String(REFUND_REASON_MAX_LENGTH));
  });
});
