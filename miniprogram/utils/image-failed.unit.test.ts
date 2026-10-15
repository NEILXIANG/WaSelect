/**
 * 职责：`markImageFailed` 的行为——按项标、幂等、非法下标不动（审计 UX-004）。
 *
 * @why 这条算法被六个页面的商品图共用，它是"整页布尔值"这个错误实现的唯一防线：
 *      按项标的正确写法与整页布尔值在 wxml 上只差 `[index]` 六个字符，
 *      所以"标了第 1 项、第 0 项不受影响"必须在这里钉成用例。
 *
 * @see ./image-failed.js；../pages/order-detail/index.wxml.unit.test.ts（同形态的模板侧用例）
 */
import { describe, expect, it } from 'vitest';
import { markImageFailed } from './image-failed.js';

describe('markImageFailed：按项标记（审计 UX-004）', () => {
  it('🔴 第 1 项失败 → 只标第 1 项，第 0 项不受影响（抓"整页一个布尔值"）', () => {
    const next = markImageFailed([], 1);
    expect(next).not.toBeNull();
    // 其它项没被标：整页共用一个布尔值时这里会是 true
    expect(next?.[0]).toBeFalsy();
    expect(next?.[1]).toBe(true);
  });

  it('🔴 已有标记的那一项再报一次 → 返回 null（不重复 setData、不重渲列表）', () => {
    expect(markImageFailed([true], 0)).toBeNull();
    expect(markImageFailed([false, true, false], 1)).toBeNull();
  });

  it('下标非法 / 不是整数 → null（脏 dataset 不许写进 data）', () => {
    expect(markImageFailed([], -1)).toBeNull();
    expect(markImageFailed([], 1.5)).toBeNull();
    expect(markImageFailed([], Number.NaN)).toBeNull();
    expect(markImageFailed([], 'x')).toBeNull();
    expect(markImageFailed([], undefined)).toBeNull();
  });

  it('`failed` 不是数组（首次渲染前 / 脏 data）→ 当空数组处理，不抛', () => {
    expect(markImageFailed(null, 0)).toEqual([true]);
    expect(markImageFailed(undefined, 2)?.[2]).toBe(true);
  });

  it('不改动入参数组（薄壳里的 `this.data.imgFailed` 是同一份引用）', () => {
    const prev = [false, false];
    markImageFailed(prev, 1);
    expect(prev).toEqual([false, false]);
  });
});
