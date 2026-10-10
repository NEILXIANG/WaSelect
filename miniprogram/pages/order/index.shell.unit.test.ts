/**
 * 职责：订单列表薄壳的**行为**用例——M-04 下拉刷新（AJ-405）。
 *
 * @why 下拉刷新有两个**都不报错**的失效形态：
 *      ① 页面 json 没开 `enablePullDownRefresh` → `onPullDownRefresh` 永远不会被调用，下拉只是回弹；
 *      ② 刷新完不调 `stopPullDownRefresh`（尤其是**失败**那条路）→ 顶部的加载动画一直挂着。
 *      两者都只能把页面跑起来看（或读 json），纯函数里没有它们。
 * @limitation 不渲染（mp-page @limitation 一）：下拉手势本身、动画观感只能真机看（AppID 未下来）。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let calls: string[];
let fail: boolean;
let hold: ReturnType<typeof deferred<unknown>> | null;
/** AJ-408：页签用例要改写一次性意图（globalData.orderTab）与"空列表"——setup 只是多留两个句柄，原用例不变。 */
let gd: Record<string, unknown>;
let empty: boolean;

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  calls = [];
  fail = false;
  hold = null;
  empty = false;
  vi.stubGlobal('wx', {
    stopPullDownRefresh: () => calls.push('stop'),
    navigateTo: () => undefined,
    switchTab: () => undefined,
  });
  gd = {
    orderTab: '',
    apiBase: 'http://api.test',
    api: async (req: { url: string }) => {
      calls.push(`GET ${req.url.replace('http://api.test', '')}`);
      if (hold !== null) return hold.promise;
      if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
      if (empty) return { items: [] };
      return {
        items: [{ order_id: 'o-1', order_no: 'WS-20261008-0001', status: 'paid', total_jpy: 9150 }],
      };
    },
  };
  page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: gd });
  call('onLoad');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订单列表：下拉刷新（M-04）', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh（没开 = onPullDownRefresh 永远不会被调用）', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重取列表，取完才收起下拉动画（先收后取 = 用户以为刷新完了、看到的还是旧数据）', async () => {
    hold = deferred<unknown>();
    const done = call<Promise<void>>('onPullDownRefresh');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders']);
    hold.resolve({ items: [{ order_id: 'o-2', status: 'shipped' }] });
    await done;
    expect(calls).toEqual(['GET /api/v1/orders', 'stop']);
    expect((page.data['rows'] as Array<{ statusText: string }>)[0]?.statusText).toBe(
      '已发货 · 国际运输中',
    );
  });

  it('🔴 取数失败也要收起下拉动画，并显示错误（不能一直转圈）', async () => {
    fail = true;
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['GET /api/v1/orders', 'stop']);
    expect(page.data['error']).not.toBe('');
    expect(page.data['rows']).toEqual([]);
  });
});

describe('订单列表：状态页签（M-10，AJ-408）', () => {
  it('🔴 点页签 → 带 status 重取；「全部」不带参数', async () => {
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'unpaid' } },
    });
    expect(calls).toEqual(['GET /api/v1/orders?status=created,pending_payment']);
    expect(page.data['activeTab']).toBe('unpaid');
    expect(
      (page.data['tabs'] as Array<{ key: string; active: boolean }>).find((t) => t.active)?.key,
    ).toBe('unpaid');
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'all' } },
    });
    expect(calls.at(-1)).toBe('GET /api/v1/orders');
  });

  it('🔴 从「我的」带来的一次性意图：onShow 读走并清空，按它取数', async () => {
    gd['orderTab'] = 'after_sale';
    (page['onShow'] as () => void)();
    await settle();
    // AJ-430：「售后·退款」取全量、本地按 tabItems 过滤（有售后申请的已送达单也要在）
    expect(calls.at(-1)).toBe('GET /api/v1/orders');
    expect(gd['orderTab']).toBe('');
    expect(page.data['activeTab']).toBe('after_sale');
  });

  it('🔴 快速切页签：先发的请求后回来 → 丢弃（不让「全部」的结果盖住「待付款」）', async () => {
    hold = deferred<unknown>();
    const slow = (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'all' } },
    });
    await settle();
    const first = hold;
    hold = null;
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'to_ship' } },
    });
    first.resolve({ items: [{ order_id: 'stale', status: 'created' }] });
    await slow;
    const rows = page.data['rows'] as Array<{ orderId: string }>;
    expect(rows.map((r) => r.orderId)).toEqual(['o-1']);
    expect(page.data['activeTab']).toBe('to_ship');
  });

  it('分页签空态文案（「待付款」里空着不说"还没有订单"）', async () => {
    empty = true;
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'unpaid' } },
    });
    expect(page.data['empty']).toBe(true);
    expect(page.data['emptyText']).toBe('「待付款」里暂时没有订单');
  });
});

// AJ-430：页签过滤在页面里真的接上了（不只是 utils/order-tabs 单测里对）
describe('订单列表：「售后·退款」本地过滤', () => {
  it('🔴 取回全量后只显示退款中 / 已退款或有售后申请的单', async () => {
    gd['api'] = async (req: { url: string }) => {
      calls.push(`GET ${req.url.replace('http://api.test', '')}`);
      return {
        items: [
          {
            order_id: 'o-del',
            order_no: 'N1',
            status: 'delivered',
            total_jpy: 1000,
            after_sale_state: null,
          },
          {
            order_id: 'o-as',
            order_no: 'N2',
            status: 'delivered',
            total_jpy: 1000,
            after_sale_state: 'open',
          },
          {
            order_id: 'o-rf',
            order_no: 'N3',
            status: 'refunded',
            total_jpy: 1000,
            after_sale_state: null,
          },
        ],
      };
    };
    gd['orderTab'] = 'after_sale';
    (page['onShow'] as () => void)();
    await settle();
    expect((page.data['rows'] as Array<{ orderId: string }>).map((r) => r.orderId)).toEqual([
      'o-as',
      'o-rf',
    ]);
  });
});
