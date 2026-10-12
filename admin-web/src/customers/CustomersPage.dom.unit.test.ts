// @vitest-environment jsdom
/**
 * 职责：客户页的**组件行为**（AJ-404）——列表 / 搜索 / 翻页进地址栏、详情的拉黑与解除。
 *
 * @why 拉黑 / 解除在客户详情页是**新入口**、复用的是风控页同一对接口：这里盯的是
 *      "确认弹层之前不发请求""解除原因必填""成功后重新取详情（以服务端为准）"三件事——
 *      它们在风控页各有用例，换一个页面就要重新证明一次（组件不同，状态机不同）。
 * @why 详情里**不出现 openid**、订单行是可点的 `#/orders/:id` 链接（订单详情是真深链接，router.ts @limitation 一）。
 */
import { act, createElement, useState } from 'react';
import { SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { CustomersPage } from './CustomersPage.js';
import type { Route } from '../router.js';

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const ROW = {
  id: 'u-3f6c2a9e-1b7d-4e8a-9c0f-5d2e7a1b4c6d',
  created_at: '2026-08-20T03:00:00.000Z',
  blocked: false,
  order_count: 3,
  paid_order_count: 2,
  paid_total_jpy: 21380,
  last_order_at: '2026-10-01T01:00:00.000Z',
  contact_email: 'zhang.wei@example.com',
  last_recipient: 'Zhang Wei',
};

function detail(blocked: boolean): Record<string, unknown> {
  return {
    id: ROW.id,
    created_at: ROW.created_at,
    blocked,
    ...(blocked ? { blocked_at: '2026-10-07T01:00:00.000Z' } : {}),
    contact_email: 'zhang.wei@example.com',
    stats: {
      order_count: 3,
      paid_order_count: 2,
      paid_total_jpy: 21380,
      test_order_count: 1,
      first_order_at: '2026-09-01T02:00:00.000Z',
      last_order_at: '2026-10-01T01:00:00.000Z',
    },
    addresses: [
      {
        id: 'addr-a1',
        recipient: 'Zhang Wei',
        phone: '+12125550143',
        line1: '350 5th Ave Apt 12B',
        city: 'New York',
        state: 'NY',
        postal_code: '10118',
        country: 'US',
        is_default: true,
      },
    ],
    orders: [
      {
        order_id: 'o-a4',
        order_no: '261005-TEST01',
        status: 'paid',
        total_jpy: 1000,
        is_test: true,
        has_dispute: false,
        created_at: '2026-10-05T01:00:00.000Z',
      },
      {
        order_id: 'o-a1',
        order_no: '260901-K7Q2MN',
        status: 'paid',
        total_jpy: 8930,
        is_test: false,
        has_dispute: true,
        created_at: '2026-09-01T02:00:00.000Z',
        paid_at: '2026-09-01T02:05:00.000Z',
      },
    ],
    risk: { dispute_count: 1, open_dispute_count: 1 },
  };
}

async function open(route: Route, server: { blocked: boolean } = { blocked: false }) {
  const calls: Call[] = [];
  const navigated: Route[] = [];
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.path.endsWith('/block')) {
      server.blocked = true;
      return null;
    }
    if (req.path.endsWith('/unblock')) {
      server.blocked = false;
      return { already_unblocked: false };
    }
    if (req.path.endsWith('/events') && req.method === 'DELETE') return { deleted: 12 };
    if (req.path.startsWith('/api/v1/admin/customers/')) return detail(server.blocked);
    return { items: [ROW], total: 41 };
  };
  mounted = await mount(
    createElement(CustomersPage, {
      api: api as never,
      route,
      onNavigate: (next: Route) => navigated.push(next),
    }),
  );
  return { el: mounted.el, calls, navigated, server };
}

const listRoute = (q = ''): Route => ({ page: 'customers', id: '', query: new URLSearchParams(q) });
const detailRoute = (): Route => ({ page: 'customers', id: ROW.id, query: new URLSearchParams() });

