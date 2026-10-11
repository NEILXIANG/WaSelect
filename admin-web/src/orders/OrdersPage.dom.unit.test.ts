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
import { createElement, useCallback, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { OrdersPage } from './OrdersPage.js';
import { parseHash, type Route } from '../router.js';

interface Call {
  path: string;
  method?: string;
}

let mounted: Mounted | undefined;
let calls: Call[];
let apiImpl: (req: Call) => Promise<unknown>;

/**
 * 宿主：替页面持有"当前路由"，`onNavigate` 换掉它并触发一次**重渲染**。
 * @why 不在用例里 unmount + 重新 mount 来模拟换路由：**重新挂载会重置组件 state**，
 *      于是每次换筛选都多一次挂载请求，"点了搜索共发几次"这类断言（ADM3-09）
 *      会把挂载次数也算进去，断言就不再是在验它声称要验的东西。
 * @why `onNavigate` 用 `useCallback` 包住：它进了 `OrdersPage` 里 `patch` 的依赖数组，
 *      每次渲染都新建的话 `patch` 会一直变 → 每次渲染都重新拉列表（乃至死循环）。
 */
function Harness({ initial }: { initial: Route }): React.JSX.Element {
  const [route, setRoute] = useState<Route>(initial);
  const onNavigate = useCallback((next: Route) => setRoute(next), []);
  return createElement(OrdersPage, { api: apiImpl as never, route, onNavigate });
}

async function open(hash = '#/orders'): Promise<HTMLElement> {
  calls = [];
  apiImpl = async (req: Call): Promise<unknown> => {
    calls.push(req);
    return { items: [], total: 0 };
  };
  mounted = await mount(createElement(Harness, { initial: parseHash(hash) }));
  return mounted.el;
}

const gets = (): Call[] =>
  // 列表请求；待办计数（TodoBar，size=1）另算（三端联动 UI 模拟 2026-10-08）
  calls.filter(
    (c) =>
      c.method !== 'POST' && c.path.includes('/admin/orders') && !/[?&]size=1(&|$)/.test(c.path),
  );
const keywordInput = (el: HTMLElement): HTMLInputElement =>
  el.querySelector('input[placeholder^="单号"]') as HTMLInputElement;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

// AJ-410 / N13：开关文案「含测试单」改为「显示测试订单」
describe('订单列表："显示测试订单"开关（剩余清单 3-4）', () => {
  it('🔴 默认不带 include_test；勾选 → 重新请求且带 include_test=true、回到第 1 页', async () => {
    const el = await open();
    expect(gets()[0]?.path).not.toContain('include_test');
    const box = el.querySelector(
      'input[type="checkbox"][aria-label="显示测试订单"]',
    ) as HTMLInputElement;
    await click(box);
    expect(gets().at(-1)?.path).toContain('include_test=true');
    expect(gets().at(-1)?.path).toContain('page=1');
  });
});

describe('订单列表：URL 上认不出的 status（AJ-398）', () => {
  it('🔴 #/orders?status=foo → 按「全部」请求，不把 foo 发给服务端', async () => {
    const el = await open('#/orders?status=foo');
    expect(gets()).toHaveLength(1);
    expect(gets()[0]?.path).not.toContain('status=');
    // AJ-400：下拉改页签——回落后高亮的是「全部」页签
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('全部');
  });
});

/**
 * AJ-400：状态页签 + 计数、下单日期。URL 仍是唯一真源（`status` 逗号分隔、`range` 存预设名）。
 */
describe('订单列表：状态页签与日期筛选（AJ-400）', () => {
  const tab = (el: HTMLElement, label: string): HTMLElement =>
    [...el.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? '').startsWith(label),
    ) as HTMLElement;

  it('点「售后·退款」→ 请求带 status=refunding,refunded、回第 1 页，且该页签高亮；每个页签都去取了计数', async () => {
    const el = await open('#/orders?page=3');
    await click(tab(el, '售后·退款'));
    const last = decodeURIComponent(gets().at(-1)?.path ?? '');
    expect(last).toContain('status=refunding,refunded');
    expect(last).toContain('page=1');
    expect(tab(el, '售后·退款').getAttribute('aria-selected')).toBe('true');
    const countCalls = calls.filter((c) => /[?&]size=1(&|$)/.test(c.path));
    expect(countCalls.length).toBeGreaterThanOrEqual(7);
  });

  // AJ-410 / N27：行为变更——单状态链接高亮所属页签（原为不高亮、显示「当前筛选：…」）
  it('🔴 工作台的单状态链接（status=refunding）照常请求；高亮「售后·退款」并说"只显示：退款中"，可一键看整个页签', async () => {
    const el = await open('#/orders?status=refunding');
    expect(gets()[0]?.path).toContain('status=refunding');
    expect(tab(el, '售后·退款').getAttribute('aria-selected')).toBe('true');
    expect(el.textContent).toContain('此页签下只显示：退款中');
    await click(button(el, '显示本页签全部'));
    expect(decodeURIComponent(gets().at(-1)?.path ?? '')).toContain('status=refunding,refunded');
  });

  it('🔴 status=shipped（只是「已发货」页签的一半）→ 高亮「已发货」，不再显示"当前筛选 … 清除"', async () => {
    const el = await open('#/orders?status=shipped');
    expect(tab(el, '已发货').getAttribute('aria-selected')).toBe('true');
    expect(el.textContent).not.toContain('当前筛选');
  });

  it('选「近 7 天」→ 请求带 created_from / created_to（JST 日历日）', async () => {
    const el = await open();
    await type(el.querySelector('select[aria-label="下单日期"]'), '7d');
    const last = gets().at(-1)?.path ?? '';
    expect(last).toMatch(/created_from=\d{4}-\d{2}-\d{2}/);
    expect(last).toMatch(/created_to=\d{4}-\d{2}-\d{2}/);
  });

  it('自定义日期起点晚于终点 → 提示且不发请求', async () => {
    const el = await open('#/orders?range=custom&from=2026-10-08&to=2026-10-01');
    expect(gets()).toHaveLength(0);
    expect(el.textContent).toContain('开始日期晚于结束日期');
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
    expect(keywordInput(el).maxLength).toBe(SEARCH_KEYWORD_MAX_LENGTH); // P2-47
    // 关键词已生效后再点一次（不变）→ 仍然重载
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(3);
  });

  it('🔴 在搜索框里按回车 = 点"搜索"（三端联动模拟 2026-10-08：原先回车没反应）；输入法选字的回车不算', async () => {
    const el = await open();
    const input = keywordInput(el);
    await type(input, 'Kenji');
    const { act } = await import('react');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
      );
    });
    expect(gets()).toHaveLength(1);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(gets()).toHaveLength(2);
    expect(gets()[1]?.path).toContain('keyword=Kenji');
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
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return { items: orders, total: orders.length };
    };
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
    return mounted.el;
  }

  const ORDER = {
    order_id: 'o-1',
    order_no: 'NO-1',
    status: 'paid',
    total_jpy: 1000,
    created_at: '2026-01-02T00:00:00.000Z',
  };

  it('🔴 订单号本身就是去详情的链接（走查 2026-10-08：运营点单号没反应，只能找最右边的「详情」）', async () => {
    const el = await openWith([{ ...ORDER, order_id: 'ord-72c6', order_no: '261009-76PJP4' }]);
    const a = [...el.querySelectorAll('tbody a')].find((x) => x.textContent === '261009-76PJP4');
    expect(a?.getAttribute('href')).toBe('#/orders/ord-72c6');
  });

  it('🔴 操作列固定在右侧（窄屏横向滚动时「详情 / 发货」不被挤出视野）', async () => {
    const el = await openWith([ORDER]);
    expect(el.querySelector('table')?.className).toContain('table-sticky-actions');
  });

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
    apiImpl = api;
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
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
    apiImpl = api;
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
    await click(button(mounted.el, '下一页'));
    expect(gets().at(-1)?.path).toContain('page=1');
  });
});

