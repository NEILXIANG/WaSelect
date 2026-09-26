/**
 * 职责：状态机迁移表的 L0 单测（I1-U5b）。
 *
 * @why 前三条是**整体断言**（表作为数据被全量校验，而不是逐条用例碰运气）：
 *      键集合、终态集合、迁移目标合法性——任何一处改表，这三条立刻逼着面对全表。
 * @see domain/order.ts（被测）；技术文档 §1
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS, TERMINAL_ORDER_STATUS } from '@waselect/shared';
import { AppError } from '../errors.js';
import { asOrderStatus, assertTransition, canTransition, ORDER_TRANSITIONS } from './order.js';

describe('ORDER_TRANSITIONS（整体断言，与技术文档 §1 同源）', () => {
  it('键集合 === shared 的 10 态（不缺态、不多态）', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUS].sort());
  });

  it('无出边的状态集合 === TERMINAL_ORDER_STATUS（终态定义只有一处真源）', () => {
    const terminal = ORDER_STATUS.filter((s) => ORDER_TRANSITIONS[s].length === 0);
    expect(terminal.sort()).toEqual([...TERMINAL_ORDER_STATUS].sort());
  });

  it('所有迁移目标都是合法状态（不许迁到枚举外的幽灵状态）', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const t of targets) {
        expect((ORDER_STATUS as readonly string[]).includes(t)).toBe(true);
      }
    }
  });

  it('技术文档 §1 的关键迁移逐条在表里（防"整体断言绿但具体迁移被改"）', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['created', 'pending_payment'],
      ['created', 'cancelled'],
      ['created', 'expired'],
      ['pending_payment', 'paid'],
      ['pending_payment', 'expired'],
      ['pending_payment', 'cancelled'],
      ['paid', 'shipped'],
      ['paid', 'refunding'],
      ['shipped', 'delivered'],
      ['shipped', 'refunding'],
      ['delivered', 'completed'],
      ['delivered', 'refunding'],
      ['refunding', 'refunded'],
    ];
    for (const [from, to] of expected) {
      expect(canTransition(from as never, to as never), `${from} → ${to}`).toBe(true);
    }
  });

  it('终态不可再迁（expired 的单不能被关单 job 之外的任何东西复活）', () => {
    for (const t of TERMINAL_ORDER_STATUS) {
      for (const to of ORDER_STATUS) {
        expect(canTransition(t, to)).toBe(false);
      }
    }
  });

  it('refunding 的失败停留不算迁移（refunding → refunding 不在表里）', () => {
    expect(canTransition('refunding', 'refunding')).toBe(false);
  });
});

describe('assertTransition / asOrderStatus', () => {
  it('非法迁移抛 40902 且 details 带来源标识', () => {
    try {
      assertTransition('paid', 'created', 'test');
      expect.unreachable('应当抛 40902');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(40902);
      expect((e as AppError).details).toMatchObject({ from: 'paid', to: 'created', where: 'test' });
    }
  });

  it('库行脏状态（枚举外）抛 50000 而不是静默 as 强转', () => {
    expect(asOrderStatus('created')).toBe('created');
    try {
      asOrderStatus('price_review');
      expect.unreachable('应当抛 50000');
    } catch (e) {
      expect((e as AppError).code).toBe(50000);
    }
  });
});
