/**
 * 职责：首页 vm 的单测（约束十一要求的配套测试；`vm-guard.unit.test.ts` 会检查它存在）。
 *
 * @why 这些断言钉的都是**错了不报错**的事：
 *      ① 切分类忘了清空列表 → 美妆分类下出现厨刀（用户只会觉得这站不靠谱）；
 *      ② 到底了还在触底加载 → 每到底一次发一个必空请求（不报错，只是流量与电量）；
 *      ③ 汇率缺失时副行怎么显示 → 显示 `0.00` 会被读成"这东西不要钱"；
 *      ④ `image` 空 → `<image>` 留白，和"商品没图"在真机上无法区分。
 *
 * @why 分类枚举与契约的双向比对放在**本文件**而不是另起 contract 层测试：
 *      `vm-guard` 要求 vm 的同名配套测试必须存在，拆成两个文件会让"vm 有测试"
 *      这条规则需要再维护一份例外；这里只是 fs + 正则，不跑运行时，放 unit 层没有副作用。
 *
 * @limitation 一：本文件只测**逻辑**，不测 WXML 绑定与样式——那部分只能真机验（约束十一明说）。
 * @limitation 二：契约比对用正则解析 YAML 文本（与 `check-contract.mjs` 同口径，不引 YAML 依赖）；
 *              契约把 category 的 enum 改写成多行就会失配——那种改动本来也该被 review 拦下。
 *
 * @see ../index.vm.js；../../../CLAUDE.md 约束十一；../../../contracts/api-contract.yaml
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  PAGE_SIZE,
  PLACEHOLDER_IMAGE,
  categoryTabs,
  errorMessage,
  hasMore,
  intentForProduct,
  listQuery,
  mergeCards,
  nextPage,
  productCards,
} from './index.vm.js';

/**
 * 像真的商品（约束三：真实日文品名、真实价位、真实 ImageSet 形状）。
 * 展示价按"后端已按当日汇率算成整数分"的契约形态给，前端不做任何乘法。
 */
const ITEMS = [
  {
    id: 'p-shiro-cleansing-oil',
    title: '資生堂 クレンジングオイル 200ml',
    category: 'beauty',
    price_jpy: 3600,
    display: { USD: 2450, CNY: 17600 },
    image: {
      thumb: 'https://img.example.com/p1/thumb.jpg',
      card: 'https://img.example.com/p1/card.jpg',
      detail: 'https://img.example.com/p1/detail.jpg',
    },
    stock: 12,
    status: 'active',
  },
  {
    id: 'p-nanabun-kyusu',
    title: '南部鉄器 急須 0.6L',
    category: 'kitchen',
    price_jpy: 8800,
    display: { USD: 5980 },
    image: 'https://img.example.com/p2.jpg',
    stock: 0,
    status: 'active',
  },
];

describe('categoryTabs（分类 tab）', () => {
  it('未选分类时"全部"选中，四个分类都不选中', () => {
    const tabs = categoryTabs('');
    expect(tabs.map((t) => t.label)).toEqual(['全部', '美妆护肤', '生活百货', '厨房餐具', '食品']);
    expect(tabs.filter((t) => t.active).map((t) => t.key)).toEqual(['']);
  });

  it('选中 kitchen 时只有它 active（其余全 false，不会出现两个高亮）', () => {
    const tabs = categoryTabs('kitchen');
    expect(tabs.filter((t) => t.active)).toEqual([
      { key: 'kitchen', label: '厨房餐具', active: true },
    ]);
  });

  it('非字符串 / 未传 → 与"全部"同一形态（不是抛错，也不是全部不高亮）', () => {
    // @why 分类来自 wxml 的 `data-key`，取不到时是 undefined——那一跳若没有 tab 高亮，
    //      用户会以为"点了个寂寞"，而页面上没有任何报错。
    expect(categoryTabs(undefined).find((t) => t.active)?.key).toBe('');
    expect(categoryTabs(null).find((t) => t.active)?.key).toBe('');
  });
});

