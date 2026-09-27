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
      ['created', 'paid'],
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

  it('非法边**不存在**：整表与期望常量逐字相等（防"加了一条 paid→cancelled 却没人红"，全量审计 M7）', () => {
    // @why 上面只断言"该有的边有"，往表里**多加**一条边（例如让已付款的单可以 cancelled）全绿——
    //      而多出来的边正是钱的事故（已付款被取消 = 退款流程绕过）。整表相等把两个方向都钉住。
    expect(ORDER_TRANSITIONS).toEqual({
      created: ['pending_payment', 'cancelled', 'expired', 'paid'],
      pending_payment: ['paid', 'expired', 'cancelled'],
      paid: ['shipped', 'refunding'],
      shipped: ['delivered', 'refunding'],
      delivered: ['completed', 'refunding'],
      completed: [],
      cancelled: [],
      expired: [],
      refunding: ['refunded'],
      refunded: [],
    });
  });

  /**
   * @why 落账（mark-paid）曾经**手写** `status !== 'created' && status !== 'pending_payment'`
   *      而不问这张表——表与代码各一份真源，改一边另一边不报错。2026-09-27 起 mark-paid
   *      改走 `canTransition`，"能到 paid 的源状态"就有了唯一答案，钉住它：
   *      将来谁往表里再加一条 `X → paid`（例如 refunding → paid），本条立刻红，
   *      逼着回答"退款中的单能不能被机构回调直接置为已付"——那正是钱的事故。
   * @limitation 期望值**手写在测试里**（不是从 mark-paid 反推）：mark-paid 已无自己的清单，
   *      这里钉的是"答案应该是什么"，不是"代码现在做什么"。
   */
  it('能到 paid 的源状态只有 created 与 pending_payment（落账允许集的唯一答案）', () => {
    const sources = ORDER_STATUS.filter((s) => canTransition(s, 'paid'));
    expect([...sources].sort()).toEqual(['created', 'pending_payment']);
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
