// @vitest-environment jsdom
/**
 * 职责：商品列表的**组件行为**用例——上下架之后，"状态"列与按钮必须说同一件事（AJ-231）。
 *
 * @why 乐观更新只翻了 `online` / `status`，没改 `statusText`，成功后也不重新取列表。
 *      于是每次下架之后：状态列仍写"在售"，按钮却变成了"上架"。
 *      运营看状态列以为没生效，再点一次按钮——把刚下架的商品重新上架了。每次上下架必现。
 *
 * @see ./ProductsPage.tsx；./view.ts（`withStatus`）
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type as typeInto, type Mounted } from '../testing/dom.js';
import { ProductsPage } from './ProductsPage.js';

let mounted: Mounted | undefined;
let patchFails: boolean;
let patches: Array<{ path: string; body?: unknown }>;
/** 服务端此刻的状态与 updated_at（PATCH 成功会改写它们，与真服务端一致）。 */
let serverStatus: string;
let serverUpdatedAt: string;
let edited: Array<Record<string, unknown> | null>;

const PRODUCT = {
  id: 'p-1',
  title: '資生堂 クレンジングオイル 200ml',
  category: 'beauty',
  price_jpy: 2980,
  stock: 12,
  status: 'active',
};

async function open(): Promise<HTMLElement> {
  patches = [];
  edited = [];
  serverStatus = PRODUCT.status;
  serverUpdatedAt = '2026-10-01T00:00:00.000Z';
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    if (req.method === 'PATCH') {
      patches.push(req);
      if (patchFails) throw new ApiError(50000, '服务器内部错误', 't-1');
      serverStatus = (req.body as { status: string }).status;
      serverUpdatedAt = '2026-10-05T00:00:00.000Z';
      return { id: PRODUCT.id, status: serverStatus };
    }
    return {
      items: [{ ...PRODUCT, status: serverStatus, updated_at: serverUpdatedAt }],
      total: 1,
      page: 1,
      size: 20,
    };
  };
  mounted = await mount(
    createElement(ProductsPage, {
      api: api as never,
      onEdit: (_id: string | null, source?: unknown) => {
        edited.push((source ?? null) as Record<string, unknown> | null);
      },
    }),
  );
  return mounted.el;
}

/** 第一行的"状态"单元格文字（表头顺序：商品 / 分类 / 售价 / 库存 / 状态 / 操作）。 */
const statusCell = (el: HTMLElement): string =>
  // 第 0 列是缩略图（三端联动模拟 2026-10-08 新增），状态列随之后移一位
  el.querySelector('tbody tr')?.querySelectorAll('td')[5]?.textContent ?? '';

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** 上下架是两步（点一下出「确认」，再点才生效）。 */
async function toggleStatus(el: HTMLElement, label: '下架' | '上架'): Promise<void> {
  await click(button(el, label));
  await click(button(el, `确认${label}`));
}

describe('商品列表：上下架两步确认（三端联动模拟 2026-10-08）', () => {
  it('🔴 只点一下「下架」→ 不发请求，出现「确认下架 / 取消」；点取消回到原样', async () => {
    patchFails = false;
    const el = await open();
    await click(button(el, '下架'));
    expect(patches).toHaveLength(0);
    expect(button(el, '确认下架')).not.toBeNull();
    await click(button(el, '取消'));
    expect(button(el, '确认下架')).toBeNull();
    expect(patches).toHaveLength(0);
    expect(statusCell(el)).toBe('在售');
  });
});

describe('商品列表：上下架后的状态显示（AJ-231）', () => {
  it('🔴 下架成功：状态列变成"已下架"，按钮变成"上架"——两者说同一件事', async () => {
    patchFails = false;
    const el = await open();
    expect(statusCell(el)).toBe('在售');
    await toggleStatus(el, '下架');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ status: 'offline' });
    expect(statusCell(el)).toBe('已下架');
    expect(button(el, '上架')).not.toBeNull();
  });

  it('🔴 下架失败：状态列与按钮一起回到"在售 / 下架"，并显示错误', async () => {
    patchFails = true;
    const el = await open();
    await toggleStatus(el, '下架');
    expect(statusCell(el)).toBe('在售');
    expect(button(el, '下架')).not.toBeNull();
    // 审查 2026-10-09：反馈统一走 Toast（错误恒停留），不再是页面顶部一行红字
    expect(el.querySelector('.toast[data-kind="error"]')?.textContent).toContain('服务器内部错误');
  });

  it('连续两次：下架再上架，状态列每次都跟着变', async () => {
    patchFails = false;
    const el = await open();
    await toggleStatus(el, '下架');
    await toggleStatus(el, '上架');
    expect(patches.map((p) => p.body)).toEqual([{ status: 'offline' }, { status: 'active' }]);
    expect(statusCell(el)).toBe('在售');
  });
});

