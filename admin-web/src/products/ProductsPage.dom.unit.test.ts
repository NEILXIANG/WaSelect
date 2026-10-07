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
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
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
    expect(el.querySelector('.error')?.textContent).toContain('服务器内部错误');
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
