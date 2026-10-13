/**
 * 部分退款准入（AJ-383）的边界表。
 * @why 这是"能不能再退一笔钱、最多退多少"的唯一判定处——错一个边界就是多退（损失）或该退的退不了（纠纷）。
 */
import { describe, expect, it } from 'vitest';
import {
  fullRefundAmount,
  fullRefundDisputeLostGuard,
  partialRefundGuard,
} from './partial-refund.js';

const base = {
  status: 'delivered' as const,
  hasDispute: false,
  chargeAmountMinor: 8160,
  reservedMinor: 0,
  inFlight: false,
  amountMinor: 1000,
  channelSupportsPartial: true,
  lostDisputeMinor: 0,
};

describe('partialRefundGuard', () => {
  it.each(['paid', 'shipped', 'delivered', 'completed'] as const)('%s → 放行', (status) => {
    expect(partialRefundGuard({ ...base, status })).toEqual({ ok: true });
  });

  it.each(['created', 'pending_payment', 'cancelled', 'expired', 'refunding', 'refunded'] as const)(
    '🔴 %s → 40902（没收到钱，或整单退款已在走 / 已走完）',
    (status) => {
      expect(partialRefundGuard({ ...base, status })).toMatchObject({ ok: false, code: 40902 });
    },
  );

  it('🔴 拒付进行中 → 40907（钱可能已被机构拉回，再退就是两次）', () => {
    expect(partialRefundGuard({ ...base, hasDispute: true })).toMatchObject({
      ok: false,
      code: 40907,
    });
  });

  it('🔴 通道能力声明不支持部分退款 → 40902 partial_refund_not_supported（第三轮缺口 P2-4）', () => {
    expect(partialRefundGuard({ ...base, channelSupportsPartial: false })).toEqual({
      ok: false,
      code: 40902,
      reason: 'partial_refund_not_supported',
    });
  });

  it('🔴 已有一笔在途（initiated / pending / unknown）→ 40902 partial_refund_in_flight', () => {
    expect(partialRefundGuard({ ...base, inFlight: true })).toEqual({
      ok: false,
      code: 40902,
      reason: 'partial_refund_in_flight',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('🔴 金额 %s → 40001 amount_invalid', (amountMinor) => {
    expect(partialRefundGuard({ ...base, amountMinor })).toEqual({
      ok: false,
      code: 40001,
      reason: 'amount_invalid',
    });
  });

  it('边界：已占 7160 + 本次 1000 = 8160 恰好等于实收 → 放行；再多 1 → 40001 exceeds_refundable', () => {
    expect(partialRefundGuard({ ...base, reservedMinor: 7160, amountMinor: 1000 })).toEqual({
      ok: true,
    });
    expect(partialRefundGuard({ ...base, reservedMinor: 7160, amountMinor: 1001 })).toEqual({
      ok: false,
      code: 40001,
      reason: 'exceeds_refundable',
    });
  });

  // AJ-516：拒付败诉的那部分钱已被银行退回买家；人工解除限制（has_dispute=false）后，额度里也不能再算它
  it('🔴 已败诉拒付 3000（部分金额）：额度 = 8160 − 3000 = 5160；恰好 5160 放行，5161 → 40001 exceeds_refundable', () => {
    const lost = { ...base, lostDisputeMinor: 3000 };
    expect(partialRefundGuard({ ...lost, amountMinor: 5160 })).toEqual({ ok: true });
    expect(partialRefundGuard({ ...lost, amountMinor: 5161 })).toEqual({
      ok: false,
      code: 40001,
      reason: 'exceeds_refundable',
    });
  });

  it('🔴 已败诉拒付 + 已占额度一起扣：8160 − 3000 − 5000 = 160；161 → 40001', () => {
    const lost = { ...base, lostDisputeMinor: 3000, reservedMinor: 5000 };
    expect(partialRefundGuard({ ...lost, amountMinor: 160 })).toEqual({ ok: true });
    expect(partialRefundGuard({ ...lost, amountMinor: 161 })).toMatchObject({
      reason: 'exceeds_refundable',
    });
  });

  it('🔴 败诉金额大于实收（汇率差 / 合并拒付）：一分都不能再退', () => {
    expect(partialRefundGuard({ ...base, lostDisputeMinor: 9000, amountMinor: 1 })).toMatchObject({
      ok: false,
      reason: 'exceeds_refundable',
    });
  });

  it('判定顺序：状态不对时先报状态（金额再错也不该先说金额）', () => {
    expect(partialRefundGuard({ ...base, status: 'refunded', amountMinor: 0 })).toMatchObject({
      code: 40902,
    });
  });
});

describe('fullRefundDisputeLostGuard（AJ-516：拒付败诉后不许整单退款）', () => {
  it('没有败诉的拒付 → 放行', () => {
    expect(fullRefundDisputeLostGuard('paid', 0)).toEqual({ ok: true });
  });
  it.each(['paid', 'shipped', 'delivered', 'expired', 'cancelled'] as const)(
    '🔴 %s + 败诉 1 → 40907 dispute_lost（整单退会把银行已退回的钱再退一次；机构拒了订单就卡在退款中）',
    (status) => {
      expect(fullRefundDisputeLostGuard(status, 1)).toEqual({
        ok: false,
        code: 40907,
        reason: 'dispute_lost',
      });
    },
  );
  it('refunding（重试同一把幂等键）→ 放行：与 refundGuard 的 OPS3-03 同口径，钱只可能动一次', () => {
    expect(fullRefundDisputeLostGuard('refunding', 3000)).toEqual({ ok: true });
  });
});

describe('fullRefundAmount（整单退款要退的余额）', () => {
  it('没有部分退款 → 实收全额', () => {
    expect(fullRefundAmount(8160, 0)).toBe(8160);
  });
  it('已成功部分退款 1000 → 余额 7160', () => {
    expect(fullRefundAmount(8160, 1000)).toBe(7160);
  });
  it('🔴 已退光（或数据异常导致已退 > 实收）→ 0，由调用方拒绝，不得退负数', () => {
    expect(fullRefundAmount(8160, 8160)).toBe(0);
    expect(fullRefundAmount(8160, 9000)).toBe(0);
  });
});
