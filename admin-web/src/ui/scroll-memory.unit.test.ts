/**
 * 职责：列表滚动位置的记忆（全入口点击测试 2026-10-11）。
 * @why 实测：订单列表滚到下面点开一单，返回后回到页顶，要重新往下找——主流后台（如 Shopify）返回时停在原处。
 *      点链接 / 侧栏进新页面仍从页顶开始；只有后退 / 前进才回到记下的位置。
 * @limitation 只验决策与存取；真正的滚动（要等列表取数撑开高度）在浏览器里实测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumePush,
  markPush,
  rememberScroll,
  resetScrollMemory,
  scrollTarget,
} from './scroll-memory.js';

afterEach(() => resetScrollMemory());

describe('scroll-memory', () => {
  it('🔴 后退 / 前进回到记下的位置', () => {
    rememberScroll('#/orders?status=paid', 1495);
    expect(scrollTarget('#/orders?status=paid', consumePush())).toBe(1495);
  });

  it('🔴 点链接 / 侧栏进来 → 页顶（即使以前在这页滚到过下面）', () => {
    rememberScroll('#/orders?status=paid', 1495);
    markPush();
    expect(scrollTarget('#/orders?status=paid', consumePush())).toBe(0);
  });

  it('标记只管下一次（用掉即清）；没记过的页面 → 页顶', () => {
    markPush();
    expect(consumePush()).toBe(true);
    expect(consumePush()).toBe(false);
    expect(scrollTarget('#/customers', false)).toBe(0);
  });
});
