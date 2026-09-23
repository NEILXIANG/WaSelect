/**
 * 职责：假数据的确定性随机源（F9-a）——同一个种子必然产出同一批数据。
 *
 * @why 假数据一旦不可复现，"上次复现的那个 bug"就永远回不去了：
 *      测试红了，但你没法拿到当时那批数据，只能再随机碰运气。
 *      固定种子把"一批数据"变成一个可写在 bug 单里的数字（seed=1234）。
 *
 * @tradeoff 为什么不用 `fast-check`：两者互补，不是替代。
 *      - fast-check 擅长"搜索反例"（自动生成边界值去撞断言），默认不保证跨次一致；
 *      - 工厂需要"成批、互相关联、可重放"（一张订单要带上它的明细、地址、支付记录，
 *        且金额与重量必须自洽），这种**数据之间的约束关系**用 arbitrary 表达很别扭。
 *      所以：工厂负责"造一批自洽且可复现的数据"，fast-check 负责"用这些数据去撞规则"。
 *
 * @limitation 一：**不是密码学随机**。mulberry32 周期 2^32、可预测，只用于测试与灌数据；
 *              任何 token / 密钥 / 幂等键的真实生成都不能用它。
 * @limitation 二：只用 `Math.imul`（规格保证的 32 位整数乘法），不用 `Math.random`、
 *              不用 `Date.now()`——后两者是"不可复现"的两个最常见来源。
 *              也因此本模块跨平台（Node / 浏览器 / 小程序）结果一致。
 * @limitation 三：`int()` 是闭区间 `[min, max]`。开区间语义不同，混用会让"边界值测试"悄悄失效
 *              （以为能取到 max，实际永远取不到）。这里统一闭区间并在测试里钉住。
 *
 * @see docs/地基搭建清单.md F9
 */

export interface Rng {
  /** 当前种子的数值形式（便于日志里记下来复现）。 */
  readonly seed: number;
  /** [0,1) 浮点。 */
  next(): number;
  /** 闭区间整数。 */
  int(min: number, max: number): number;
  /** 从数组里等概率取一个；空数组直接抛错。 */
  pick<T>(items: readonly T[]): T;
  /** 以概率 p 返回 true，默认 0.5。 */
  bool(p?: number): boolean;
  /** 复制后洗牌（不改动入参）。 */
  shuffle<T>(items: readonly T[]): T[];
  /** 取 k 个不重复元素；k 大于长度时抛错。 */
  sample<T>(items: readonly T[], k: number): T[];
}

/** 字符串 → 32 位种子（FNV-1a），让种子可以是人能记住的词。 */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32：32 位状态的 PRNG，实现短、无依赖、跨平台一致。
 * @param seed 数字或字符串（字符串走 FNV-1a）
 */
export function createRng(seed: number | string): Rng {
  const seedNum = typeof seed === 'string' ? seedFrom(seed) : seed >>> 0;
  let state = seedNum;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(`int() 只接受整数边界，收到 ${min} / ${max}`);
    }
    if (min > max) throw new Error(`int() 下界不能大于上界：${min} > ${max}`);
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    // 空数组时 int(0,-1) 会先抛错，这里只是让类型系统满意
    if (item === undefined) throw new Error('pick() 收到空数组');
    return item;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    // Fisher–Yates：从后往前换，保证每个排列等概率（正向换会有偏）
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  };

  return {
    seed: seedNum,
    next,
    int,
    pick,
    bool: (p = 0.5) => next() < p,
    shuffle,
    sample: <T>(items: readonly T[], k: number): T[] => {
      if (k > items.length) {
        throw new Error(`sample() 取 ${k} 个但只有 ${items.length} 个可选`);
      }
      return shuffle(items).slice(0, k);
    },
  };
}
