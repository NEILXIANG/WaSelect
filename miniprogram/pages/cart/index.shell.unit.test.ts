/**
 * 职责：购物车页薄壳的行为用例（M-14，AJ-406）——删除可撤销、报价失败可重试、点行进详情、tabBar 角标。
 *
 * @why 这四件事的关键都在薄壳里：撤销要在**真实的 cart-store** 上放回原位、到点要收起；
 *      重试要真的再打一次报价；角标要在每次改动后更新。纯函数各自对，接起来才是用户看到的样子。
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js
 */
import { readFileSync } from 'node:fs';
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
/** 每次报价的请求体（A3：只报勾选的）。 */
let quoteBodies: unknown[];

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
  quoteBodies = [];
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
      api: async (req: { data?: unknown }) => {
        quoteCalls += 1;
        quoteBodies.push(req.data);
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

  // 统一结论 5.3：数量减到 0 由 cart-store 定义为移除，原先走的是 setQty——行直接消失，没有撤销
  it('🔴 数量 1 再点「−」→ 与删除同一条路：行消失、出现"已删除「…」"；撤销 → 原位置、数量 1', () => {
    call('onMinus', tapId(OIL.productId));
    expect(ids()).toEqual([KNIFE.productId]);
    expect(page.data['undo']).toEqual({
      show: true,
      index: 0,
      text: '已删除「資生堂 クレンジングオイル 200ml」',
    });
    call('onUndo');
    expect(ids()).toEqual([OIL.productId, KNIFE.productId]);
    expect(cart.items().find((i) => i.productId === OIL.productId)?.qty).toBe(1);
  });

  it('数量 2 点「−」→ 只减到 1，不出撤销行', () => {
    call('onMinus', tapId(KNIFE.productId));
    expect(cart.items().find((i) => i.productId === KNIFE.productId)?.qty).toBe(1);
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

describe('勾选结算（A3，AJ-416）', () => {
  it('🔴 取消勾选一件 → 只拿勾着的去报价；底栏写"去结算 (1)"、全选框不再是勾上', async () => {
    call('onToggleSelect', tapId(KNIFE.productId));
    await quoted();
    expect(quoteBodies.at(-1)).toEqual({ items: [{ product_id: OIL.productId, qty: 1 }] });
    expect(page.data['bar']).toEqual({
      allSelected: false,
      selectedCount: 1,
      ctaText: '去结算 (1)',
    });
    expect((page.data['rows'] as Array<{ selected: boolean }>).map((r) => r.selected)).toEqual([
      true,
      false,
    ]);
  });

  it('🔴 全不选 → 不报价（空 items 会 40001）、合计清掉、去结算不可点并说"请勾选"；再全选 → 恢复报价', async () => {
    const before = quoteCalls;
    call('onToggleAll'); // 当前全选 → 全不选
    await quoted();
    expect(quoteCalls).toBe(before);
    expect(page.data['quote']).toBeNull();
    expect(page.data['gate']).toEqual({ disabled: true, hint: '请勾选要结算的商品' });
    call('onToggleAll'); // 全选
    await quoted();
    expect(quoteCalls).toBe(before + 1);
    expect((page.data['gate'] as { disabled: boolean }).disabled).toBe(false);
  });
});

// 第 24 项（2026-10-10）：购物车下拉刷新——价格 / 库存 / 运费可能在买家停留期间变了，原先只能切走再切回来
describe('购物车：下拉刷新', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重读购物车并重新报价；读完本地就收起动画（报价有防抖，合计稍后落地）', async () => {
    const stops: number[] = [];
    vi.stubGlobal('wx', { stopPullDownRefresh: () => stops.push(1), navigateTo: () => undefined });
    const before = quoteCalls;
    call('onPullDownRefresh');
    expect(stops).toEqual([1]);
    await quoted();
    expect(quoteCalls).toBe(before + 1);
  });
});

