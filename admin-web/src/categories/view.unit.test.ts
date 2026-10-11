/**
 * 职责：商品分类视图函数（categories/view.ts，AJ-491）的单测。
 */
import { describe, expect, it } from 'vitest';
import { categoryDraftErrors, categoryName, categoryOptions, categoryServerError } from './view.js';

const LIST = [
  {
    key: 'beauty',
    name: '美妆护肤',
    sort: 10,
    active: true,
    active_product_count: 3,
    product_count: 4,
  },
  { key: 'tea', name: '日本茶', sort: 5, active: false, active_product_count: 0, product_count: 1 },
  { key: 'food', name: '食品', sort: 40, active: true, active_product_count: 9, product_count: 9 },
];

describe('categoryName / categoryOptions', () => {
  it('键 → 名称；认不出原样返回键', () => {
    expect(categoryName(LIST, 'food')).toBe('食品');
    expect(categoryName(LIST, 'nope')).toBe('nope');
  });

  it('🔴 下拉只列启用的；当前值是停用 / 已删除的分类时保留一项并标注（不让受控 select 静默显示第一项）', () => {
    expect(categoryOptions(LIST, 'food')).toEqual([
      { value: 'beauty', label: '美妆护肤' },
      { value: 'food', label: '食品' },
    ]);
    expect(categoryOptions(LIST, 'tea').at(-1)).toEqual({
      value: 'tea',
      label: '日本茶（已停用）',
    });
    expect(categoryOptions(LIST, 'gone').at(-1)).toEqual({
      value: 'gone',
      label: 'gone（已删除）',
    });
  });
});

describe('categoryDraftErrors', () => {
  it('🔴 与服务端同口径：键形状、名称 1–10 字、无网页代码、排序 0–9999；改的时候不查键', () => {
    expect(categoryDraftErrors({ key: 'baby_care', name: '母婴', sort: '50' }, true)).toEqual({});
    const bad = categoryDraftErrors({ key: 'Baby', name: '一'.repeat(11), sort: '-1' }, true);
    expect(Object.keys(bad).sort()).toEqual(['key', 'name', 'sort']);
    expect(categoryDraftErrors({ key: 'Baby', name: '<b>茶</b>', sort: '1' }, false)).toEqual({
      name: '分类名称里不能有网页代码（如 <b>）',
    });
  });
});

describe('categoryServerError', () => {
  it('重复说清是代码还是名称；其它原因翻人话；没有 data → null', () => {
    expect(categoryServerError({ field: 'name', reason: 'duplicate' })?.text).toContain('同名');
    expect(categoryServerError({ field: 'key', reason: 'duplicate' })?.text).toContain('分类代码');
    expect(categoryServerError({ field: 'key', reason: 'key_invalid' })?.text).toContain(
      '小写英文字母',
    );
    expect(categoryServerError(undefined)).toBeNull();
  });
});
