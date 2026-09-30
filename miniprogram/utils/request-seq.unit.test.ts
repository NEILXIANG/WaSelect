/**
 * 职责：`utils/request-seq.js` 的单测（B36 / AJ-219）。
 *
 * @why 这两个函数小到一眼能看完，但它们守的是"用户看到的数据是不是他点的那一份"。
 *      判据方向写反（`>` 而不是 `<`）的表现是**永远丢弃最新响应**——
 *      列表再也不更新，而没有任何报错，比乱序更难发现。所以方向必须钉死。
 */
import { describe, expect, it } from 'vitest';
import { isStale, nextSeq } from './request-seq.js';

describe('isStale：只接受最新响应', () => {
  it('序号落后 → 过期（后发的已经回来了，旧的必须丢）', () => {
    expect(isStale(1, 2)).toBe(true);
    expect(isStale(2, 3)).toBe(true);
  });

  it('序号等于当前 → 不过期（它就是最新的那一次）', () => {
    expect(isStale(3, 3)).toBe(false);
  });

  it('序号超前 → 不过期（不该发生；真发生了也不能丢，否则数据永远不更新）', () => {
    expect(isStale(4, 3)).toBe(false);
  });

  it('反向：方向写反（旧的当最新）必须红——这条钉的是 `<` 不是 `>`', () => {
    // @why 判据方向写反的表现是"每次都被判为过期，列表永不更新"，且不报错。
    expect(isStale(1, 2), '旧的必须判为过期').toBe(true);
    expect(isStale(2, 1), '新的绝不能判为过期').toBe(false);
  });

  it('脏序号（undefined / 字符串 / 小数 / null）→ 一律不过期（宁可显示旧数据，也不要空列表）', () => {
    for (const [seq, cur] of [
      [undefined, 1],
      [1, undefined],
      ['1', 2],
      [1, null],
      [1.5, 2],
      [1, 'x'],
    ]) {
      expect(isStale(seq, cur), `${String(seq)} vs ${String(cur)}`).toBe(false);
    }
  });
});

describe('nextSeq：领号', () => {
  it('正整数 +1', () => {
    expect(nextSeq(1)).toBe(2);
    expect(nextSeq(41)).toBe(42);
  });

  it('脏值 / 0 / 负数 → 从 1 重数（不信任脏计数器，但不因此卡死页面）', () => {
    expect(nextSeq(undefined)).toBe(1);
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(-3)).toBe(1);
    expect(nextSeq('x')).toBe(1);
  });
});
