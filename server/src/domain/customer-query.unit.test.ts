/**
 * 职责：`GET /admin/customers` 查询参数判定的边界表（AJ-404）。
 *
 * @why 边界表逐格写死而不是循环生成：每一格对应一种"客户端真的会送进来"的形态
 *      （手改地址栏、旧版前端、重复参数被 Express 解析成数组），循环生成会把"为什么有这一格"抹掉。
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import {
  CUSTOMER_PAGE_SIZE_DEFAULT,
  CUSTOMER_PAGE_SIZE_MAX,
  parseCustomerListQuery,
} from './customer-query.js';

describe('parseCustomerListQuery：分页', () => {
  it('都不给 → page 1 / size 默认 20 / 无关键字', () => {
    expect(parseCustomerListQuery({})).toEqual({
      ok: true,
      page: 1,
      size: CUSTOMER_PAGE_SIZE_DEFAULT,
      keyword: null,
      sort: null,
    });
    expect(CUSTOMER_PAGE_SIZE_DEFAULT).toBe(20);
    expect(CUSTOMER_PAGE_SIZE_MAX).toBe(100);
  });

  const table: ReadonlyArray<[string, Record<string, unknown>, 'ok' | 'page_size_invalid']> = [
    ['size = 上限 100（边界内）', { size: '100' }, 'ok'],
    ['size = 101（跨过上限）', { size: '101' }, 'page_size_invalid'],
    ['size = 1（下界）', { size: '1' }, 'ok'],
    ['size = 0', { size: '0' }, 'page_size_invalid'],
    ['page = 0', { page: '0' }, 'page_size_invalid'],
    ['page = -1', { page: '-1' }, 'page_size_invalid'],
    ['page = 1.5（非整数）', { page: '1.5' }, 'page_size_invalid'],
    ['page = abc', { page: 'abc' }, 'page_size_invalid'],
    ['page = 空串（地址栏留了 ?page=）', { page: '' }, 'page_size_invalid'],
    ['page 重复给两次（Express 解析成数组）', { page: ['1', '2'] }, 'page_size_invalid'],
  ];
  it.each(table)('%s', (_name, q, want) => {
    const r = parseCustomerListQuery(q);
    if (want === 'ok') expect(r.ok).toBe(true);
    else expect(r).toEqual({ ok: false, reason: want });
  });

  it('page / size 原样转成整数', () => {
    expect(parseCustomerListQuery({ page: '3', size: '50' })).toEqual({
      ok: true,
      page: 3,
      size: 50,
      keyword: null,
      sort: null,
    });
  });
});

describe('parseCustomerListQuery：关键字', () => {
  it('去首尾空白、转小写（邮箱与姓名大小写不敏感）', () => {
    expect(parseCustomerListQuery({ keyword: '  Zhang.Wei@Example.COM ' })).toMatchObject({
      ok: true,
      keyword: 'zhang.wei@example.com',
    });
  });

  it("全空白 = 没给（否则 position('' in x) > 0 恒真，等于全表命中）", () => {
    expect(parseCustomerListQuery({ keyword: '   ' })).toMatchObject({ ok: true, keyword: null });
  });

  it('长度上限 = SEARCH_KEYWORD_MAX_LENGTH，量的是原始输入（trim 之前）', () => {
    const atLimit = 'a'.repeat(SEARCH_KEYWORD_MAX_LENGTH);
    expect(parseCustomerListQuery({ keyword: atLimit })).toMatchObject({ ok: true });
    expect(parseCustomerListQuery({ keyword: `${atLimit}b` })).toEqual({
      ok: false,
      reason: 'keyword_too_long',
    });
    // "64 字 + 一万空格"不得因为 trim 后变短而放行（AJ-360 同口径）
    expect(
      parseCustomerListQuery({ keyword: `abc${' '.repeat(SEARCH_KEYWORD_MAX_LENGTH)}` }),
    ).toEqual({ ok: false, reason: 'keyword_too_long' });
  });

  it('非字符串（重复参数 → 数组 / 嵌套对象）→ keyword_invalid，不去猜拼接方式', () => {
    expect(parseCustomerListQuery({ keyword: ['a', 'b'] })).toEqual({
      ok: false,
      reason: 'keyword_invalid',
    });
    expect(parseCustomerListQuery({ keyword: { x: '1' } })).toEqual({
      ok: false,
      reason: 'keyword_invalid',
    });
  });
});

describe('parseCustomerListQuery：排序（评估 4.5，2026-10-09）', () => {
  it('🔴 -paid_total_jpy → 降序；last_order_at → 升序；白名单外 → sort_invalid', () => {
    const a = parseCustomerListQuery({ sort: '-paid_total_jpy' });
    expect(a.ok && a.sort).toEqual({ key: 'paid_total_jpy', dir: 'desc' });
    const b = parseCustomerListQuery({ sort: 'last_order_at' });
    expect(b.ok && b.sort).toEqual({ key: 'last_order_at', dir: 'asc' });
    expect(parseCustomerListQuery({ sort: 'total_jpy' })).toEqual({
      ok: false,
      reason: 'sort_invalid',
    });
  });
});
