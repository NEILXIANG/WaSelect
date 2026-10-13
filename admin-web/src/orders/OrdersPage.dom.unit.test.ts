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
import { act, createElement, useCallback, useState } from 'react';
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

// 全入口点击测试 2026-10-12：筛空了只写"没有符合条件的订单"，不说怎么回去；给一键清除（与商品列表同）
describe('订单列表：筛空了给「清除筛选」', () => {
  it('🔴 状态 + 关键词 + 日期 + 待处理 + 只看某客户 都清掉；排序与每页条数保留', async () => {
    const el = await open(
      '#/orders?status=paid&q=W-2601&range=7d&attention=after_sale&user=u-1&who=Ken&sort=-total_jpy&size=50',
    );
    expect(el.textContent).toContain('没有符合条件的订单');
    await click(button(el, '清除筛选'));
    const last = decodeURIComponent(gets().at(-1)?.path ?? '');
    for (const k of ['status=', 'keyword=', 'created_from', 'attention=', 'user_id=']) {
      expect(last, k).not.toContain(k);
    }
    expect(last).toContain('sort=-total_jpy');
    expect(last).toContain('size=50');
    expect(keywordInput(el).value).toBe('');
  });

  it('没开任何筛选时不给「清除筛选」', async () => {
    const el = await open('#/orders');
    expect(button(el, '清除筛选')).toBeNull();
  });
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
    expect(gets().length).toBeGreaterThan(0);
    // 三天提交复查 2026-10-12：f568e3d 去掉了次数上界——StrictMode 双跑最多 2 次，多于 2 次就是 effect 在反复拉
    expect(gets().length).toBeLessThanOrEqual(2);
    for (const g of gets()) expect(g.path).not.toContain('status=');
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

  // 规律排查 2026-10-12：页签原名「售后·退款」，里面只有退款中 / 已退款——有售后申请的单不在这里（在「售后待处理」筛选里），
  //   运营点"售后"页签看到没有，以为没有售后；页签改叫「退款」
  it('🔴 退款页签名如实叫「退款」，不叫「售后·退款」', async () => {
    const el = await open();
    const labels = [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.startsWith('退款'))).toBe(true);
    expect(labels.some((l) => l.includes('售后'))).toBe(false);
  });

  it('点「退款」→ 请求带 status=refunding,refunded、回第 1 页，且该页签高亮；每个页签都去取了计数', async () => {
    const el = await open('#/orders?page=3');
    await click(tab(el, '退款'));
    const last = decodeURIComponent(gets().at(-1)?.path ?? '');
    expect(last).toContain('status=refunding,refunded');
    expect(last).toContain('page=1');
    expect(tab(el, '退款').getAttribute('aria-selected')).toBe('true');
    const countCalls = calls.filter((c) => /[?&]size=1(&|$)/.test(c.path));
    expect(countCalls.length).toBeGreaterThanOrEqual(7);
  });

  // AJ-410 / N27：行为变更——单状态链接高亮所属页签（原为不高亮、显示「当前筛选：…」）
  it('🔴 工作台的单状态链接（status=refunding）照常请求；高亮「退款」并说"只显示：退款中"，可一键看整个页签', async () => {
    const el = await open('#/orders?status=refunding');
    expect(gets()[0]?.path).toContain('status=refunding');
    expect(tab(el, '退款').getAttribute('aria-selected')).toBe('true');
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
  // 挂载即拉列表。测试宿主与生产一样开 StrictMode（testing/dom.ts）：开发模式下挂载 effect 双跑，
  // 会发两次**同样的**请求（生产构建只发一次）——所以这里断言"拉了、且都是同一个请求"，下面各条按"动作前后的增量"数
  it('挂载时拉列表（StrictMode 双跑时两次是同一个请求）', async () => {
    await open();
    expect(gets().length).toBeGreaterThan(0);
    expect(gets().length).toBeLessThanOrEqual(2); // 上界：StrictMode 双跑最多 2 次（三天提交复查 2026-10-12）
    expect(new Set(gets().map((g) => g.path)).size).toBe(1);
  });

  it('🔴 关键词**不变**时连点两次"搜索" → 每次都重新请求（现状：一次都不发）', async () => {
    const el = await open();
    const base = gets().length;
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(base + 1);
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(base + 2);
  });

  it('🔴 关键词变了再点"搜索"：仍然只加一次请求，且带上新关键词', async () => {
    const el = await open();
    const base = gets().length;
    await type(keywordInput(el), 'W-2601');
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(base + 1);
    expect(gets()[base]?.path).toContain('keyword=W-2601');
    expect(keywordInput(el).maxLength).toBe(SEARCH_KEYWORD_MAX_LENGTH); // P2-47
    // 关键词已生效后再点一次（不变）→ 仍然重载
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(base + 2);
  });

  it('🔴 在搜索框里按回车 = 点"搜索"（三端联动模拟 2026-10-08：原先回车没反应）；输入法选字的回车不算', async () => {
    const el = await open();
    const base = gets().length;
    const input = keywordInput(el);
    await type(input, 'Kenji');
    const { act } = await import('react');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
      );
    });
    expect(gets()).toHaveLength(base);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(gets()).toHaveLength(base + 1);
    expect(gets()[base]?.path).toContain('keyword=Kenji');
  });

  it('🔴 "刷新"按钮：不依赖关键词或页码，点一次就重载一次', async () => {
    const el = await open();
    const base = gets().length;
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(base + 1);
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(base + 2);
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
          { title: '包丁', qty: 1, purchase_source: 'Amazon JP' },
          { title: '茶碗', qty: 2, purchase_source: '楽天市場' },
        ],
      },
    ]);
    // 两端逐页走查 2026-10-12：每个商品一块——先"中文名 × 件数"，再采购依据
    const items = [...el.querySelectorAll('.purchase-cell .purchase-item')].map((d) => [
      d.querySelector('.purchase-name')?.textContent ?? '',
      d.querySelector('.purchase-line')?.textContent ?? '',
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]?.[0]).toBe('包丁 × 1');
    expect(items[0]?.[1]).toContain('Amazon JP');
    expect(items[1]?.[0]).toBe('茶碗 × 2');
    expect(items[1]?.[1]).toContain('楽天市場');
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
                title: '新潟产越光免洗米 5kg',
                qty: 1,
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
    // 悬停全文 = 每个商品的名称行与采购行依次相接（与格子里看到的两行同序）
    expect(purchase?.getAttribute('title')).toBe(
      [...(purchase?.querySelectorAll('.purchase-name, .purchase-line') ?? [])]
        .map((d) => d.textContent)
        .join('\n'),
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

  // 三端模拟测试 2026-10-11（AJ-484）：badges.unit 里「超时未发货」「迟到付款待退」是绿的，筛选也筛对了，
  // 但列表页把行转成视图模型时只挑了四个布尔再交给 flagBadges——新标记在列表上一个都不出现（同 10-09 那次接缝）。
  it('🔴 列表行带 ship_overdue / late_paid → 状态列显示「超时未发货」「迟到付款待退」（flagBadges 拿到的是原始行）', async () => {
    calls = [];
    const rows = [
      {
        order_id: 'o-1',
        order_no: 'NO-1',
        status: 'paid',
        total_jpy: 1000,
        created_at: '2026-01-02T00:00:00.000Z',
        ship_overdue: true,
      },
      {
        order_id: 'o-2',
        order_no: 'NO-2',
        status: 'expired',
        total_jpy: 1000,
        created_at: '2026-01-02T00:00:00.000Z',
        late_paid: true,
      },
    ];
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return { items: rows, total: 2 };
    };
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders') }));
    const trs = mounted.el.querySelectorAll('tbody tr');
    expect(trs[0]?.textContent).toContain('超时未发货');
    expect(trs[1]?.textContent).toContain('迟到付款待退');
  });

  // AJ-486：客户详情"查看全部订单"跳进来带 ?user=；页面说清只看这位客户，并能清除
  it('🔴 ?user= → 请求带 user_id；页头写「只看这位客户」；点清除后不再带', async () => {
    const el = await open('#/orders?user=u-065bf2d9-7815');
    await flush();
    expect(gets().at(-1)?.path).toContain('user_id=u-065bf2d9-7815');
    expect(el.textContent).toContain('只看这位客户');
    const clear = [...el.querySelectorAll('button')].find(
      (b) =>
        b.textContent === '清除' && (b.parentElement?.textContent ?? '').includes('只看这位客户'),
    );
    await click(clear ?? null);
    await flush();
    expect(gets().at(-1)?.path).not.toContain('user_id=');
  });

  // 全入口点击测试 2026-10-11：原先写"只看这位客户：u-065bf2d9-7815-…"（36 位 id）；改写称呼，并说一共几单
  it('🔴 ?user=&who= → 写称呼不写 id；筛选行说「共 N 单」', async () => {
    const el = await open('#/orders?user=u-065bf2d9-7815&who=' + encodeURIComponent('Jason Huang'));
    await flush();
    const line = [...el.querySelectorAll('p.muted')].find((p) =>
      (p.textContent ?? '').includes('只看这位客户'),
    );
    expect(line?.textContent).toContain('只看这位客户：Jason Huang');
    expect(line?.textContent).not.toContain('u-065bf2d9');
    expect(line?.textContent).toMatch(/共 \d+ 单/);
  });

  it('🔴 只有 ?user=（老链接）→ 写缩短的编号，不写整串', async () => {
    const el = await open('#/orders?user=u-065bf2d9-7815-42f7-a9a8-b91843c8406d');
    await flush();
    expect(el.textContent).toContain('只看这位客户：u-065bf2d9…');
    expect(el.textContent).not.toContain('b91843c8406d');
  });

  it('🔴 待处理筛选行也说「共 N 单」', async () => {
    const el = await open('#/orders?attention=after_sale');
    await flush();
    const line = [...el.querySelectorAll('p.muted')].find((p) =>
      (p.textContent ?? '').includes('只看：'),
    );
    expect(line?.textContent).toMatch(/只看：售后待处理 · 共 \d+ 单/);
  });

  it('网址里形状不对的 user 不发给服务端（不换一个 40001）', async () => {
    await open('#/orders?user=' + encodeURIComponent("u 1'--"));
    await flush();
    expect(gets().at(-1)?.path).not.toContain('user_id=');
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
      // 第三轮走查后按钮文字带单数（「售后待处理 3」），按类名前缀找
      const chip =
        [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('售后待处理')) ??
        null;
      expect(chip).not.toBeNull();
      await click(chip);
      // 计数请求（size=1）也带 attention：断言的是点完之后那次列表请求
      const list = gets().filter((g) => !g.path.includes('size=1'));
      expect(list.at(-1)?.path).toContain('attention=after_sale');
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

/**
 * 从一张单的详情直接换到另一张单（地址栏 / 浏览器前进后退）时，抽屉与半填的表单不能跟过去。
 * @why 规律排查 2026-10-12（"表单状态跟着组件走、没跟着对象走"）实测：在 A 单打开「部分退款」填了 1234，
 *      地址栏换到 B 单、点「放弃修改并离开」后，抽屉仍开着、金额还是 1234——点提交就是给 B 退 1234。
 */
describe('订单详情换单时表单不串单', () => {
  it('🔴 A 单部分退款填了金额 → 换到 B 单：不留 A 的抽屉与金额', async () => {
    let go: (r: Route) => void = () => undefined;
    function SwitchHarness(): React.JSX.Element {
      const [route, setRoute] = useState<Route>(parseHash('#/orders/o-A'));
      go = setRoute;
      const onNavigate = useCallback((next: Route) => setRoute(next), []);
      return createElement(OrdersPage, { api: apiImpl as never, route, onNavigate });
    }
    calls = [];
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      const m = /\/admin\/orders\/(o-[AB])$/.exec(req.path);
      if (m !== null)
        return {
          order_id: m[1],
          order_no: m[1] === 'o-A' ? '261012-AAAAAA' : '261012-BBBBBB',
          status: 'paid',
          total_jpy: 9150,
          items: [],
          events: [],
          payments: [{ status: 'succeeded', charge_amount: 9150, charge_currency: 'JPY' }],
        };
      return { items: [], total: 0 };
    };
    mounted = await mount(createElement(SwitchHarness));
    const el = mounted.el;
    await click(button(el, '部分退款…'));
    await type(el.querySelector('input[name="partial-amount"]'), '1234');
    await act(async () => {
      go(parseHash('#/orders/o-B'));
      await Promise.resolve();
    });
    await flush();
    expect(el.textContent).toContain('261012-BBBBBB');
    const amount = el.querySelector<HTMLInputElement>('input[name="partial-amount"]');
    expect(amount === null || amount.value === '').toBe(true);
  });
});

// 规律排查 2026-10-12：服务端一次最多 50 单（batch_too_large），CSV 导入早就拦了；勾选路径（每页可显示 100 条、
//   「全选本页可发货订单」）不拦——填完 51 个运单号点提交，整批失败、提示只有"批量发货失败"
describe('批量发货：勾选超过一次的上限', () => {
  it('🔴 勾了 51 张可发货的单 → 按钮不可点，就近说一次最多 50 单', async () => {
    const orders = Array.from({ length: 51 }, (_, i) => ({
      order_id: `o-${String(i)}`,
      order_no: `261012-A${String(i).padStart(5, '0')}`,
      status: 'paid',
      total_jpy: 1000,
      created_at: '2026-10-02T00:00:00.000Z',
    }));
    calls = [];
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return { items: orders, total: orders.length };
    };
    mounted = await mount(
      createElement(Harness, { initial: parseHash('#/orders?status=paid&size=100') }),
    );
    const el = mounted.el;
    await click(el.querySelector('input[aria-label="全选本页可发货订单"]'));
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('批量发货（'),
    );
    expect(btn?.disabled).toBe(true);
    expect(el.textContent).toContain('一次最多 50 单');
  });
});

// 规律排查 2026-10-12：待发货页签里拒付锁定 / 测试单的行，勾选框灰着、没有「发货」按钮，也不说为什么
describe('待发货：不能发的行说清原因', () => {
  it('🔴 拒付锁定的行在操作列写不能发货的原因', async () => {
    calls = [];
    apiImpl = async (req: Call): Promise<unknown> => {
      calls.push(req);
      return {
        items: [
          {
            order_id: 'o-d',
            order_no: '261012-DDDDDD',
            status: 'paid',
            total_jpy: 1000,
            has_dispute: true,
            created_at: '2026-10-02T00:00:00.000Z',
          },
        ],
        total: 1,
      };
    };
    mounted = await mount(createElement(Harness, { initial: parseHash('#/orders?status=paid') }));
    const row = mounted.el.querySelector('tbody tr');
    expect(row?.querySelector('.ship-blocked')?.textContent ?? '').toContain('拒付');
  });
});