/**
 * AJ-411 浏览器验收（2026-10-09）：改版后导航变宽，物流列 "Japan Post EMS / EM…JP 查件" 被挤成 4 行、
 * 采购信息挤成 4–7 行，一屏只剩 3 单。改为：物流两行不折行（运单号等宽）、采购信息悬停看全文。
 */
describe('订单列表：物流列分两行、采购信息有全文提示（AJ-411 验收）', () => {
  it('承运商与运单号各占一行，查件链接跟在运单号后；采购信息单元格 title 是完整文本', async () => {
    calls = [];
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return {
        items: [
          {
            order_id: 'o-1',
            order_no: '261009-30YX28',
            status: 'shipped',
            total_jpy: 16800,
            created_at: '2026-10-08T17:51:00Z',
            recipient: 'Kenji Tanaka',
            carrier: 'Japan Post EMS',
            tracking_no: 'EM300000001JP',
            tracking_url: 'https://trackings.post.japanpost.jp/x',
            items: [
              {
                title_ja: '新潟産コシヒカリ 無洗米 5kg',
                jan_code: '4901234567890',
                purchase_source: '新潟 JA',
              },
            ],
          },
        ],
        total: 1,
      };
    };
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
    await flush();
    const el = mounted.el;
    const lines = [...el.querySelectorAll('tbody td.ship-cell > div')].map((d) =>
      d.textContent?.trim(),
    );
    expect(lines).toEqual(['Japan Post EMS', 'EM300000001JP 查件']);
    expect(el.querySelector('tbody td.ship-cell > div.mono')?.textContent).toContain(
      'EM300000001JP',
    );
    const purchase = el.querySelector('tbody td.purchase-cell');
    expect(purchase?.getAttribute('title')).toBe(
      [...(purchase?.querySelectorAll('div') ?? [])].map((d) => d.textContent).join('\n'),
    );
  });
});

