/**
 * 职责：管理端列表排序参数（`sort`）的唯一解析口径——服务端拒非法值、管理端拼地址栏都用它。
 *
 * @why 白名单而不是"传列名"：排序键直接落到 SQL 的 ORDER BY，任意列名 = 注入面 + 无索引的全表排序。
 */
import { describe, expect, it } from 'vitest';
import { LIST_SORT_KEYS, parseListSort, sortParam } from './list-sort.js';

describe('parseListSort', () => {
  it('不传 / 空串 → 默认排序（key 为 null）', () => {
    expect(parseListSort(undefined, LIST_SORT_KEYS.orders)).toEqual({
      ok: true,
      key: null,
      dir: 'desc',
    });
    expect(parseListSort('', LIST_SORT_KEYS.orders)).toEqual({ ok: true, key: null, dir: 'desc' });
  });

  it('🔴 `total_jpy` → 升序；`-total_jpy` → 降序', () => {
    expect(parseListSort('total_jpy', LIST_SORT_KEYS.orders)).toEqual({
      ok: true,
      key: 'total_jpy',
      dir: 'asc',
    });
    expect(parseListSort('-total_jpy', LIST_SORT_KEYS.orders)).toEqual({
      ok: true,
      key: 'total_jpy',
      dir: 'desc',
    });
  });

  it('🔴 白名单外的键、别的列表的键、注入串、非字符串、重复参数 → sort_invalid', () => {
    for (const bad of [
      'stock',
      'id',
      'total_jpy;drop table orders',
      '--total_jpy',
      '-',
      ['total_jpy'],
      3,
    ]) {
      expect(parseListSort(bad, LIST_SORT_KEYS.orders), String(bad)).toEqual({
        ok: false,
        reason: 'sort_invalid',
      });
    }
  });

  it('三张列表的白名单（改它要同步改服务端 SQL 映射与管理端表头）', () => {
    expect(LIST_SORT_KEYS).toEqual({
      orders: ['created_at', 'total_jpy', 'paid_at'], // paid_at：AJ-453（服务端映射 + 管理端待发货默认）
      products: ['updated_at', 'stock', 'price_jpy'],
      customers: ['last_order_at', 'paid_total_jpy'],
    });
  });
});

describe('sortParam（点表头：同一列在降序 / 升序之间切换；换列从降序开始）', () => {
  it('🔴 当前不是这一列 → 降序；当前降序 → 升序；当前升序 → 降序', () => {
    expect(sortParam(null, 'desc', 'total_jpy')).toBe('-total_jpy');
    expect(sortParam('created_at', 'desc', 'total_jpy')).toBe('-total_jpy');
    expect(sortParam('total_jpy', 'desc', 'total_jpy')).toBe('total_jpy');
    expect(sortParam('total_jpy', 'asc', 'total_jpy')).toBe('-total_jpy');
  });
});
