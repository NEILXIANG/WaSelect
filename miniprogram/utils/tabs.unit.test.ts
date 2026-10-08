/**
 * 职责：`setActiveTab` / `TAB_INDEX` 的行为钉子 + **三处 tab 清单的一致性**（S5）。
 *
 * @why S5 引入自定义 tabBar 之后，"哪个 tab 是第几个"散在三处
 *      （app.json 的 `tabBar.list`、组件的 `data.list`、本文件的 `TAB_INDEX`）。
 *      它们漂移的表现是"人在购物车、高亮却在首页"——**不报错、不崩溃**，
 *      且没有任何测试天然覆盖它（只有真机点一遍才看得见）。
 *      这里用一处断言把三份钉在一起，是这条防线唯一存在的地方。
 *
 * @why 顺带钉"`setActiveTab` 取不到 tabBar 时不炸"：它在 `onShow` 里被调用，
 *      抛错的代价是**白屏**，而"高亮没更新"的代价只是晚一帧——
 *      这两者的严重程度差着一个数量级，必须有一条用例守着"宁可不亮也不白屏"。
 *
 * @see ./tabs.js；../custom-tab-bar/index.js；../app.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAB_COUNT, TAB_INDEX, cartBadgeText, setActiveTab, setCartBadge } from './tabs.js';

const root = resolve(import.meta.dirname, '../..');

/**
 * 读 `custom-tab-bar/index.js` 里 `data.list` 的四个 pagePath（顺序即渲染顺序）。
 * @why 去掉前导斜杠再比：组件的 `pagePath` 是给 `switchTab` 用的**绝对路径**（`/pages/…`），
 *      而 `app.json` 的 `pagePath` 是**相对路径**（`pages/…`）。两边斜杠不同但指的是同一页，
 *      直接比会永远红——红得没有意义，于是有人会删掉这条断言（那才是真正的损失）。
 */
function componentListPaths(): string[] {
  const src = readFileSync(resolve(root, 'miniprogram/custom-tab-bar/index.js'), 'utf8');
  const start = src.indexOf('list: [');
  const block = src.slice(start, src.indexOf('],', start));
  return [...block.matchAll(/pagePath:\s*'([^']+)'/g)].map((m) => (m[1] ?? '').replace(/^\//, ''));
}

/** 读 `app.json` 的 `tabBar.list[].pagePath`（顺序即宿主认定的 tab 顺序）。 */
function appJsonListPaths(): string[] {
  const json = JSON.parse(readFileSync(resolve(root, 'miniprogram/app.json'), 'utf8')) as {
    tabBar?: { custom?: boolean; list?: { pagePath?: string }[] };
  };
  return (json.tabBar?.list ?? []).map((it) => it.pagePath ?? '');
}

/** 一个够用的假 tabBar（只实现组件会用到的那一个方法）。 */
function fakeBar() {
  const calls: unknown[] = [];
  return {
    setData(v: unknown) {
      calls.push(v);
    },
    calls,
  };
}

describe('setActiveTab（tab 页在 onShow 里注入高亮）', () => {
  it('正常注入：把该 tab 的序号写进 tabBar 的 active', () => {
    const bar = fakeBar();
    expect(setActiveTab({ getTabBar: () => bar }, 'cart')).toBe(true);
    expect(bar.calls).toEqual([{ active: TAB_INDEX.cart }]);
  });

  it('四个 tab 名都能注入，且序号互不相同（重复序号 = 两个格子同时高亮）', () => {
    const seen = new Set<number>();
    for (const name of ['home', 'cart', 'order', 'user'] as const) {
      const bar = fakeBar();
      expect(setActiveTab({ getTabBar: () => bar }, name)).toBe(true);
      seen.add((bar.calls[0] as { active: number }).active);
    }
    expect(seen.size).toBe(4);
  });

  it('⚠️ 取不到 tabBar（getTabBar 返回 null / 不是方法）→ 返回 false 且**不抛**（抛了就是白屏）', () => {
    expect(setActiveTab({ getTabBar: () => null }, 'home')).toBe(false);
    expect(setActiveTab({}, 'home')).toBe(false);
    expect(setActiveTab(undefined, 'home')).toBe(false);
    expect(setActiveTab(null, 'home')).toBe(false);
  });

  it('tabBar 实例**没有 setData** → 返回 false 且不抛（基础库差异的兜底）', () => {
    expect(setActiveTab({ getTabBar: () => ({}) }, 'home')).toBe(false);
  });

  it('⚠️ 传了不认识的 tab 名 → 返回 false，不把 undefined 写进 active', () => {
    const bar = fakeBar();
    // @ts-expect-error 故意传错名：这里钉的是运行期行为
    expect(setActiveTab({ getTabBar: () => bar }, 'discover')).toBe(false);
    expect(bar.calls).toEqual([]);
  });
});