/** 评估 4.5 / 4.6（2026-10-09）：排序与每页条数进地址栏、带进请求。 */
describe('订单列表：排序与每页条数', () => {
  it('🔴 #/orders?sort=-total_jpy&size=50&page=2 → 请求带 sort / size / page；金额列标为降序', async () => {
    const el = await open('#/orders?sort=-total_jpy&size=50&page=2');
    // 看**第一次**请求：替身返回 0 条，随后页码会按 A-02 拉回第 1 页（那是另一条既有行为）
    const p = gets()[0]?.path ?? '';
    expect(p).toContain('sort=-total_jpy');
    expect(p).toContain('size=50');
    expect(p).toContain('page=2');
    const th = [...el.querySelectorAll('th')].find((t) => t.textContent?.includes('金额'));
    expect(th?.getAttribute('aria-sort')).toBe('descending');
  });

  it('🔴 点「金额」表头 → 按金额降序重新取、回到第 1 页；再点 → 升序', async () => {
    const el = await open('#/orders?page=3');
    const amount = (): HTMLButtonElement =>
      [...el.querySelectorAll('th button')].find((b) =>
        b.textContent?.includes('金额'),
      ) as HTMLButtonElement;
    await click(amount());
    let p = gets().at(-1)?.path ?? '';
    expect(p).toContain('sort=-total_jpy');
    expect(p).not.toContain('page=3');
    await click(amount());
    p = gets().at(-1)?.path ?? '';
    expect(p).toContain('sort=total_jpy');
    expect(p).not.toContain('sort=-total_jpy');
  });

  it('🔴 每页条数选 100 → 请求 size=100；默认 20 不写进地址', async () => {
    const el = await open();
    expect(gets().at(-1)?.path).toContain('size=20');
    const sel = el.querySelector('select[aria-label="每页显示条数"]') as HTMLSelectElement;
    sel.value = '100';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(gets().at(-1)?.path).toContain('size=100');
  });
});

