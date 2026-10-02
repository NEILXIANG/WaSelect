/**
 * 职责：`validateProductInput`（管理端上架/改商品输入校验）的行为钉子。
 *
 * @why 上架校验是**合规的最后一道自动闸门**：D-42 航空禁寄、D-45 不上电器、
 *      D-51 医薬部外品/SPF（美国 FDA 口径属 OTC 药品）、CPSIA、酒类 —— 七类商品
 *      上架即拒。它们一旦漏检，后果不是"页面显示错"，而是**货被海关扣留**或
 *      **在卖处方药边界的东西**；而漏检的样子是"商品静静地上架了"，没有任何一方报错。
 *
 * @why 每条规则配**一个独立用例**（不批量断言）：两年前本项目踩过"两个变量一起改"的
 *      覆盖假象（关税行 duty_jpy 与 duty_estimate 同时改，漏了一档）。这里每条规则
 *      只动一个字段，缺陷注入时才能确认"这一条真的被这条用例守着"。
 *
 * @see domain/product-input.ts（被测）；contracts/api-contract.yaml ProductInput
 */
import { describe, expect, it } from 'vitest';
import { validateProductInput, type ProductInput } from './product-input.js';

/** 一条合法输入（每个用例只改自己关心的那一两个字段）。 */
function base(): Record<string, unknown> {
  return {
    title: '测试商品',
    category: 'beauty',
    price_jpy: 3600,
    weight_g: 800,
    customs_desc_en: 'cosmetic set',
    origin_country: 'JP',
  };
}

/**
 * 单价上界（B25 / AJ-211）。
 * @why 显式写一个常量而不是复用 config：`validateProductInput` 是纯函数、上界由调用方注入，
 *      测试若读 config 就变成"测的是配置值"；这里要钉的是"**超限会被拒**"这个行为。
 */
const MAX_PRICE = 180_000;

/** 断言通过并取回归一化值。 */
function ok(raw: unknown): ProductInput {
  const r = validateProductInput(raw, MAX_PRICE);
  if (!r.ok) throw new Error(`期望通过，实际拒绝：${JSON.stringify(r.errors)}`);
  return r.value;
}

/** 断言被拒并返回错误里的 reason 列表。 */
function reasons(raw: unknown): string[] {
  const r = validateProductInput(raw, MAX_PRICE);
  if (r.ok) throw new Error('期望拒绝，实际通过');
  return r.errors.map((e) => e.reason);
}