/**
 * 上下架之后再编辑，不能撞上自己的乐观锁（A-03）。
 * @why 服务端上下架会刷新 updated_at；列表只做乐观更新、不重新取，编辑页拿到旧的 updated_at，
 *      保存必报 40914「被别人改过了」——"下架 → 改价 → 上架"每次都撞。
 */
describe('商品列表：上下架后编辑（A-03）', () => {
  it('🔴 下架成功后点编辑，传给编辑页的是服务端最新的 updated_at', async () => {
    patchFails = false;
    const el = await open();
    await toggleStatus(el, '下架');
    await flush();
    await click(button(el, '编辑'));
    expect(edited.at(-1)?.['updated_at']).toBe('2026-10-05T00:00:00.000Z');
  });
});

/**
 * AJ-403（第二批 C）：草稿筛选 / 草稿上架 / 列表内联改库存。
 * 假服务端是**有状态**的：库存与状态被 PATCH 改写，列表 GET 回的是改写后的值（与真服务端一致），
 * 这样"冲突后刷新拿到的是最新库存"才测得到。
 */
describe('商品列表：草稿与内联改库存（AJ-403）', () => {
  let state: { status: string; stock: number };
  let reqs: Array<{ path: string; method?: string; body?: unknown }>;
  /** 下一次 PATCH stock 之前，模拟"期间有人下单扣减"。 */
  let sellBeforeNextStockPatch = false;

  async function openDraft(initial: { status: string; stock: number }): Promise<HTMLElement> {
    state = { ...initial };
    reqs = [];
    sellBeforeNextStockPatch = false;
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      reqs.push(req);
      if (req.method === 'PATCH' && req.path.endsWith('/stock')) {
        if (sellBeforeNextStockPatch) {
          sellBeforeNextStockPatch = false;
          state.stock -= 1;
        }
        const b = req.body as { stock: number; expected_stock: number };
        if (b.expected_stock !== state.stock)
          throw new ApiError(40914, '这条内容在你打开之后被别人改过了', 't-stock');
        state.stock = b.stock;
        return { id: 'p-1', stock: state.stock };
      }
      if (req.method === 'PATCH') {
        state.status = (req.body as { status: string }).status;
        return { id: 'p-1', status: state.status };
      }
      return {
        items: [{ ...PRODUCT, ...state, updated_at: '2026-10-01T00:00:00.000Z' }],
        total: 1,
      };
    };
    mounted = await mount(
      createElement(ProductsPage, { api: api as never, onEdit: () => undefined }),
    );
    return mounted.el;
  }

  const stockCell = (el: HTMLElement): HTMLTableCellElement =>
    el.querySelector('tbody tr')!.querySelectorAll('td')[4] as HTMLTableCellElement;
  const stockInput = (el: HTMLElement): HTMLInputElement | null =>
    stockCell(el).querySelector('input');
  const toastText = (el: HTMLElement): string =>
    [...el.querySelectorAll('.toast')].map((t) => t.textContent ?? '').join('|');
  const gets = (): number =>
    reqs.filter((r) => r.method === undefined || r.method === 'GET').length;

  it('🔴 「草稿」筛选 → 请求带 status=draft；草稿行状态列「草稿」、按钮「上架」→ 确认后 PATCH active', async () => {
    const el = await openDraft({ status: 'draft', stock: 12 });
    expect(statusCell(el)).toBe('草稿');
    await click(button(el, '草稿'));
    expect(reqs.at(-1)?.path).toContain('status=draft');
    await toggleStatus(el, '上架');
    expect(reqs.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { status: 'active' },
    ]);
    expect(statusCell(el)).toBe('在售');
  });

  it('🔴 改库存成功：PATCH /stock 带列表上看到的库存作 expected_stock；单元格与「紧张」标记跟着变；成功走 Toast', async () => {
    const el = await openDraft({ status: 'active', stock: 3 });
    expect(stockCell(el).textContent).toContain('紧张');
    await click(button(el, '改库存'));
    expect(stockInput(el)?.value).toBe('3');
    await typeInto(stockInput(el), '30');
    await click(button(el, '保存库存'));
    const patch = reqs.find((r) => r.path.endsWith('/stock'));
    expect(patch?.path).toBe('/api/v1/admin/products/p-1/stock');
    expect(patch?.body).toEqual({ stock: 30, expected_stock: 3 });
    expect(stockInput(el)).toBeNull();
    expect(stockCell(el).textContent).toContain('30');
    expect(stockCell(el).textContent).not.toContain('紧张');
    expect(toastText(el)).toContain('30');
  });

  it('🔴 40914（期间被买走一件）：输入框保留运营填的值、Toast 说清要刷新；点「刷新」后再存带**最新**库存', async () => {
    const el = await openDraft({ status: 'active', stock: 3 });
    await click(button(el, '改库存'));
    await typeInto(stockInput(el), '30');
    sellBeforeNextStockPatch = true;
    await click(button(el, '保存库存'));
    expect(stockInput(el)?.value).toBe('30'); // 没被清、没被改回 3
    expect(toastText(el)).toContain('刷新');
    expect(state.stock).toBe(2); // 服务端没被覆盖

    const before = gets();
    await click(button(el, '刷新'));
    expect(gets()).toBe(before + 1);
    expect(stockInput(el)?.value).toBe('30'); // 刷新列表不丢正在填的值
    // 「看过再覆盖」：刷新后运营必须**看得见**最新库存与变化，否则再点保存等于盲覆盖（2026-10-08 浏览器验收发现）
    expect(stockCell(el).textContent).toContain('当前库存 2');
    expect(stockCell(el).textContent).toContain('已从 3 变为 2');
    await click(button(el, '保存库存'));
    expect(reqs.filter((r) => r.path.endsWith('/stock')).at(-1)?.body).toEqual({
      stock: 30,
      expected_stock: 2,
    });
    expect(state.stock).toBe(30);
  });

  it('不合法输入（-1）：就地提示、不发请求；「放弃」回到原值', async () => {
    const el = await openDraft({ status: 'active', stock: 3 });
    await click(button(el, '改库存'));
    await typeInto(stockInput(el), '-1');
    await click(button(el, '保存库存'));
    expect(reqs.filter((r) => r.path.endsWith('/stock'))).toHaveLength(0);
    expect(stockCell(el).querySelector('.error')?.textContent).toMatch(/库存/);
    await click(button(el, '放弃'));
    expect(stockInput(el)).toBeNull();
    expect(stockCell(el).textContent).toContain('3');
  });
});

