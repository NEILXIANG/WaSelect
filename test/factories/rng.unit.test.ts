/**
 * 职责：确定性随机源的测试（F9-a）。
 *
 * @why 这批断言的全部价值在于**"可复现"这个承诺**本身：
 *      一旦 PRNG 悄悄变成不可复现（有人换了 Math.random、有人改了状态推进方式），
 *      后面所有假数据工厂的"同种子重现"会一起失效，而没有任何业务测试会报错——
 *      因为业务测试关心数据长什么样，不关心它能不能重生。所以必须单独钉住。
 */
// fast-check 4.x 无 default 导出，必须整体导入（用 `import { fc }` 会拿到 undefined）
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, seedFrom } from './rng.js';

describe('确定性', () => {
  it('同一种子两次生成完全一致（这是假数据工厂的全部前提）', () => {
    const seq = (seed: number | string): number[] => {
      const r = createRng(seed);
      return Array.from({ length: 50 }, () => r.next());
    };
    expect(seq(1234)).toEqual(seq(1234));
    expect(seq('waselect')).toEqual(seq('waselect'));
  });

  it('不同种子产出不同序列（否则"换种子"这个排障手段是假的）', () => {
    const seq = (seed: number): number[] => {
      const r = createRng(seed);
      return Array.from({ length: 20 }, () => r.next());
    };
    expect(seq(1234)).not.toEqual(seq(1235));
  });

  it('字符串种子稳定：同一词永远同一数值（种子可以写进 bug 单）', () => {
    expect(seedFrom('waselect')).toBe(seedFrom('waselect'));
    expect(seedFrom('waselect')).not.toBe(seedFrom('waselect2'));
    expect(createRng('waselect').seed).toBeGreaterThanOrEqual(0);
  });

  it('取值落在 [0,1)', () => {
    const r = createRng(7);
    for (let i = 0; i < 5000; i += 1) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('int()', () => {
  it('闭区间：上下界都取得到（开区间会让边界值测试静默失效）', () => {
    const r = createRng('boundary');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(r.int(0, 9));
    for (let v = 0; v <= 9; v += 1) expect(seen.has(v)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('任意种子下都不越界（性质测试）', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), fc.integer(), fc.integer(), (s, a, b) => {
        const [min, max] = a <= b ? [a, b] : [b, a];
        const r = createRng(s);
        for (let i = 0; i < 30; i += 1) {
          const v = r.int(min, max);
          if (v < min || v > max) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('下界大于上界 / 非整数边界 → 直接抛错，不静默返回垃圾值', () => {
    const r = createRng(1);
    expect(() => r.int(5, 3)).toThrow(/下界/);
    expect(() => r.int(0.5, 3)).toThrow(/整数/);
  });
});

describe('pick / shuffle / sample', () => {
  it('pick 空数组直接抛错（不能返回 undefined 让后面炸得更远）', () => {
    expect(() => createRng(1).pick([])).toThrow();
  });

  it('pick 能覆盖到所有元素', () => {
    const r = createRng('cover');
    const items = ['a', 'b', 'c', 'd'];
    const seen = new Set(Array.from({ length: 500 }, () => r.pick(items)));
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shuffle 是排列：元素不变、顺序变了、且不改动入参', () => {
    const src = Array.from({ length: 30 }, (_, i) => i);
    const frozen = [...src];
    const out = createRng('shuffle').shuffle(src);
    expect(src).toEqual(frozen); // 入参未被改动
    expect([...out].sort((a, b) => a - b)).toEqual(frozen);
    expect(out).not.toEqual(frozen); // 30 个元素原样返回的概率可忽略
  });

  /**
   * 均匀性：3 个元素只有 6 种排列，可以直接数频率。
   * @why 只断言"是排列、且顺序变了"**验不出有偏洗牌**——
   *      把 Fisher–Yates 写成正向遍历（i 从 0 开始、j 取 [0, n-1]）仍是合法排列，
   *      但分布是偏的（实测 6000 次：最少的排列只占期望的 0.63 倍）。
   *      偏差的后果是"假数据里某些组合永远出现不了"，而单看数据看不出来。
   *      这条用例是在我自己注回缺陷时**发现原断言无效**后补的。
   * @limitation 用固定种子 + 固定次数，阈值 [0.8, 1.25]×期望：
   *            正确实现实测 0.983–1.023，有偏实现 0.628–1.358，两者之间有量级级间隔，
   *            不会因随机波动假红。改成随机种子则需要卡方检验，收益不抵复杂度。
   */
  it('shuffle 分布均匀（有偏洗牌也必须红）', () => {
    const r = createRng('uniformity');
    const counts = new Map<string, number>();
    const N = 6000;
    for (let i = 0; i < N; i += 1) {
      const key = r.shuffle([0, 1, 2]).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    const expected = N / 6;
    for (const [perm, n] of counts) {
      expect(n / expected, `排列 ${perm} 的频率偏离过大`).toBeGreaterThan(0.8);
      expect(n / expected, `排列 ${perm} 的频率偏离过大`).toBeLessThan(1.25);
    }
  });

  it('sample 不重复，且取多了会抛错', () => {
    const r = createRng('sample');
    const out = r.sample([1, 2, 3, 4, 5], 3);
    expect(new Set(out).size).toBe(3);
    expect(() => r.sample([1, 2], 5)).toThrow(/只有/);
  });

  it('bool(0) 恒假、bool(1) 恒真（概率参数的边界不能含糊）', () => {
    const r = createRng('bool');
    for (let i = 0; i < 100; i += 1) {
      expect(r.bool(0)).toBe(false);
      expect(r.bool(1)).toBe(true);
    }
  });
});