describe('客户列表：搜空了（全入口点击测试 2026-10-12，与商品 / 订单列表同）', () => {
  const openEmpty = async (q: string) => {
    const navigated: Route[] = [];
    mounted = await mount(
      createElement(CustomersPage, {
        api: (async () => ({ items: [], total: 0 })) as never,
        route: listRoute(q),
        onNavigate: (next: Route) => navigated.push(next),
      }),
    );
    return { el: mounted.el, navigated };
  };

  it('🔴 有关键词时说"没有符合条件的客户"并给「清除搜索」：回到不带关键词的第 1 页、输入框清空', async () => {
    const { el, navigated } = await openEmpty('keyword=nobody&page=2');
    expect(el.textContent).toContain('没有符合条件的客户');
    await click(button(el, '清除搜索'));
    expect(navigated.at(-1)?.query.get('keyword') ?? '').toBe('');
    expect(navigated.at(-1)?.query.get('page') ?? '1').toBe('1');
    expect((el.querySelector('form input') as HTMLInputElement).value).toBe('');
  });

  it('没有关键词时是"还没有客户"，不给「清除搜索」', async () => {
    const { el } = await openEmpty('');
    expect(el.textContent).toContain('还没有客户');
    expect(button(el, '清除搜索')).toBeNull();
  });
});

describe('客户列表', () => {
  it('按地址栏里的关键字与页码取数；行里是打码 id + 收件人 + 邮箱 + 单数 + 累计', async () => {
    const { el, calls } = await open(listRoute('keyword=zhang&page=2'));
    expect(calls[0]?.path).toBe('/api/v1/admin/customers?keyword=zhang&page=2');
    const text = el.querySelector('tbody')?.textContent ?? '';
    expect(text).toContain('u-3f6c2a9e…');
    expect(text).not.toContain(ROW.id);
    expect(text).toContain('Zhang Wei');
    expect(text).toContain('zhang.wei@example.com');
    expect(text).toContain('3 单 · 已付 2');
    // 数字列不折行（验收 2026-10-08：窄屏下被拆成三行）
    const cells = [...(el.querySelector('tbody tr')?.querySelectorAll('td') ?? [])];
    expect(cells.find((td) => td.textContent === '3 单 · 已付 2')?.className).toContain(
      'cell-nowrap',
    );
    // 打码 id 与最近下单时间不折行（三端模拟测试 2026-10-11：「u-」在连字符处断到上一行，各行高低不齐）
    expect(cells.find((td) => td.textContent === 'u-3f6c2a9e…')?.className).toContain(
      'cell-nowrap',
    );
    // 邮箱列单行截断、悬停看全文（验收 2026-10-08：1009px 视口下整表横向溢出、挤掉「操作」列）
    const mail = cells.find((td) => td.textContent?.trim() === 'zhang.wei@example.com');
    expect(mail?.className).toContain('cell-ellipsis');
    expect(mail?.getAttribute('title')).toBe('zhang.wei@example.com');
    expect(text).toContain('21,380 日元');
    expect(el.textContent).toContain('第 2 / 3 页 · 共 41 位');
    // 搜索框回显地址栏里的关键字（刷新后不丢）
    // 两端输入测试 2026-10-12：没有上限时贴一长串再搜，服务端拒成"参数缺失或格式错误"+技术编号（订单 / 商品搜索早有上限）
    expect((el.querySelector('input[name="customer-keyword"]') as HTMLInputElement).maxLength).toBe(
      SEARCH_KEYWORD_MAX_LENGTH,
    );
    expect((el.querySelector('input[name="customer-keyword"]') as HTMLInputElement).value).toBe(
      'zhang',
    );
  });

  it('搜索 → 写进地址栏（回到第 1 页）；点「详情」→ #/customers/:id', async () => {
    const { el, navigated } = await open(listRoute('page=3'));
    await type(el.querySelector('input[name="customer-keyword"]'), 'chen.hao@');
    await click(button(el, '搜索'));
    expect(navigated.at(-1)?.query.toString()).toBe('keyword=chen.hao%40');
    await click(button(el, '详情'));
    expect(navigated.at(-1)).toMatchObject({ page: 'customers', id: ROW.id });
  });
});

