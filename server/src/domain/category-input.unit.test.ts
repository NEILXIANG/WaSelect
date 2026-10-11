/**
 * 职责：商品分类输入校验（category-input.ts）的单测与边界表（AJ-491）。
 */
import { describe, expect, it } from 'vitest';
import { validateCategoryCreate, validateCategoryPatch } from './category-input.js';

const reasons = (r: { ok: boolean; errors?: { field: string; reason: string }[] }): string[] =>
  (r.errors ?? []).map((e) => `${e.field}:${e.reason}`);

describe('validateCategoryCreate', () => {
  it('合法 → 去首尾空格；sort 缺省 100', () => {
    expect(validateCategoryCreate({ key: 'tea', name: ' 日本茶 ' })).toEqual({
      ok: true,
      value: { key: 'tea', name: '日本茶', sort: 100 },
    });
    expect(validateCategoryCreate({ key: 'baby_care2', name: '母婴', sort: 0 })).toMatchObject({
      ok: true,
    });
  });

  it('🔴 键的边界表：小写字母开头、2–32 位、只含小写字母 / 数字 / 下划线', () => {
    const cases: Array<[unknown, boolean]> = [
      ['ab', true],
      ['a'.repeat(32), true],
      ['a', false],
      ['a'.repeat(33), false],
      ['Tea', false],
      ['1tea', false],
      ['te-a', false],
      ['茶', false],
      ['', false],
      [12, false],
      [undefined, false],
    ];
    for (const [key, ok] of cases) {
      expect(validateCategoryCreate({ key, name: '茶' }).ok, String(key)).toBe(ok);
    }
  });

  it('🔴 名称的边界表：去空格后 1–10 字（表情算一个）；不收网页代码', () => {
    expect(reasons(validateCategoryCreate({ key: 'tea', name: '   ' }))).toEqual([
      'name:name_required',
    ]);
    expect(validateCategoryCreate({ key: 'tea', name: '一'.repeat(10) }).ok).toBe(true);
    expect(reasons(validateCategoryCreate({ key: 'tea', name: '一'.repeat(11) }))).toEqual([
      'name:name_too_long',
    ]);
    expect(validateCategoryCreate({ key: 'tea', name: '🍵'.repeat(10) }).ok).toBe(true);
    expect(reasons(validateCategoryCreate({ key: 'tea', name: '<b>茶</b>' }))).toEqual([
      'name:html_not_allowed',
    ]);
  });

  it('sort 只收 0–9999 的整数', () => {
    for (const sort of [-1, 10000, 1.5, '10', null]) {
      expect(
        reasons(validateCategoryCreate({ key: 'tea', name: '茶', sort })),
        String(sort),
      ).toEqual(['sort:sort_invalid']);
    }
    expect(validateCategoryCreate({ key: 'tea', name: '茶', sort: 9999 }).ok).toBe(true);
  });

  it('非对象 → body:not_object', () => {
    expect(reasons(validateCategoryCreate(null))).toEqual(['body:not_object']);
  });
});

describe('validateCategoryPatch', () => {
  it('只改给了的项；键不能改（给了 key 就拒）', () => {
    expect(validateCategoryPatch({ name: '茶具', active: false })).toEqual({
      ok: true,
      value: { name: '茶具', active: false },
    });
    expect(reasons(validateCategoryPatch({ key: 'x', name: '茶' }))).toEqual(['key:key_immutable']);
  });

  it('🔴 一项都没给 → empty_patch；active 不是布尔 → active_invalid', () => {
    expect(reasons(validateCategoryPatch({}))).toEqual(['body:empty_patch']);
    expect(reasons(validateCategoryPatch({ active: 'false' }))).toEqual(['active:active_invalid']);
  });
});