describe('库存不足：改到可买件数（AJ-493，全入口点击测试 2026-10-11）', () => {
  const stockErr = (stock: number) =>
    Object.assign(new Error('库存不足'), {
      code: 40901,
      data: { product_id: KNIFE.productId, stock },
    });
  const knife = () =>
    (
      page.data['rows'] as Array<{ productId: string; noteText?: string; invalidText?: string }>
    ).find((r) => r.productId === KNIFE.productId);

  it('🔴 报价回 40901 + stock=1 → 车里改成 1 件、行上说明、重报价后合计照常出现', async () => {
    quoteFail = stockErr(1);
    call('onPlus', tapId(KNIFE.productId));
    await quoted();
    expect(cart.items().find((i) => i.productId === KNIFE.productId)?.qty).toBe(1);
    quoteFail = null;
    await quoted();
    expect(knife()?.noteText).toBe('库存只剩 1 件，已改为 1 件');
    expect(page.data['quoteError']).toBe('');
    expect(page.data['quote']).not.toBeNull();
  });

  it('🔴 stock=0 → 标"已售罄，请移除"，错误条说人话、不出错误码', async () => {
    quoteFail = stockErr(0);
    call('onPlus', tapId(KNIFE.productId));
    await quoted();
    expect(knife()?.invalidText).toBe('已售罄，请移除');
    expect(String(page.data['quoteError'])).toContain('已售罄');
    expect(page.data['quoteErrorRef']).toBe('');
    // 三天提交复查 2026-10-12：同屏还挂着「重试」、底栏说"合计未能获取，请稍后重试"——售罄重试一万次也一样
    expect(page.data['quoteRetry']).toBe(false);
    expect((page.data['gate'] as { hint: string }).hint).toBe(
      '有商品已售罄：移除或取消勾选后再结算',
    );
  });

  it('改过数量后再动这一行 → 说明消失', async () => {
    quoteFail = stockErr(1);
    call('onPlus', tapId(KNIFE.productId));
    await quoted();
    quoteFail = null;
    await quoted();
    call('onPlus', tapId(OIL.productId));
    await quoted();
    expect(knife()?.noteText).toBe('库存只剩 1 件，已改为 1 件');
    call('onPlus', tapId(KNIFE.productId));
    expect(knife()?.noteText).toBe('');
  });

  it('🔴 删掉这一行再撤销 → 说明不再挂着（删除也算"动了这一行"）', async () => {
    quoteFail = stockErr(1);
    call('onPlus', tapId(KNIFE.productId));
    await quoted();
    quoteFail = null;
    await quoted();
    call('onRemove', tapId(KNIFE.productId));
    call('onUndo');
    expect(knife()?.noteText).toBe('');
  });
});

// 规律排查 2026-10-12：数量到 99 再点「＋」——数字不动、什么也不说（详情页 F8 早就修了同一件事，购物车没跟上）
describe('购物车：数量到单件上限', () => {
  it('🔴 99 件再点「＋」→ 那一行说"每件商品一次最多买 99 件"', async () => {
    cart.setQty(OIL.productId, 99);
    call('onShow');
    await vi.advanceTimersByTimeAsync(1000);
    const before = quoteCalls;
    call('onPlus', tapId(OIL.productId));
    await vi.advanceTimersByTimeAsync(1000);
    // 三天提交复查 2026-10-12：数量没变，不该重新报价、也不该闪"购物车有变动，正在重新计算…"
    expect(quoteCalls).toBe(before);
    const row = (
      page.data['rows'] as Array<{ productId: string; noteText: string; qty: number }>
    ).find((r) => r.productId === OIL.productId);
    expect(row?.qty).toBe(99);
    expect(row?.noteText).toBe('每件商品一次最多买 99 件');
  });
});

// 三天提交复查 2026-10-12：行上的库存 / 变价说明只在"动这一行"时清——结算把这件移出购物车后，
//   买家下次再加同一件，旧说明（"库存只剩 1 件，已改为 1 件"）又挂回来
describe('购物车：说明不跨"移出再加回"', () => {
  it('🔴 结算移出后再加回同一件 → 不带旧说明', async () => {
    const quotedOnce = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(400);
      await Promise.resolve();
    };
    quoteFail = Object.assign(new Error('库存不足'), {
      code: 40901,
      data: { product_id: KNIFE.productId, stock: 1 },
    });
    call('onPlus', tapId(KNIFE.productId));
    await quotedOnce();
    quoteFail = null;
    await quotedOnce();
    const knifeRow = () =>
      (page.data['rows'] as Array<{ productId: string; noteText?: string }>).find(
        (r) => r.productId === KNIFE.productId,
      );
    expect(knifeRow()?.noteText).toBe('库存只剩 1 件，已改为 1 件');
    cart.removeMany([KNIFE.productId]); // 结算页下单成功后移出
    call('onShow');
    cart.add(KNIFE);
    call('onShow');
    expect(knifeRow()?.noteText).toBe('');
  });
});