/** 审查 2026-10-09（WorkBuddy 评估 4.1）：筛选 / 关键词 / 库存紧张 / 页码进地址栏，与订单页同口径。 */
describe('商品列表：筛选与页码进地址栏', () => {
  async function openAt(q: string) {
    const listCalls: string[] = [];
    const navs: string[] = [];
    const api = async (req: { path: string; method?: string }): Promise<unknown> => {
      listCalls.push(req.path);
      return {
        items: [{ ...PRODUCT, updated_at: '2026-10-01T00:00:00.000Z' }],
        total: 120,
        page: 1,
        size: 20,
      };
    };
    mounted = await mount(
      createElement(ProductsPage, {
        api: api as never,
        onEdit: () => undefined,
        route: { page: 'products', id: '', query: new URLSearchParams(q) },
        onNavigate: (next: { query: URLSearchParams }) => navs.push(next.query.toString()),
      }),
    );
    return { el: mounted.el, listCalls, navs };
  }

  it('🔴 打开 #/products?status=offline&low=1&q=鉄&page=3 → 按这些条件取第 3 页（编辑完回来、刷新、别人发来的链接都一样）', async () => {
    const { el, listCalls } = await openAt('status=offline&low=1&q=%E9%89%84&page=3');
    const last = listCalls.at(-1) ?? '';
    expect(last).toContain('status=offline');
    expect(last).toContain('low_stock=true');
    expect(last).toContain('page=3');
    expect(decodeURIComponent(last)).toContain('keyword=鉄');
    expect((el.querySelector('input.input') as HTMLInputElement).value).toBe('鉄');
    expect(el.textContent).toContain('第 3 / 6 页');
  });

  it('🔴 sort=stock&size=50 → 请求带 sort / size；点「售价」→ 地址栏 sort=-price_jpy 并回到第 1 页（评估 4.5 / 4.6）', async () => {
    const { el, listCalls, navs } = await openAt('sort=stock&size=50&page=2');
    const first = listCalls[0] ?? '';
    expect(first).toContain('sort=stock');
    expect(first).toContain('size=50');
    const priceBtn = [...el.querySelectorAll('th button')].find((b) =>
      b.textContent?.includes('售价'),
    ) as HTMLButtonElement;
    await click(priceBtn);
    expect(navs.at(-1)).toBe('sort=-price_jpy&size=50');
  });

  it('🔴 点筛选 / 下一页 → 改地址栏（页码回到 1 时不写 page，默认值不进地址）', async () => {
    const { el, navs } = await openAt('page=2');
    await click(button(el, '已下架'));
    expect(navs.at(-1)).toBe('status=offline');
    await click(button(el, '下一页'));
    expect(navs.at(-1)).toBe('page=3');
  });
});
