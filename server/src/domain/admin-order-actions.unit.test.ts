/**
 * 职责：`domain/admin-order-actions.ts`（管理端三个操作的准入判定）的单测（I2 U-B2a）。
 *
 * @why 用**十态全遍历**（`ORDER_STATUS` 逐个断言）而不是挑几个状态写用例：
 *      闸门漏一个状态的表现是"那一态的按钮点不动"，既不会报错也不会崩——
 *      只有把十态都断言一遍，加新状态时才会在**这里**红（而不是等客服来报）。
 *      状态枚举来自 shared，与契约 `OrderStatus` 由另一条测试双向比对，不会漂移。
 *
 * @why "拒付 vs 状态"的**判定顺序**各有一条专门用例：两个条件同时满足时，
 *      返回哪个码决定了客服看到的提示是"有拒付"还是"状态不对"——
 *      给错的话客服会去改状态，越改越错（实现里的 @why 写了同一条）。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS, type OrderStatus } from '@waselect/shared';
import { addressGuard, refundGuard, shipGuard } from './admin-order-actions.js';

/** 取失败码；断言"必须通过"前先断言 ok（否则 `code` 是 undefined，断言会假绿）。 */
function codeOf(r: ReturnType<typeof shipGuard>): number {
  if (r.ok) throw new Error('期望被拦，实际放行');
  return r.code;
}

describe('admin-order-actions（管理端操作准入，I2 U-B2a）', () => {
  it('shipGuard：十态里只有 paid 可发货', () => {
    const allowed = ORDER_STATUS.filter((s) => shipGuard(s, false).ok);
    expect(allowed).toEqual(['paid']);
  });

  it('shipGuard：有进行中的拒付 → 40909（不是 40902）', () => {
    const r = shipGuard('paid', true);
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe(40909);
  });

  // @why 拒付先于状态判定：这张单**两个理由都能拦**，给 40902 会让客服以为"状态不对"。
  it('shipGuard：拒付与状态同时不合时，报的是拒付（40909）而不是状态（40902）', () => {
    expect(codeOf(shipGuard('cancelled', true))).toBe(40909);
    expect(codeOf(shipGuard('cancelled', false))).toBe(40902);
  });

  it('shipGuard：审核期测试单（is_test）→ 40902 test_order，永不发货（技术文档 §2.9 / AJ-179）', () => {
    const r = shipGuard('paid', false, true);
    expect(codeOf(r)).toBe(40902);
    expect(r.ok ? '' : r.reason).toBe('test_order');
    // 缺省 isTest=false：存量调用口径不变
    expect(shipGuard('paid', false).ok).toBe(true);
  });

  it('refundGuard：paid / shipped / delivered 可退，refunding 可**重试**（KD-4），其余六态拦', () => {
    const allowed = ORDER_STATUS.filter((s) => refundGuard(s, false).ok);
    expect(allowed).toEqual(['paid', 'shipped', 'delivered', 'refunding']);
    // completed 由状态机决定（ORDER_TRANSITIONS.completed = []），本模块不另写一条
    expect(refundGuard('completed', false).ok).toBe(false);
    expect(refundGuard('refunded', false).ok).toBe(false); // 已退完的不能再退
  });

  it('refundGuard：有进行中的拒付 → 40907（D-50）', () => {
    const r = refundGuard('paid', true);
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe(40907);
  });

  it('refundGuard：拒付与状态同时不合时，报的是拒付（40907）', () => {
    expect(codeOf(refundGuard('refunding', true))).toBe(40907);
    expect(codeOf(refundGuard('refunded', false))).toBe(40902);
  });

  it('addressGuard：十态里只有 paid 可改址（改完仍是 paid，不是状态迁移）', () => {
    const allowed = ORDER_STATUS.filter((s) => addressGuard(s).ok);
    expect(allowed).toEqual(['paid']);
  });

  // @why 这条守的是"改址**不**因拒付被拦"：同一张单发货被拦、改址放行，
  //      两个闸门对同一个事实给出不同答案是有意为之（改址不动钱也不动货）。
  it('改址不因拒付被拦：同一张单 shipGuard 拦、addressGuard 放行', () => {
    expect(shipGuard('paid', true).ok).toBe(false);
    expect(addressGuard('paid' as OrderStatus).ok).toBe(true);
  });
});
