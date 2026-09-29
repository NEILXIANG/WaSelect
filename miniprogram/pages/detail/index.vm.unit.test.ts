/**
 * 职责：商品详情页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的都是"错了不报错"的事：
 *      ① images 为空数组 → 轮播整个消失，页面看起来"没加载完"而不是"没有图"；
 *      ② 报关字段（hs_code 等）被透出 → 用户看到 quasi_drug 之类标签只会产生疑问；
 *      ③ 描述是空白字符串 → 留一个空段落，页面像坏了一样。
 *
 * @see ../index.vm.js；../../../CLAUDE.md 约束十一
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_IMAGE } from '../../utils/placeholder.js';
import { detailView } from './index.vm.js';

/** 像真的商品（契约 Product 全形状：报关字段在，但视图不该透出它们）。 */
const PRODUCT = {
  id: 'p-shiro-cleansing-oil',
  title: '資生堂 クレンジングオイル 200ml',
  category: 'beauty',
  price_jpy: 3600,
  display: { USD: 2450, CNY: 17600 },
  image: { thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' },
  images: [
    {
      thumb: 'https://img.example.com/p1/thumb.jpg',
      card: 'https://img.example.com/p1/card.jpg',
      detail: 'https://img.example.com/p1/detail.jpg',
    },
    'https://img.example.com/p1/alt.jpg',
  ],
  stock: 12,
  status: 'active',
  description: '  天然オイル配合、肌を傷めないクレンジング。  ',
  weight_g: 850,
  compliance_tags: ['cosmetic'],
  hs_code: '3307.90',
  customs_desc_en: 'cleansing oil',
  origin_country: 'JP',
};

describe('detailView（主数据）', () => {
  it('标题 / 价格透传、副行走 displaySubLine、售罄为 false', () => {
    const v = detailView(PRODUCT);
    expect(v.title).toBe('資生堂 クレンジングオイル 200ml');
    expect(v.priceJpy).toBe(3600);
    expect(v.subPrice).toBe('≈ $24.50 · ≈ ¥176.00');
    expect(v.soldOut).toBe(false);
  });

  it('⚠️ price_jpy 原样透传，不兜底（补 0 会显示 `0 円`，那会被读成免费）', () => {
    expect(detailView({ ...PRODUCT, price_jpy: undefined }).priceJpy).toBeUndefined();
  });

  it('stock=0 → soldOut=true', () => {
    expect(detailView({ ...PRODUCT, stock: 0 }).soldOut).toBe(true);
  });
});

describe('detailView（图片）', () => {
  it('每条图取 card；裸字符串条目直接用（存量形态不炸）', () => {
    expect(detailView(PRODUCT).images).toEqual([
      'https://img.example.com/p1/card.jpg',
      'https://img.example.com/p1/alt.jpg',
    ]);
  });

  it('⚠️ images 缺失 / 空数组 / 全是空串 → [占位图]（不是空数组——轮播会整个消失）', () => {
    for (const images of [undefined, null, [], [{ thumb: '', card: '', detail: '' }], '']) {
      expect(detailView({ ...PRODUCT, images }).images).toEqual([PLACEHOLDER_IMAGE]);
    }
  });

  it('单条图的 card 缺失 → 退化 thumb/detail，不落占位图', () => {
    expect(
      detailView({ ...PRODUCT, images: [{ thumb: 't.jpg', card: '', detail: '' }] }).images,
    ).toEqual(['t.jpg']);
  });
});

describe('detailView（描述与规格）', () => {
  it('描述去首尾空白；空白字符串 → 空串（wxml 整段隐藏，不留空段落）', () => {
    expect(detailView(PRODUCT).description).toBe('天然オイル配合、肌を傷めないクレンジング。');
    expect(detailView({ ...PRODUCT, description: '   ' }).description).toBe('');
    expect(detailView({ ...PRODUCT, description: undefined }).description).toBe('');
  });

  it('规格：原产地 JP → 「日本」（卖点文案，不是 ISO 码）+ 重量「约 N g」', () => {
    expect(detailView(PRODUCT).specs).toEqual([
      { label: '原产地', value: '日本' },
      { label: '重量', value: '约 850 g' },
    ]);
  });

  it('⚠️ 报关合规字段（hs_code / customs_desc_en / compliance_tags）不进视图', () => {
    // @why 它们是管理员上架核对用（D-39/D-42）。给用户看 "quasi_drug" 只会制造疑问，
    //      而这个问题没有一个答案是用户能用上的。
    const v = detailView(PRODUCT);
    expect(JSON.stringify(v)).not.toContain('hs_code');
    expect(JSON.stringify(v)).not.toContain('cleansing oil');
    expect(JSON.stringify(v)).not.toContain('cosmetic');
  });

  it('weight_g 缺失 / 非正数 → 该行不出现（不是"约 0 g"）', () => {
    for (const weight_g of [undefined, 0, -1]) {
      expect(detailView({ ...PRODUCT, weight_g }).specs).toEqual([
        { label: '原产地', value: '日本' },
      ]);
    }
  });

  it('脏输入：null / 非对象 → 空壳 + 占位图，不抛', () => {
    for (const p of [null, undefined, 'x']) {
      const v = detailView(p);
      expect(v).toMatchObject({
        title: '',
        subPrice: '',
        images: [PLACEHOLDER_IMAGE],
        specs: [],
        soldOut: false,
      });
    }
  });
});

/**
 * 提审前必须的两行说明（PRD §3 商品详情 / GUI §3.2 / D-32 / D-39⑦；AJ-180）。
 * @why FTC 邮购规则：商品页写了"X 个工作日内发出"，就必须在时限内发出——数字来自服务端配置，
 *      前端不编；没有就**不出这一行**（写错的承诺比不写更糟）。
 */
describe('detailView（关税与发货时限说明）', () => {
  it('两行齐全：含美国关税 + 付款后 N 个工作日内发出（N 取自 ship_within_business_days）', () => {
    expect(detailView({ ...PRODUCT, ship_within_business_days: 7 }).notes).toEqual([
      '价格含美国关税，国际运费按重量在结算时计算',
      '付款后 7 个工作日内发出',
    ]);
  });

  it('时限缺失 / 非正整数 → 只出关税一行（不编数字）', () => {
    for (const bad of [undefined, 0, -1, 2.5, '7']) {
      expect(detailView({ ...PRODUCT, ship_within_business_days: bad }).notes).toEqual([
        '价格含美国关税，国际运费按重量在结算时计算',
      ]);
    }
  });
});
