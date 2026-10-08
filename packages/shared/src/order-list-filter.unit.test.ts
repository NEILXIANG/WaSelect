/**
 * 职责：管理端订单列表筛选参数的解析（AJ-400，契约 0.6.44）——多状态 `status` 与 JST 日期区间的边界表。
 * @see ./order-list-filter.ts
 */
import { describe, expect, it } from 'vitest';
import { parseJstDate, parseJstDateRange, parseOrderStatusList } from './order-list-filter.js';

describe('parseOrderStatusList（逗号分隔的订单状态）', () => {
  const table: ReadonlyArray<readonly [string, readonly string[] | null]> = [
    ['paid', ['paid']],
    ['refunding,refunded', ['refunding', 'refunded']],
    ['created,pending_payment', ['created', 'pending_payment']],
    // 重复值去重（同一个筛选写两遍不是错误，但也不该让 SQL 多一个参数）
    ['paid,paid', ['paid']],
    // 全部十态 = 合法（上限天然是枚举大小）
    [
      'created,pending_payment,paid,shipped,delivered,completed,cancelled,expired,refunding,refunded',
      [
        'created',
        'pending_payment',
        'paid',
        'shipped',
        'delivered',
        'completed',
        'cancelled',
        'expired',
        'refunding',
        'refunded',
      ],
    ],
    ['', null],
    ['nope', null],
    ['paid,nope', null],
    // 空段：`paid,` 多半是前端拼接错，响亮失败而不是悄悄当成 `paid`
    ['paid,', null],
    [',paid', null],
    ['paid,,shipped', null],
    // 不 trim、不改大小写：契约值是精确的小写蛇形
    [' paid', null],
    ['PAID', null],
  ];
  for (const [raw, expected] of table) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(parseOrderStatusList(raw)).toEqual(expected);
    });
  }
});

describe('parseJstDate（YYYY-MM-DD → 该 JST 日 00:00 的 UTC 时刻）', () => {
  it('JST 日界 = 前一天 UTC 15:00', () => {
    expect(parseJstDate('2026-10-07')?.toISOString()).toBe('2026-10-06T15:00:00.000Z');
  });
  it('年初：跨到上一年的 UTC', () => {
    expect(parseJstDate('2026-01-01')?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });
  it('闰日：2028-02-29 合法，2026-02-29 不合法（不得滚成 03-01）', () => {
    expect(parseJstDate('2028-02-29')?.toISOString()).toBe('2028-02-28T15:00:00.000Z');
    expect(parseJstDate('2026-02-29')).toBeNull();
  });
  const bad = [
    '',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-10-00',
    '2026-1-01',
    '2026-10-7',
    '26-10-07',
    '2026/10/07',
    '2026-10-07T00:00:00Z',
    ' 2026-10-07',
    '2026-10-07 ',
    '２０２６-10-07',
    '0000-01-01',
  ];
  for (const s of bad) {
    it(`${JSON.stringify(s)} → null`, () => {
      expect(parseJstDate(s)).toBeNull();
    });
  }
});

describe('parseJstDateRange（含两端的 JST 日期 → 左闭右开的 UTC 区间）', () => {
  it('都不给 → 不限', () => {
    expect(parseJstDateRange(undefined, undefined)).toEqual({ ok: true, from: null, to: null });
  });
  it('同一天 → [当日 00:00, 次日 00:00)', () => {
    const r = parseJstDateRange('2026-10-07', '2026-10-07');
    expect(r).toEqual({
      ok: true,
      from: new Date('2026-10-06T15:00:00.000Z'),
      to: new Date('2026-10-07T15:00:00.000Z'),
    });
  });
  it('只给起点 / 只给终点', () => {
    expect(parseJstDateRange('2026-10-01', undefined)).toEqual({
      ok: true,
      from: new Date('2026-09-30T15:00:00.000Z'),
      to: null,
    });
    expect(parseJstDateRange(undefined, '2026-10-31')).toEqual({
      ok: true,
      from: null,
      to: new Date('2026-10-31T15:00:00.000Z'),
    });
  });
  it('终点是月末 / 年末：右端滚到下月 / 下年第一天', () => {
    const r = parseJstDateRange(undefined, '2026-12-31');
    expect(r.ok && r.to?.toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });
  it('起点晚于终点 → created_range_invalid（不静默对调）', () => {
    expect(parseJstDateRange('2026-10-08', '2026-10-07')).toEqual({
      ok: false,
      reason: 'created_range_invalid',
    });
  });
  it('格式错各报各的 reason（排查时知道是哪一端）', () => {
    expect(parseJstDateRange('2026-02-30', '2026-03-01')).toEqual({
      ok: false,
      reason: 'created_from_invalid',
    });
    expect(parseJstDateRange('2026-03-01', 'tomorrow')).toEqual({
      ok: false,
      reason: 'created_to_invalid',
    });
    // 空串 = 给了但无效（不是"没给"）：`?created_from=` 多半是前端把空输入框拼进去了
    expect(parseJstDateRange('', undefined)).toEqual({
      ok: false,
      reason: 'created_from_invalid',
    });
  });
});
