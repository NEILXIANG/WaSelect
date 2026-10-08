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
import { button, click, mount, type, type Mounted } from './testing/dom.js';
import { App } from './App.js';

let mounted: Mounted | undefined;
/** 所有页面发出的请求（假 fetch 记录）。 */
let requested: string[];

/**
 * 假后端：一律回 200，只记录 URL（测的是路由不是业务）。
 * @why body 里同时带 `items/total` 与 `today/last7`：列表页与工作台页的形状校验都在
 *      `*.api.ts` 里硬失败（@limitation 一），缺任一半都会让对应那一页抛错，
 *      于是"页面切过去了没有"会被一串错误提示盖住——那是路由用例不该有的噪音。
 */
function stubFetch(): void {
  const window = { from: 'x', to: 'y', orders: 0, paid_orders: 0, sales_jpy: 0, avg_jpy: null };
  vi.stubGlobal('fetch', async (url: unknown) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ items: [], total: 0, today: window, last7: window }), {
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
  it('七个一级页都在侧栏里，工作台在最前（新增页面忘挂 = 没人能点进去）', async () => {
    const el = await open('#/orders');
    const labels = [...el.querySelectorAll('.sidebar .nav-item')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(labels).toEqual([
      '工作台',
      '订单管理',
      '商品管理',
      '运营配置',
      '首页 Banner',
      '风控',
      '运营日志',
    ]);
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

  it('认不出的地址回落首页（工作台），不白屏', async () => {
    const el = await open('#/nope');
    expect(location.hash).toBe('#/nope');
    expect(el.querySelector('.sidebar .nav-item-on')?.textContent?.trim()).toBe('工作台');
  });

  it('#/dashboard 打开即工作台（HOME_PAGE）', async () => {
    await open('#/dashboard');
    expect(requested.some((u) => u.includes('/admin/dashboard/sales'))).toBe(true);
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
    // AJ-400：状态下拉改成页签——回到默认 = 点「全部」页签
    const all = [...el.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? '').startsWith('全部'),
    );
    await click(all);
    expect(location.hash).toBe('#/orders');
  });

  it('🔴 多状态页签进地址栏、再从地址栏读回来（AJ-400：刷新 / 收藏 / 发同事都是同一个列表）', async () => {
    const el = await open('#/orders');
    const tab = [...el.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? '').startsWith('售后·退款'),
    );
    await click(tab);
    expect(new URLSearchParams(location.hash.split('?')[1]).get('status')).toBe(
      'refunding,refunded',
    );
    // 模拟"刷新"：卸掉再按同一个地址挂一次
    const hash = location.hash;
    await mounted?.unmount();
    requested = [];
    const again = await open(hash);
    const list = requested.filter((u) => u.includes('/admin/orders') && !u.includes('size=1'));
    expect(decodeURIComponent(list[0] ?? '')).toContain('status=refunding,refunded');
    expect(again.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      '售后·退款',
    );
  });
});

describe('App：后退 / 前进也要过未保存提醒（批次复审发现此前完全绕过）', () => {
  it('🔴 Banner 表单改了一半按后退 → 地址回滚、弹二次确认；确认后才真正换页', async () => {
    const el = await open('#/banners');
    const field = el.querySelector(
      '.main input[type=text], .main input:not([type]), .main textarea',
    );
    expect(field, 'Banner 页应有可输入的字段').not.toBeNull();
    await type(field, '双十一主图');

    await goHash('#/risk');
    expect(heading(el), '脏着时不应被 hashchange 直接换走').not.toBe('风控：拒付与拉黑');
    expect(location.hash, '地址栏应回滚到当前页').toBe('#/banners');
    expect(el.ownerDocument.querySelector('.dialog')?.textContent ?? '').toContain('未保存');

    await click(button(el.ownerDocument.body, '放弃修改并离开'));
    expect(heading(el)).toBe('风控：拒付与拉黑');
    expect(location.hash).toBe('#/risk');
  });
});
