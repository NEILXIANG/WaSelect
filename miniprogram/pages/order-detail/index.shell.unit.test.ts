/**
 * 职责：订单详情薄壳的**行为**用例——M-04 下拉刷新、M-05 复制订单号（AJ-405）。
 *
 * @why 都是"接线"问题，纯函数里测不到：
 *      ① json 没开下拉 / 失败路径不收起动画（同订单列表）；
 *      ② 复制订单号复制的是**订单号**（order_no，买家与客服对话用的那串），不是内部 order_id；
 *         复制失败要告诉用户手动长按，而不是什么都不发生。
 * @limitation 不渲染（mp-page @limitation 一）：按钮位置、客服卡是否真的挪到了状态区下方只能看 wxml / 真机。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

const ORDER = {
  order_id: 'o-1',
  order_no: 'WS-20261008-0001',
  status: 'paid',
  total_jpy: 9150,
  contact_email: 'buyer@example.com',
};

let page: LoadedPage;
let calls: string[];
let fail: boolean;
let clipFail: boolean;
let hold: ReturnType<typeof deferred<unknown>> | null;
/** A7：每次打开详情返回的订单（默认 ORDER）。 */
let order: Record<string, unknown>;
/** A7：再次购买时加进购物车的条目；`full` 为 true 时购物车拒收新品种。 */
let added: unknown[];
let full: boolean;
let nav: string[];

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

async function open(id = 'o-1'): Promise<void> {
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: { url: string }) => {
        const path = req.url.replace('http://api.test', '');
        calls.push(`GET ${path}`);
        if (path.endsWith('/support')) return { wechat: 'waselect_cs' };
        if (hold !== null) return hold.promise;
        if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
        return order;
      },
      cart: {
        add: (item: unknown) => {
          if (full) return { added: false, reason: 'full' };
          added.push(item);
          return { added: true };
        },
      },
    },
  });
  // 真机生命周期：onLoad → onShow（取单在 onShow）
  call('onLoad', { id });
  call('onShow');
  await settle();
  calls = [];
}

beforeEach(() => {
  calls = [];
  fail = false;
  clipFail = false;
  hold = null;
  order = ORDER;
  added = [];
  full = false;
  nav = [];
  vi.stubGlobal('wx', {
    stopPullDownRefresh: () => calls.push('stop'),
    setClipboardData: (o: { data: string; success?: () => void; fail?: () => void }) => {
      calls.push(`clip ${o.data}`);
      if (clipFail) o.fail?.();
      else o.success?.();
    },
    navigateTo: (o: { url: string }) => nav.push(o.url),
    switchTab: (o: { url: string }) => nav.push(o.url),
    showModal: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订单详情：下拉刷新（M-04）', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重取这张单，取完才收起动画；状态区带"下一步"', async () => {
    await open();
    hold = deferred<unknown>();
    const done = call<Promise<void>>('onPullDownRefresh');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders/o-1']);
    hold.resolve({ ...ORDER, status: 'shipped' });
    await done;
    expect(calls).toEqual(['GET /api/v1/orders/o-1', 'stop']);
    const view = page.data['view'] as { statusText: string; nextText: string };
    expect(view.statusText).toBe('已发货 · 国际运输中');
    expect(view.nextText).toContain('确认收货');
  });

  it('🔴 取数失败也收起动画，并显示错误', async () => {
    await open();
    fail = true;
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['GET /api/v1/orders/o-1', 'stop']);
    expect(page.data['error']).not.toBe('');
  });

  it('链接里没有订单 id → 不发请求，直接收起动画（空 id 会撞上列表路由）', async () => {
    await open('');
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['stop']);
  });
});

describe('订单详情：复制订单号（M-05）', () => {
  it('🔴 复制的是订单号 order_no（客服认这串），成功后按钮处显示"已复制"', async () => {
    await open();
    call('onCopyOrderNo');
    expect(calls).toEqual(['clip WS-20261008-0001']);
    expect(page.data['copied']).toBe('order');
  });

  it('🔴 复制失败 → 告诉用户长按手动复制（不是什么都不发生）', async () => {
    await open();
    clipFail = true;
    call('onCopyOrderNo');
    expect(page.data['copied']).toBe('');
    expect(String(page.data['error'])).toContain('订单号');
  });

  it('订单还没取到（没有订单号）→ 不调剪贴板', async () => {
    await open();
    page.setData({ view: null });
    call('onCopyOrderNo');
    expect(calls).toEqual([]);
  });

  it('客服联系方式照常取到（卡片挪位置不影响取数）', async () => {
    await open();
    expect(page.data['support']).toEqual([
      { key: 'wechat', label: '客服微信', value: 'waselect_cs', copyable: true },
    ]);
  });
});

describe('订单详情：再次购买 / 商品可点（A7，AJ-416）', () => {
  const DONE = {
    ...ORDER,
    status: 'completed',
    items: [
      { product_id: 'p-1', title: '白色恋人 12 枚装', qty: 2, unit_price_jpy: 2160 },
      { product_id: 'p-2', title: '南部铁器 急须', qty: 1, unit_price_jpy: 12800 },
    ],
  };

  it('🔴 再次购买：原样的商品与数量放回购物车，然后去购物车（tab 页用 switchTab）', async () => {
    order = DONE;
    await open();
    call('onBuyAgain');
    expect(added).toMatchObject([
      { productId: 'p-1', qty: 2 },
      { productId: 'p-2', qty: 1 },
    ]);
    expect(nav).toEqual(['/pages/cart/index']);
  });

  it('🔴 购物车品种已满放不进去 → 留在本页说清楚，不假装成功地跳走', async () => {
    order = DONE;
    full = true;
    await open();
    call('onBuyAgain');
    expect(nav).toEqual([]);
    expect(page.data['buyAgainNote']).toContain('购物车');
  });

  it('🔴 点商品行 → 进商品详情（看看现在还卖不卖、什么价）', async () => {
    order = DONE;
    await open();
    call('onOpenItem', { currentTarget: { dataset: { id: 'p-2' } } });
    expect(nav).toEqual(['/pages/detail/index?id=p-2']);
  });
});
