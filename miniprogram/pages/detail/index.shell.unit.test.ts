/**
 * 职责：详情页薄壳的行为用例（M-13，AJ-406）——底部购买栏的购物车件数与加购反馈接得上。
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js `buyBarView`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';
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
const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const bar = () => page.data['bar'] as { cartText: string; disabled: boolean };

beforeEach(async () => {
  stock = 4;
  const disk = new Map<string, unknown>();
  cart = createCartStore({
    storage: {
      getJson: (k: string) => disk.get(k) ?? null,
      setJson: (k: string, v: unknown) => disk.set(k, v),
    },
  } as never);
  cart.add(MATCHA);
  vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      cart,
      api: async (req: { url: string }) =>
        req.url.endsWith('/support')
          ? {}
          : {
              id: 'p-sakai-gyuto-210',
              title: '堺孝行 牛刀 210mm',
              price_jpy: 18_700,
              stock,
              images: [],
              description: '',
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
