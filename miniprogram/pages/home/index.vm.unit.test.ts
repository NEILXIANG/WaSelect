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
  SEARCH_KEYWORD_MAX,
  bannerAt,
  bannerSlides,
  categoryTabs,
  intentForBanner,
  visibleBanners,
  hasMore,
  intentForProduct,
  listQuery,
  mergeCards,
  nextPage,
  productCards,
  searchKeyword,
  emptyCopy,
} from './index.vm.js';
import { SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { PLACEHOLDER_IMAGE } from '../../utils/placeholder.js';

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
    // 第一个参数为空 = "服务端还没下发"（首屏 / /home 未回来）→ 本地常量兜底
    const tabs = categoryTabs([], '');
    expect(tabs.map((t) => t.label)).toEqual(['全部', '美妆护肤', '生活百货', '厨房餐具', '食品']);
    expect(tabs.filter((t) => t.active).map((t) => t.key)).toEqual(['']);
  });

  it('选中 kitchen 时只有它 active（其余全 false，不会出现两个高亮）', () => {
    const tabs = categoryTabs([], 'kitchen');
    expect(tabs.filter((t) => t.active)).toEqual([
      { key: 'kitchen', label: '厨房餐具', active: true },
    ]);
  });

  it('非字符串 / 未传 → 与"全部"同一形态（不是抛错，也不是全部不高亮）', () => {
    // @why 分类来自 wxml 的 `data-key`，取不到时是 undefined——那一跳若没有 tab 高亮，
    //      用户会以为"点了个寂寞"，而页面上没有任何报错。
    expect(categoryTabs([], undefined).find((t) => t.active)?.key).toBe('');
    expect(categoryTabs([], null).find((t) => t.active)?.key).toBe('');
  });

  it('服务端下发了分类清单 → **以它为准**（否则 /home 的 categories 是没人消费的死数据）', () => {
    const tabs = categoryTabs(['food', 'beauty'], '');
    expect(tabs.map((t) => t.key)).toEqual(['', 'food', 'beauty']);
    expect(tabs.map((t) => t.label)).toEqual(['全部', '食品', '美妆护肤']);
  });

  it('服务端下发了一个前端不认识的新分类 → 展示名回落到 key，不让它从分类栏消失', () => {
    // @why @limitation 一：消失的话运营会以为"配了没生效"，而它只是缺一个展示名。
    const tabs = categoryTabs(['kitchenware'], '');
    expect(tabs).toContainEqual({ key: 'kitchenware', label: 'kitchenware', active: false });
  });

  it('服务端给了空数组 / 非数组 → 回落到本地 CATEGORIES（首屏不等网络，分类栏不抖）', () => {
    // @why 等 /home 回来再渲染的话，首屏会先只显示「全部」再补出四个分类——
    //      分类栏往上顶一下是用户能看见的抖动，而它们是常量，没理由等一次往返。
    expect(categoryTabs([], '').map((t) => t.key)).toEqual(['', ...CATEGORIES]);
    expect(categoryTabs(undefined, '').map((t) => t.key)).toEqual(['', ...CATEGORIES]);
    expect(categoryTabs('not-an-array', '').map((t) => t.key)).toEqual(['', ...CATEGORIES]);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 编辑口径三字段（020 / AJ-296①）——喂给 S4 的 `ws-pick-card`
  // ═══════════════════════════════════════════════════════════════════════════

  it('why / maker / tags 齐全 → 原样带出（pick-card 的三个区块都渲染得出来）', () => {
    const [card] = productCards([
      {
        ...ITEMS[0],
        why: '铸铁蓄热足，水温掉得慢。',
        maker: '岩手 · 南部铁器',
        tags: ['产地直送', '终身可用'],
      },
    ]);
    expect(card?.why).toBe('铸铁蓄热足，水温掉得慢。');
    expect(card?.maker).toBe('岩手 · 南部铁器');
    expect(card?.tags).toEqual(['产地直送', '终身可用']);
  });

  /**
   * `why` 缺失 → **空串**，组件据此降级。
   * @why 这一条钉的是 AJ-296① 整条链路的最后一环：服务端整键省略 →
   *      这里补空串 → 组件不渲染 why 块。任何一环"顺便给个默认值"
   *      （比如这里给"精选好物"）都会让降级变成假文案——而假文案比留白更伤。
   */
  it('🔴 why / maker 缺失 → 空串（组件降级，不补任何通用话术）', () => {
    const [card] = productCards([ITEMS[0]]);
    expect(card?.why).toBe('');
    expect(card?.maker).toBe('');
    expect(card?.tags).toEqual([]);
  });

  it('tags 非数组 / 含非字符串 → 收敛成空数组或只留字符串项（渲染出 [object Object] 更糟）', () => {
    expect(productCards([{ ...ITEMS[0], tags: '产地直送' }])[0]?.tags).toEqual([]);
    expect(productCards([{ ...ITEMS[0], tags: null }])[0]?.tags).toEqual([]);
    expect(productCards([{ ...ITEMS[0], tags: ['产地直送', 42] }])[0]?.tags).toEqual(['产地直送']);
  });

  /**
   * `stock` 缺/非整数 → **-1**（未知），不能给 0。
   * @why 0 在组件里是"售罄"的语义。给 0 会让**所有**商品都显示售罄——
   *      那是一次能毁掉整个首页的默认值，而且不报错（数据看起来很正常）。
   */
  it('🔴 stock 缺失 / 非整数 → -1（未知），**不是** 0（0 会被读成售罄）', () => {
    expect(productCards([{ ...ITEMS[0], stock: undefined }])[0]?.stock).toBe(-1);
    expect(productCards([{ ...ITEMS[0], stock: '12' }])[0]?.stock).toBe(-1);
    expect(productCards([{ ...ITEMS[0], stock: 3 }])[0]?.stock).toBe(3);
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

describe('bannerSlides（首页轮播）', () => {
  const BANNERS = [
    {
      id: 'b-1',
      image_key: 'banners/a.png',
      link_type: 'product',
      link_id: 'p-1',
      sort: 1,
      active: true,
      image: 'https://img.example.com/banners/a.png',
    },
    {
      id: 'b-2',
      image_key: 'banners/b.png',
      link_type: 'category',
      link_id: 'kitchen',
      sort: 2,
      active: true,
      image: 'https://img.example.com/banners/b.png',
    },
  ];

  it('正常：只取 id 与 image（渲染不需要 image_key / link_*）', () => {
    expect(bannerSlides(BANNERS)).toEqual([
      { id: 'b-1', image: 'https://img.example.com/banners/a.png' },
      { id: 'b-2', image: 'https://img.example.com/banners/b.png' },
    ]);
  });

  it('⚠️ 缺 `image` 的条目**整条不展示**，且**不回落占位图**', () => {
    // @why 这是全站唯一不回落 `PLACEHOLDER_IMAGE` 的图位：占位图说的是"商品没图"，
    //      而 banner 缺 image 说的是"服务端没配 IMG_BASE_URL"——用占位图顶上，
    //      就把一次配置故障洗成了"这张 banner 没图"，排查方向会跑偏到图床。
    const out = bannerSlides([
      BANNERS[0],
      { ...BANNERS[1], image: undefined }, // IMG_BASE_URL 未配置 → 服务端整键省略
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('b-1');
    expect(out[0]?.image).not.toBe(PLACEHOLDER_IMAGE);
  });

  it('🔴 缺 `image` 时若改成回落占位图 → 本条必须红（钉住上一条的取舍）', () => {
    // @why 没有这条反向断言，"不回落"只是一个注释里的承诺：
    //      有人为了"不让轮播空着"给它补上占位图，那条（上面的）用例仍然是绿的——
    //      因为补完之后条目数变多、id 断言照样通过。
    const noImage = [{ id: 'b-1', image_key: 'banners/a.png', link_type: 'none' }];
    expect(bannerSlides(noImage)).toEqual([]);
  });

  it('id 缺失的也跳过（wx:key 用 id，缺 id 会让节点复用错乱）', () => {
    expect(bannerSlides([{ image: 'https://img.example.com/a.png', link_type: 'none' }])).toEqual(
      [],
    );
  });

  it('非数组 / null / 脏条目 → []（不抛，轮播段只是不渲染）', () => {
    for (const v of [undefined, null, 'x', 42, {}]) {
      expect(bannerSlides(v)).toEqual([]);
    }
    expect(bannerSlides([null, undefined, 'x', 42])).toEqual([]);
  });

  it('⚠️ **不**在前端判 active / 起止时间：那是服务端按自己时钟做过的判定', () => {
    // @why 前端再判一次就得用本机时钟——时钟偏的用户会看到"该下架的还在 / 该上线的没来"，
    //      且表现是随机的。这条钉住"vm 不重复判定"：将来有人加了过滤，本条立刻红。
    const out = bannerSlides([
      { id: 'b-off', image: 'https://img.example.com/x.png', active: false },
      {
        id: 'b-expired',
        image: 'https://img.example.com/y.png',
        active: true,
        starts_at: '2020-01-01T00:00:00Z',
        ends_at: '2020-01-02T00:00:00Z',
      },
    ]);
    expect(out.map((s) => s.id)).toEqual(['b-off', 'b-expired']);
  });
});

describe('intentForBanner（轮播跳转）', () => {
  const CATS = ['beauty', 'daily', 'kitchen', 'food'];

  it('link_type=product → 去详情', () => {
    expect(intentForBanner({ link_type: 'product', link_id: 'p-1' }, CATS)).toEqual({
      go: 'detail',
      id: 'p-1',
    });
  });

  it('link_type=category 且该分类在清单里 → 切分类', () => {
    expect(intentForBanner({ link_type: 'category', link_id: 'kitchen' }, CATS)).toEqual({
      go: 'category',
      key: 'kitchen',
    });
  });

  it('⚠️ link_type=category 但分类**不在**清单里 → null（跳过去会拿到 40001）', () => {
    // @why 直接拿 link_id 去打 /products?category= 的话，不合法的值会返回 40001，
    //      页面上是"切了分类、列表空了、还有一行错误"——用户被带进了一个错误状态。
    expect(intentForBanner({ link_type: 'category', link_id: 'nosuch' }, CATS)).toBeNull();
    // 服务端没下发分类清单（/home 还没回来 / 失败）时同样不跳
    expect(intentForBanner({ link_type: 'category', link_id: 'kitchen' }, [])).toBeNull();
  });

  it('link_type=none / 认不出的类型 / 缺 link_id → null（点了不动，不跳空页）', () => {
    expect(intentForBanner({ link_type: 'none', link_id: 'p-1' }, CATS)).toBeNull();
    expect(intentForBanner({ link_id: 'p-1' }, CATS)).toBeNull();
    expect(intentForBanner({ link_type: 'product' }, CATS)).toBeNull();
    expect(intentForBanner({ link_type: 'product', link_id: '   ' }, CATS)).toBeNull();
    expect(intentForBanner(undefined, CATS)).toBeNull();
    expect(intentForBanner(null, CATS)).toBeNull();
    // 选了跳转却没填目标（管理端会拦，但前端这道是纵深防御）
    expect(intentForBanner({ link_type: 'unknown_type', link_id: 'x' }, CATS)).toBeNull();
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

/**
 * 防复发：B36 的病根**在薄壳**（`reload` / `loadMore` 都不看序号），
 * vm 的纯函数用例在薄壳漏接线时一条都不会红（与 AJ-217 / AJ-218 同一条理由）。
 *
 * @why 首页这条比购物车更值得钉：快速切分类时"后到的旧响应覆盖新结果"，
 *      表现是"切到食品却看到厨刀"——用户在首页遇到它，归因是"这个站数据乱"，
 *      不会有人想到是前端没判序号。
 */
describe('防复发：首页薄壳的乱序接线（B36 / AJ-219）', () => {
  const code = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const count = (needle: string): number => code.split(needle).length - 1;

  it('自检：计数函数对已知文本有效（否则下面全是"0 >= n"的假红）', () => {
    expect(count('wxApi'), '自检：wxApi 在薄壳里确实出现').toBeGreaterThan(0);
    expect(count('这段字符串根本不存在')).toBe(0);
  });

  it('只有 reload 领号；loadMore 借用当前号（R-04 / AJ-226：二者都领号会互相判过期）', () => {
    // ⚠️ 这条原先钉的是"两处各领一次号 = 2"——那正是缺陷本身：loadMore 领走新号，
    //    在途的 reload 就被判过期、结果丢弃、loading 永不清。行为由 index.shell.unit.test.ts 验，
    //    这里只留一条廉价的文本哨兵，防有人顺手把 loadMore 改回领号。
    expect(count('nextSeq(this.seq)'), '只有 reload 领号').toBe(1);
    expect(count('const seq = this.seq;'), 'loadMore 借用当前号').toBe(1);
  });

  it('结果回来后必须判过期——成功、失败、finally 三处都得判', () => {
    // ⚠️ 少判 finally 的表现：过期请求把 loading 清掉 → 页面显示"没在加载"而新的还在途中
    // reload / loadMore 各三处：成功 / 失败 / finally（精确值：改动接线就必须同步改这条）
    expect(count('isStale(seq, this.seq)'), 'reload 与 loadMore 各三处').toBe(6);
  });
});

describe('轮播下标必须与「可见 banner」同源（点第 N 张跳第 N 张）', () => {
  /**
   * @why 首页渲染的是 `bannerSlides()` **过滤后**的数组（无图 / 无 id 的条目被跳过），
   *      而原来点击时取的是 `this.banners[index]`——**未过滤**的那一份。
   *      两条数组的下标只在"一个都没被过滤掉"时才相等；
   *      只要有一张 banner 没图（管理端很常见：图没传完就先上架），
   *      后面每一张整体前移一位 ⇒ 点第 2 张跳到第 3 张的链接，点了没反应还算好的。
   * @why 修法是让"下标 → banner"这一步**也走同一个过滤函数**，
   *      而不是在页面里再维护一份"过滤后的数组"：两份数组靠人保持同步，
   *      迟早有一处漏改，而漏改的表现是静默的（图看起来是对的，只有链接错）。
   */
  const WITH_GAP = [
    { id: 'b-0', image: '', link_type: 'product', link_id: 'p-0' },
    {
      id: 'b-1',
      image: 'https://img.example.com/banners/1.png',
      link_type: 'product',
      link_id: 'p-1',
    },
    {
      id: 'b-2',
      image: 'https://img.example.com/banners/2.png',
      link_type: 'category',
      link_id: 'kitchen',
    },
  ];

  it('visibleBanners 跳过无图 / 无 id 的条目', () => {
    expect(visibleBanners(WITH_GAP).map((b) => b.id)).toEqual(['b-1', 'b-2']);
    expect(visibleBanners(undefined)).toEqual([]);
  });

  it('🔴 bannerAt(0) 是第一张**可见**的 banner，不是 banners[0]', () => {
    expect(bannerAt(WITH_GAP, 0)?.id).toBe('b-1');
    expect(bannerAt(WITH_GAP, 1)?.id).toBe('b-2');
  });

  it('bannerAt 越界 / 非整数 / 缺失 → undefined（不静默取到别的位置）', () => {
    expect(bannerAt(WITH_GAP, 2)).toBeUndefined();
    expect(bannerAt(WITH_GAP, -1)).toBeUndefined();
    expect(bannerAt(WITH_GAP, 1.5)).toBeUndefined();
    expect(bannerAt(WITH_GAP, undefined)).toBeUndefined();
  });

  it('🔴 下标与 slides 一一对应：第 i 张 slide 的意图 = bannerAt(i) 的意图', () => {
    const visible = visibleBanners(WITH_GAP);
    const slides = bannerSlides(WITH_GAP);
    expect(slides).toHaveLength(visible.length);
    slides.forEach((s, i) => {
      expect(s.id).toBe(String(visible[i].id));
      expect(intentForBanner(bannerAt(WITH_GAP, i), CATEGORIES)).toEqual(
        intentForBanner(visible[i], CATEGORIES),
      );
    });
  });
});

describe('searchKeyword（P2-32：服务端 >64 字符一律 40001）', () => {
  it('上限与 shared 的 SEARCH_KEYWORD_MAX_LENGTH 同值', () => {
    expect(SEARCH_KEYWORD_MAX).toBe(SEARCH_KEYWORD_MAX_LENGTH);
  });

  it('先 trim 再截断到上限', () => {
    expect(searchKeyword('  急須  ')).toBe('急須');
    const long = 'あ'.repeat(SEARCH_KEYWORD_MAX + 10);
    expect(searchKeyword(long)).toHaveLength(SEARCH_KEYWORD_MAX);
    expect(searchKeyword(`   ${long}`)).toHaveLength(SEARCH_KEYWORD_MAX);
  });

  it('截断不切开代理对（半个 emoji 会让 encodeURIComponent 抛 URIError）', () => {
    const raw = `${'a'.repeat(SEARCH_KEYWORD_MAX - 1)}😀`;
    const k = searchKeyword(raw);
    expect(k).toBe('a'.repeat(SEARCH_KEYWORD_MAX - 1));
    expect(() => encodeURIComponent(k)).not.toThrow();
  });

  it('非字符串 → 空串', () => {
    expect(searchKeyword(undefined)).toBe('');
    expect(searchKeyword(42)).toBe('');
  });

  it('listQuery 发出去的 keyword 不超过上限', () => {
    const q: Record<string, unknown> = listQuery({ page: 1, keyword: 'x'.repeat(200) });
    expect(q['keyword']).toHaveLength(SEARCH_KEYWORD_MAX);
  });
});

describe('mergeCards：翻页去重（审查 2026-10-09）', () => {
  it('🔴 追加时丢掉已在列表里的 id（浏览途中有新品上架，偏移分页会把上一页末尾那件再给一次）', () => {
    const a = { id: 'p1' };
    const b = { id: 'p2' };
    const b2 = { id: 'p2', name: 'dup' };
    const c = { id: 'p3' };
    expect(mergeCards([a, b] as never, [b2, c] as never, false)).toEqual([a, b, c]);
  });
});

describe('emptyCopy：空态说清楚是"搜不到"还是"分类里没有"（小程序评估 A4，2026-10-09）', () => {
  it('🔴 有搜索词 → 点名搜的词、指出口；没有 → 原分类空态文案', () => {
    expect(emptyCopy('抹茶')).toEqual({
      title: '没有找到「抹茶」相关的商品',
      reason: '换个词试试，或点上方「清除搜索」看全部商品',
    });
    expect(emptyCopy('  ')).toEqual({
      title: '这个分类下暂时没有商品',
      reason: '换个分类看看',
    });
  });
});
