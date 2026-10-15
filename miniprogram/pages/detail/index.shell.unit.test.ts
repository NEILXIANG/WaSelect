/**
 * 职责：详情页薄壳的行为用例（M-13，AJ-406）——底部购买栏的购物车件数与加购反馈接得上。
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js `buyBarView`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';
import { PLACEHOLDER_IMAGE } from '../../utils/placeholder.js';
import { createCartStore } from '../../utils/cart-store.js';

/** 购物车里已有的一件（像真的：日文商品名、整数円快照价）。 */
const MATCHA = {
  productId: 'p-uji-matcha-40g',
  qty: 2,
  title: '宇治抹茶 40g',
  image: '',
  priceJpy: 2160,
};

let page: LoadedPage;
let cart: ReturnType<typeof createCartStore>;
let stock: number;
let navs: string[];
let fail: (Error & { code?: number }) | null;
/** A10：同类推荐列表请求的地址（null = 没发）。 */
let listUrl: string | null;
let switches: string[];
let redirects: string[];
let depth: number;
const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const bar = () => page.data['bar'] as { cartText: string; disabled: boolean };

beforeEach(async () => {
  stock = 4;
  navs = [];
  fail = null;
  listUrl = null;
  switches = [];
  redirects = [];
  const disk = new Map<string, unknown>();
  cart = createCartStore({
    storage: {
      getJson: (k: string) => disk.get(k) ?? null,
      setJson: (k: string, v: unknown) => disk.set(k, v),
    },
  } as never);
  cart.add(MATCHA);
  vi.stubGlobal('wx', {
    navigateTo: (o: { url: string }) => navs.push(o.url),
    switchTab: (o: { url: string }) => switches.push(o.url),
    redirectTo: (o: { url: string }) => redirects.push(o.url),
  });
  depth = 2;
  vi.stubGlobal('getCurrentPages', () => Array.from({ length: depth }, () => ({})));
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      cart,
      api: async (req: { url: string }) => {
        if (req.url.includes('/products?')) {
          listUrl = req.url;
          return {
            items: [
              { id: 'p-sakai-gyuto-210', title: '本品', price_jpy: 18_700, stock: 4, images: [] },
              {
                id: 'p-nambu-kyusu',
                title: '南部铁器 急须',
                price_jpy: 12_800,
                stock: 2,
                images: [],
              },
            ],
          };
        }
        if (!req.url.endsWith('/support') && fail !== null) throw fail;
        return req.url.endsWith('/support')
          ? {}
          : {
              id: 'p-sakai-gyuto-210',
              title: '堺孝行 牛刀 210mm',
              price_jpy: 18_700,
              stock,
              images: [],
              description: '',
              category: 'kitchen',
            };
      },
    },
  });
  call('onLoad', { id: 'p-sakai-gyuto-210' });
  call('onShow');
  await settle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('详情页轮播图片加载失败（审计 UX-01）', () => {
  it('🔴 某张图 binderror → 只这一张换占位图', () => {
    const product = page.data['product'] as Record<string, unknown>;
    page.setData({
      product: { ...product, images: ['https://img.test/a.webp', 'https://img.test/b.webp'] },
    });
    call('onGalleryError', { currentTarget: { dataset: { index: 1 } } });
    const images = (page.data['product'] as { images: string[] }).images;
    expect(images).toEqual(['https://img.test/a.webp', PLACEHOLDER_IMAGE]);
  });
});

describe('详情页底部购买栏（M-13，AJ-406）', () => {
  it('🔴 进屏显示购物车已有件数；加购后同一处变成"已加入购物车 · 3"', () => {
    expect(bar().cartText).toBe('购物车 · 2');
    call('onAddToCart');
    expect(bar().cartText).toBe('已加入购物车 · 3');
  });

  it('售罄 → 栏里两个按钮禁用', async () => {
    stock = 0;
    call('onLoad', { id: 'p-sakai-gyuto-210' });
    await settle();
    expect(bar().disabled).toBe(true);
  });
});

