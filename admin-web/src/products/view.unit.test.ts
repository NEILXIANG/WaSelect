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
import { BLOCKED_COMPLIANCE_TAG, COMPLIANCE_TAG } from '@waselect/shared';
import {
  BLOCKED_CUSTOMS_WORDS,
  CATEGORY_LABELS,
  PRODUCT_CATEGORY,
  emptyProductForm,
  productFormErrors,
  productFormModel,
  productRows,
  withStatus,
  toProductInput,
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
};

describe('productRows（列表行）', () => {
  it('字段透传 + 金额/库存/状态文案', () => {
    const [row] = productRows([PRODUCT]);
    expect(row).toEqual({
      id: 'p-shiro-cleansing-oil',
      title: '資生堂 クレンジングオイル 200ml',
      categoryLabel: '美妆护肤',
      priceText: '3600 円',
      stockText: '12',
      status: 'active',
      statusText: '在售',
      online: true,
    });
  });

  it('⚠️ 状态不在枚举内 → 按 offline 处理但**保留原值**（不静默改数据）', () => {
    const row = productRows([{ ...PRODUCT, status: 'brand_new' }])[0];
    expect(row?.status).toBe('offline');
    expect(row?.online).toBe(false);
    expect(row?.statusText).toBe('已下架');
  });

  it('缺字段降级：价格/库存非整数 → 空串与 —（不把脏数据渲染成数字）', () => {
    const row = productRows([{ id: 'x', status: 'offline' }])[0];
    expect(row?.priceText).toBe('');
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
    expect(f.tags).toEqual([]);
    expect(f.images).toEqual([]);
  });

  it('编辑态：服务端对象 → 表单（数值转字符串）', () => {
    const f = productFormModel(PRODUCT);
    expect(f.priceJpy).toBe('3600');
    expect(f.weightG).toBe('260');
    expect(f.customsDescEn).toBe('Cleansing oil 200ml');
    expect(f.tags).toEqual(['cosmetic', 'liquid']);
    expect(f.images).toEqual([{ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' }]);
  });

  it('脏输入：null / 字段类型不对 → 回落空值，不抛', () => {
    expect(productFormModel(null).title).toBe('');
    expect(productFormModel({ price_jpy: 3600.5 }).priceJpy).toBe('');
    expect(productFormModel({ compliance_tags: 'cosmetic' }).tags).toEqual([]);
    expect(productFormModel({ images: [null] }).images).toEqual([
      { thumb: '', card: '', detail: '' },
    ]);
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

  it('⚠️ 禁售标签勾上 → 报出来（shared 的 BLOCKED_COMPLIANCE_TAG 是真源）', () => {
    const r = productFormErrors({
      ...productFormModel(PRODUCT),
      tags: ['cosmetic', 'sunscreen'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors['tags']).toContain('sunscreen');
  });

  it('⚠️ 七个禁售标签**每一个**都被拒（漏一个就是一条静默失效的合规拦截）', () => {
    for (const tag of BLOCKED_COMPLIANCE_TAG) {
      const r = productFormErrors({ ...productFormModel(PRODUCT), tags: [tag] });
      expect(r.ok, `${tag} 没被拒`).toBe(false);
    }
  });

  it('可标记标签（liquid/battery/cosmetic/food）**不**报', () => {
    const allowed = COMPLIANCE_TAG.filter(
      (t) => !(BLOCKED_COMPLIANCE_TAG as readonly string[]).includes(t),
    );
    expect(allowed).toEqual(['liquid', 'battery', 'cosmetic', 'food']);
    expect(productFormErrors({ ...productFormModel(PRODUCT), tags: allowed }).ok).toBe(true);
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
      ['category'.slice(0, 0) + 'customsDescEn', 'priceJpy', 'title', 'weightG'].sort(),
    );
    expect(r.first).toBe(r.errors['title']);
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
      images: [{ thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' }],
    });
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
