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

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  calls = [];
  fail = false;
  hold = null;
  vi.stubGlobal('wx', {
    stopPullDownRefresh: () => calls.push('stop'),
    navigateTo: () => undefined,
    switchTab: () => undefined,
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: { url: string }) => {
        calls.push(`GET ${req.url.replace('http://api.test', '')}`);
        if (hold !== null) return hold.promise;
        if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
        return {
          items: [
            { order_id: 'o-1', order_no: 'WS-20261008-0001', status: 'paid', total_jpy: 9150 },
          ],
        };
      },
    },
  });
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