describe('客户详情', () => {
  it('资料 / 统计 / 地址簿 / 订单（测试单标出、订单号链到订单详情）/ 风险', async () => {
    const { el, calls } = await open(detailRoute());
    expect(calls[0]?.path).toBe(`/api/v1/admin/customers/${ROW.id}`);
    expect(el.querySelector('.title')?.textContent).toBe('客户详情：Zhang Wei'); // 原断言只写"客户详情"（2026-10-12 改）
    expect(el.textContent).toContain(ROW.id); // 详情页给完整 id（可复制去运营日志查）
    expect(el.textContent).toContain('21,380 日元');
    expect(el.textContent).toContain('+1 (212) 555-0143'); // 原断言要裸 E.164（2026-10-12 改）
    expect(el.textContent).toContain('350 5th Ave Apt 12B, New York, NY 10118, US');
    expect(el.textContent).toContain('拒付 1 笔，进行中 1 笔');
    const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('#/orders/o-a1');
    expect(links).toContain('#/orders/o-a4');
    // AJ-486：详情只列最近 50 张；给出到订单页按人筛的入口（此前注释说"去订单页按人筛"，订单页却筛不了）
    // 全入口点击测试 2026-10-11：带上称呼（默认地址收件人），订单页不再显示 36 位用户 id
    expect(links).toContain(
      `#/orders?user=${encodeURIComponent(ROW.id)}&who=${encodeURIComponent('Zhang Wei')}`,
    );
    const testRow = [...el.querySelectorAll('tr')].find((tr) =>
      (tr.textContent ?? '').includes('261005-TEST01'),
    );
    expect(testRow?.textContent).toContain('测试单');
  });

  it('拉黑：原因必填 → 先弹确认（之前不发请求）→ 确认后发 block（带原因、不带 order_id）→ 重新取详情显示已拉黑', async () => {
    const { el, calls } = await open(detailRoute());
    const detailGets = () =>
      calls.filter((c) => c.path === `/api/v1/admin/customers/${ROW.id}`).length;
    const before = detailGets(); // 挂载取详情的次数；测试宿主开 StrictMode，开发模式挂载 effect 双跑，按动作前后的增量数——testing/dom.ts
    await click(button(el, '拉黑该客户'));
    expect(el.querySelector('.dialog')).toBeNull(); // AJ-449：没填原因不弹层
    await type(el.querySelector('input[name="customer-block-reason"]'), '多次拒付');
    await click(button(el, '拉黑该客户'));
    expect(calls.some((c) => c.path.endsWith('/block'))).toBe(false);
    expect(el.querySelector('.dialog')?.textContent).toContain('未付款的订单');
    await click(button(el, '确认拉黑'));
    const block = calls.find((c) => c.path.endsWith('/block'));
    expect(block).toMatchObject({
      path: `/api/v1/admin/users/${encodeURIComponent(ROW.id)}/block`,
      method: 'POST',
    });
    expect(block?.body).toEqual({ reason: '多次拒付' });
    expect(detailGets()).toBe(before + 1); // 拉黑成功后重取一次详情
    expect(el.textContent).toContain('已拉黑（2026-10-07 10:00）');
    expect(button(el, '拉黑该客户')).toBeNull();
  });

  it('解除：原因必填（空着不发请求）→ 弹确认 → 发 unblock 带原因 → 重新取详情', async () => {
    const { el, calls } = await open(detailRoute(), { blocked: true });
    await click(button(el, '解除拉黑'));
    expect(calls.some((c) => c.path.endsWith('/unblock'))).toBe(false);
    expect(el.textContent).toContain('请填写解除原因');
    await type(el.querySelector('input[name="customer-unblock-reason"]'), '客服核实为误拉黑');
    await click(button(el, '解除拉黑'));
    await click(button(el, '确认解除'));
    const un = calls.find((c) => c.path.endsWith('/unblock'));
    expect(un?.body).toEqual({ reason: '客服核实为误拉黑' });
    expect(el.textContent).toContain('未拉黑');
  });
});

// 全入口点击测试 2026-10-12：标题只写"客户详情"（名字要到地址簿里找）；地址簿电话是 +12125550143；
// 没填原因时提示跑到右下角浮层、光标不动；确认弹层与成功提示写 36 位 id
describe('客户详情：看得懂、提示就近', () => {
  it('🔴 标题带客户称呼；地址簿电话按美国写法', async () => {
    const { el } = await open(detailRoute());
    expect(el.querySelector('h1')?.textContent).toBe('客户详情：Zhang Wei');
    expect(el.textContent).toContain('+1 (212) 555-0143');
    expect(el.textContent).not.toContain('+12125550143');
  });

  it('🔴 拉黑 / 删除行为记录没填原因：提示标在输入框下并把光标放进去', async () => {
    const { el } = await open(detailRoute());
    await click(button(el, '拉黑该客户'));
    const block = el.querySelector('input[name="customer-block-reason"]');
    expect(block?.closest('.field')?.textContent).toContain('请填写拉黑原因（会记录下来）');
    expect(document.activeElement).toBe(block);
    await click(button(el, '删除行为记录'));
    const purge = el.querySelector('input[name="customer-purge-reason"]');
    expect(purge?.closest('.field')?.textContent).toContain('请填写删除原因');
    expect(document.activeElement).toBe(purge);
  });

  it('🔴 确认弹层与成功提示写客户称呼，不写内部 id', async () => {
    const { el } = await open(detailRoute());
    await type(el.querySelector('input[name="customer-purge-reason"]'), '买家邮件要求删除');
    await click(button(el, '删除行为记录'));
    expect(el.querySelector('.dialog')?.textContent).toContain('Zhang Wei');
    expect(el.querySelector('.dialog')?.textContent).not.toContain(ROW.id);
    await type(el.querySelector('input[name="customer-block-reason"]'), '多次拒付');
    await click(button(el, '取消'));
    await click(button(el, '拉黑该客户'));
    expect(el.querySelector('.dialog')?.textContent).toContain('Zhang Wei');
    expect(el.querySelector('.dialog')?.textContent).not.toContain(ROW.id);
  });
});

