/**
 * 职责：`admin-web/src/products/view.ts` 的单测。
 *
 * @why 钉的全是**点了之后看起来成功、实际是坏的**：
 *      ① 禁售标签勾了却让提交 → 服务端 40001，运营看到"提交失败"不知道是哪条；
 *      ② 报关品名含 SPF 却放行 → 同上，且这条在美国口岸是**合规风险**不是体验问题；
 *      ③ 分类/状态不在枚举内 → 三元表达式会静默当默认，运营看到错的状态；
 *      ④ 库存/重量非整数 → 服务端拒，而表单上看不出是哪个字段。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_COMPLIANCE_TAG,
  COMPLIANCE_TAG,
  PRODUCT_MAX_CHARS,
  LOW_STOCK_THRESHOLD,
  PRODUCT_MAX_STOCK,
  PRODUCT_MAX_WEIGHT_G,
} from '@waselect/shared';
import {
  BLOCKED_CUSTOMS_WORDS,
  CATEGORY_LABELS,
  PRODUCT_CATEGORY,
  hsCodeShapeOk,
  productConflictRows,
  productFormWarnings,
  emptyProductForm,
  productFormErrors,
  productFormSummary,
  productFormModel,
  productRows,
  withStatus,
  toProductInput,
  PRODUCT_STATUS,
  moveImage,
  makeMainImage,
  parseStockEdit,
  withStock,
  serverFieldError,
} from './view.js';

/** 像真的商品（约束三：真实日文品名、真实价位与重量）。 */
const PRODUCT = {
  id: 'p-shiro-cleansing-oil',
  title: '資生堂 クレンジングオイル 200ml',
  category: 'beauty',
  price_jpy: 3600,
  cost_jpy: 2400,
  weight_g: 260,
  stock: 12,
  status: 'active',
  description: '洗い流し不要のクレンジングオイル。',
  customs_desc_en: 'Cleansing oil 200ml',
  origin_country: 'JP',
  hs_code: '3304.99',
  title_ja: '資生堂 クレンジングオイル',
  jan_code: '4901872071234',
  purchase_source: 'cosme.net',
  compliance_tags: ['cosmetic', 'liquid'],
  images: [{ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' }],
  updated_at: '2026-09-27T00:00:00Z',
  // 编辑口径三列（020）：下行键名无前缀，与上面的 compliance_tags 是两套东西
  why: '洗い流し不要なので、ダブル洗顔の手間が一つ消える。',
  maker: '資生堂 掛川工場',
  tags: ['無香料', 'マツエク可'],
};

describe('productRows（列表行）', () => {
  it('字段透传 + 金额/库存/状态文案', () => {
    const [row] = productRows([PRODUCT]);
    expect(row).toEqual({
      id: 'p-shiro-cleansing-oil',
      title: '資生堂 クレンジングオイル 200ml',
      categoryLabel: '美妆护肤',
      priceText: '3,600 円', // P2-52：与订单页同一个 moneyText（千分位）
      stockText: '12',
      status: 'active',
      statusText: '在售',
      online: true,
      thumb: '', // 夹具无图
      lowStock: false, // 夹具库存 12
    });
  });

  it('首图缩略图：取 images[0].thumb；只收 http(s)（三端联动模拟 2026-10-08）', () => {
    const img = {
      image_id: 'x',
      thumb: 'http://localhost:3000/dev-img/img/x/thumb.webp',
      card: 'c',
      detail: 'd',
    };
    expect(productRows([{ ...PRODUCT, images: [img] }])[0]?.thumb).toBe(img.thumb);
    expect(
      productRows([{ ...PRODUCT, images: [{ thumb: 'javascript:alert(1)' }] }])[0]?.thumb,
    ).toBe('');
  });

  it('⚠️ 状态不在枚举内 → 按 offline 处理但**保留原值**（不静默改数据）', () => {
    const row = productRows([{ ...PRODUCT, status: 'brand_new' }])[0];
    expect(row?.status).toBe('offline');
    expect(row?.online).toBe(false);
    expect(row?.statusText).toBe('已下架');
  });

  it('缺字段降级：价格/库存非整数 → —（不把脏数据渲染成数字）', () => {
    const row = productRows([{ id: 'x', status: 'offline' }])[0];
    expect(row?.priceText).toBe('—');
    expect(row?.stockText).toBe('—');
  });

  it('脏输入：null / 非数组 / 无 id 的行丢掉', () => {
    expect(productRows(null)).toEqual([]);
    expect(productRows('x')).toEqual([]);
    expect(productRows([{ title: 'no id' }, PRODUCT])).toHaveLength(1);
  });
});

describe('emptyProductForm / productFormModel', () => {
  it('空表单：默认分类与产地正确', () => {
    const f = emptyProductForm();
    expect(f.category).toBe(PRODUCT_CATEGORY[0]);
    expect(f.originCountry).toBe('JP');
    expect(f.complianceTags).toEqual([]);
    expect(f.editorialWhy).toBe('');
    expect(f.editorialMaker).toBe('');
    expect(f.editorialTags).toEqual([]);
    expect(f.images).toEqual([]);
  });

  it('编辑态：服务端对象 → 表单（数值转字符串）', () => {
    const f = productFormModel(PRODUCT);
    expect(f.priceJpy).toBe('3600');
    expect(f.weightG).toBe('260');
    expect(f.customsDescEn).toBe('Cleansing oil 200ml');
    expect(f.complianceTags).toEqual(['cosmetic', 'liquid']);
    // ⚠️ 编辑口径三列**必须**进表单：漏了就随 PUT 整行覆盖被抹成 null（@see 下方 describe）
    expect(f.editorialWhy).toBe('洗い流し不要なので、ダブル洗顔の手間が一つ消える。');
    expect(f.editorialMaker).toBe('資生堂 掛川工場');
    expect(f.editorialTags).toEqual(['無香料', 'マツエク可']);
    expect(f.images).toEqual([{ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' }]);
  });

  it('🔴 编辑口径三列：缺列 → 空值（不是"保持原值"，PUT 会写空）', () => {
    // 这条不是"降级就行"：它描述的是当前行为，而下面的 toProductInput 用例
    // 钉住的是"即便降级成空，也必须**带着**发出去"——空是明确的清空，
    // 不带则是"服务端兜 null"，两者日志不同（@see view.ts 的 @why）。
    expect(productFormModel({ ...PRODUCT, why: undefined }).editorialWhy).toBe('');
    expect(productFormModel({ ...PRODUCT, maker: null }).editorialMaker).toBe('');
    expect(productFormModel({ ...PRODUCT, tags: '無香料' }).editorialTags).toEqual([]);
  });

  it('脏输入：null / 字段类型不对 → 回落空值，不抛', () => {
    expect(productFormModel(null).title).toBe('');
    expect(productFormModel({ price_jpy: 3600.5 }).priceJpy).toBe('');
    expect(productFormModel({ compliance_tags: 'cosmetic' }).complianceTags).toEqual([]);
    expect(productFormModel({ images: [null] }).images).toEqual([
      { thumb: '', card: '', detail: '' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AJ-362（0.6.29）：商品图提交 `image_id`，三档 URL 只留在表单里做预览
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 第一条与第二条是一件事的两半：**存** id 与**回显** id。只做前者的后果是——
//      编辑页拿不到 id ⇒ 保存只能发回三档 URL ⇒ 一次"只改标题的编辑"就把商品
//      静默退回旧形态（业务表里又存回了存储位置），而运营看到的是"保存成功、图还在"。
describe('AJ-362：images 的提交形态', () => {
  it('有 image_id → 只发 {image_id}，三档 URL 一个都不带（带上是混填 → 40001）', () => {
    const out = toProductInput(
      productFormModel({
        images: [{ image_id: 'img-abc', thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }],
      }),
    );
    expect(out['images']).toEqual([{ image_id: 'img-abc' }]);
  });

  it('🔴 编辑往返：服务端回显的 image_id 经表单往返后**仍是** image_id（不许退回 URL）', () => {
    // @why 这条是第二步的**成立前提**。0.6.28 的读路径会丢掉 image_id（AJ-362 前半修掉），
    //      丢了的形态正是"保存成功、图还在、但库里又变回 URL"——没有任何一方报错，
    //      而它恰好发生在运营第一次编辑这个商品的时候。
    const row = {
      ...PRODUCT,
      images: [{ image_id: 'img-abc', thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }],
    };
    expect(toProductInput(productFormModel(row))['images']).toEqual([{ image_id: 'img-abc' }]);
  });

  it('🔴 隔离「回显」这一半：productFormModel 直接保留 image_id（不经 toProductInput）', () => {
    // @why 上面两条走的是**整条往返**，于是"读侧丢 id"与"提交时没丢 URL"两处退化
    //      **撞在同一对用例上**（实测两次注入给出完全相同的两条红）——红灯出现了，
    //      却说不清是哪一处坏了。这条只断言映射层，把"回显"单独钉住。
    //      ⚠️ 反过来**隔离不了"提交"那一半**：`toProductInput` 内部的 `asForm` 会把
    //      images 再过一遍 `productFormModel`（view.ts 就是这么实现的），
    //      所以任何走 `toProductInput` 的用例都必然同时经过两侧——
    //      这是本条用例存在的原因，也是它只能钉一半的原因。
    expect(
      productFormModel({
        images: [{ image_id: 'img-abc', thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }],
      }).images,
    ).toEqual([{ image_id: 'img-abc', thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }]);
  });

  it('存量条目（按三档 URL 存）→ 没有 image_id，提交形态照旧（不自动迁移）', () => {
    expect(toProductInput(productFormModel(PRODUCT))['images']).toEqual([
      { thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' },
    ]);
  });

  it('空串 image_id 按"没有"处理（服务端回显的是键缺席，不是给个空串）', () => {
    const out = toProductInput(
      productFormModel({
        images: [{ image_id: '', thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }],
      }),
    );
    expect(out['images']).toEqual([{ thumb: 't.webp', card: 'c.webp', detail: 'd.webp' }]);
  });
});

describe('P2-51 数值不收科学计数法 / HS 编码形状 / 成本≥售价提醒', () => {
  const base = (): ReturnType<typeof productFormModel> => productFormModel(PRODUCT);

  it('1e3 这类科学计数法 → 拒，并点明原因', () => {
    for (const key of ['priceJpy', 'weightG', 'stock', 'costJpy'] as const) {
      const r = productFormErrors({ ...base(), [key]: '1e3' });
      expect(r.errors[key], key).toContain('科学计数法');
    }
  });

  it.each([
    ['6912.00', true],
    ['330499', true],
    ['3304995000', true],
    ['3304', false],
    ['3304,99', false],
    ['HS330499', false],
    ['33049950001', false],
  ])('hsCodeShapeOk(%s) → %s', (raw, ok) => {
    expect(hsCodeShapeOk(raw)).toBe(ok);
  });

  it('HS 编码形状不对 → 报错；带点号的 10 位 HTS（12 字符）可录（迁移 031 列宽 16，AJ-386）', () => {
    expect(productFormErrors({ ...base(), hsCode: '3304,99' }).errors['hsCode']).toContain(
      '6–10 位数字',
    );
    expect(productFormErrors({ ...base(), hsCode: '3304.99.5000' }).errors['hsCode']).toBe(
      undefined,
    );
  });

  it('成本 ≥ 售价只提醒不拦截', () => {
    const f = { ...base(), priceJpy: '1000', costJpy: '1000' };
    expect(productFormErrors(f).ok).toBe(true);
    expect(productFormWarnings(f)[0]).toContain('不低于售价');
    expect(productFormWarnings({ ...f, costJpy: '999' })).toEqual([]);
    expect(productFormWarnings({ ...f, costJpy: '' })).toEqual([]);
  });

  it('productConflictRows：逐字段对照，标出不同项', () => {
    const rows = productConflictRows({ ...base(), priceJpy: '9999' }, PRODUCT);
    const price = rows.find((r) => r.label === '售价（円）');
    expect(price).toMatchObject({ mine: '9999', differs: true });
    expect(rows.find((r) => r.label === '商品名')?.differs).toBe(false);
  });
});

describe('productFormErrors（上架预检）', () => {
  it('合法表单 → 无错误', () => {
    expect(productFormErrors(productFormModel(PRODUCT))).toEqual({
      ok: true,
      errors: {},
      first: '',
    });
  });

  /**
   * 顶部错误条**不得**重复第一条原文。
   * @why 详情已经显示在各自字段下方，顶部再来一遍「商品名必填」，
   *      同一句在同一屏出现两次——运营会以为有两个同名商品名字段
   *      （三端联动模拟 2026-10-08 实机）。
   */
  it('🔴 多条错误时顶部只报条数，不再复述第一条原文', () => {
    const empty = productFormErrors({});
    expect(empty.ok).toBe(false);
    expect(Object.keys(empty.errors).length).toBeGreaterThan(1);
    const top = productFormSummary(empty.errors, empty.first);
    expect(top).not.toContain(empty.first);
    expect(top).toContain('需要修正');
    // 条数必须与 errors 的键数一致，不能写一个与实际不符的数字
    expect(top).toContain(String(Object.keys(empty.errors).length));
  });

  it('只有一条错误时照旧给原文（聚合没有意义，不该丢了具体原因）', () => {
    const one = productFormErrors({ ...productFormModel(PRODUCT), title: '   ' });
    expect(Object.keys(one.errors)).toEqual(['title']);
    expect(productFormSummary(one.errors, one.first)).toBe(one.first);
  });

  it('⚠️ 禁售标签勾上 → 报出来（shared 的 BLOCKED_COMPLIANCE_TAG 是真源）', () => {
    const r = productFormErrors({
      ...productFormModel(PRODUCT),
      complianceTags: ['cosmetic', 'sunscreen'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors['complianceTags']).toContain('sunscreen');
  });

  it('⚠️ 七个禁售标签**每一个**都被拒（漏一个就是一条静默失效的合规拦截）', () => {
    for (const tag of BLOCKED_COMPLIANCE_TAG) {
      const r = productFormErrors({ ...productFormModel(PRODUCT), complianceTags: [tag] });
      expect(r.ok, `${tag} 没被拒`).toBe(false);
    }
  });

  it('可标记标签（liquid/battery/cosmetic/food）**不**报', () => {
    const allowed = COMPLIANCE_TAG.filter(
      (t) => !(BLOCKED_COMPLIANCE_TAG as readonly string[]).includes(t),
    );
    expect(allowed).toEqual(['liquid', 'battery', 'cosmetic', 'food']);
    expect(productFormErrors({ ...productFormModel(PRODUCT), complianceTags: allowed }).ok).toBe(
      true,
    );
  });

  it('⚠️ 编辑标签**不受**合规枚举约束（自由文案；拿枚举值去套会把"南部铁器"拒掉）', () => {
    const r = productFormErrors({
      ...productFormModel(PRODUCT),
      editorialTags: ['南部鉄器', '直火OK'],
    });
    expect(r.ok).toBe(true);
  });

  it('编辑标签含空串 → 拒（服务端 tags_invalid 会拒整条请求，十几个字段白填）', () => {
    const r = productFormErrors({
      ...productFormModel(PRODUCT),
      editorialTags: ['南部鉄器', '  '],
    });
    expect(r.ok).toBe(false);
    expect(r.errors['editorialTags']).toContain('空标签');
  });

  /**
   * 工程缺口第二轮 §3.6 #2：其余六个文本字段原先没有长度预检——超长提交拿到的是泛化 40001
   * （响应体只回 code/message，reason 只进日志），运营看不出是哪一栏太长。
   */
  it.each([
    ['title', 'title'],
    ['customsDescEn', 'customs_desc_en'],
    ['hsCode', 'hs_code'],
    ['titleJa', 'title_ja'],
    ['janCode', 'jan_code'],
    ['purchaseSource', 'purchase_source'],
  ] as const)('🔴 %s 超过 PRODUCT_MAX_CHARS.%s → 该栏报错且带出上限', (field, key) => {
    const err = productFormErrors({
      ...productFormModel(PRODUCT),
      // HS 码纯数字超 10 位先被形状检查拦下；用点号分段凑长度，才走得到列宽检查（形状合法、17 字）
      [field]:
        field === 'hsCode'
          ? `${'1.'.repeat(PRODUCT_MAX_CHARS[key] / 2)}1`
          : '1'.repeat(PRODUCT_MAX_CHARS[key] + 1),
    }).errors[field];
    expect(err).toContain(String(PRODUCT_MAX_CHARS[key]));
  });

  it('🔴 重量超过单件上界（shared PRODUCT_MAX_WEIGHT_G）→ 该栏报错', () => {
    const err = productFormErrors({
      ...productFormModel(PRODUCT),
      weightG: String(PRODUCT_MAX_WEIGHT_G + 1),
    }).errors['weightG'];
    expect(err).toContain(String(PRODUCT_MAX_WEIGHT_G));
  });

  it('⚠️ why / maker 超限 → 拒（上限从 shared 取，不写死 200 / 120）', () => {
    expect(
      productFormErrors({
        ...productFormModel(PRODUCT),
        editorialWhy: 'あ'.repeat(PRODUCT_MAX_CHARS.why + 1),
      }).errors['editorialWhy'],
    ).toContain(String(PRODUCT_MAX_CHARS.why));
    expect(
      productFormErrors({
        ...productFormModel(PRODUCT),
        editorialMaker: 'あ'.repeat(PRODUCT_MAX_CHARS.maker + 1),
      }).errors['editorialMaker'],
    ).toContain(String(PRODUCT_MAX_CHARS.maker));
  });

  it('why / maker 恰好到上限 → 放行（边界是"≤"不是"<"）', () => {
    expect(
      productFormErrors({
        ...productFormModel(PRODUCT),
        editorialWhy: 'あ'.repeat(PRODUCT_MAX_CHARS.why),
        editorialMaker: 'あ'.repeat(PRODUCT_MAX_CHARS.maker),
      }).ok,
    ).toBe(true);
  });

  it('⚠️ 报关品名含敏感词 → 拒（大小写不敏感）', () => {
    for (const w of BLOCKED_CUSTOMS_WORDS) {
      const r = productFormErrors({
        ...productFormModel(PRODUCT),
        customsDescEn: `Cleansing ${w.toUpperCase()} oil`,
      });
      expect(r.ok, `${w} 没被拒`).toBe(false);
      expect(r.errors['customsDescEn']).toContain('敏感词');
    }
  });

  it('必填与数值：售价/重量/库存/品名/分类各自有提示', () => {
    const r = productFormErrors(emptyProductForm());
    expect(Object.keys(r.errors).sort()).toEqual(
      // 新建库存默认留空 → 也要报"库存必填"（三端联动 UI 模拟 2026-10-08：原先默认 0，直接输入得 "030"）
      [
        'category'.slice(0, 0) + 'customsDescEn',
        'hsCode',
        'priceJpy',
        'stock',
        'title',
        'weightG',
      ].sort(),
    );
    expect(r.first).toBe(r.errors['title']);
  });

  it('HS 编码所有商品必填，纯空白也算没填（剩余清单 1-4，与服务端同口径）', () => {
    expect(
      productFormErrors({ ...productFormModel(PRODUCT), hsCode: '' }).errors['hsCode'],
    ).toContain('必填');
    expect(productFormErrors({ ...productFormModel(PRODUCT), hsCode: '  ' }).ok).toBe(false);
  });

  it('⚠️ 原产地非 JP → 拒（MVP 只接受 JP，D-42/D-43）', () => {
    expect(productFormErrors({ ...productFormModel(PRODUCT), originCountry: 'CN' }).ok).toBe(false);
  });

  it('多字段同时错 → 全部返回（不是一个一个报，让运营提交十几次）', () => {
    const r = productFormErrors({ ...emptyProductForm(), title: 'x' });
    expect(Object.keys(r.errors).length).toBeGreaterThan(1);
  });
});

describe('toProductInput（请求体）', () => {
  it('字段按契约命名，数值已转 number，空串字段不塞 null', () => {
    const body = toProductInput(productFormModel(PRODUCT));
    expect(body).toEqual({
      title: '資生堂 クレンジングオイル 200ml',
      category: 'beauty',
      price_jpy: 3600,
      cost_jpy: 2400,
      weight_g: 260,
      stock: 12,
      description: '洗い流し不要のクレンジングオイル。',
      customs_desc_en: 'Cleansing oil 200ml',
      origin_country: 'JP',
      hs_code: '3304.99',
      title_ja: '資生堂 クレンジングオイル',
      jan_code: '4901872071234',
      purchase_source: 'cosme.net',
      compliance_tags: ['cosmetic', 'liquid'],
      why: '洗い流し不要なので、ダブル洗顔の手間が一つ消える。',
      maker: '資生堂 掛川工場',
      tags: ['無香料', 'マツエク可'],
      images: [{ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' }],
    });
  });

  /**
   * 🔴 这是本轮修复要钉的**回归本身**（020 迁移引入，2026-10-05 修）。
   *
   * 背景：`PUT /admin/products/{id}` 是**整行覆盖**。表单若不回传编辑口径三列，
   * 服务端就按"省略 → null / []"写入 ⇒ 运营改个价格点保存，
   * 编辑撰写的 `why` 被抹掉，**不报错、无提示、无法回滚**（商品没有历史版本表）。
   */
  it('🔴 编辑态只改价格：why / maker / tags **原样回传**（PUT 整行覆盖，不回传 = 抹掉）', () => {
    const f = productFormModel(PRODUCT);
    const body = toProductInput({ ...f, priceJpy: '3980' }, f.stock);
    expect(body['price_jpy']).toBe(3980);
    expect(body['why']).toBe(PRODUCT.why);
    expect(body['maker']).toBe(PRODUCT.maker);
    expect(body['tags']).toEqual(PRODUCT.tags);
  });

  it('🔴 编辑口径三列在**清空**时也带着（空串/空数组 = 明确的清空，不是"没填"）', () => {
    const f = productFormModel(PRODUCT);
    const body = toProductInput(
      { ...f, editorialWhy: '', editorialMaker: '', editorialTags: [] },
      f.stock,
    );
    expect(body['why']).toBe('');
    expect(body['maker']).toBe('');
    expect(body['tags']).toEqual([]);
  });

  it('🔴 新建态：三列恒带（空串也会发，服务端 `?? null` 只在 undefined 时兜）', () => {
    const body = toProductInput(emptyProductForm());
    expect(body['why']).toBe('');
    expect(body['maker']).toBe('');
    expect(body['tags']).toEqual([]);
  });

  it('编辑标签两端空格 → 提交时 trim（否则卡片上出现对不齐的方块）', () => {
    const body = toProductInput({ ...productFormModel(PRODUCT), editorialTags: [' 南部鉄器 '] });
    expect(body['tags']).toEqual(['南部鉄器']);
  });

  it('⚠️ 合规标签与编辑标签**各行其道**（写错前缀会把禁售枚举印到买家卡片上）', () => {
    const body = toProductInput({
      ...productFormModel(PRODUCT),
      complianceTags: ['liquid'],
      editorialTags: ['南部鉄器'],
    });
    expect(body['compliance_tags']).toEqual(['liquid']);
    expect(body['tags']).toEqual(['南部鉄器']);
  });

  it('⚠️ origin_country **强制 JP**（表单里出现别值也不照抄）', () => {
    expect(
      toProductInput({ ...productFormModel(PRODUCT), originCountry: 'CN' }).origin_country,
    ).toBe('JP');
  });

  it('编辑时库存**没改** → 不带 stock（服务端保持原值，不覆盖期间的下单扣减，AJ-175）', () => {
    const f = productFormModel(PRODUCT);
    const body = toProductInput({ ...f, title: '改个标题' }, f.stock);
    expect(body['stock']).toBeUndefined();
    expect(body['title']).toBe('改个标题');
  });

  it('编辑时库存**改了** → 带新值；新建（不传原值）→ 照常带', () => {
    const f = productFormModel(PRODUCT);
    expect(toProductInput({ ...f, stock: '30' }, f.stock)['stock']).toBe(30);
    expect(toProductInput(f)['stock']).toBe(12);
  });

  it('🔴 改了库存 → 带 expected_stock = 打开时的原值（P2-8）；没改 / 新建 → 不带', () => {
    const f = productFormModel(PRODUCT);
    expect(toProductInput({ ...f, stock: '30' }, f.stock)['expected_stock']).toBe(12);
    expect(toProductInput({ ...f, title: 'x' }, f.stock)['expected_stock']).toBeUndefined();
    expect(toProductInput(f)['expected_stock']).toBeUndefined();
  });

  it('成本价留空 → 不带该字段（不是塞 0，0 会被当成"零成本"）', () => {
    const body = toProductInput({ ...productFormModel(PRODUCT), costJpy: '' });
    expect(body['cost_jpy']).toBeUndefined();
  });
});

/**
 * ⚠️ 与契约的双向比对：分类 key 必须**恰好等于**契约里的枚举。
 * @limitation 一 已写明它与小程序的 CATEGORY_LABELS 是两份真源，各自由本类断言守着。
 */
describe('PRODUCT_CATEGORY 与契约的双向比对', () => {
  const yaml = readFileSync(
    resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
    'utf8',
  );

  it('契约里 category 的枚举与本模块一致', () => {
    // 契约 `/products` 的 category 参数与 ProductInput 都引用同一枚举；取 admin/products 之外
    // 的那处声明（`/products` 的 query enum）做比对，避免只比对到自己。
    const m = /name: category, in: query, schema: \{type: string, enum: \[([^\]]+)\]\}/.exec(yaml);
    expect(m?.[1], '契约里没找到 /products 的 category enum').toBeTruthy();
    const contract = (m?.[1] ?? '').split(',').map((s) => s.trim());
    expect([...PRODUCT_CATEGORY].sort()).toEqual([...contract].sort());
  });

  it('每个分类都有非空展示名（空串 = 列表页上一列空白）', () => {
    for (const c of PRODUCT_CATEGORY) {
      expect(CATEGORY_LABELS[c], `${c} 没有展示名`).not.toBe('');
    }
  });
});

describe('withStatus：状态的三个展示字段一起改（AJ-231）', () => {
  const [row] = productRows([
    { id: 'p-1', title: 'x', category: 'beauty', price_jpy: 100, stock: 1, status: 'active' },
  ]);
  if (row === undefined) throw new Error('前置不成立：productRows 应产出一行');

  it('🔴 改成 offline：status / statusText / online 三个都变（漏一个就是"文案说在售、按钮说上架"）', () => {
    expect(withStatus(row, 'offline')).toMatchObject({
      status: 'offline',
      statusText: '已下架',
      online: false,
    });
  });

  it('改回 active 与 productRows 的产出逐字段一致（回滚用的就是它）', () => {
    expect(withStatus(withStatus(row, 'offline'), 'active')).toEqual(row);
  });

  it('不改其它字段、不改入参', () => {
    const next = withStatus(row, 'offline');
    expect(next.title).toBe(row.title);
    expect(row.statusText).toBe('在售');
  });
});

/** 库存框清空不能被当成 0（A-06）：`Number('') === 0` 会让"清空重打"的商品直接售罄。 */
describe('productFormErrors：库存必填（A-06）', () => {
  it.each(['', ' '])('库存为 %j → 报"库存必填"', (stock) => {
    const r = productFormErrors({ ...productFormModel(PRODUCT), stock });
    expect(r.ok).toBe(false);
    expect(r.errors['stock']).toContain('必填');
  });
  it('库存 0 仍然合法（真的卖完了）', () => {
    expect(productFormErrors({ ...productFormModel(PRODUCT), stock: '0' }).ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AJ-403（第二批 C）：草稿状态 / 图片排序 / 列表内联改库存
// ═══════════════════════════════════════════════════════════════════════════

describe('草稿状态（AJ-403）', () => {
  it('🔴 PRODUCT_STATUS 与契约 AdminProduct.status 枚举逐字一致（双向）', () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
      'utf8',
    );
    const m = /AdminProduct: .*?status: \{type: string, enum: \[([^\]]+)\]/.exec(yaml);
    expect(m?.[1], '契约里没找到 AdminProduct.status 的 enum').toBeTruthy();
    const contract = (m?.[1] ?? '').split(',').map((s) => s.trim());
    expect([...PRODUCT_STATUS].sort()).toEqual(contract.sort());
  });

  it('🔴 draft 行：状态列「草稿」、online=false（按钮是"上架"），不被折叠成"已下架"', () => {
    const row = productRows([{ ...PRODUCT, status: 'draft' }])[0];
    expect(row).toMatchObject({ status: 'draft', statusText: '草稿', online: false });
  });

  it('withStatus 草稿 → 在售：三个展示字段一起变', () => {
    const row = productRows([{ ...PRODUCT, status: 'draft' }])[0]!;
    expect(withStatus(row, 'active')).toMatchObject({
      status: 'active',
      statusText: '在售',
      online: true,
    });
  });
});

describe('图片排序 moveImage / makeMainImage（AJ-403：数组顺序即展示顺序，第一张是主图）', () => {
  const img = (k: string) => ({
    image_id: `img-${k}`,
    thumb: `${k}.t`,
    card: `${k}.c`,
    detail: `${k}.d`,
  });
  const A = img('a');
  const B = img('b');
  const C = img('c');
  const ids = (xs: Array<{ image_id?: string }>) => xs.map((x) => x.image_id);

  it.each([
    [0, 1, ['img-b', 'img-a', 'img-c']], // 下移
    [2, 1, ['img-a', 'img-c', 'img-b']], // 上移
    [0, 2, ['img-b', 'img-c', 'img-a']], // 跨两格
    [0, -1, ['img-a', 'img-b', 'img-c']], // 已在最前再上移：不动
    [2, 3, ['img-a', 'img-b', 'img-c']], // 已在最后再下移：不动
    [5, 0, ['img-a', 'img-b', 'img-c']], // 源下标越界：不动
    [1, 1, ['img-a', 'img-b', 'img-c']], // 原地
  ])('moveImage(%i → %i)', (from, to, expected) => {
    const src = [A, B, C];
    expect(ids(moveImage(src, from, to))).toEqual(expected);
    expect(ids(src)).toEqual(['img-a', 'img-b', 'img-c']); // 不改入参
  });

  it('makeMainImage：第三张设为主图 = 移到第一张，其余相对顺序不变', () => {
    expect(ids(makeMainImage([A, B, C], 2))).toEqual(['img-c', 'img-a', 'img-b']);
    expect(ids(makeMainImage([A, B, C], 0))).toEqual(['img-a', 'img-b', 'img-c']);
    expect(ids(makeMainImage([A, B, C], 9))).toEqual(['img-a', 'img-b', 'img-c']);
  });

  it('🔴 排完序后 toProductInput 按新顺序提交（主图是第一张）', () => {
    const form = { ...productFormModel(PRODUCT), images: makeMainImage([A, B, C], 2) };
    expect(toProductInput(form, '12')['images']).toEqual([
      { image_id: 'img-c' },
      { image_id: 'img-a' },
      { image_id: 'img-b' },
    ]);
  });
});

describe('parseStockEdit：列表内联改库存的即时判定（AJ-403）', () => {
  it.each([
    ['0', 0],
    ['30', 30],
    [' 7 ', 7],
    [String(PRODUCT_MAX_STOCK), PRODUCT_MAX_STOCK],
  ])('合法 %j → %i', (raw, value) => {
    expect(parseStockEdit(raw)).toEqual({ ok: true, value });
  });

  it.each(['', '  ', '-1', '1.5', '1e3', 'abc', '0x10', String(PRODUCT_MAX_STOCK + 1)])(
    '不合法 %j → 带人话的错误',
    (raw) => {
      const r = parseStockEdit(raw);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toMatch(/库存/);
    },
  );
});

describe('withStock：库存的两个展示字段一起改（AJ-403）', () => {
  it.each([
    [LOW_STOCK_THRESHOLD, true],
    [LOW_STOCK_THRESHOLD + 1, false],
    [0, true],
  ])('stock=%i → lowStock=%s，stockText 跟着变', (stock, low) => {
    const row = productRows([{ ...PRODUCT, stock: 100 }])[0]!;
    expect(withStock(row, stock)).toEqual({ ...row, stockText: String(stock), lowStock: low });
  });
});

// AJ-488（三端模拟测试 2026-10-11）：售价填 999,999 保存只见"参数缺失或格式错误"；服务端 40001 现带 {field, reason, count}
describe('serverFieldError：服务端校验原因 → 表单字段 + 人话', () => {
  it('🔴 认得出的原因落到对应输入框，文案说清怎么改；多处出错时提示还有几处', () => {
    // 用户截图指出：只说"超过上限"不说上限是多少，运营不知道该调到多少
    expect(
      serverFieldError({ field: 'price_jpy', reason: 'price_too_large', count: 1, limit: 180000 }),
    ).toEqual({
      key: 'priceJpy',
      text: '售价超过单笔订单上限（最多 180,000 円），买家无法下单——请调低售价',
      more: 0,
    });
    // 没带上限（旧服务端）：仍说清原因，只是不报数字
    expect(
      serverFieldError({ field: 'price_jpy', reason: 'price_too_large', count: 1 })?.text,
    ).toBe('售价超过单笔订单上限，买家无法下单——请调低售价');
    expect(
      serverFieldError({ field: 'customs_desc_en', reason: 'customs_desc_forbidden', count: 3 }),
    ).toMatchObject({ key: 'customsDescEn', more: 2 });
    expect(
      serverFieldError({ field: 'weight_g', reason: 'weight_too_large', count: 1 })?.text,
    ).toContain('重量');
  });

  it('认不出的原因：仍落到字段上，文案给通用说法（不吞掉、不显示原因码）', () => {
    const r = serverFieldError({ field: 'title', reason: 'brand_new_reason', count: 1 });
    expect(r?.key).toBe('title');
    expect(r?.text).not.toContain('brand_new_reason');
    expect(r?.text).toContain('商品名');
  });

  it('没有 data / 形状不对 → null（页面退回原来的笼统提示）', () => {
    expect(serverFieldError(undefined)).toBeNull();
    expect(serverFieldError({ reason: 'x' })).toBeNull();
  });
});
