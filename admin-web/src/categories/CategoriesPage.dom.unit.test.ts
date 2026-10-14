// @vitest-environment jsdom
/**
 * 职责：后台「商品分类」管理页（CategoriesPage.tsx，AJ-491）的组件行为用例。
 * @why 分类改为后台可配置（用户 2026-10-11）：运营要能新建、改名改序、停用、删除，并一眼看出哪些分类买家看得到、为什么看不到。
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { CategoriesPage } from './CategoriesPage.js';
import { primeCategoryCache, resetCategoryCache } from './useCategories.js';

let mounted: Mounted | undefined;
let calls: Array<{ path: string; method?: string; body?: unknown }>;
let items: Array<Record<string, unknown>>;
let failWith: ApiError | null;

beforeEach(() => {
  resetCategoryCache();
  calls = [];
  failWith = null;
  items = [
    {
      key: 'tea',
      name: '日本茶',
      sort: 5,
      active: true,
      active_product_count: 0,
      product_count: 0,
    },
    {
      key: 'beauty',
      name: '美妆护肤',
      sort: 10,
      active: true,
      active_product_count: 3,
      product_count: 4,
    },
    {
      key: 'toy',
      name: '玩具',
      sort: 20,
      active: false,
      active_product_count: 2,
      product_count: 2,
    },
  ];
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(): Promise<HTMLElement> {
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    calls.push(req);
    if (req.method !== undefined && req.method !== 'GET' && failWith !== null) throw failWith;
    if (req.method === undefined || req.method === 'GET') return { items };
    return {};
  };
  mounted = await mount(createElement(CategoriesPage, { api: api as never }));
  await flush();
  return mounted.el;
}

const rows = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('tbody tr')].map((r) => (r.textContent ?? '').replace(/\s+/g, ' '));

describe('商品分类管理页', () => {
  it('🔴 每行说清买家端看不看得到、为什么：有在售商品 → 显示中；没有 → 已隐藏（无在售商品）；停用 → 已停用', async () => {
    const el = await open();
    const r = rows(el);
    expect(r[0]).toContain('日本茶');
    expect(r[0]).toContain('已隐藏（暂无在售商品）');
    expect(r[1]).toContain('显示中');
    expect(r[1]).toContain('3 / 4');
    expect(r[2]).toContain('已停用');
  });

  it('🔴 新建：本地预检不过不发请求；填对后 POST，成功后重新取列表', async () => {
    const el = await open();
    await type(el.querySelector('input[name="category-name"]'), '母婴');
    await type(el.querySelector('input[name="category-key"]'), 'Baby');
    await click(button(el, '新建分类'));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(el.textContent).toContain('分类代码用小写英文字母开头');
    await type(el.querySelector('input[name="category-key"]'), 'baby_care');
    await click(button(el, '新建分类'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      key: 'baby_care',
      name: '母婴',
      sort: 100,
    });
    expect(
      calls.filter((c) => c.method === undefined || c.method === 'GET').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('🔴 服务端说名称重复 → 标到名称框，说人话', async () => {
    const el = await open();
    failWith = new ApiError(40001, '参数缺失或格式错误', 't', {
      data: { field: 'name', reason: 'duplicate', count: 1 },
    });
    await type(el.querySelector('input[name="category-name"]'), '日本茶');
    await type(el.querySelector('input[name="category-key"]'), 'tea2');
    await click(button(el, '新建分类'));
    expect(el.textContent).toContain('已经有同名的分类了');
    // 填的值不行是运营自己能改的事，不是技术故障：不给报障编号（全入口点击测试 2026-10-12；同登录页 3c6d8c8）
    expect(el.textContent).not.toContain('发给技术人员');
  });

  it('🔴 行内改名撞上重名 → 说人话、不给报障编号；仍停在编辑态', async () => {
    const el = await open();
    failWith = new ApiError(40001, '参数缺失或格式错误', 't-dup', {
      data: { field: 'name', reason: 'duplicate', count: 1 },
    });
    await click([...el.querySelectorAll('tbody tr')][1]?.querySelector('button[data-act="edit"]'));
    await type(el.querySelector('input[name="edit-name"]'), '日本茶');
    await click(button(el, '保存'));
    expect(el.textContent).toContain('已经有同名的分类了');
    expect(el.textContent).not.toContain('发给技术人员');
    expect(el.querySelector('input[name="edit-name"]')).not.toBeNull();
  });

  it('认不出的服务端错误（如 50000）照旧给报障编号——那才是技术人员要查的', async () => {
    const el = await open();
    failWith = new ApiError(50000, '服务器内部错误', 't-500');
    await type(el.querySelector('input[name="category-name"]'), '零食');
    await type(el.querySelector('input[name="category-key"]'), 'snack');
    await click(button(el, '新建分类'));
    expect(el.textContent).toContain('发给技术人员');
  });

  it('🔴 有商品的分类不能删（按钮不可点、提示改为停用）；空分类删除先确认再发 DELETE', async () => {
    const el = await open();
    const beautyDel = [...el.querySelectorAll('tbody tr')][1]?.querySelector(
      'button[data-act="delete"]',
    ) as HTMLButtonElement;
    expect(beautyDel.disabled).toBe(true);
    expect(beautyDel.title).toContain('停用');
    const teaDel = [...el.querySelectorAll('tbody tr')][0]?.querySelector(
      'button[data-act="delete"]',
    ) as HTMLButtonElement;
    await click(teaDel);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click(button(el, '确认删除'));
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/v1/admin/categories/tea');
  });

  // 真实界面实测 2026-10-11：先在商品编辑页把商品改到新分类，再回分类页——看到的还是旧数字（本标签页缓存）
  it('🔴 打开分类页总是重新取一次（不吃别的页面留下的缓存）', async () => {
    primeCategoryCache([
      {
        key: 'tea',
        name: '旧缓存',
        sort: 5,
        active: true,
        active_product_count: 0,
        product_count: 0,
      },
    ]);
    const el = await open();
    expect(calls.filter((c) => c.method === undefined || c.method === 'GET')).toHaveLength(1);
    expect(rows(el)[0]).toContain('日本茶');
    expect(el.textContent).not.toContain('旧缓存');
  });

  it('启用一键切换：PUT {active: true}', async () => {
    const el = await open();
    await click(button(el, '启用'));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      path: '/api/v1/admin/categories/toy',
      method: 'PUT',
      body: { active: true },
    });
  });

  // 体验审查 2026-10-15（P2-6）：停用一步生效、后果只在**成功之后**的 Toast 里说清——
  //   运营按下按钮时并不知道会发生什么，而买家端的影响是即时的（首页少一整个分类）。
  it('🔴 停用要两步：先确认（后果说在确认之前），确认后才发 PUT {active: false}', async () => {
    const el = await open();
    await click(
      [...el.querySelectorAll('tbody tr')][1]?.querySelector('button[data-act="toggle"]'),
    );
    // 确认框先出现，且**在按下之前**就说完后果
    expect(button(el, '确认停用')).not.toBeNull();
    expect(el.textContent).toContain('停用后小程序首页不再显示这个分类');
    expect(el.textContent).toContain('要停卖请到商品管理下架');
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
    await click(button(el, '确认停用'));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      path: '/api/v1/admin/categories/beauty',
      method: 'PUT',
      body: { active: false },
    });
  });

  it('🔴 确认框上点取消 → 不发请求，分类照旧启用', async () => {
    const el = await open();
    await click(
      [...el.querySelectorAll('tbody tr')][1]?.querySelector('button[data-act="toggle"]'),
    );
    await click(button(el, '取消'));
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
    expect(rows(el)[1]).toContain('显示中');
  });

  // 规律排查 2026-10-12：提示说"不想让买家看到可以停用""小程序不再显示它"，可停用只收起首页分类入口，
  //   商品仍在「全部」和搜索里买得到——运营照提示停用以为商品停卖了
  it('🔴 停用的提示说清只收起首页分类、商品要停卖请下架', async () => {
    const el = await open();
    const beautyDel = [...el.querySelectorAll('tbody tr')][1]?.querySelector(
      'button[data-act="delete"]',
    ) as HTMLButtonElement;
    expect(beautyDel.title).toContain('下架');
    expect(beautyDel.title).not.toContain('不想让买家看到');
    await click(
      [...el.querySelectorAll('tbody tr')][1]?.querySelector('button[data-act="toggle"]'),
    );
    // 确认框里就说（P2-6），不是等到成功之后的 Toast
    expect(el.textContent).toContain('首页不再显示');
    expect(el.textContent).toContain('仍能在「全部」和搜索里买到');
    await click(button(el, '确认停用'));
    expect(el.textContent).toContain('已停用「美妆护肤」');
  });

  it('改名 / 排序：点编辑 → 行内输入 → 保存发 PUT {name, sort}', async () => {
    const el = await open();
    await click([...el.querySelectorAll('tbody tr')][1]?.querySelector('button[data-act="edit"]'));
    await type(el.querySelector('input[name="edit-name"]'), '美妆个护');
    await type(el.querySelector('input[name="edit-sort"]'), '8');
    await click(button(el, '保存'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: '美妆个护', sort: 8 });
  });
});
