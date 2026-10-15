/**
 * 职责：条款页薄壳的「重试」行为（审查 2026-10-09）。
 *
 * @why 重试时只设了 `loading`，而页面渲染看的是 `state`、旧 `error` 要等请求成功才清——
 *      点了"重试"后失败块原样挂着、没有任何加载提示，看起来像按钮没反应。
 *
 * UX-008（AJ-556）：本页原先没接请求序号——`onShow` 每次进屏都重取，快退快进会并发两个 `load`，
 *      先发后到的旧响应会把**旧版本号**盖回去。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;

/** 起一个条款页；`api` 由用例自己给（要能编排"哪个响应先回来"）。 */
const open = async (api: (req: { url: string }) => Promise<unknown>): Promise<void> => {
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: { apiBase: 'http://api.test', api },
  });
  (page['onLoad'] as () => void)();
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('条款页：重试', () => {
  it('🔴 失败后点重试 → 立刻显示加载中、收起旧错误；成功后显示条款', async () => {
    let next: Promise<unknown> = Promise.reject(Object.assign(new Error('timeout'), { code: -1 }));
    next.catch(() => undefined);
    page = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: { apiBase: 'http://api.test', api: () => next },
    });
    (page['onLoad'] as () => void)();
    (page['onShow'] as () => void)();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(page.data['error']).not.toBe('');

    const d = deferred<unknown>();
    next = d.promise;
    (page['onShow'] as () => void)();
    expect(page.data['error']).toBe('');
    expect((page.data['state'] as { showLoading: boolean }).showLoading).toBe(true);

    d.resolve({ version: 'TOS-2026-09-20', urls: { zh: 'https://legal.example.com/zh' } });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect((page.data['state'] as { showLoading: boolean }).showLoading).toBe(false);
    expect(page.data['version']).toBe('TOS-2026-09-20');
  });
});

// UX-008（AJ-556）：`onShow` 每次进屏都重取（条款版本会变），快退快进会并发两个 `load`——
// 弱网下先发的那次后回来，页面显示的就不是当前生效的那一版，而用户是从结算页「已同意条款」跳过来的。
describe('条款页：取数序号（UX-008 / AJ-556）', () => {
  it('🔴 先发的慢响应回来时不覆盖后发的快响应（版本号以最新的那次为准）', async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    let n = 0;
    await open(() => (n++ === 0 ? slow.promise : fast.promise));
    (page['onShow'] as () => void)();
    await settle();
    (page['onShow'] as () => void)();
    await settle();
    fast.resolve({ version: 'TOS-NEW', urls: { zh: 'https://legal.example.com/zh' } });
    await settle();
    expect(page.data['version']).toBe('TOS-NEW');
    slow.resolve({ version: 'TOS-OLD', urls: { zh: 'https://legal.example.com/zh-old' } });
    await settle();
    expect(page.data['version']).toBe('TOS-NEW');
    expect(page.data['langs']).toEqual([
      expect.objectContaining({ url: 'https://legal.example.com/zh' }),
    ]);
  });

  it('🔴 页面已销毁（onUnload）→ 在途响应回来不改页面，也不再翻 loading', async () => {
    const held = deferred<unknown>();
    await open(() => held.promise);
    (page['onShow'] as () => void)();
    await settle();
    expect(page.data['loading']).toBe(true);
    (page['onUnload'] as () => void)();
    held.resolve({ version: 'TOS-NEW', urls: { zh: 'https://legal.example.com/zh' } });
    await settle();
    expect(page.data['version']).toBe('');
    expect(page.data['loading']).toBe(true);
  });

  it('取数失败的错误仍然照常显示（序号不能把错误分支也一起吞掉）', async () => {
    await open(() => Promise.reject(Object.assign(new Error('网络请求失败'), { code: -1 })));
    (page['onShow'] as () => void)();
    await settle();
    expect(page.data['error']).not.toBe('');
    expect(page.data['loading']).toBe(false);
  });
});
