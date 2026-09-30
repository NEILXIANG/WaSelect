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
import { button, click, mount, type Mounted } from '../testing/dom.js';
import { ProductsPage } from './ProductsPage.js';

let mounted: Mounted | undefined;
let patchFails: boolean;
let patches: Array<{ path: string; body?: unknown }>;

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
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    if (req.method === 'PATCH') {
      patches.push(req);
      if (patchFails) throw new ApiError(50000, '服务器内部错误', 't-1');
      return {};
    }
    return { items: [PRODUCT], total: 1, page: 1, size: 20 };
  };
  mounted = await mount(
    createElement(ProductsPage, { api: api as never, onEdit: () => undefined }),
  );
  return mounted.el;
}

/** 第一行的"状态"单元格文字（表头顺序：商品 / 分类 / 售价 / 库存 / 状态 / 操作）。 */
const statusCell = (el: HTMLElement): string =>
  el.querySelector('tbody tr')?.querySelectorAll('td')[4]?.textContent ?? '';

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('商品列表：上下架后的状态显示（AJ-231）', () => {
  it('🔴 下架成功：状态列变成"已下架"，按钮变成"上架"——两者说同一件事', async () => {
    patchFails = false;
    const el = await open();
    expect(statusCell(el)).toBe('在售');
    await click(button(el, '下架'));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ status: 'offline' });
    expect(statusCell(el)).toBe('已下架');
    expect(button(el, '上架')).not.toBeNull();
  });

  it('🔴 下架失败：状态列与按钮一起回到"在售 / 下架"，并显示错误', async () => {
    patchFails = true;
    const el = await open();
    await click(button(el, '下架'));
    expect(statusCell(el)).toBe('在售');
    expect(button(el, '下架')).not.toBeNull();
    expect(el.querySelector('.error')?.textContent).toContain('服务器内部错误');
  });

  it('连续两次：下架再上架，状态列每次都跟着变', async () => {
    patchFails = false;
    const el = await open();
    await click(button(el, '下架'));
    await click(button(el, '上架'));
    expect(patches.map((p) => p.body)).toEqual([{ status: 'offline' }, { status: 'active' }]);
    expect(statusCell(el)).toBe('在售');
  });
});
