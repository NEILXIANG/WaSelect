/**
 * 订单"修正"动作（取消未付单 / 改运单号，P1-10 / P1-11，AJ-386）的纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_NOTE_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';
import { cancelGate, shipmentFixErrors, shipmentFixGate, trackingWarning } from './fix-view.js';

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
