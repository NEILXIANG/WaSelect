/**
 * 职责：买家订单页签（M-10，AJ-408）的单测。
 *
 * @why 钉三件**都不报错**的事：
 *      ① 服务端新增一个状态，没人把它分到页签里 → 那张单只在「全部」里出现、而没人知道是有意的还是漏了；
 *      ② 一个状态同时进两个页签 → 同一张单在两处出现，角标重复计数；
 *      ③ 「我的」角标把历史单（已退款 / 已送达）也算进去 → 角标永远不归零，等于没有角标。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import {
  ALL_ONLY_STATUSES,
  BADGE_STATUSES,
  ORDER_TABS,
  orderTabCounts,
  resolveOrderTab,
  tabBadgeText,
  tabStatusParam,
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

describe('orderTabCounts（「我的」四入口角标）', () => {
  const items = [
    { status: 'created' },
    { status: 'pending_payment' },
    { status: 'paid' },
    { status: 'shipped' },
    { status: 'delivered' },
    { status: 'refunding' },
    { status: 'refunded' },
    { status: 'completed' },
    { status: 'brand_new' },
    null,
  ];

  it('🔴 只数"还在进行中"的单：已送达 / 已退款 / 已完成不计（否则角标永不归零）', () => {
    expect(orderTabCounts(items)).toEqual({ unpaid: 2, to_ship: 1, shipped: 1, after_sale: 1 });
  });

  it('角标状态 ⊆ 该页签状态（角标数的单，点进页签必须看得到）', () => {
    for (const [key, statuses] of Object.entries(BADGE_STATUSES)) {
      const tab = ORDER_TABS.find((t) => t.key === key);
      expect(tab, key).toBeDefined();
      for (const s of statuses) expect(tab!.statuses).toContain(s);
    }
  });

  it('非数组 / 空 → 全 0', () => {
    expect(orderTabCounts(undefined)).toEqual({ unpaid: 0, to_ship: 0, shipped: 0, after_sale: 0 });
    expect(orderTabCounts([])).toEqual({ unpaid: 0, to_ship: 0, shipped: 0, after_sale: 0 });
  });

  it('角标文案：0 不显示、超过 99 显示 99+', () => {
    expect(tabBadgeText(0)).toBe('');
    expect(tabBadgeText(3)).toBe('3');
    expect(tabBadgeText(100)).toBe('99+');
    expect(tabBadgeText(Number.NaN)).toBe('');
  });
});