describe('订单列表：待处理筛选（AJ-425）', () => {
  it('🔴 网址带 attention → 列表请求带上它，并显示"只看：…"与清除按钮；清除后不再带', async () => {
    const el = await open('#/orders?attention=after_sale');
    await flush();
    expect(gets().at(-1)?.path).toContain('attention=after_sale');
    expect(el.textContent).toContain('只看：售后待处理');
    await click(button(el, '清除'));
    await flush();
    expect(gets().at(-1)?.path).not.toContain('attention=');
  });

  // 浏览器走查 2026-10-09：badges.unit 直接调 flagBadges 是绿的，但列表行只把 has_dispute / is_test
  // 传给它，"售后中"在页面上从未出现——这条用例验的是接线，不是 flagBadges 本身。
  it('🔴 列表行带 after_sale_open / user_blocked → 状态列真的显示「售后中」「用户已拉黑」', async () => {
    calls = [];
    const row = {
      order_id: 'o-1',
      order_no: 'NO-1',
      status: 'paid',
      total_jpy: 1000,
      created_at: '2026-01-02T00:00:00.000Z',
      after_sale_open: true,
      user_blocked: true,
    };
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return { items: [row], total: 1 };
    };
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
    const tr = mounted.el.querySelector('tbody tr');
    expect(tr?.textContent).toContain('售后中');
    expect(tr?.textContent).toContain('用户已拉黑');
  });

  it('网址里认不出的 attention 不发给服务端（不换一个 40001）', async () => {
    await open('#/orders?attention=everything');
    await flush();
    expect(gets().at(-1)?.path).not.toContain('attention=');
  });

  describe('G4 / G5（AJ-471）：关键字搜索时说明含测试单；订单页自带待处理筛选入口', () => {
    it('有关键字且未勾"显示测试订单" → 提示"搜索结果含测试单"；没关键字不提示', async () => {
      const el = await open('#/orders?q=261010');
      expect(el.textContent).toContain('含测试单');
      await mounted?.unmount();
      const el2 = await open('#/orders');
      expect(el2.textContent).not.toContain('含测试单');
    });
    it('订单页有待处理筛选按钮（售后 / 迟到付款 / 拉黑 / 部分退款），点一个 → URL 带 attention', async () => {
      const el = await open('#/orders');
      const chip = button(el, '售后待处理');
      expect(chip).not.toBeNull();
      await click(chip);
      expect(gets().at(-1)?.path).toContain('attention=after_sale');
    });
  });
});

describe('待发货默认按付款时间排（AJ-453）时表头不能说谎（第二轮审计浏览器验收）', () => {
  it('🔴 #/orders?status=paid → 请求 sort=paid_at；「下单时间」表头不标为当前排序，表格上方写明按付款时间', async () => {
    const el = await open('#/orders?status=paid');
    expect(gets()[0]?.path ?? '').toContain('sort=paid_at');
    const th = [...el.querySelectorAll('th')].find((t) => t.textContent?.includes('下单时间'));
    // 原实现：没带 sort 时一律把「下单时间 ↓」标成当前排序——而列表实际是按付款时间从早到晚
    expect(th?.getAttribute('aria-sort')).toBe('none');
    expect(el.textContent).toContain('按付款时间从早到晚');
  });

  it('全部订单（无默认排序）照旧：「下单时间」标为降序，不出那句说明', async () => {
    const el = await open('#/orders');
    const th = [...el.querySelectorAll('th')].find((t) => t.textContent?.includes('下单时间'));
    expect(th?.getAttribute('aria-sort')).toBe('descending');
    expect(el.textContent).not.toContain('按付款时间从早到晚');
  });
});