describe('详情页加购与立即购买（审查 2026-10-09）', () => {
  it('🔴 库存 4：购物车里已有 4 件时再点加购 → 不加，提示库存上限', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i += 1) {
        call('onAddToCart');
        vi.advanceTimersByTime(1000);
      }
      const line = cart.items().find((x) => x.productId === 'p-sakai-gyuto-210');
      expect(line?.qty).toBe(4);
      expect(page.data['addNote']).toBe('库存只剩 4 件，购物车里已经放满了');
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 加购后去购物车删掉这件、再回来 → 不再显示"已加入购物车"', () => {
    call('onAddToCart');
    expect(page.data['added']).toBe(true);
    cart.setQty('p-sakai-gyuto-210', 0);
    call('onShow');
    expect(page.data['added']).toBe(false);
    expect(bar().cartText).toBe('购物车 · 2');
  });

  it('🔴 立即购买连点两下 → 只打开一个结算页', () => {
    call('onBuyNow');
    call('onBuyNow');
    expect(navs).toHaveLength(1);
  });

  it('🔴 商品已下架（40401）→ 不给"重试"；网络错误仍给', async () => {
    fail = Object.assign(new Error('商品不存在或已下架'), { code: 40401 });
    call('onLoad', { id: 'p-sakai-gyuto-210' });
    await settle();
    expect(page.data['retryable']).toBe(false);
    fail = Object.assign(new Error('timeout'), { code: -1 });
    call('onRetry');
    await settle();
    expect(page.data['retryable']).toBe(true);
  });
});

describe('详情页选数量（A9，AJ-416）', () => {
  it('🔴 选 2 件 → 加购加 2 件；立即购买的结算条目也是 2 件', () => {
    call('onQtyPlus');
    expect(page.data['qty']).toBe(2);
    call('onAddToCart');
    expect(cart.items().find((x) => x.productId === 'p-sakai-gyuto-210')?.qty).toBe(2);
    call('onBuyNow');
    const app = (
      globalThis as unknown as { getApp: () => { globalData: { buyNow: { qty: number } } } }
    ).getApp();
    expect(app.globalData.buyNow.qty).toBe(2);
    expect(navs).toHaveLength(1);
  });

  it('🔴 数量不超过库存（库存 4：点到 4 再点不涨）；减到 1 不再减', () => {
    for (let i = 0; i < 6; i += 1) call('onQtyPlus');
    expect(page.data['qty']).toBe(4);
    // F8（第二轮审计）：点不动时说为什么（原先没有任何反馈，像按钮坏了）
    expect(page.data['qtyNote']).toBe('库存只剩 4 件，最多买 4 件');
    for (let i = 0; i < 6; i += 1) call('onQtyMinus');
    expect(page.data['qty']).toBe(1);
    expect(page.data['qtyNote']).toBe('');
  });

  it('🔴 车里已有 3 件、这次要加 2 件、库存 4 → 不加，并说清楚"最多再加 1 件"', () => {
    // 与 MATCHA 同写法（先成常量再传）：对象字面量直传时 typecheck 报 `image` 不在 CartItem 上——原因未查清（typedef 里明明有），先按既有写法规避
    const GYUTO = {
      productId: 'p-sakai-gyuto-210',
      qty: 3,
      title: '堺孝行 牛刀 210mm',
      image: '',
      priceJpy: 18_700,
    };
    cart.add(GYUTO);
    call('onQtyPlus');
    call('onAddToCart');
    expect(cart.items().find((x) => x.productId === 'p-sakai-gyuto-210')?.qty).toBe(3);
    expect(page.data['addNote']).toBe('库存只剩 4 件，购物车里已有 3 件，最多再加 1 件');
  });
});

describe('详情页同类推荐 / 下架去首页（A10，AJ-416）', () => {
  it('🔴 详情到了之后按分类取同类，排除本品；点推荐 → 进那件的详情', () => {
    expect(listUrl).toContain('/api/v1/products?category=kitchen');
    expect((page.data['related'] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      'p-nambu-kyusu',
    ]);
    call('onOpenRelated', { currentTarget: { dataset: { id: 'p-nambu-kyusu' } } });
    expect(navs.at(-1)).toBe('/pages/detail/index?id=p-nambu-kyusu');
  });

  it('🔴 页面栈已满 10 层 → 点推荐改用 redirectTo（替换当前详情页），不再 navigateTo 静默失败', () => {
    depth = 10;
    const before = navs.length;
    call('onOpenRelated', { currentTarget: { dataset: { id: 'p-nambu-kyusu' } } });
    expect(navs.length).toBe(before);
    expect(redirects.at(-1)).toBe('/pages/detail/index?id=p-nambu-kyusu');
  });

  it('🔴 已下架（40401，不给重试）→ 错误态的按钮是"去首页逛逛"，点了回首页', async () => {
    fail = Object.assign(new Error('商品不存在或已下架'), { code: 40401 });
    call('onLoad', { id: 'p-sakai-gyuto-210' });
    await settle();
    call('onStateAction');
    expect(switches).toEqual(['/pages/home/index']);
  });
});

