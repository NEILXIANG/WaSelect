/**
 * 职责：买家订单页签（M-10，AJ-408）的单测。
 *
 * @why 钉三件**都不报错**的事：
 *      ① 服务端新增一个状态，没人把它分到页签里 → 那张单只在「全部」里出现、而没人知道是有意的还是漏了；
 *      ② 一个状态同时进两个页签 → 同一张单在两处出现，角标重复计数；
 *      ③ 「我的」角标把历史单（已退款 / 已送达）也算进去 → 角标永远不归零，等于没有角标。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_BADGE_STATUSES, ORDER_STATUS } from '@waselect/shared';
import {
  ALL_ONLY_STATUSES,
  ORDER_PAGE_SIZE,
  ORDER_TABS,
  orderListQuery,
  resolveOrderTab,
  tabBadgeText,
  tabStatusParam,
  tabItems,
} from './order-tabs.js';

describe('ORDER_TABS（页签 ↔ 状态）', () => {
  it('五个页签，顺序固定：全部 / 待付款 / 采购中 / 已发货 / 售后·退款', () => {
    expect(ORDER_TABS.map((t) => [t.key, t.label])).toEqual([
      ['all', '全部'],
      ['unpaid', '待付款'],
      ['to_ship', '采购中'],
      ['shipped', '已发货'],
      ['after_sale', '售后·退款'],
    ]);
  });

  it('🔴 契约 10 态每一个都**恰好**落在一个页签，或显式登记为"只在全部里"（不多不少）', () => {
    const seen = new Map<string, string[]>();
    for (const t of ORDER_TABS) {
      for (const s of t.statuses) seen.set(s, [...(seen.get(s) ?? []), t.key]);
    }
    for (const s of ALL_ONLY_STATUSES) seen.set(s, [...(seen.get(s) ?? []), 'all-only']);
    for (const s of ORDER_STATUS) {
      expect([s, seen.get(s)]).toEqual([s, [expect.any(String)]]);
    }
    expect([...seen.keys()].sort()).toEqual([...ORDER_STATUS].sort());
  });

  it('具体归属（代购视角：已送达仍在「已发货」；已完成 / 已取消 / 已超时只在「全部」）', () => {
    const of = (k: string): readonly string[] => ORDER_TABS.find((t) => t.key === k)!.statuses;
    expect(of('all')).toEqual([]);
    expect(of('unpaid')).toEqual(['created', 'pending_payment']);
    expect(of('to_ship')).toEqual(['paid']);
    expect(of('shipped')).toEqual(['shipped', 'delivered']);
    expect(of('after_sale')).toEqual(['refunding', 'refunded']);
    expect(ALL_ONLY_STATUSES).toEqual(['completed', 'cancelled', 'expired']);
  });
});

describe('tabStatusParam / resolveOrderTab', () => {
  it('页签 → 查询参数（逗号拼接；全部 = 空串，不带 status）', () => {
    expect(tabStatusParam('all')).toBe('');
    expect(tabStatusParam('unpaid')).toBe('created,pending_payment');
    // S-7（契约 0.6.69）：「售后·退款」带自己的状态，"有售后申请"由 include_after_sale 交给服务端（原先取全量本地滤）
    expect(tabStatusParam('after_sale')).toBe('refunding,refunded');
  });

  it('⚠️ 认不出的 key / 脏值 → 回落「全部」（不把坏值发给服务端换一个 40001）', () => {
    expect(tabStatusParam('closed')).toBe('');
    expect(tabStatusParam(undefined)).toBe('');
    expect(resolveOrderTab('to_ship')).toBe('to_ship');
    expect(resolveOrderTab('constructor')).toBe('all');
    expect(resolveOrderTab('')).toBe('all');
    expect(resolveOrderTab(null)).toBe('all');
    expect(resolveOrderTab(3)).toBe('all');
  });
});

describe('「我的」角标口径（S-7 起由服务端 GET /orders/counts 计数，口径 shared ORDER_BADGE_STATUSES）', () => {
  it('角标状态 ⊆ 该页签状态（角标数的单，点进页签必须看得到）；且只数"还在进行中"的状态', () => {
    for (const [key, statuses] of Object.entries(ORDER_BADGE_STATUSES)) {
      const tab = ORDER_TABS.find((t) => t.key === key);
      expect(tab, key).toBeDefined();
      for (const s of statuses) expect(tab!.statuses).toContain(s);
    }
    // 已送达 / 已退款 / 已完成是结果不是待办：算进去角标永远不归零
    const counted = Object.values(ORDER_BADGE_STATUSES).flat() as string[];
    for (const s of ['delivered', 'refunded', 'completed', 'cancelled', 'expired']) {
      expect(counted, s).not.toContain(s);
    }
  });

  it('角标文案：0 不显示、超过 99 显示 99+', () => {
    expect(tabBadgeText(0)).toBe('');
    expect(tabBadgeText(3)).toBe('3');
    expect(tabBadgeText(100)).toBe('99+');
    expect(tabBadgeText(Number.NaN)).toBe('');
  });
});

// AJ-430（契约 0.6.60）：列表行带 after_sale_state（open / closed / null）
describe('「售后·退款」页签收进有售后申请的单', () => {
  const list = [
    { order_id: 'a', status: 'refunded', after_sale_state: null },
    { order_id: 'b', status: 'delivered', after_sale_state: 'open' },
    { order_id: 'c', status: 'completed', after_sale_state: 'closed' },
    { order_id: 'd', status: 'delivered', after_sale_state: null },
    { order_id: 'e', status: 'refunding', after_sale_state: 'open' },
  ];

  it('🔴 tabItems：退款中 / 已退款，或有任何售后申请（进行中或已结案）的单都在；没有售后的已送达不在', () => {
    expect(tabItems('after_sale', list).map((o) => o.order_id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('其它页签原样返回（服务端已按 status 过滤）；脏输入 → 空数组', () => {
    expect(tabItems('shipped', list)).toBe(list);
    expect(tabItems('after_sale', undefined)).toEqual([]);
  });
});

describe('orderListQuery（S-7：买家订单列表分页，契约 0.6.69）', () => {
  it('🔴 每个页签的查询串：分页恒带；「售后·退款」带 include_after_sale=1 交给服务端筛', () => {
    expect(ORDER_PAGE_SIZE).toBe(20);
    expect(orderListQuery('all', 1)).toBe('?page=1&size=20');
    expect(orderListQuery('unpaid', 2)).toBe('?status=created,pending_payment&page=2&size=20');
    expect(orderListQuery('after_sale', 1)).toBe(
      '?status=refunding,refunded&include_after_sale=1&page=1&size=20',
    );
  });

  it('脏页码 → 第 1 页；认不出的页签 → 全部', () => {
    for (const p of [0, -1, 1.5, Number.NaN, undefined]) {
      expect(orderListQuery('all', p as number), String(p)).toBe('?page=1&size=20');
    }
    expect(orderListQuery('constructor', 3)).toBe('?page=3&size=20');
  });
});
