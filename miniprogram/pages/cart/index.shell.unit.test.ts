/**
 * 职责：购物车页薄壳的行为用例（M-14，AJ-406）——删除可撤销、报价失败可重试、点行进详情、tabBar 角标。
 *
 * @why 这四件事的关键都在薄壳里：撤销要在**真实的 cart-store** 上放回原位、到点要收起；
 *      重试要真的再打一次报价；角标要在每次改动后更新。纯函数各自对，接起来才是用户看到的样子。
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';
import { createCartStore } from '../../utils/cart-store.js';

const OIL = {
  productId: 'p-shiro-cleansing-oil',
  qty: 1,
  title: '資生堂 クレンジングオイル 200ml',
  image: 'https://img.example.com/p1/card.jpg',
  priceJpy: 3600,
};
const KNIFE = {
  productId: 'p-sakai-gyuto-210',
  qty: 2,
  title: '堺孝行 牛刀 210mm',
  image: 'https://img.example.com/p2/card.jpg',
  priceJpy: 18_700,
};

let page: LoadedPage;
let cart: ReturnType<typeof createCartStore>;
let quoteCalls: number;
let quoteFail: (Error & { code?: number }) | null;
let navigations: string[];
let badges: unknown[];
/** 非空 = 报价请求挂在这个 Promise 上（编排"报价在途时删光"）。 */
let quoteHold: Promise<void> | null;

const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const tapId = (id: string) => ({ currentTarget: { dataset: { id } } });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
/** 走完报价防抖（400ms）并等响应落地。 */
const quoted = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(400);
  await settle();
};
const ids = (): string[] =>
  (page.data['rows'] as Array<{ productId: string }>).map((r) => r.productId);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-08T03:00:00.000Z'));
  quoteCalls = 0;
  quoteFail = null;
  navigations = [];
  badges = [];
  quoteHold = null;
  const disk = new Map<string, unknown>();
  cart = createCartStore({
    storage: {
      getJson: (k: string) => disk.get(k) ?? null,
      setJson: (k: string, v: unknown) => disk.set(k, structuredClone(v)),
    },
  } as never);
  cart.add(OIL);
  cart.add(KNIFE);
  vi.stubGlobal('wx', {
    navigateTo: (o: { url: string }) => navigations.push(o.url),
    switchTab: (o: { url: string }) => navigations.push(o.url),
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      cart,
      api: async () => {
        quoteCalls += 1;
        if (quoteHold !== null) await quoteHold;
        if (quoteFail !== null) throw quoteFail;
        return { items_jpy: 41_000, shipping_jpy: 1_150, total_jpy: 42_150, split_hint: false };
      },
    },
  });
  page['getTabBar'] = () => ({ setData: (v: unknown) => badges.push(v) });
  call('onLoad');
  call('onShow');
  await quoted();
});

afterEach(() => {
  call('onUnload');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('M-14 删除可撤销（AJ-406）', () => {
  it('🔴 删第 1 行 → 行立刻消失、原位置出现"已删除「…」"；撤销 → 回到原位置（不是末尾）', async () => {
    call('onRemove', tapId(OIL.productId));
    expect(ids()).toEqual([KNIFE.productId]);
    expect(page.data['undo']).toEqual({
      show: true,
      index: 0,
      text: '已删除「資生堂 クレンジングオイル 200ml」',
    });
    call('onUndo');
    expect(ids()).toEqual([OIL.productId, KNIFE.productId]);
    expect((page.data['undo'] as { show: boolean }).show).toBe(false);
  });

  it('🔴 过了 5 秒 → 撤销行收起；之后再点撤销不放回（删除生效）', async () => {
    call('onRemove', tapId(OIL.productId));
    await vi.advanceTimersByTimeAsync(5000);
    expect((page.data['undo'] as { show: boolean }).show).toBe(false);
    call('onUndo');
    expect(ids()).toEqual([KNIFE.productId]);
  });

  it('定时器被冻结（切后台）也不能超时撤销：到点后的点击按时刻判，不放回', () => {
    call('onRemove', tapId(OIL.productId));
    vi.setSystemTime(Date.now() + 6000); // 时钟走了，定时器没跑（模拟后台冻结）
    call('onUndo');
    expect(ids()).toEqual([KNIFE.productId]);
  });

  it('删光最后一件 → 不切空态（撤销入口还在）；撤销后回来', () => {
    call('onRemove', tapId(OIL.productId));
    call('onRemove', tapId(KNIFE.productId));
    expect(page.data['empty']).toBe(false);
    expect((page.data['undo'] as { index: number }).index).toBe(0);
    call('onUndo');
    expect(ids()).toEqual([KNIFE.productId]);
  });
});

describe('M-14 报价失败重试 / 点行进详情 / 角标', () => {
  it('🔴 报价网络失败 → 给"重试"；点了立刻再报一次（不等防抖），成功后按钮消失', async () => {
    quoteFail = Object.assign(new Error('request:fail timeout'), { code: -1 });
    call('onPlus', tapId(OIL.productId));
    await quoted();
    expect(page.data['quoteRetry']).toBe(true);
    const before = quoteCalls;
    quoteFail = null;
    call('onRetryQuote');
    await settle();
    expect(quoteCalls).toBe(before + 1);
    expect(page.data['quoteRetry']).toBe(false);
    expect(page.data['quoteError']).toBe('');
  });

  it('商品下架（40401）→ 不给重试（重试一万次也一样）', async () => {
    quoteFail = Object.assign(new Error('商品不存在或已下架'), { code: 40401 });
    call('onPlus', tapId(OIL.productId));
    await quoted();
    expect(page.data['quoteRetry']).toBe(false);
  });

  it('点行 → 进该商品详情（id 编码进 query）', () => {
    call('onOpenDetail', tapId(KNIFE.productId));
    expect(navigations).toEqual(['/pages/detail/index?id=p-sakai-gyuto-210']);
  });

  it('🔴 角标：进屏是 3 件；删一件后跟着变成 2', () => {
    // tabBar 同时收到 active（高亮）与 cartBadge（角标）两类写入，这里只看角标
    const lastBadge = () => badges.filter((b) => Object.hasOwn(b as object, 'cartBadge')).at(-1);
    expect(lastBadge()).toEqual({ cartBadge: '3' });
    call('onRemove', tapId(OIL.productId));
    expect(lastBadge()).toEqual({ cartBadge: '2' });
  });
});

describe('报价在途 / 防抖窗口（审查 2026-10-09）', () => {
  it('🔴 改数量的那一刻「去结算」就禁用（不等 400ms 防抖才变）', async () => {
    await quoted();
    expect((page.data['gate'] as { disabled: boolean }).disabled).toBe(false);
    call('onPlus', tapId(OIL.productId));
    expect((page.data['gate'] as { disabled: boolean }).disabled).toBe(true);
    await quoted();
    expect((page.data['gate'] as { disabled: boolean }).disabled).toBe(false);
  });

  it('🔴 报价在途时删光最后一件 → 不再挂着「正在计算运费…」（quoting 复位）', async () => {
    await quoted();
    let release: () => void = () => undefined;
    quoteHold = new Promise<void>((r) => {
      release = r;
    });
    call('onPlus', tapId(OIL.productId));
    await vi.advanceTimersByTimeAsync(400); // 报价发出，挂起
    expect(page.data['quoting']).toBe(true);
    call('onRemove', tapId(OIL.productId));
    call('onRemove', tapId(KNIFE.productId));
    expect(page.data['quoting']).toBe(false);
    release();
    await settle();
    expect(page.data['quoting']).toBe(false);
  });
});
