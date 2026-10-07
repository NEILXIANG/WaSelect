// @vitest-environment jsdom
/**
 * 职责：**网址路由**的组件用例（第一批②）——地址栏决定看哪一页，页面切换会写回地址栏。
 *
 * @why 必须走组件用例：这一批要守的不是"解析函数对不对"（`router.unit.test.ts` 已守），
 *      而是"**点了侧栏，地址栏真的变了；改了地址栏，页面真的跟着变**"这条闭环。
 *      断一半的失效形态很安静：解析全绿、侧栏点着也有反应（乐观更新），
 *      但刷新一次就回到第一个页——运营遇到的是"我发给同事的链接打不开他要的那个页"。
 *
 * @why 特意测"改 hash 不点按钮"（后退 / 手改地址栏）：`App` 里 `go()` 在 navigate 之后
 *      还做了一次 `setRoute` 乐观更新，于是"点按钮"这条路**即使订阅坏了也是绿的**——
 *      只有走 hashchange 那条路才验得到订阅。这是本批最容易留下的假绿灯。
 *
 * @see ./App.tsx；./router.ts；../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1②
 */
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY } from './api/token-store.js';
import { button, click, mount, type Mounted } from './testing/dom.js';
import { App } from './App.js';

let mounted: Mounted | undefined;
/** 所有页面发出的请求（假 fetch 记录）。 */
let requested: string[];

/** 假后端：一律回 200 空列表，只记录 URL（测的是路由不是业务）。 */
function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function open(hash: string): Promise<HTMLElement> {
  location.hash = hash;
  mounted = await mount(createElement(App));
  return mounted.el;
}

/** 模拟"用户改了地址栏 / 按了后退"：hashchange 是唯一的通知途径。 */
async function goHash(hash: string): Promise<void> {
  location.hash = hash;
  await act(async () => {
    dispatchEvent(new Event('hashchange'));
  });
}

const heading = (el: HTMLElement): string => el.querySelector('.title')?.textContent ?? '';

beforeEach(() => {
  requested = [];
  stubFetch();
  localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
  location.hash = '';
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe('App：侧栏', () => {
  it('六个一级页都在侧栏里（新增页面忘挂 = 没人能点进去）', async () => {
    const el = await open('#/orders');
    const labels = [...el.querySelectorAll('.sidebar .nav-item')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(labels).toEqual(['订单管理', '商品管理', '运营配置', '首页 Banner', '风控', '运营日志']);
  });

  it('当前页在侧栏里高亮（只有一个，避免"看着像在两处"）', async () => {
    const el = await open('#/risk');
    const on = [...el.querySelectorAll('.sidebar .nav-item-on')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(on).toEqual(['风控']);
  });
});

describe('App：地址栏 → 页面（刷新 / 分享 / 后退都要成立）', () => {
  it('#/orders 打开即订单页', async () => {
    const el = await open('#/orders');
    expect(heading(el)).toBe('订单管理');
  });

  it('#/risk 打开即风控页（发给同事的链接要打到同一屏）', async () => {
    const el = await open('#/risk');
    expect(heading(el)).toBe('风控：拒付与拉黑');
  });

  it('🔴 改 hash（后退 / 手改地址栏）→ 页面跟着变（只靠点按钮的乐观更新验不到订阅）', async () => {
    const el = await open('#/orders');
    expect(heading(el)).toBe('订单管理');
    await goHash('#/products');
    expect(heading(el), 'hashchange 没有驱动换页').toBe('商品管理');
  });

  it('认不出的地址回落订单页，不白屏', async () => {
    const el = await open('#/nope');
    expect(heading(el)).toBe('订单管理');
  });
});

describe('App：页面 → 地址栏（点了要能复制走）', () => {
  it('🔴 点侧栏项 → 地址栏变成那一页', async () => {
    const el = await open('#/orders');
    await click(button(el, '商品管理'));
    expect(location.hash).toBe('#/products');
    expect(heading(el)).toBe('商品管理');
  });

  it('🔴 订单详情进地址栏（`#/orders/:id`），刷新后还能回到同一单', async () => {
    const el = await open('#/orders');
    // 列表是空的（假后端返回空），所以直接走"地址栏里带 id"这一侧：
    // 详情页自己会重新拉单条，这正是它能做深链接的原因（@see router.ts @limitation 一）
    await goHash('#/orders/o-1');
    expect(heading(el), '带 id 的地址应打开详情而不是列表').toBe('订单详情');
    requested = [];
    await goHash('#/orders');
    expect(heading(el)).toBe('订单管理');
  });
});

describe('App：筛选进地址栏（第一批③工作台的跳转依赖它）', () => {
  it('🔴 `#/orders?status=paid` 打开即按"待发货"筛好的列表', async () => {
    await open('#/orders?status=paid');
    const list = requested.filter((u) => u.includes('/admin/orders') && !u.includes('size=1'));
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toContain('status=paid');
  });

  it('筛选变默认时不留 `?status=all` 这种没有信息的尾巴', async () => {
    const el = await open('#/orders?status=paid');
    const select = el.querySelector('.filters select') as HTMLSelectElement;
    select.value = 'all';
    await act(async () => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(location.hash).toBe('#/orders');
  });
});