describe('客户详情：删除行为记录（隐私请求，AJ-413）', () => {
  it('🔴 原因必填（空着不发请求）→ 弹确认（之前不发请求）→ 确认后发 DELETE 带原因 → 提示删除条数', async () => {
    const { el, calls } = await open(detailRoute());
    await click(button(el, '删除行为记录'));
    expect(calls.some((c) => c.path.endsWith('/events'))).toBe(false);
    expect(el.textContent).toContain('请填写删除原因');
    await type(el.querySelector('input[name="customer-purge-reason"]'), '买家邮件要求删除');
    await click(button(el, '删除行为记录'));
    expect(calls.some((c) => c.path.endsWith('/events'))).toBe(false);
    expect(el.textContent).toContain('无法恢复');
    await click(button(el, '确认删除行为记录'));
    const req = calls.find((c) => c.path.endsWith('/events'));
    expect(req).toEqual({
      path: `/api/v1/admin/customers/${ROW.id}/events`,
      method: 'DELETE',
      body: { reason: '买家邮件要求删除' },
    });
    expect(el.textContent).toContain('已删除 12 条');
  });
});

describe('客户列表：排序与每页条数（评估 4.5 / 4.6）', () => {
  it('🔴 地址栏 sort=-paid_total_jpy&size=50 → 请求带上；点「最近下单」→ 换成 -last_order_at 并回到第 1 页', async () => {
    const { el, calls, navigated } = await open(listRoute('sort=-paid_total_jpy&size=50&page=3'));
    const req = calls.find((c) => c.path.startsWith('/api/v1/admin/customers?'))?.path ?? '';
    expect(req).toContain('sort=-paid_total_jpy');
    expect(req).toContain('size=50');
    const btn = [...el.querySelectorAll('th button')].find((b) =>
      b.textContent?.includes('最近下单'),
    ) as HTMLButtonElement;
    await click(btn);
    expect(navigated.at(-1)?.query.toString()).toBe('sort=-last_order_at&size=50');
  });
});

// 全入口点击测试 2026-10-11：最左、最显眼的「客户」列原是截短的用户 id（u-065bf2d9…），人名排第二列；
// 主流后台第一列是能认出人的名字。改为：第一列写名字（最近收件人），编号挪到操作前、灰字
describe('客户列表列序（全入口点击测试 2026-10-11）', () => {
  it('🔴 第一列是名字，编号列在操作之前', async () => {
    const { el } = await open(listRoute());
    const heads = [...el.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());
    expect(heads[0]).toBe('客户');
    expect(heads).not.toContain('最近收件人');
    expect(heads.at(-2)).toBe('编号');
    const first = el.querySelector('tbody tr td');
    expect(first?.textContent).toBe(ROW.last_recipient);
  });
});

// 规律排查 2026-10-12（与订单详情同类）：从 A 客户详情直接换到 B（前进后退 / 地址栏），A 的拉黑原因留在 B 的框里
describe('客户详情换人时表单不串人', () => {
  it('🔴 A 的拉黑原因不带到 B', async () => {
    let go: (r: Route) => void = () => undefined;
    const api = async (req: Call): Promise<unknown> => {
      const id = req.path.split('/').at(-1) ?? '';
      return { ...detail(false), id };
    };
    function Harness(): React.JSX.Element {
      const [route, setRoute] = useState<Route>({
        page: 'customers',
        id: 'u-A',
        query: new URLSearchParams(),
      });
      go = setRoute;
      return createElement(CustomersPage, { api: api as never, route, onNavigate: setRoute });
    }
    mounted = await mount(createElement(Harness));
    const el = mounted.el;
    await type(el.querySelector('input[name="customer-block-reason"]'), '同一张卡 3 次拒付');
    await act(async () => {
      go({ page: 'customers', id: 'u-B', query: new URLSearchParams() });
      await Promise.resolve();
    });
    await flush();
    expect(el.querySelector<HTMLInputElement>('input[name="customer-block-reason"]')?.value).toBe(
      '',
    );
  });
});