describe('三处 tab 清单必须一致（漂移 = 高亮错位，不报错）', () => {
  it('app.json 的 tabBar 开了 custom，且登记了 4 个 tab 页', () => {
    const json = JSON.parse(readFileSync(resolve(root, 'miniprogram/app.json'), 'utf8')) as {
      tabBar?: { custom?: boolean };
    };
    expect(json.tabBar?.custom, 'S5：`tabBar.custom` 必须是 true').toBe(true);
    expect(appJsonListPaths().length).toBe(TAB_COUNT);
  });

  it('🔴 组件的 data.list 与 app.json 的 tabBar.list **逐项同序**（错位 = 点了 A 高亮 B）', () => {
    expect(componentListPaths()).toEqual(appJsonListPaths());
  });

  it('🔴 custom-tab-bar 组件四件套齐全（少了任何一个 = 底部栏不出现，且不报错）', () => {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      expect(
        existsSync(resolve(root, `miniprogram/custom-tab-bar/index${ext}`)),
        `缺少 custom-tab-bar/index${ext}`,
      ).toBe(true);
    }
  });

  it('🔴 TAB_INDEX 的序号等于它们在 app.json 里的下标（第三份映射）', () => {
    const paths = appJsonListPaths();
    expect(paths[TAB_INDEX.home]).toContain('pages/home/index');
    expect(paths[TAB_INDEX.cart]).toContain('pages/cart/index');
    expect(paths[TAB_INDEX.order]).toContain('pages/order/index');
    expect(paths[TAB_INDEX.user]).toContain('pages/user/index');
  });

  it('🔴 四个 tab 页的 onShow 都调用了 setActiveTab（少一个 = 那一页高亮不动）', () => {
    const names = ['home', 'cart', 'order', 'user'] as const;
    for (const name of names) {
      const src = readFileSync(resolve(root, `miniprogram/pages/${name}/index.js`), 'utf8');
      expect(src, `pages/${name}/index.js 的 onShow 里没有注入 active`).toMatch(/setActiveTab\(/);
    }
  });
});

describe('购物车角标（M-14，AJ-406）', () => {
  it('cartBadgeText：0 / 非整数不显示；1–99 原样；>99 → 99+', () => {
    expect(cartBadgeText(0)).toBe('');
    expect(cartBadgeText(-1)).toBe('');
    expect(cartBadgeText(1.5)).toBe('');
    expect(cartBadgeText(undefined)).toBe('');
    expect(cartBadgeText(1)).toBe('1');
    expect(cartBadgeText(99)).toBe('99');
    expect(cartBadgeText(100)).toBe('99+');
  });

  it('🔴 setCartBadge：读购物车件数写进 tabBar 的 cartBadge（只写这一个键）', () => {
    const bar = fakeBar();
    expect(setCartBadge({ getTabBar: () => bar }, { count: () => 3 })).toBe(true);
    expect(bar.calls).toEqual([{ cartBadge: '3' }]);
  });

  it('购物车缺失 → 按 0 件（清掉角标）；取不到 tabBar → false 且不抛', () => {
    const bar = fakeBar();
    expect(setCartBadge({ getTabBar: () => bar }, undefined)).toBe(true);
    expect(bar.calls).toEqual([{ cartBadge: '' }]);
    expect(setCartBadge({ getTabBar: () => null }, { count: () => 3 })).toBe(false);
    expect(setCartBadge(undefined, { count: () => 3 })).toBe(false);
  });

  it('角标挂在购物车那一格：组件的 cartIndex 取自 TAB_INDEX.cart（不另写序号）', () => {
    const src = readFileSync(resolve(root, 'miniprogram/custom-tab-bar/index.js'), 'utf8');
    expect(src).toMatch(/cartIndex:\s*TAB_INDEX\.cart/);
  });

  it('四个 tab 页的 onShow 都更新角标（漏一个 = 切到那一页角标停在旧数）', () => {
    for (const page of ['home', 'cart', 'order', 'user']) {
      const src = readFileSync(resolve(root, `miniprogram/pages/${page}/index.js`), 'utf8');
      expect(src, page).toMatch(/setCartBadge\(this, app\.globalData\.cart\)/);
    }
  });
});
