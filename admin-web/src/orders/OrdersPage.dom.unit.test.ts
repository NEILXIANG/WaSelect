// @vitest-environment jsdom
/**
 * 职责：订单列表页的**组件行为**用例——"我要再看一眼最新的"这个动作必须真的发一次请求（ADM3-09）。
 *
 * @why 客服最常做的事是"客户说刚付了款，我刷新看看"。而列表的 `load` 只随
 *      `page / status / applied` 变化：用同一个关键词再点一次"搜索"，这三项一项都不变，
 *      effect 不触发、列表不动，页面却没有任何提示。客服据此回复"还没收到款"——
 *      错的不是数据，是他看到的那一屏没被更新过。
 *      这是纯函数层全绿也照样发生的缺陷：逻辑没错，错的是"哪些变化该触发重载"这个接线。
 *
 * @see ./OrdersPage.tsx；./api.ts；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { OrdersPage } from './OrdersPage.js';

interface Call {
  path: string;
  method?: string;
}

let mounted: Mounted | undefined;
let calls: Call[];

async function open(): Promise<HTMLElement> {
  calls = [];
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    return { items: [], total: 0 };
  };
  mounted = await mount(createElement(OrdersPage, { api: api as never }));
  return mounted.el;
}

const gets = (): Call[] =>
  calls.filter((c) => c.method !== 'POST' && c.path.includes('/admin/orders'));
const keywordInput = (el: HTMLElement): HTMLInputElement =>
  el.querySelector('input[placeholder^="单号"]') as HTMLInputElement;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('订单列表："含测试单"开关（剩余清单 3-4）', () => {
  it('🔴 默认不带 include_test；勾选 → 重新请求且带 include_test=true、回到第 1 页', async () => {
    const el = await open();
    expect(gets()[0]?.path).not.toContain('include_test');
    const box = el.querySelector(
      'input[type="checkbox"][aria-label="含测试单"]',
    ) as HTMLInputElement;
    await click(box);
    expect(gets().at(-1)?.path).toContain('include_test=true');
    expect(gets().at(-1)?.path).toContain('page=1');
  });
});

describe('订单列表：刷新入口（ADM3-09）', () => {
  it('挂载时拉一次列表', async () => {
    await open();
    expect(gets()).toHaveLength(1);
  });

  it('🔴 关键词**不变**时连点两次"搜索" → 每次都重新请求（现状：一次都不发）', async () => {
    const el = await open();
    expect(gets()).toHaveLength(1);
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(2);
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(3);
  });

  it('🔴 关键词变了再点"搜索"：仍然只加一次请求，且带上新关键词', async () => {
    const el = await open();
    await type(keywordInput(el), 'W-2601');
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(2);
    expect(gets()[1]?.path).toContain('keyword=W-2601');
    // 关键词已生效后再点一次（不变）→ 仍然重载
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(3);
  });

  it('🔴 "刷新"按钮：不依赖关键词或页码，点一次就重载一次', async () => {
    const el = await open();
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(2);
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(3);
  });
});

/**
 * 采购信息列（0.6.26 / 技术文档 §2.7「待采购清单 = GET /admin/orders?status=paid」）。
 *
 * @why 这三条是**接线**用例，不是 `purchaseLine` 的重复：`view.unit.test.ts` 已经证明
 *      "给定一行 item 能拼出正确的文案"，但它证明不了"列表页真的把那一列渲染出来了"。
 *      漏渲染的失效形态很安静——view 全绿、api 全绿、页面上整列空白，
 *      采购员看到的是"今天没有要买的东西"，而实际上有 50 单。
 */