describe('productCards（列表加工）', () => {
  it('正常商品：图取 card、副行 USD · CNY 都显示、stock>0 不售罄', () => {
    const [card] = productCards(ITEMS);
    expect(card?.image).toBe('https://img.example.com/p1/card.jpg');
    expect(card?.subPrice).toBe('≈ $24.50 · ≈ ¥176.00');
    expect(card?.soldOut).toBe(false);
    expect(card?.id).toBe('p-shiro-cleansing-oil');
  });

  it('⚠️ 副行价格**小数恒两位**：`$24.5` 会被读成另一个金额', () => {
    // 2450 分 → $24.50；这条钉的是 price-format 的两位小数口径在 vm 里没被改写
    expect(productCards([{ ...ITEMS[0], display: { USD: 2450 } }])[0]?.subPrice).toBe('≈ $24.50');
  });

  it('汇率缺失时只显示能算出的币种（少 USD → 只剩 CNY，不显示 0.00）', () => {
    expect(productCards([{ ...ITEMS[0], display: { CNY: 17600 } }])[0]?.subPrice).toBe('≈ ¥176.00');
  });

  it('display 为空对象 / 缺失 / 非对象 → 副行空串（wxml 整行隐藏，不留 `≈ ` 孤零零一个符号）', () => {
    for (const display of [{}, undefined, null, 'x']) {
      expect(productCards([{ ...ITEMS[0], display }])[0]?.subPrice).toBe('');
    }
  });

  it('⚠️ 展示价是**非整数**时跳过该币而不是让整列渲染失败', () => {
    // @why 服务端 bug（返回小数）不该让首页整列空白：这里宁可少一行参考价。
    //      @see index.vm.js @limitation 三（降级 ≠ 吞错）
    const [card] = productCards([{ ...ITEMS[0], display: { USD: 24.5, CNY: 17600 } }]);
    expect(card?.subPrice).toBe('≈ ¥176.00');
  });

  it('image 缺 / 空串 / 三键皆空 → 落到占位图（不留空 src）', () => {
    const cases = [undefined, null, {}, { thumb: '', card: '  ', detail: '' }, ''];
    for (const image of cases) {
      expect(productCards([{ ...ITEMS[0], image }])[0]?.image).toBe(PLACEHOLDER_IMAGE);
    }
  });

  it('image 是**裸字符串**（服务端旧形态）→ 直接用它，不落占位图', () => {
    // @why 后端 `toImageSet` 对字符串条目会补成三尺寸同源的 ImageSet；
    //      但契约只保证最终是对象，这里对字符串宽容是为了"存量数据不炸"。
    expect(productCards([ITEMS[1]])[0]?.image).toBe('https://img.example.com/p2.jpg');
  });

  it('stock=0 → soldOut=true（售罄态由数据决定，不在 wxml 里写判断）', () => {
    expect(productCards(ITEMS)[1]?.soldOut).toBe(true);
  });

  it('⚠️ price_jpy 原样透传，不做任何兜底（补 0 会显示 `0 円`，那会被读成免费）', () => {
    expect(productCards([{ ...ITEMS[0], price_jpy: 3600 }])[0]?.priceJpy).toBe(3600);
    expect(productCards([{ ...ITEMS[0], price_jpy: undefined }])[0]?.priceJpy).toBeUndefined();
  });

  it('脏输入：items 非数组 / 元素是 null → 不炸，返回空或空壳', () => {
    expect(productCards(undefined)).toEqual([]);
    expect(productCards({})).toEqual([]);
    const [card] = productCards([null]);
    expect(card).toMatchObject({ id: '', title: '', image: PLACEHOLDER_IMAGE, soldOut: false });
  });
});

describe('listQuery（查询参数）', () => {
  it('默认：page=1、size=PAGE_SIZE，且**不带**空的 category/keyword', () => {
    expect(listQuery({ page: 1 })).toEqual({ page: 1, size: PAGE_SIZE });
    expect(listQuery({ page: 1, category: '', keyword: '  ' })).toEqual({
      page: 1,
      size: PAGE_SIZE,
    });
  });

  it('page 非法（0 / 负数 / 非整数 / 缺失）→ 归一成 1（服务端对 page<1 是 40001）', () => {
    for (const page of [0, -3, 1.5, undefined, '2']) {
      expect(listQuery({ page }).page).toBe(1);
    }
  });

  it('category / keyword 去空格后带上；两者可同时带', () => {
    expect(listQuery({ page: 2, category: 'kitchen', keyword: '  南部鉄器 ' })).toEqual({
      page: 2,
      size: PAGE_SIZE,
      category: 'kitchen',
      keyword: '南部鉄器',
    });
  });

  it('size 可覆盖（上限 50 由服务端守，这里不重复校验）', () => {
    expect(listQuery({ page: 1, size: 50 }).size).toBe(50);
  });
});

