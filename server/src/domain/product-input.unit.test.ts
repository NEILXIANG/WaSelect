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
import {
  PRODUCT_MAX_WEIGHT_G,
  PRODUCT_PACKAGING_HEADROOM_G,
  SHIPPING_RATE_BOUNDS,
} from '@waselect/shared';
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
    hs_code: '330499',
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

  // AJ-490（三端模拟测试 2026-10-11，用户截图指出）：后台列表里商品名显示成「<b>加粗</b> 测试 <script>alert(1)</script> 抹茶」——
  //   转义是对的（不会执行），但这串符号买家会原样看到；运营从网页复制商品名时最容易带进来。录入时就拦
  it('🔴 买家看得到的文字字段里有网页标签 → html_not_allowed（逐字段报）；"<5cm""a < b" 这类正常文字不拦', () => {
    for (const field of ['title', 'title_ja', 'description', 'why', 'maker'] as const) {
      const r = validateProductInput({ ...base(), [field]: '抹茶 <b>限定</b>' }, 180_000);
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.errors, field).toContainEqual({ field, reason: 'html_not_allowed' });
    }
    const tags = validateProductInput(
      { ...base(), tags: ['产地直送', '<script>alert(1)</script>'] },
      180_000,
    );
    expect(tags.ok).toBe(false);
    if (!tags.ok) expect(tags.errors).toContainEqual({ field: 'tags', reason: 'html_not_allowed' });
    for (const fine of ['杯口直径 <5cm', '甜度 a < b 也行', '3>2 的口感', '<<限定>>']) {
      expect(validateProductInput({ ...base(), title: fine }, 180_000).ok, fine).toBe(true);
    }
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
    expect(ok({ ...base(), weight_g: PRODUCT_MAX_WEIGHT_G }).weight_g).toBe(PRODUCT_MAX_WEIGHT_G);
  });

  /**
   * 工程缺口第二轮 §3.6 #1：计费重 = 商品重 + 包材（PACKAGING_WEIGHT_G，默认 250g）。上界原先等于运费表
   * 最大档 30 000g，于是 29 751–30 000g 的单件能上架、却任何购物车都报"包裹超重请拆单"——单件拆不了。
   * 上界改为 30 000 − 包材余量 1 000 = 29 000g；包材配置由 config 规则钉在余量之内。
   */
  it('🔴 单件上界给包材留余量：29 001g → weight_too_large；上界 + 余量 = 运费表最大档', () => {
    expect(reasons({ ...base(), weight_g: 29_001 })).toContain('weight_too_large');
    expect(PRODUCT_MAX_WEIGHT_G + PRODUCT_PACKAGING_HEADROOM_G).toBe(
      SHIPPING_RATE_BOUNDS.maxWeightG,
    );
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
    // 列宽 16（迁移 031，AJ-386）：带点的美国 10 位 HTS `3304.99.5000` 是 12 字，原先 VARCHAR(10) 存不进
    expect(reasons({ ...base(), hs_code: '1'.repeat(17) })).toContain('hs_code_too_long');
    expect(ok({ ...base(), hs_code: '3304.99.5000' }).hs_code).toBe('3304.99.5000');
    expect(reasons({ ...base(), customs_desc_en: 'x'.repeat(121) })).toContain(
      'customs_desc_too_long',
    );
    expect(reasons({ ...base(), title_ja: 'あ'.repeat(256) })).toContain('title_ja_too_long');
    expect(reasons({ ...base(), purchase_source: 's'.repeat(256) })).toContain(
      'purchase_source_too_long',
    );
    // 恰好等于列宽 → 放行（DB 能存下就不该拦）
    expect(ok({ ...base(), hs_code: '1'.repeat(16) }).hs_code).toBe('1'.repeat(16));
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
  // AJ-491：分类改为后台可配置——这里只判键的形状（与 product_categories CHECK 同口径），存在与否由路由查库
  it('category 形状不对 → category_invalid；形状对就放行（存在与否由路由查分类表）', () => {
    expect(reasons({ ...base(), category: 'Beauty!' })).toContain('category_invalid');
    expect(reasons({ ...base(), category: 'b' })).toContain('category_invalid');
    expect(ok({ ...base(), category: 'baby_care' }).category).toBe('baby_care');
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
  /** 去掉 hs_code 的 base（剩余清单 1-4 起所有商品必填）。 */
  function noHs(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const rest = base();
    delete rest['hs_code'];
    return { ...rest, ...extra };
  }

  it('food 标签且无 hs_code → 拒绝', () => {
    expect(reasons(noHs({ compliance_tags: ['food'] }))).toContain('hs_code_required');
  });

  it('cosmetic 标签且无 hs_code → 拒绝', () => {
    expect(reasons(noHs({ compliance_tags: ['cosmetic'] }))).toContain('hs_code_required');
  });

  it('food + hs_code → 通过（补了就放行）', () => {
    expect(ok({ ...base(), compliance_tags: ['food'], hs_code: '210690' }).hs_code).toBe('210690');
  });

  /**
   * 剩余清单 1-4（PRD §7 / GUI「HS 码上架必填」，AJ-368）：不带任何标签也必须填。
   * @why 契约原写"缺省由 Zonos 识别"，但 Zonos 从未接入——缺省的结果是报关单上 HS 码空白。
   */
  it('无标签且 hs_code 缺省 / 空白 → 拒绝（所有商品必填）', () => {
    expect(reasons(noHs())).toContain('hs_code_required');
    expect(reasons(noHs({ hs_code: '   ' }))).toContain('hs_code_required');
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

  // ── images 的新形态：{image_id}（0.6.28 / AJ-361）──────────────────────────
  it('images 条目可以是 {image_id}：存的是 id 本身，不是三档 URL', () => {
    expect(ok({ ...base(), images: [{ image_id: 'img-7qk3m9vz2rx8' }] }).images).toEqual([
      { image_id: 'img-7qk3m9vz2rx8' },
    ]);
  });

  it('image_id 不合法 → 拒绝（存进去就永远拼不出键，写入侧先拦）', () => {
    // 含大写、含点、含斜杠：都不是 IdGen 产出的形状（IMAGE_ID_PATTERN）
    expect(reasons({ ...base(), images: [{ image_id: 'Bad_Id' }] })).toContain('image_invalid');
    expect(reasons({ ...base(), images: [{ image_id: 'a.b' }] })).toContain('image_invalid');
    expect(reasons({ ...base(), images: [{ image_id: 'img/abc' }] })).toContain('image_invalid');
    expect(reasons({ ...base(), images: [{ image_id: '' }] })).toContain('image_invalid');
    expect(reasons({ ...base(), images: [{ image_id: 123 }] })).toContain('image_invalid');
  });

  it('image_id 与 thumb/card/detail 混填 → 拒绝（形状不唯一，不许替调用方猜）', () => {
    expect(
      reasons({
        ...base(),
        images: [{ image_id: 'img-abc', thumb: 'a', card: 'b', detail: 'c' }],
      }),
    ).toContain('image_invalid');
  });

  it('带 image_key 不算混填：它不是档位，只是上传响应带出的附加键', () => {
    expect(
      ok({ ...base(), images: [{ image_id: 'img-abc', image_key: 'img/img-abc/detail.webp' }] })
        .images,
    ).toEqual([{ image_id: 'img-abc' }]);
  });

  it('jan_code 超 13 字符 → 拒绝（DB VARCHAR(13)；超长会在入库时才炸）', () => {
    expect(reasons({ ...base(), jan_code: '1'.repeat(14) })).toContain('jan_code_too_long');
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 编辑口径三字段（020 / AJ-296①）——S4 迁 `pick-card` 的前置
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // @why 这三条字段的性质与上面所有必填项**相反**：它们是"编辑撰写的内容"，
  //      不是"商品能不能卖的事实"。所以这里钉的是"**可以没有**"以及
  //      "**有就必须合法**"，而不是"必须有"。

  it('三个编辑字段全部省略 → 通过（可选是刻意的：必填会逼运营编假文案）', () => {
    const v = ok(base());
    expect(v.why).toBeUndefined();
    expect(v.maker).toBeUndefined();
    expect(v.tags).toBeUndefined();
  });

  it('why / maker / tags 都填 → 原样带出（归一化后字段齐全，S4 的 pick-card 才渲染得出来）', () => {
    const v = ok({
      ...base(),
      why: '铸铁蓄热足，水温掉得慢。',
      maker: '岩手 · 南部铁器',
      tags: ['产地直送', '终身可用'],
    });
    expect(v.why).toBe('铸铁蓄热足，水温掉得慢。');
    expect(v.maker).toBe('岩手 · 南部铁器');
    expect(v.tags).toEqual(['产地直送', '终身可用']);
  });

  it('why 超 200 字 → 拒绝 why_too_long（TEXT 列无列宽，上限在应用层；不静默截断）', () => {
    // @why "不静默截断"是这条的关键：截断会把一句判断截成半句，
    //      而半句话读起来正好像口号——那正是设计侧点名的最坏降级结果。
    expect(reasons({ ...base(), why: 'x'.repeat(201) })).toContain('why_too_long');
    expect(ok({ ...base(), why: 'x'.repeat(200) }).why).toBe('x'.repeat(200));
  });

  it('maker 超 120 字 → 拒绝 maker_too_long（与 DB VARCHAR(120) 同宽，否则撞 22001 变泛化 40001）', () => {
    expect(reasons({ ...base(), maker: 'x'.repeat(121) })).toContain('maker_too_long');
    expect(ok({ ...base(), maker: 'x'.repeat(120) }).maker).toBe('x'.repeat(120));
  });

  it('tags 不是数组 → 拒绝 tags_invalid', () => {
    expect(reasons({ ...base(), tags: '产地直送' })).toContain('tags_invalid');
  });

  it('tags 含空串 / 非字符串 → 拒绝（空串会渲染出一个空色块，只有在入库前拦得住）', () => {
    expect(reasons({ ...base(), tags: ['产地直送', ''] })).toContain('tags_invalid');
    expect(reasons({ ...base(), tags: ['产地直送', null] })).toContain('tags_invalid');
    expect(reasons({ ...base(), tags: [42] })).toContain('tags_invalid');
  });

  /**
   * `tags: []` 与"省略"必须**可区分**。
   * @why PUT 是整行覆盖：空数组 = "清空标签"，省略 = "不改"。
   *      把 [] 当成"没填"会让运营删掉最后一个标签时**删不掉**——
   *      保存后标签又回来了，且没有任何报错（典型"保存失败但不说"）。
   */
  it('🔴 tags 传空数组 → 带出 [] 而不是被当成"没填"（删除最后一个标签必须真的能删掉）', () => {
    expect(ok({ ...base(), tags: [] }).tags).toEqual([]);
  });

  it('why / maker 传空串 → 当"没填"（空串不该落库替代 null）', () => {
    const v = ok({ ...base(), why: '', maker: '' });
    expect(v.why).toBeUndefined();
    expect(v.maker).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 可选文本字段的**类型**（CAT2-06 / AJ-352）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // @why 旧的 `strOpt` 对"填了但不是字符串"返回 undefined ⇒ 与"没填"不可区分，
  //      而 PUT 是**整行覆盖**（路由把 undefined 写成 null）⇒ 导入脚本传
  //      `hs_code: 330499` 时库里原有的 HS 码被**静默清空**：200、没有任何报错，
  //      运营看不到，只有报关那天才发现。这是"错了但不响"里最难查的一类。
  // @why 每个字段单独一条（本文件文件头的纪律）：批量断言在缺陷注入时会产生
  //      "改一处、另一处兜住"的覆盖假象——这里要的是"这一条真的被自己那条守着"。

  /**
   * 🔴 最关键的一条：提示**不能指错方向**。
   * @why 修复前带 food 标签传数字 HS 码，报的是 `hs_code_required`——
   *      运营照它去"补一个她其实已经补了的值"，永远补不对；
   *      而不带标签时更糟：直接 200 通过、原值被清空。
   */
  it('🔴 hs_code 传数字 → hs_code_invalid，且**不**报 hs_code_required（提示不能指错方向）', () => {
    const withFood = reasons({ ...base(), compliance_tags: ['food'], hs_code: 330499 });
    expect(withFood).toContain('hs_code_invalid');
    expect(withFood).not.toContain('hs_code_required');
    // 不带 food / cosmetic 标签时同样要拒：否则 200 通过、原值被静默清空
    expect(reasons({ ...base(), hs_code: 330499 })).toContain('hs_code_invalid');
  });

  it('🔴 customs_desc_en 传数字 → customs_desc_en_invalid，且**不**报 customs_desc_required', () => {
    const r = reasons({ ...base(), customs_desc_en: 12345 });
    expect(r).toContain('customs_desc_en_invalid');
    expect(r).not.toContain('customs_desc_required');
  });

  it('title_ja 传数字 → title_ja_invalid（不是被当成"没填"）', () => {
    expect(reasons({ ...base(), title_ja: 4901872 })).toContain('title_ja_invalid');
  });

  it('purchase_source 传对象 → purchase_source_invalid', () => {
    expect(reasons({ ...base(), purchase_source: { shop: 'x' } })).toContain(
      'purchase_source_invalid',
    );
  });

  it('description 传布尔 → description_invalid', () => {
    expect(reasons({ ...base(), description: true })).toContain('description_invalid');
  });

  it('jan_code 传数字 → jan_code_invalid（与超长的 jan_code_too_long 分开，两种修法）', () => {
    expect(reasons({ ...base(), jan_code: 4901872071234 })).toContain('jan_code_invalid');
    expect(reasons({ ...base(), jan_code: 4901872071234 })).not.toContain('jan_code_too_long');
  });

  it('why 传数字 → why_invalid（不是被当成"编辑还没撰写"）', () => {
    expect(reasons({ ...base(), why: 42 })).toContain('why_invalid');
  });

  it('maker 传数组 → maker_invalid', () => {
    expect(reasons({ ...base(), maker: ['岩手'] })).toContain('maker_invalid');
  });

  /**
   * "没填"的语义**不能**被这次改动误伤。
   * @why 修的是"填了但类型不对"，不是"没填"——把后者也拒了，等于逼运营给每个
   *      可选字段都填点什么，那正是 `why` 刻意做成可选要防的退化（编一句假文案）。
   */
  it('🔴 省略 / null / 空串三种"没填"仍全部通过（不是被当成类型错）', () => {
    const v = ok({
      ...base(),
      title_ja: null,
      purchase_source: '',
      description: undefined,
      jan_code: '',
      // hs_code 自剩余清单 1-4 起必填，不再属于"可选字段没填"
      why: undefined,
      maker: null,
    });
    expect(v.title_ja).toBeUndefined();
    expect(v.purchase_source).toBeUndefined();
    expect(v.description).toBeUndefined();
    expect(v.jan_code).toBeUndefined();
    expect(v.why).toBeUndefined();
    expect(v.maker).toBeUndefined();
  });
});

describe('🔴 必填文本：纯空白 ≠ 已填写（报关口径）', () => {
  /**
   * @why `hs_code` 早就判了 `trim() === ''`（本文件 hs 段注释："纯空白也算没填"），
   *      而**真正进报关单的** `customs_desc_en` 与商品名 `title` 没判——
   *      同一份文件里两个必填字段两种口径，是"改了一半"的典型形态。
   *      运营在表单里敲三个空格保存成功，报关 CSV 上这一栏是空的。
   */
  it('customs_desc_en 为纯空格 → customs_desc_required', () => {
    expect(reasons({ ...base(), customs_desc_en: '   ' })).toContain('customs_desc_required');
  });

  it('title 为纯空格 → title_required', () => {
    expect(reasons({ ...base(), title: '   ' })).toContain('title_required');
  });

  /** 已实现的那条要钉住，防止"统一口径"时被顺手改坏。 */
  it('hs_code 为纯空格 → hs_code_required', () => {
    expect(reasons({ ...base(), hs_code: '   ' })).toContain('hs_code_required');
  });

  /**
   * 反向：不许把"含空格"一律拒掉。
   * @why 修的是"只有空白"，不是"有空格"。把 `cosmetic set` 也拒了，
   *      运营只能把报关品名写成连写单词，那反而更难过关。
   */
  it('🔴 文本中间/两端含正常空格仍通过，且原样保留', () => {
    const v = ok({ ...base(), title: '测试 商品', customs_desc_en: 'cosmetic set' });
    expect(v.title).toBe('测试 商品');
    expect(v.customs_desc_en).toBe('cosmetic set');
  });

  /** 制表符与换行同样只是空白，不是内容。 */
  it('customs_desc_en 为制表符/换行 → 同样算没填', () => {
    expect(reasons({ ...base(), customs_desc_en: '\t\n' })).toContain('customs_desc_required');
  });
});