// 独立审查 2026-10-13 【2】：客服卡 / 相关推荐是即发即忘的请求，用户秒退时回包打到已销毁页面
describe('商品详情：页面已卸载后不再 setData', () => {
  it('🔴 onUnload 之后 /support 才回来 → data.support 保持为空', async () => {
    let resolveSupport: ((v: unknown) => void) | null = null;
    vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
    const p = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: {
        apiBase: 'http://api.test',
        api: (req: { url: string }) => {
          if (req.url.endsWith('/api/v1/support'))
            return new Promise((r) => {
              resolveSupport = r;
            });
          return Promise.reject(new Error('下游不在本用例里'));
        },
      },
    });
    (p['onLoad'] as (o: unknown) => void)({ id: 'p-1' });
    (p['onUnload'] as () => void)();
    (resolveSupport as unknown as (v: unknown) => void)({ email: 'a@b.c' });
    await settle();
    expect(p.data['support']).toEqual([]);
  });
});

// 审计 BUG-004：详情页 `load()` 既不领号也不判存活——
//   ① 慢请求回来时页面可能已 onUnload，setData 打在已销毁的实例上；
//   ② 并发的两次取数（首次 + 错误态重试）里，先发的慢响应会盖掉后发的新结果。
describe('商品详情：取详情的存活与乱序（审计 BUG-004）', () => {
  /** 两件像真的商品：靠标题分辨落到页面上的是哪一份响应。 */
  const OLD = {
    id: 'p-old',
    title: '南部铁器 急须',
    price_jpy: 12_800,
    stock: 2,
    images: [],
    category: 'kitchen',
  };
  const NEW = {
    id: 'p-new',
    title: '堺孝行 牛刀 210mm',
    price_jpy: 18_700,
    stock: 4,
    images: [],
    category: 'kitchen',
  };

  /**
   * 取详情的请求**不自动回来**：每发一次就入队一个 deferred，由用例决定谁先兑现——
   * 这才是"慢请求晚返回"这个条件（用真实延时只能是 sleep，用例会又慢又脆）。
   */
  async function openHeld(): Promise<{
    p: LoadedPage;
    pending: Array<ReturnType<typeof deferred<unknown>>>;
  }> {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
    const p = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: {
        apiBase: 'http://api.test',
        cart,
        api: (req: { url: string }) => {
          if (req.url.includes('/products?')) return Promise.resolve({ items: [] });
          if (req.url.endsWith('/support')) return Promise.resolve({});
          const d = deferred<unknown>();
          pending.push(d);
          return d.promise;
        },
      },
    });
    return { p, pending };
  }

  /** 当前渲染的是哪件商品（null = 还没渲染）。 */
  const title = (p: LoadedPage): string =>
    (p.data['product'] as { title: string } | null)?.title ?? '';

  it('🔴 取详情在途时离开页面 → 结果晚回来也不 setData', async () => {
    const { p, pending } = await openHeld();
    (p['onLoad'] as (o: unknown) => void)({ id: 'p-old' });
    await settle();
    expect(pending).toHaveLength(1);
    (p['onUnload'] as () => void)();
    (pending[0] as { resolve: (v: unknown) => void }).resolve(OLD);
    await settle();
    expect(p.data['product']).toBeNull();
    // loading 仍是 true 正是断言的一部分：连 finally 都没跑 ⇒ 这一次返回什么都没写到页面上
    expect(p.data['loading']).toBe(true);
  });

  it('🔴 重试后先发的慢响应晚到 → 不覆盖后发的新结果', async () => {
    const { p, pending } = await openHeld();
    (p['onLoad'] as (o: unknown) => void)({ id: 'p-old' });
    await settle();
    // 首次取数还在途（弱网），用户点了错误态的「重试」→ 第二次取数
    void (p['load'] as () => Promise<void>)();
    await settle();
    expect(pending).toHaveLength(2);
    (pending[1] as { resolve: (v: unknown) => void }).resolve(NEW); // 后发的先回来
    await settle();
    expect(title(p)).toBe('堺孝行 牛刀 210mm');
    (pending[0] as { resolve: (v: unknown) => void }).resolve(OLD); // 先发的慢响应晚到
    await settle();
    expect(title(p)).toBe('堺孝行 牛刀 210mm');
    expect(p.data['loading']).toBe(false);
  });
});