describe('订单列表：采购信息列（0.6.26）', () => {
  /** 用给定的订单条目打开列表页（默认那个 `open()` 返回空列表）。 */
  async function openWith(orders: unknown[]): Promise<HTMLElement> {
    calls = [];
    const api = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return { items: orders, total: orders.length };
    };
    mounted = await mount(createElement(OrdersPage, { api: api as never }));
    return mounted.el;
  }

  const ORDER = {
    order_id: 'o-1',
    order_no: 'NO-1',
    status: 'paid',
    total_jpy: 1000,
    created_at: '2026-01-02T00:00:00.000Z',
  };

  it('列表页真的渲染出「采购信息」列，且内容含采购来源与 JAN 码', async () => {
    const el = await openWith([
      {
        ...ORDER,
        items: [
          {
            title: '包丁',
            title_ja: 'シェフナイフ',
            jan_code: '4900000000011',
            purchase_source: 'Amazon JP',
          },
        ],
      },
    ]);
    expect(el.textContent).toContain('采购信息');
    const cell = el.querySelector('.purchase-cell');
    expect(cell?.textContent).toContain('Amazon JP');
    expect(cell?.textContent).toContain('4900000000011');
    expect(cell?.textContent).toContain('シェフナイフ');
  });

  it('一单多个行项目 → 采购信息分行显示（不是挤成一坨）', async () => {
    const el = await openWith([
      {
        ...ORDER,
        items: [
          { title: '包丁', purchase_source: 'Amazon JP' },
          { title: '茶碗', purchase_source: '楽天市場' },
        ],
      },
    ]);
    const lines = [...el.querySelectorAll('.purchase-cell div')].map((d) => d.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Amazon JP');
    expect(lines[1]).toContain('楽天市場');
  });

  it('🧷 服务端没给 items（旧版响应）→ 显示「—」，不抛也不谎称"未记录"', async () => {
    // @why "—" 与"未记录"是两个意思：前者是"没有行项目可显示"（服务端形状变了 / 空单），
    //      后者是"这行没记采购信息"（要人工补）。混在一起，运营会去补一个不存在的缺口。
    const el = await openWith([{ ...ORDER }]);
    const cell = el.querySelector('.purchase-cell');
    expect(cell?.textContent).toBe('—');
    expect(el.textContent).not.toContain('未记录');
  });
});

/**
 * 旧请求晚到不得覆盖新列表（A-05）。
 * @why 网络慢时先点「下一页」再点「上一页」：第 1 页先回、第 2 页后回，
 *      页码显示第 1 页，表格却是第 2 页的单——待采购清单里会混进别的状态的订单。
 */
describe('订单列表：响应乱序（A-05）', () => {
  it('🔴 第 2 页的响应晚于第 1 页到达 → 表格仍是第 1 页的内容', async () => {
    const pending: Array<{ page: string; resolve: (v: unknown) => void }> = [];
    const row = (no: string) => ({
      order_id: no,
      order_no: no,
      status: 'paid',
      total_jpy: 1000,
      created_at: '2026-10-01T00:00:00.000Z',
      recipient: 'Jane',
    });
    const api = (req: Call): Promise<unknown> => {
      const page = /[?&]page=(\d+)/.exec(req.path)?.[1] ?? '1';
      if (pending.length === 0 && page === '1') {
        return Promise.resolve({ items: [row('PAGE1-A')], total: 40 });
      }
      return new Promise((resolve) => pending.push({ page, resolve }));
    };
    mounted = await mount(createElement(OrdersPage, { api: api as never }));
    const el = mounted.el;
    await click(button(el, '下一页'));
    await click(button(el, '上一页'));
    const p1 = pending.find((p) => p.page === '1');
    const p2 = pending.find((p) => p.page === '2');
    p1?.resolve({ items: [row('PAGE1-A')], total: 40 });
    await flush();
    p2?.resolve({ items: [row('PAGE2-B')], total: 40 });
    await flush();
    expect(el.textContent).toContain('第 1 /');
    expect(el.querySelector('tbody')?.textContent).toContain('PAGE1-A');
    expect(el.querySelector('tbody')?.textContent).not.toContain('PAGE2-B');
  });
});

/** 扫描 A-02：最后一页唯一一张单处理掉之后，列表不能停在"第 2 / 1 页、没有订单"。 */
describe('订单列表：总数变少时拉回最后一页（扫描 A-02）', () => {
  it('🔴 第 2 页请求回来 total 只够 1 页 → 自动再请求第 1 页', async () => {
    calls = [];
    let n = 0;
    const api = async (req: Call): Promise<unknown> => {
      calls.push(req);
      n += 1;
      return { items: [], total: n === 1 ? 40 : 20 };
    };
    mounted = await mount(createElement(OrdersPage, { api: api as never }));
    await click(button(mounted.el, '下一页'));
    expect(gets().at(-1)?.path).toContain('page=1');
  });
});