describe('hasMore / nextPage（触底加载边界）', () => {
  it('loaded < total → 还有下一页', () => {
    expect(hasMore({ loaded: 20, total: 57 })).toBe(true);
    expect(nextPage({ page: 1, loaded: 20, total: 57 })).toBe(2);
  });

  it('loaded = total / loaded > total → null（到底后不再发请求）', () => {
    expect(nextPage({ page: 3, loaded: 57, total: 57 })).toBeNull();
    expect(nextPage({ page: 3, loaded: 60, total: 57 })).toBeNull();
  });

  it('⚠️ total 非整数（老后端 / 字段缺失）→ false，不是"永远还能加载"', () => {
    // @why 少了这条，字段缺失会变成 loaded(0) < total(undefined 比较为 false)… 实际上 undefined
    //      比较恒 false，但 `total` 若变成字符串 "57" 就会失配。钉住整数守卫即可。
    expect(hasMore({ loaded: 20, total: '57' })).toBe(false);
    expect(hasMore({ loaded: 20, total: undefined })).toBe(false);
  });
});

describe('mergeCards（切分类 vs 触底）', () => {
  it('reset=false → 追加（触底加载）', () => {
    expect(mergeCards(['a', 'b'], ['c'], false)).toEqual(['a', 'b', 'c']);
  });

  it('⚠️ reset=true → **替换**（切分类 / 搜索 / 下拉刷新）', () => {
    // @why 这条钉的是最容易漏的一步：切了分类却没清空，列表里会混着上一个分类的商品。
    //      那种错误不报错，用户在"美妆"里看到厨刀，只会觉得这个站不靠谱。
    expect(mergeCards(['a', 'b'], ['c'], true)).toEqual(['c']);
  });
});

describe('intentForProduct（导航意图）', () => {
  it('有 id → 意图；空 id / 非字符串 → null（跳过去只会白屏）', () => {
    expect(intentForProduct('p-1')).toEqual({ go: 'detail', id: 'p-1' });
    expect(intentForProduct('')).toBeNull();
    expect(intentForProduct(undefined)).toBeNull();
    expect(intentForProduct(42)).toBeNull();
  });
});

describe('errorMessage（错误文案）', () => {
  it('带 code + message → `code message`（可机读，便于对照错误码表）', () => {
    expect(errorMessage({ code: 50003, message: '汇率缺失' })).toBe('50003 汇率缺失');
  });

  it('缺 message / 形状不对 → 兜底文案，不显示 undefined', () => {
    expect(errorMessage({ code: -1 })).toBe('-1 加载失败');
    expect(errorMessage(new Error('网络不通'))).toBe('网络不通');
    expect(errorMessage(undefined)).toBe('加载失败');
    expect(errorMessage('x')).toBe('加载失败');
  });
});

describe('分类枚举与契约同源（防前端 tab 静默漂移）', () => {
  it('`CATEGORIES` 与契约 `/products` 的 category enum 完全一致（顺序也一致）', () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
      'utf8',
    );
    const line = yaml.split('\n').find((l) => l.includes('name: category') && l.includes('enum:'));
    expect(line, '契约里没找到 /products 的 category 枚举——契约改版式了？').toBeDefined();
    const enumText = /enum:\s*\[([^\]]+)\]/.exec(line ?? '')?.[1] ?? '';
    const contract = enumText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    expect(contract.length, '解析出的枚举是空的——正则失配了，这条会假绿').toBeGreaterThan(0);
    // 双向：契约多一个 → 前端少一个 tab（点了没反应）；前端多一个 → 点了永远是空的
    expect(CATEGORIES).toEqual(contract);
  });
});
