/**
 * 职责：确定性 ID 生成器（测试用固定种子，断言可复现；生产用随机种子）。
 * 边界：只生成"形状像 ULID 的字符串"，不读时钟、不依赖外部环境。
 * 逻辑：xorshift128+ 伪随机 → Crockford Base32 编码 26 位。
 * @see docs/测试策略与验证门禁.md §3.2（ID 固定种子，禁止真实随机导致断言不稳定）
 * @tradeoff 不引入 ulid 依赖：MVP 只需要形状与可复现，30 行换零依赖；
 *           代价：不含时间序（测试不需要；生产侧唯一性由 DB 主键约束兜底，不靠此函数）。
 * @limitation 非加密随机，**禁止用于安全用途**（token / 签名 / 会话）；安全场景一律 crypto.randomUUID。
 */

/** Crockford Base32 字符表（去 I/L/O/U 防混淆）。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 创建一个确定性 ID 工厂。
 * @param seed 任意正整数；同一 seed 产生的序列完全相同（测试断言稳定的前提）
 * @returns 每次调用返回 26 位 Base32 字符串（ULID 形状）的函数
 * @sideeffects 闭包内推进伪随机状态；不同工厂互不影响
 */
export function createIdFactory(seed: number): () => string {
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new RangeError('seed 必须是正整数');
  }
  let s0 = seed >>> 0 || 0x9e3779b9;
  let s1 = (seed * 0x85ebca6b) >>> 0 || 0xc2b2ae35;

  const next32 = (): number => {
    // xorshift128+：两轮步进后混合，周期 2^128-1，足够测试复现使用
    s1 ^= s0;
    s0 = ((s0 << 23) | (s0 >>> 9)) >>> 0;
    s1 = (s1 ^ (s0 << 7) ^ (s1 >>> 17)) >>> 0;
    return (s0 + s1) >>> 0;
  };

  return () => {
    let out = '';
    // 26 位 × 5bit = 130bit > 32bit，每调用一次 next32 取 6 位
    while (out.length < 26) {
      let chunk = next32();
      for (let i = 0; i < 6 && out.length < 26; i += 1) {
        out += ALPHABET[chunk & 31];
        chunk >>>= 5;
      }
    }
    return out;
  };
}
