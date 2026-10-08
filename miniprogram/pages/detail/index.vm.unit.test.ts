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
import { STOCK_REFUND_NOTE } from '../../utils/order-status.js';
import {
  ADD_TAP_GUARD_MS,
  acceptAddTap,
  addFeedback,
  buyBarView,
  buyNowItem,
  detailView,
  shareCard,
} from './index.vm.js';

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
 * M-03（AJ-405）：购买保障区——原来价格下的两行说明（关税口径 + 发货时限，AJ-180）并入这里，
 * 改成"标签 + 说明"两层；两条既有约束原样保留：关税口径一字不改、时限数字只取服务端。
 * @why FTC 邮购规则：商品页写了"X 个工作日内发出"，就必须在时限内发出——数字来自服务端配置，
 *      前端不编；没有就**不出这一条**（写错的承诺比不写更糟）。
 */
describe('detailView（购买保障，M-03）', () => {
  it('四条齐全：日本采购直邮 / 含美国关税 / N 个工作日内发出 / 缺货整单全额退款', () => {
    const g = detailView({ ...PRODUCT, ship_within_business_days: 7 }).guarantees;
    expect(g.map((x: { tag: string }) => x.tag)).toEqual([
      '日本采购 · 日本直邮',
      '价格含美国关税',
      '付款后 7 个工作日内发出',
      '缺货整单全额退款',
    ]);
    // 关税口径的说明沿用 DUTY_NOTE 原句（D-32 / D-69②，提审前必须项）
    expect(g[1]?.detail).toBe('价格含美国关税，国际运费按重量在结算时计算');
    // 缺货退款的说明与结算页、订单详情同一句（STOCK_REFUND_NOTE 真源）
    expect(g[3]?.detail).toBe(STOCK_REFUND_NOTE);
    for (const x of g) expect(x.detail, x.tag).not.toBe('');
  });

  it('🔴 时限缺失 / 非正整数 → 不出"N 个工作日"那一条（不编数字），其余三条照常', () => {
    for (const bad of [undefined, 0, -1, 2.5, '7', null]) {
      const tags = detailView({ ...PRODUCT, ship_within_business_days: bad }).guarantees.map(
        (x: { tag: string }) => x.tag,
      );
      expect(tags, String(bad)).toEqual([
        '日本采购 · 日本直邮',
        '价格含美国关税',
        '缺货整单全额退款',
      ]);
    }
  });

  it('🔴 不写无法兑现 / 需资质背书的承诺用语（AJ-295 同口径）', () => {
    const text = JSON.stringify(detailView({ ...PRODUCT, ship_within_business_days: 7 }));
    for (const w of ['正品', '保真', '包邮', '天内送达', '日达', '假一赔'])
      expect(text).not.toContain(w);
  });
});

/**
 * M-03（AJ-405 / AJ-402 Q2）：运输流程分段说明——**没有天数**。
 * @why 天数要等首批 EMS 实测后由服务端配置下发；在那之前写任何数字都是猜（写错的承诺比不写更糟）。
 */
describe('shippingSteps（运输流程分段，M-03）', () => {
  it('四段固定顺序：日本采购 → 日本发出 → 国际运输 → 清关派送', () => {
    expect(detailView(PRODUCT).shippingSteps.map((s: { title: string }) => s.title)).toEqual([
      '日本采购',
      '日本发出',
      '国际运输',
      '清关派送',
    ]);
  });

  it('🔴 任何一段都不出现阿拉伯数字（天数 / 时效在实测前一律不写）', () => {
    for (const s of detailView({ ...PRODUCT, ship_within_business_days: 7 }).shippingSteps) {
      expect(`${s.title}${s.detail}`, s.title).not.toMatch(/[0-9０-９]/);
    }
  });

  it('脏输入（null）也给出完整四段（流程是店铺事实，不随商品变）', () => {
    expect(detailView(null).shippingSteps).toHaveLength(4);
  });
});

/** M-02（AJ-405）：编辑口径三字段——与首页卡片同源；契约里都可缺（0.6.23 ②）。 */
describe('detailView（为什么值得买 / 产地匠人 / 标签，M-02）', () => {
  const EDITORIAL = {
    why: '  一瓶卸全妆，乳化快、不搓脸，敏感肌也敢天天用。 ',
    maker: '東京 · 資生堂',
    tags: ['敏感肌可用', '  ', 42, '日本药妆店常年前三'],
  };

  it('三项透出：why / maker 去首尾空白；tags 只留非空字符串（去空白）', () => {
    const v = detailView({ ...PRODUCT, ...EDITORIAL });
    expect(v.why).toBe('一瓶卸全妆，乳化快、不搓脸，敏感肌也敢天天用。');
    expect(v.maker).toBe('東京 · 資生堂');
    expect(v.tags).toEqual(['敏感肌可用', '日本药妆店常年前三']);
  });

  it('🔴 缺失（服务端整键省略）/ null / 空白 / 非字符串 → 空串与空数组，不用通用话术顶上', () => {
    for (const bad of [undefined, null, '   ', 42, {}]) {
      const v = detailView({ ...PRODUCT, why: bad, maker: bad, tags: bad });
      expect(v.why, String(bad)).toBe('');
      expect(v.maker, String(bad)).toBe('');
      expect(v.tags, String(bad)).toEqual([]);
    }
    const none = detailView(PRODUCT);
    expect([none.why, none.maker, none.tags]).toEqual(['', '', []]);
  });

  it('⚠️ 编辑标签不与报关 compliance_tags 混用（后者仍不透出）', () => {
    const v = detailView({ ...PRODUCT, ...EDITORIAL, compliance_tags: ['quasi_drug'] });
    expect(v.tags).not.toContain('quasi_drug');
    expect(JSON.stringify(v)).not.toContain('quasi_drug');
  });
});

