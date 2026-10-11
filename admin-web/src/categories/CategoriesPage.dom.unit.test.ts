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

  it('停用 / 启用一键切换：PUT {active}', async () => {
    const el = await open();
    await click(button(el, '启用'));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      path: '/api/v1/admin/categories/toy',
      method: 'PUT',
      body: { active: true },
    });
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