describe('validateProductInput（管理端商品输入，I2）', () => {
  it('全部合法字段 → 通过并归一化（缺的可选字段补默认）', () => {
    const v = ok(base());
    expect(v.category).toBe('beauty');
    expect(v.price_jpy).toBe(3600);
    expect(v.origin_country).toBe('JP');
    // 库存省略 = 不改（更新保持原值、新建由路由取 0）——不再在这里补 0（AJ-175：补 0 会让
    // "只改标题的 PUT"把库存清零；更早的形态是带旧值覆盖并发扣减）
    expect(v.stock).toBeUndefined();
  });

  it('非对象 / null → 拒绝（reason: not_object）', () => {
    expect(reasons(null)).toContain('not_object');
    expect(reasons('x')).toContain('not_object');
  });

  // ── 必填六项：每项一个用例（防"缺项被静默当成 0/空串"）──────────────────
  it('缺 title → 拒绝', () => {
    const b = base();
    delete b.title;
    expect(reasons(b)).toContain('title_required');
  });

  it('缺 category → 拒绝', () => {
    const b = base();
    delete b.category;
    expect(reasons(b)).toContain('category_required');
  });

  it('缺 price_jpy → 拒绝', () => {
    const b = base();
    delete b.price_jpy;
    expect(reasons(b)).toContain('price_required');
  });

  it('缺 weight_g → 拒绝', () => {
    const b = base();
    delete b.weight_g;
    expect(reasons(b)).toContain('weight_required');
  });

  it('缺 customs_desc_en → 拒绝（报关品名上架必填，D-39）', () => {
    const b = base();
    delete b.customs_desc_en;
    expect(reasons(b)).toContain('customs_desc_required');
  });

  it('缺 origin_country → 拒绝（必填无默认，D-42/D-43）', () => {
    const b = base();
    delete b.origin_country;
    expect(reasons(b)).toContain('origin_required');
  });

  // ── 数值约束 ────────────────────────────────────────────────────────────
  it('price_jpy = 0 / 负数 / 非整数 / 非数字 → 拒绝', () => {
    expect(reasons({ ...base(), price_jpy: 0 })).toContain('price_invalid');
    expect(reasons({ ...base(), price_jpy: -1 })).toContain('price_invalid');
    expect(reasons({ ...base(), price_jpy: 1.5 })).toContain('price_invalid');
    expect(reasons({ ...base(), price_jpy: '3600' })).toContain('price_invalid');
  });

  it('weight_g = 0 / 非整数 → 拒绝（运费取档的输入，0 克会让取档取到最小档）', () => {
    expect(reasons({ ...base(), weight_g: 0 })).toContain('weight_invalid');
    expect(reasons({ ...base(), weight_g: 10.5 })).toContain('weight_invalid');
  });

  /**
   * AJ-298：重量**上界**（与 `SHIPPING_RATE_BOUNDS.maxWeightG` 同源，30kg）。
   *
   * @why 必须与 `weight_invalid` 分开报：一个是"填错了格式"，一个是"填了一个超重的数"——
   *      合起来的话运营看到"无效"会去改格式，而这个数根本不需要改格式。
   * @why 上界本身放行（不能把极值本身拦掉）。
   */
  it('🔴 weight_g 超过单件上限 → weight_too_large（AJ-298：否则买家会看到莫名其妙的 40912）', () => {
    expect(reasons({ ...base(), weight_g: 30_001 })).toContain('weight_too_large');
    expect(ok({ ...base(), weight_g: 30_000 }).weight_g).toBe(30_000);
  });

  /**
   * AJ-298：四个可选文本字段的**列宽**。
   *
   * @why 断言 reason 而不是只看"被拒"：超长此前会一路走到 PG 的 22001，
   *      被 `http.ts` 的 22 类兜底折成 40001——**错误码本来就一样**，
   *      所以"有没有被拒"证明不了"是在这一层被拒的"，只有 reason 能证明。
   * @why 每个字段单独一条：批量断言会在注入时产生覆盖假象（改一处、另一处兜住）。
   */
  it('🔴 hs_code / customs_desc_en / title_ja / purchase_source 超列宽 → 逐字段拒绝（AJ-298）', () => {
    expect(reasons({ ...base(), hs_code: '1'.repeat(11) })).toContain('hs_code_too_long');
    expect(reasons({ ...base(), customs_desc_en: 'x'.repeat(121) })).toContain(
      'customs_desc_too_long',
    );
    expect(reasons({ ...base(), title_ja: 'あ'.repeat(256) })).toContain('title_ja_too_long');
    expect(reasons({ ...base(), purchase_source: 's'.repeat(256) })).toContain(
      'purchase_source_too_long',
    );
    // 恰好等于列宽 → 放行（DB 能存下就不该拦）
    expect(ok({ ...base(), hs_code: '1'.repeat(10) }).hs_code).toBe('1'.repeat(10));
  });

  it('stock 负数 → 拒绝（0 允许：预售/缺货上架是正常运营动作）', () => {
    expect(reasons({ ...base(), stock: -1 })).toContain('stock_invalid');
    expect(ok({ ...base(), stock: 0 }).stock).toBe(0);
  });

  it('cost_jpy 负数 → 拒绝（未填允许：采购价可后补）', () => {
    expect(reasons({ ...base(), cost_jpy: -1 })).toContain('cost_invalid');
    expect(ok({ ...base(), cost_jpy: 2000 }).cost_jpy).toBe(2000);
  });

  // ── 枚举与产地 ──────────────────────────────────────────────────────────
  it('category 不在四值枚举 → 拒绝', () => {
    expect(reasons({ ...base(), category: 'beauty2' })).toContain('category_invalid');
    for (const c of ['beauty', 'daily', 'kitchen', 'food']) {
      expect(ok({ ...base(), category: c }).category).toBe(c);
    }
  });

  it('origin_country 非 JP → 拒绝（MVP 只卖日本原产；DB 也有 CHECK，前端拦是为了给出人话错误）', () => {
    expect(reasons({ ...base(), origin_country: 'CN' })).toContain('origin_invalid');
    expect(reasons({ ...base(), origin_country: 'jp' })).toContain('origin_invalid'); // 大小写敏感
  });

  // ── 合规标签：上架即拒（D-42 / D-45 / D-51）────────────────────────────
  it('七个拦截标签任一 → 拒绝（reason: tag_blocked）', () => {
    for (const t of [
      'flammable',
      'aerosol',
      'electrical',
      'quasi_drug',
      'sunscreen',
      'children_product',
      'alcohol',
    ]) {
      expect(reasons({ ...base(), compliance_tags: [t] })).toContain('tag_blocked');
    }
  });

  it('只标记不拦的标签 → 通过（liquid / battery 不要求 HS 码；cosmetic / food 要求，见下两条）', () => {
    for (const t of ['liquid', 'battery']) {
      expect(ok({ ...base(), compliance_tags: [t] }).compliance_tags).toEqual([t]);
    }
  });

  it('未登记的字符串 → 拒绝（拼错标签 = 拦截静默失效，三审 B5）', () => {
    expect(reasons({ ...base(), compliance_tags: ['quasi-drug'] })).toContain('tag_invalid');
  });

  it('compliance_tags 非数组 → 拒绝', () => {
    expect(reasons({ ...base(), compliance_tags: 'food' })).toContain('tags_invalid');
  });

  // ── 报关品名禁词（D-51）────────────────────────────────────────────────
  it('customs_desc_en 含禁词 → 拒绝（大小写不敏感：海关看的是文本不是大小写）', () => {
    for (const w of ['medicated', 'whitening', 'SPF', 'sunscreen', 'drug']) {
      expect(reasons({ ...base(), customs_desc_en: `skin ${w} cream` })).toContain(
        'customs_desc_forbidden',
      );
    }
    // 大写的 MEDICATED 同样要拦（只比小写原词会漏）
    expect(reasons({ ...base(), customs_desc_en: 'MEDICATED soap' })).toContain(
      'customs_desc_forbidden',
    );
  });

  it('禁词作为单词的一部分（classic 含 "ass"? 不在名单）不算命中——只按词边界比，避免误伤', () => {
    expect(ok({ ...base(), customs_desc_en: 'classic ceramic cup' }).customs_desc_en).toBe(
      'classic ceramic cup',
    );
  });

  // ── HS 码（食品 / 化妆品必填，D-39/D-42）────────────────────────────────
  it('food 标签且无 hs_code → 拒绝', () => {
    expect(reasons({ ...base(), compliance_tags: ['food'] })).toContain('hs_code_required');
  });

  it('cosmetic 标签且无 hs_code → 拒绝', () => {
    expect(reasons({ ...base(), compliance_tags: ['cosmetic'] })).toContain('hs_code_required');
  });

  it('food + hs_code → 通过（补了就放行）', () => {
    expect(ok({ ...base(), compliance_tags: ['food'], hs_code: '210690' }).hs_code).toBe('210690');
  });

  it('无 food/cosmetic 标签时 hs_code 缺省 → 通过（不由我们编造 HS 码）', () => {
    expect(ok(base()).hs_code).toBeUndefined();
  });

  // ── 形状与长度 ──────────────────────────────────────────────────────────
  it('images 每项须为 {thumb,card,detail} 三字符串 → 否则拒绝', () => {
    expect(
      ok({
        ...base(),
        images: [{ thumb: 'a', card: 'b', detail: 'c' }],
      }).images,
    ).toEqual([{ thumb: 'a', card: 'b', detail: 'c' }]);
    expect(reasons({ ...base(), images: [{ thumb: 'a' }] })).toContain('image_invalid');
    expect(reasons({ ...base(), images: ['a'] })).toContain('image_invalid');
  });

  it('jan_code 超 13 字符 → 拒绝（DB VARCHAR(13)；超长会在入库时才炸）', () => {
    expect(reasons({ ...base(), jan_code: '1'.repeat(14) })).toContain('jan_code_invalid');
    expect(ok({ ...base(), jan_code: '1'.repeat(13) }).jan_code).toBe('1'.repeat(13));
  });

  it('title 超 255 字符 → 拒绝（DB VARCHAR(255)）', () => {
    expect(reasons({ ...base(), title: 'x'.repeat(256) })).toContain('title_too_long');
  });

  /**
   * B25 / AJ-211：单价必须有上界。
   * @why 没有上界时，`toMinor(price_jpy, rateInt)` 的乘积会越过 2^53 抛 RangeError，
   *      而浏览页对每个商品都做一次换算 ⇒ **一个离谱单价让整页 500**。
   *      这条钉的是"写入侧挡住"，与 product-routes 的"读取侧降级"互为纵深。
   */
  it('price_jpy 超过上界 → 拒绝 price_too_large（不是"贵"，是会让整页 500）', () => {
    expect(reasons({ ...base(), price_jpy: MAX_PRICE + 1 })).toContain('price_too_large');
    // 恰好等于上界仍然通过（边界值：差 1 円就两种命运，必须各钉一条）
    expect(ok({ ...base(), price_jpy: MAX_PRICE }).price_jpy).toBe(MAX_PRICE);
  });

  it('一次收集多个错误，不是遇到第一个就停（表单要一次显示全部问题）', () => {
    const errs = validateProductInput({ title: 'x', price_jpy: 0, weight_g: -1 }, MAX_PRICE);
    expect(errs.ok).toBe(false);
    if (errs.ok) return;
    expect(errs.errors.length).toBeGreaterThanOrEqual(4);
  });
});
