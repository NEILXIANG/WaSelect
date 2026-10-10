/**
 * 订单"修正"动作（取消未付单 / 改运单号，P1-10 / P1-11，AJ-386）的纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_NOTE_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';
import {
  cancelGate,
  shipmentFixErrors,
  shipmentFixGate,
  fixDoneNotice,
  shipmentRevertGate,
  trackingWarning,
} from './fix-view.js';

describe('cancelGate', () => {
  it.each([
    ['created', true],
    ['pending_payment', true],
    ['paid', false],
    ['shipped', false],
    ['cancelled', false],
  ])('%s → %s', (status, ok) => {
    expect(cancelGate({ status }).ok).toBe(ok);
  });
  it('拦下时说清原因（已付款的单走退款，不是取消）', () => {
    expect(cancelGate({ status: 'paid' }).reason).toContain('退款');
  });
});

describe('shipmentFixGate', () => {
  it('只有 shipped 能改；带出现有承运商与运单号', () => {
    expect(shipmentFixGate({ status: 'shipped', carrier: 'EMS', tracking_no: 'EM1JP' })).toEqual({
      ok: true,
      carrier: 'EMS',
      trackingNo: 'EM1JP',
    });
    expect(shipmentFixGate({ status: 'paid' }).ok).toBe(false);
    expect(shipmentFixGate({ status: 'delivered' }).ok).toBe(false);
  });
});

describe('shipmentFixErrors', () => {
  const ok = { carrier: 'EMS', trackingNo: 'EM123456789JP', reason: '运单号录错一位' };
  it('三项齐全且不超长 → 无错误', () => {
    expect(shipmentFixErrors(ok)).toEqual({});
  });
  it('🔴 缺任一项 / 超列宽 → 对应栏报错', () => {
    expect(shipmentFixErrors({ ...ok, carrier: ' ' })['carrier']).toBeDefined();
    expect(shipmentFixErrors({ ...ok, trackingNo: '' })['trackingNo']).toBeDefined();
    expect(shipmentFixErrors({ ...ok, reason: '' })['reason']).toBeDefined();
    expect(
      shipmentFixErrors({ ...ok, trackingNo: 'A'.repeat(SHIP_MAX_CHARS.tracking_no + 1) })[
        'trackingNo'
      ],
    ).toContain(String(SHIP_MAX_CHARS.tracking_no));
    expect(
      shipmentFixErrors({ ...ok, reason: 'x'.repeat(ADMIN_NOTE_MAX_LENGTH + 1) })['reason'],
    ).toContain(String(ADMIN_NOTE_MAX_LENGTH));
  });
});

describe('trackingWarning（服务端 tracking_recognized=false 时的提示）', () => {
  it('认得出 → 空串；认不出 → 提醒核对（不拦，已保存）', () => {
    expect(trackingWarning({ tracking_recognized: true })).toBe('');
    expect(trackingWarning({ tracking_recognized: false })).toContain('核对');
    expect(trackingWarning({})).toBe('');
  });
});

/** 撤销发货按钮（AJ-440）：与服务端 revertShipmentGuard 同口径，前端先说清为什么不能撤。 */
describe('shipmentRevertGate', () => {
  const shippedAt = '2026-10-10T00:00:00.000Z';
  const t0 = Date.parse(shippedAt);
  const H = 3_600_000;
  const base = { status: 'shipped', shipped_at: shippedAt, has_dispute: false, after_sales: [] };

  it('未发货 / 已签收 → null（不显示按钮）', () => {
    expect(shipmentRevertGate({ status: 'paid' }, t0)).toBeNull();
    expect(shipmentRevertGate({ status: 'delivered', shipped_at: shippedAt }, t0)).toBeNull();
  });

  it.each([
    [0, true],
    [72 * H - 1, true],
    [72 * H, false],
  ])('发货后 %s ms → ok=%s（恰好 72 小时起拒，与服务端同口径）', (d, ok) => {
    const g = shipmentRevertGate(base, t0 + d);
    expect(g?.ok).toBe(ok);
    if (!ok) expect(g?.reason).toContain('72 小时');
  });

  it('拒付 / 售后进行中 / 缺发货时间 → 不可撤并说明原因；已结案的售后不挡', () => {
    expect(shipmentRevertGate({ ...base, has_dispute: true }, t0)?.reason).toContain('拒付');
    expect(
      shipmentRevertGate({ ...base, after_sales: [{ status: 'processing' }] }, t0)?.reason,
    ).toContain('售后');
    expect(shipmentRevertGate({ ...base, after_sales: [{ status: 'resolved' }] }, t0)?.ok).toBe(
      true,
    );
    expect(shipmentRevertGate({ ...base, shipped_at: undefined }, t0)?.ok).toBe(false);
  });
});

/** 修正完成提示：买家没留邮箱时不能说"已发邮件"（2026-10-11 模拟实测：无邮箱的单也提示"已给买家发更正邮件"）。 */
describe('fixDoneNotice', () => {
  it.each([
    ['revert', 'a@example.com', '已给买家发更正邮件'],
    ['revert', '', '买家未留邮箱，没有发更正邮件'],
    ['fix', 'a@example.com', '已给买家重发发货邮件'],
    ['fix', undefined, '买家未留邮箱，没有重发发货邮件'],
    ['cancel', undefined, '库存已回补'],
  ] as const)('%s / 邮箱=%s → 含「%s」', (mode, email, want) => {
    expect(fixDoneNotice(mode, { contact_email: email })).toContain(want);
  });
});
