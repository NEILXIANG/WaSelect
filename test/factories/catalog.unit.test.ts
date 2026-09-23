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
  REDLINE_MAX_WEIGHT_G,
  SHIPPING_TIER_ANCHOR,
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

  /**
   * 素材里不得出现"上架即拒"的信号词。
   * @why 曾经混入獺祭清酒——契约里 `alcohol` 属"需酒类免许且不可邮寄，**上架即拒**"（D-51）。
   *      用一条永远上不了架的 SKU 造订单，等于拿不可能发生的业务去测规则，绿灯是假的。
   *      这类错误靠肉眼 review 抓不住（"这个商品挺像真的"），只能扫关键词。
   * @limitation 只是**关键词粗筛**，不是合规判定：真实 SKU 上架前仍须逐条核对 `compliance_tags`。
   *             漏报可接受（有人复核），误报必须修（宁可少一条素材）。
   * @see contracts/api-contract.yaml ProductInput.compliance_tags（7 个上架即拒标签）
   */
  it('素材不含"上架即拒"的信号词（酒类 / 医薬部外品 / 防晒 / 喷雾易燃等）', () => {
    // ⚠️ 词表是**踩过坑之后补的**：最初只写了「酒 / alcohol」，而真实出错的那条
    //    （獺祭 純米大吟醸）中日文名里都没有「酒」字、报关名写的是 "Rice wine (sake)"——
    //    词表漏了就一条都抓不到。注回缺陷验证时才发现，所以酒类的别名必须列全。
    const AUTO_REJECT_HINTS = [
      '酒',
      'alcohol',
      'sake',
      'wine',
      'liquor',
      'beer',
      'whisky',
      'whiskey',
      'spirits',
      'abv',
      '薬用',
      'quasi_drug',
      'SPF',
      'sunscreen',
      'whitening',
      'medicated',
      'aerosol',
      'flammable',
    ];
    for (const p of JP_PRODUCTS) {
      const haystack = `${p.titleJa} ${p.title} ${p.customsDescEn}`.toLowerCase();
      const hit = AUTO_REJECT_HINTS.find((w) => haystack.includes(w.toLowerCase()));
      expect(hit, `商品「${p.titleJa}」命中上架即拒关键词：${String(hit)}`).toBeUndefined();
    }
  });

  /**
   * HS 编码不得落在酒类（HS 第 22 章 2203–2208）。
   * @why 光靠商品名挡不住：名字可以写得像普通食品，但报关用的 HS 码骗不了海关。
   *      出问题的那条 HS 是 2206.00，而它的中文名「纯米大吟酿」里没有"酒"字——
   *      **只扫文本会漏，HS 是第二道更硬的关**。
   */
  it('HS 编码不得落在酒类区间（HS 2203–2208）', () => {
    const ALCOHOL_HS = ['2203', '2204', '2205', '2206', '2207', '2208'];
    for (const p of JP_PRODUCTS) {
      const hs = p.hsCode.replace('.', '');
      expect(ALCOHOL_HS.some((h) => hs.startsWith(h)), `商品「${p.titleJa}」的 HS 属酒类：${p.hsCode}`).toBe(false);
    }
  });

  it('类目必须落在契约枚举内（否则造出来的是"不可能存在的商品"）', () => {
    const ALLOWED = new Set(['beauty', 'daily', 'kitchen', 'food']);
    for (const p of JP_PRODUCTS) {
      expect(ALLOWED.has(p.category), `类目越界：${p.category}`).toBe(true);
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

  /**
   * **唯一的运费阶梯必须来自技术文档 §3**，不能是这里自己编的数字。
   * @why 曾经在这里自造了一套中间档（500→1980 之类），并把它写成了断言。
   *      自造的中间档与技术文档里的回归红线 5/7 不符，而且错误值被自己的测试**锁死**——
   *      真报价到位时，这条测试会从护栏变成拦路石。
   *      现在直接把文档那 7 条向量搬过来当断言，任何人改阶梯都得回来面对它们。
   * @see jp/50-产品与技术/技术架构/技术文档.md §2.5（D-46 / R22）
   */
  it('红线向量逐条与技术文档一致（改阶梯必须回来面对这 7 条）', () => {
    const VECTORS: ReadonlyArray<readonly [number, number]> = [
      [100, 1400],
      [101, 1650],
      [500, 2150],
      [501, 3150],
      [1850, 4950],
      [2000, 4950],
      [2001, 6600],
    ];
    for (const [w, expected] of VECTORS) {
      const got = pickTier(w)?.priceJpy;
      expect(got, `包裹重 ${w}g 应取 ${expected} 円`).toBe(expected);
    }
  });

  /**
   * 红线区域（≤3000g）内不得出现**来源不明**的档。
   * @why 为了让假数据里有重货，阶梯表向上扩展了几档估算值。
   *      估算值本身可以接受，但它**绝不能影响任何一条红线向量**——否则等于
   *      用"估算的数字"去验证"取档方向是否正确"，验证就失去意义了。
   */
  it('红线区域只允许出现技术文档来源的档（估算值不得影响红线）', () => {
    const redlineMax = REDLINE_MAX_WEIGHT_G;
    const inRedline = SHIPPING_TIERS.filter((t) => t.maxWeightG <= redlineMax);
    expect(inRedline.length).toBeGreaterThan(0);
    expect(inRedline.filter((t) => t.source !== 'doc')).toEqual([]);
    // 反过来说：估算档必须全部在红线区之上
    expect(SHIPPING_TIERS.filter((t) => t.source === 'fabricated').every((t) => t.maxWeightG > redlineMax)).toBe(true);
  });

  it('阶梯锚点与技术文档 / 商业测算模型的 2kg=4,950 円一致', () => {
    expect(SHIPPING_TIER_ANCHOR.maxWeightG).toBe(2000);
    expect(SHIPPING_TIER_ANCHOR.priceJpy).toBe(4950);
  });

  it('超重返回 null（不能静默按最贵档收，必须让调用方决定）', () => {
    expect(pickTier(10001)).toBeNull();
  });
});