/** 剩余清单 4-4：立即购买的单件条目、分享卡片。 */
describe('buyNowItem / shareCard（4-4）', () => {
  const view = detailView({ title: '出刃包丁 165mm', price_jpy: 12800, stock: 3, images: [] });

  it('🔴 buyNowItem：数量 1，快照与加购同形（title / image / priceJpy）；售罄或缺 id → null', () => {
    expect(buyNowItem(view, 'p-knife')).toEqual({
      productId: 'p-knife',
      qty: 1,
      title: '出刃包丁 165mm',
      image: PLACEHOLDER_IMAGE,
      priceJpy: 12800,
    });
    expect(buyNowItem({ ...view, soldOut: true }, 'p-knife')).toBeNull();
    expect(buyNowItem(view, '')).toBeNull();
    expect(buyNowItem(null, 'p-knife')).toBeNull();
  });

  it('🔴 shareCard：标题 = 商品名，路径带 id（id 做 URL 编码）；商品没拿到 → 只分享到详情页路径 + 品牌名', () => {
    expect(shareCard(view, 'p-knife')).toEqual({
      title: '出刃包丁 165mm',
      path: '/pages/detail/index?id=p-knife',
      imageUrl: PLACEHOLDER_IMAGE,
    });
    expect(shareCard(null, 'a&b')).toEqual({
      title: 'WaSelect',
      path: '/pages/detail/index?id=a%26b',
    });
  });
});

describe('加购连点守卫与结果文案（P2-37 / P2-31）', () => {
  it('第一次点（从没加过）→ 接受', () => {
    expect(acceptAddTap(undefined, 1_000_000)).toBe(true);
    expect(acceptAddTap(0, 1_000_000)).toBe(true);
  });

  it('守卫窗口内的第二下 → 忽略；过了窗口 → 接受', () => {
    const t0 = 1_000_000;
    expect(acceptAddTap(t0, t0 + 1)).toBe(false);
    expect(acceptAddTap(t0, t0 + ADD_TAP_GUARD_MS - 1)).toBe(false);
    expect(acceptAddTap(t0, t0 + ADD_TAP_GUARD_MS)).toBe(true);
  });

  it('时钟回拨（now < last）→ 接受（不把用户永久锁住）', () => {
    expect(acceptAddTap(2_000_000, 1_000_000)).toBe(true);
  });

  it('加购结果 → 页面文案：成功 / 品种已满', () => {
    expect(addFeedback({ added: true })).toEqual({ added: true, addNote: '' });
    const full = addFeedback({ added: false, reason: 'full' });
    expect(full.added).toBe(false);
    expect(full.addNote).toContain('50');
    expect(addFeedback(undefined)).toEqual({ added: false, addNote: '' });
  });
});

describe('buyBarView（M-13 底部固定购买栏，AJ-406）', () => {
  it('🔴 购物车有 3 件、未加购 → "购物车 · 3"；加购后 → "已加入购物车 · 4"（反馈就在按钮旁）', () => {
    expect(buyBarView({ cartCount: 3, added: false, soldOut: false })).toEqual({
      cartText: '购物车 · 3',
      cartAria: '购物车，共 3 件，去购物车',
      disabled: false,
    });
    expect(buyBarView({ cartCount: 4, added: true }).cartText).toBe('已加入购物车 · 4');
  });

  it('空车不显示 · 0；超过 99 件显示 99+（与 tabBar 角标同一函数）', () => {
    expect(buyBarView({ cartCount: 0 }).cartText).toBe('购物车');
    expect(buyBarView({ cartCount: 120 }).cartText).toBe('购物车 · 99+');
  });

  it('售罄 → 两个按钮禁用；脏输入 → 不抛、按空车可买处理', () => {
    expect(buyBarView({ soldOut: true }).disabled).toBe(true);
    expect(buyBarView(null)).toEqual({
      cartText: '购物车',
      cartAria: '购物车，去购物车',
      disabled: false,
    });
  });
});
