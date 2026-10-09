/**
 * 职责：条款页薄壳的「重试」行为（审查 2026-10-09）。
 *
 * @why 重试时只设了 `loading`，而页面渲染看的是 `state`、旧 `error` 要等请求成功才清——
 *      点了"重试"后失败块原样挂着、没有任何加载提示，看起来像按钮没反应。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;

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
