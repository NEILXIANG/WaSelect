/**
 * 职责：素材库的测试（F9-b）——让**素材**自己先过一遍 DB 的 CHECK 约束。
 *
 * @why 素材是假数据的上游。如果一条地址素材的邮编写错了，
 *      下游每个用到它的用例都会以"数据问题"的形式红，而真实原因是素材写错——
 *      排查时会去查业务代码。把约束在素材这一层钉住，红灯就只指向素材本身。
 *
 * 这里的正则**逐条照抄** `migrations/001_init.sql` 的 CHECK，不是自己编的宽松版。
 */
import { describe, expect, it } from 'vitest';
import {
  JP_PRODUCTS,
  SHIPPING_TIERS,
  US_ADDRESSES,
  formatUsPhone,
  pickTier,
} from './catalog.js';

/** 与 DDL 同源的约束：可打印 ASCII，至少一个字符。 */
const ASCII = /^[ -~]+$/;
const POSTAL = /^[0-9]{5}(-[0-9]{4})?$/;
const PHONE = /^\+1[0-9]{10}$/;
/** 美国州缩写（含 DC）：防止把 CA 写成 CL 这类不会被任何 CHECK 拦住的笔误。 */
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

describe('商品素材', () => {
  it('每条都满足 products 表的 CHECK 与列长', () => {
    for (const p of JP_PRODUCTS) {
      // CHECK (price_jpy > 0) / CHECK (weight_g > 0)
      expect(p.priceJpy, p.titleJa).toBeGreaterThan(0);
      expect(p.weightG, p.titleJa).toBeGreaterThan(0);
      // VARCHAR(255) / VARCHAR(13) / VARCHAR(120)
      expect(p.title.length, p.titleJa).toBeLessThanOrEqual(255);
      expect(p.titleJa.length).toBeLessThanOrEqual(255);
      expect(p.customsDescEn.length, p.titleJa).toBeLessThanOrEqual(120);
      if (p.janCode !== null) {
        expect(p.janCode, p.titleJa).toMatch(/^[0-9]{13}$/);
      }
    }
  });

  it('清单里既有 13 位 JAN 码的商品也有无码商品（"无码"是真实情况，别只造一半）', () => {
    expect(JP_PRODUCTS.some((p) => p.janCode !== null)).toBe(true);
    expect(JP_PRODUCTS.some((p) => p.janCode === null)).toBe(true);
  });

  it('重量分布跨多个运费档（否则运费取档的边界用例没有数据可用）', () => {
    const tiers = new Set(JP_PRODUCTS.map((p) => pickTier(p.weightG)?.maxWeightG));
    expect(tiers.size).toBeGreaterThanOrEqual(4);
  });
});

describe('地址素材', () => {
  it('每条都满足 addresses 表的 CHECK（收件人/街道/城市必须是 ASCII）', () => {
    for (const a of US_ADDRESSES) {
      // CHECK (recipient ~ '^[ -~]+$') —— 收件人姓名不能是日文，这是真实约束
      expect(a.recipient, a.city).toMatch(ASCII);
      expect(a.line1, a.city).toMatch(ASCII);
      expect(a.city).toMatch(ASCII);
      if (a.line2 !== null) expect(a.line2, a.city).toMatch(ASCII);
      // CHECK (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$')
      expect(a.postalCode, a.city).toMatch(POSTAL);
      // state 真实存在于美国（不会被 CHECK 拦住的笔误，只能靠清单）
      expect(US_STATES.has(a.state), `州缩写可疑：${a.state}`).toBe(true);
      expect(a.areaCode).toMatch(/^[2-9][0-9]{2}$/);
    }
  });

  it('同时覆盖 ZIP5 与 ZIP+4 两种形态', () => {
    expect(US_ADDRESSES.some((a) => a.postalCode.length === 5)).toBe(true);
    expect(US_ADDRESSES.some((a) => a.postalCode.includes('-'))).toBe(true);
  });

  it('生成的电话满足 CHECK：+1 后跟 10 位数字', () => {
    for (const a of US_ADDRESSES) {
      expect(formatUsPhone(a.areaCode, 1234567)).toMatch(PHONE);
      expect(formatUsPhone(a.areaCode, 0)).toMatch(PHONE); // 补零，不能被截断成短号
      expect(formatUsPhone(a.areaCode, 9999999)).toMatch(PHONE);
    }
  });
});

describe('运费阶梯与取档方向', () => {
  it('阶梯本身单调：重量与价格都递增（否则"向上取档"没有意义）', () => {
    for (let i = 1; i < SHIPPING_TIERS.length; i += 1) {
      const prev = SHIPPING_TIERS[i - 1];
      const cur = SHIPPING_TIERS[i];
      expect(cur?.maxWeightG).toBeGreaterThan(prev?.maxWeightG ?? 0);
      expect(cur?.priceJpy).toBeGreaterThan(prev?.priceJpy ?? 0);
    }
  });

  /** @see 运费取档方向事故（D-46）：向下取档曾让每单少收 900–1,000 円且静默无报错。 */
  it('红线向量：包裹重 1850g → 4950 円（取到 4050 就说明取档方向反了）', () => {
    expect(pickTier(1850)?.priceJpy).toBe(4950);
  });

  it('边界值：正好等于档位上限时取本档，不是上一档', () => {
    expect(pickTier(500)?.priceJpy).toBe(1980); // 含上界
    expect(pickTier(501)?.priceJpy).toBe(2750); // 超一点就进下一档
    expect(pickTier(1500)?.priceJpy).toBe(4050);
    expect(pickTier(1501)?.priceJpy).toBe(4950);
    expect(pickTier(10000)?.priceJpy).toBe(15000);
  });

  it('超重返回 null（不能静默按最贵档收，必须让调用方决定）', () => {
    expect(pickTier(10001)).toBeNull();
  });
});
