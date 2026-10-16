/**
 * 职责：订单列表薄壳的**行为**用例——M-04 下拉刷新（AJ-405）。
 *
 * @why 下拉刷新有两个**都不报错**的失效形态：
 *      ① 页面 json 没开 `enablePullDownRefresh` → `onPullDownRefresh` 永远不会被调用，下拉只是回弹；
 *      ② 刷新完不调 `stopPullDownRefresh`（尤其是**失败**那条路）→ 顶部的加载动画一直挂着。
 *      两者都只能把页面跑起来看（或读 json），纯函数里没有它们。
 * @limitation 不渲染（mp-page @limitation 一）：下拉手势本身、动画观感只能真机看（AppID 未下来）。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let calls: string[];
let fail: boolean;
/**
 * AJ-433：接口回 40301（账号被拉黑）。
 * ⚠️ 规律排查 2026-10-12：40301 **不止一种成因**，夹具原先只给码、不给 `data.reason`——
 *    那等于把"被拉黑"当成这个码的唯一样子，于是"源站校验失败也说成账号被限制"这个缺陷
 *    在每条用例里都看不见（规律⑪：测试数据只覆盖主状态）。这里补上 reason，并另有用例钉另一个成因。
 */
let forbidden: boolean;

/** 40301 的成因（服务端 `{ reason }`）：`blocked` = 账号被拉黑；`origin_not_verified` = 源站校验失败。 */
let forbiddenReason: string;
let hold: ReturnType<typeof deferred<unknown>> | null;
/** AJ-408：页签用例要改写一次性意图（globalData.orderTab）与"空列表"——setup 只是多留两个句柄，原用例不变。 */
let gd: Record<string, unknown>;
let empty: boolean;

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  calls = [];
  fail = false;
  forbidden = false;
  forbiddenReason = 'blocked';
  hold = null;
  empty = false;
  vi.stubGlobal('wx', {
    stopPullDownRefresh: () => calls.push('stop'),
    navigateTo: () => undefined,
    switchTab: (o: { url: string }) => calls.push(`switchTab ${o.url}`),
  });
  gd = {
    orderTab: '',
    // 体验审查 2026-10-15（P1-2）：一次性"订单变过了"信号（@see app.js globalData.ordersChanged）
    ordersChanged: false,
    apiBase: 'http://api.test',
    api: async (req: { url: string }) => {
      calls.push(`GET ${req.url.replace('http://api.test', '')}`);
      if (hold !== null) return hold.promise;
      if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
      if (forbidden)
        throw Object.assign(new Error('无权限'), {
          code: 40301,
          data: { reason: forbiddenReason },
        });
      if (empty) return { items: [] };
      return {
        items: [{ order_id: 'o-1', order_no: 'WS-20261008-0001', status: 'paid', total_jpy: 9150 }],
      };
    },
  };
  page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: gd });
  call('onLoad');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订单列表：下拉刷新（M-04）', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh（没开 = onPullDownRefresh 永远不会被调用）', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重取列表，取完才收起下拉动画（先收后取 = 用户以为刷新完了、看到的还是旧数据）', async () => {
    hold = deferred<unknown>();
    const done = call<Promise<void>>('onPullDownRefresh');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    hold.resolve({ items: [{ order_id: 'o-2', status: 'shipped' }] });
    await done;
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20', 'stop']);
    expect((page.data['rows'] as Array<{ statusText: string }>)[0]?.statusText).toBe(
      '已发货 · 国际运输中',
    );
  });

  it('🔴 取数失败也要收起下拉动画，并显示错误（不能一直转圈）', async () => {
    fail = true;
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20', 'stop']);
    expect(page.data['error']).not.toBe('');
    expect(page.data['rows']).toEqual([]);
  });
});

describe('订单列表：状态页签（M-10，AJ-408）', () => {
  it('🔴 点页签 → 带 status 重取；「全部」不带参数', async () => {
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'unpaid' } },
    });
    expect(calls).toEqual(['GET /api/v1/orders?status=created,pending_payment&page=1&size=20']);
    expect(page.data['activeTab']).toBe('unpaid');
    expect(
      (page.data['tabs'] as Array<{ key: string; active: boolean }>).find((t) => t.active)?.key,
    ).toBe('unpaid');
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'all' } },
    });
    expect(calls.at(-1)).toBe('GET /api/v1/orders?page=1&size=20');
  });

  it('🔴 从「我的」带来的一次性意图：onShow 读走并清空，按它取数', async () => {
    gd['orderTab'] = 'after_sale';
    (page['onShow'] as () => void)();
    await settle();
    // S-7（契约 0.6.69）：「售后·退款」由服务端筛（状态命中或有售后申请），不再取全量本地滤
    expect(calls.at(-1)).toBe(
      'GET /api/v1/orders?status=refunding,refunded&include_after_sale=1&page=1&size=20',
    );
    expect(gd['orderTab']).toBe('');
    expect(page.data['activeTab']).toBe('after_sale');
  });

  it('🔴 快速切页签：先发的请求后回来 → 丢弃（不让「全部」的结果盖住「待付款」）', async () => {
    hold = deferred<unknown>();
    const slow = (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'all' } },
    });
    await settle();
    const first = hold;
    hold = null;
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'to_ship' } },
    });
    first.resolve({ items: [{ order_id: 'stale', status: 'created' }] });
    await slow;
    const rows = page.data['rows'] as Array<{ orderId: string }>;
    expect(rows.map((r) => r.orderId)).toEqual(['o-1']);
    expect(page.data['activeTab']).toBe('to_ship');
  });

  it('分页签空态文案（「待付款」里空着不说"还没有订单"）', async () => {
    empty = true;
    await (page['onTabTap'] as (e: unknown) => Promise<void>)({
      currentTarget: { dataset: { key: 'unpaid' } },
    });
    expect(page.data['empty']).toBe(true);
    expect(page.data['emptyText']).toBe('「待付款」里暂时没有订单');
  });
});

// AJ-430：页签过滤在页面里真的接上了（不只是 utils/order-tabs 单测里对）
describe('订单列表：「售后·退款」本地过滤', () => {
  it('🔴 取回全量后只显示退款中 / 已退款或有售后申请的单', async () => {
    gd['api'] = async (req: { url: string }) => {
      calls.push(`GET ${req.url.replace('http://api.test', '')}`);
      return {
        items: [
          {
            order_id: 'o-del',
            order_no: 'N1',
            status: 'delivered',
            total_jpy: 1000,
            after_sale_state: null,
          },
          {
            order_id: 'o-as',
            order_no: 'N2',
            status: 'delivered',
            total_jpy: 1000,
            after_sale_state: 'open',
          },
          {
            order_id: 'o-rf',
            order_no: 'N3',
            status: 'refunded',
            total_jpy: 1000,
            after_sale_state: null,
          },
        ],
      };
    };
    gd['orderTab'] = 'after_sale';
    (page['onShow'] as () => void)();
    await settle();
    expect((page.data['rows'] as Array<{ orderId: string }>).map((r) => r.orderId)).toEqual([
      'o-as',
      'o-rf',
    ]);
  });
});

describe('被拉黑的账号：错误态给「联系客服」而不是「重试」（AJ-433，用户 2026-10-10 授权代决）', () => {
  it('🔴 40301 → errorContact；点按钮去「我的」（客服联系方式在那里），不再白发一次请求', async () => {
    forbidden = true;
    calls = [];
    await call<Promise<void>>('load');
    expect(page.data['error']).toBe('账号已被限制使用，如有疑问请联系客服');
    expect(page.data['errorContact']).toBe(true);
    calls = [];
    call('onRetry');
    await settle();
    expect(calls).toEqual(['switchTab /pages/user/index']);
  });

  it('其它错误照旧「重试」：重新取列表', async () => {
    fail = true;
    await call<Promise<void>>('load');
    expect(page.data['errorContact']).toBe(false);
    calls = [];
    fail = false;
    call('onRetry');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
  });

  /**
   * 规律排查（本轮）：40301 的另一个买家可达成因是**源站校验失败**（`server/src/http.ts` 的
   * `origin_not_verified`，只接受经 Cloudflare 的流量）。原先这里（以及小程序其它三处）照码判，
   * 把一次基础设施故障说成"你的账号被限制使用"、并把出口换成客服——
   * 线上真出这种事时**全体买家**都会去找客服，而客服查不出任何问题（规律①：修一处不扫同类）。
   */
  it('🔴 40301 但成因是源站校验失败 → 不说账号被限制，仍走「重试」重新取列表', async () => {
    forbidden = true;
    forbiddenReason = 'origin_not_verified';
    calls = [];
    await call<Promise<void>>('load');
    expect(page.data['error']).not.toContain('账号已被限制');
    expect(page.data['errorContact']).toBe(false);
    calls = [];
    call('onRetry');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
  });
});

describe('订单列表：分页与触底加载（S-7，第二轮审计 2026-10-11）', () => {
  const row = (i: number) => ({
    order_id: `o-${i}`,
    order_no: `WS-${i}`,
    status: 'paid',
    total_jpy: 1000,
  });

  it('🔴 第 1 页 20 条、共 25 → 触底取第 2 页并追加；取完就不再取；跨页重复的单只留一份', async () => {
    gd['api'] = async (req: { url: string }) => {
      const url = req.url.replace('http://api.test', '');
      calls.push(`GET ${url}`);
      if (url.includes('page=1&'))
        return { items: Array.from({ length: 20 }, (_, i) => row(i)), total: 25 };
      // 翻页途中来了一张新单：第 2 页第一条与第 1 页最后一条是同一张
      return { items: [row(19), ...Array.from({ length: 5 }, (_, i) => row(20 + i))], total: 26 };
    };
    calls = [];
    await call<Promise<void>>('load');
    expect(page.data['rows']).toHaveLength(20);
    expect(page.data['hasMore']).toBe(true);
    await call<Promise<void>>('onReachBottom');
    expect(calls.at(-1)).toBe('GET /api/v1/orders?page=2&size=20');
    const ids = (page.data['rows'] as Array<{ orderId: string }>).map((r) => r.orderId);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    // 服务端偏移已取满 26（20 + 6），不再有下一页
    expect(page.data['hasMore']).toBe(false);
    const n = calls.length;
    await call<Promise<void>>('onReachBottom');
    expect(calls.length).toBe(n);
  });

  it('🔴 追加失败不清列表，页脚给"点此重试"，重试取的仍是第 2 页', async () => {
    let failMore = true;
    gd['api'] = async (req: { url: string }) => {
      const url = req.url.replace('http://api.test', '');
      calls.push(`GET ${url}`);
      if (url.includes('page=1&'))
        return { items: Array.from({ length: 20 }, (_, i) => row(i)), total: 30 };
      if (failMore) throw Object.assign(new Error('网络请求失败'), { code: -1 });
      return { items: Array.from({ length: 10 }, (_, i) => row(20 + i)), total: 30 };
    };
    await call<Promise<void>>('load');
    await call<Promise<void>>('onReachBottom');
    expect(page.data['rows']).toHaveLength(20);
    expect(String(page.data['moreError'])).not.toBe('');
    failMore = false;
    await call<Promise<void>>('onMoreRetry');
    expect(calls.at(-1)).toBe('GET /api/v1/orders?page=2&size=20');
    expect(page.data['rows']).toHaveLength(30);
    expect(page.data['moreError']).toBe('');
  });
});

/**
 * 体验审查 2026-10-15（P1-2）：`onShow` 从"无条件重取"改为"按需重取"。
 *
 * @why 这条改动有两个**都不报错**的失效形态，纯函数里看不出来，只能把页面跑起来钉：
 *      ① 忘了按需 → 从详情返回丢分页与滚动位置（原缺陷，翻不到底）；
 *      ② 按需过头 → 刚取消 / 刚付款的单回到列表还是旧状态（比 ① 更严重：已取消的单还挂着「继续支付」）。
 *      所以下面既钉"不该取的时候不取"，也钉"该取的时候一定取"。
 */
describe('订单列表：进屏按需重取（体验审查 2026-10-15，P1-2）', () => {
  /** 造一个"翻到了第 2 页"的列表：第 1 页 20 条、共 25 → 触底取第 2 页。 */
  const loadedTwoPages = async (): Promise<void> => {
    const row = (i: number) => ({
      order_id: `o-${i}`,
      order_no: `WS-${i}`,
      status: 'paid',
      total_jpy: 1000,
    });
    gd['api'] = async (req: { url: string }) => {
      const url = req.url.replace('http://api.test', '');
      calls.push(`GET ${url}`);
      // 与默认 api 同口径：分页夹具也要认 fail（否则"翻到第 2 页之后再失败"这条路径造不出来）
      if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
      if (url.includes('page=1&'))
        return { items: Array.from({ length: 20 }, (_, i) => row(i)), total: 25 };
      return { items: Array.from({ length: 5 }, (_, i) => row(20 + i)), total: 25 };
    };
    await call<Promise<void>>('load');
    await call<Promise<void>>('onReachBottom');
    expect(page.data['rows']).toHaveLength(25);
    calls = [];
  };

  it('🔴 从详情返回不重取：翻到第 2 页后进详情、返回，25 行还在、一个请求都不发', async () => {
    await loadedTwoPages();
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual([]);
    expect(page.data['rows']).toHaveLength(25);
  });

  it('🔴 上次取数超过 60 秒 → 进屏重取（运营发货 / 退款 / 关单不会置 ordersChanged；四天提交复查 2026-10-16）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-16T01:00:00Z'));
      await loadedTwoPages();
      vi.setSystemTime(new Date('2026-10-16T01:00:30Z'));
      (page['onShow'] as () => void)();
      await settle();
      expect(calls, '30 秒内回来不重取（保住翻页与滚动）').toEqual([]);
      vi.setSystemTime(new Date('2026-10-16T01:01:01Z'));
      (page['onShow'] as () => void)();
      await settle();
      expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 别处改过订单（globalData.ordersChanged）→ 进屏重取，且读走即清（下次进屏不再取）', async () => {
    await loadedTwoPages();
    gd['ordersChanged'] = true;
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    expect(gd['ordersChanged']).toBe(false);
    calls = [];
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual([]);
  });

  it('🔴 还没成功取过（首屏）→ 进屏要取；取成功后就不取了', async () => {
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    calls = [];
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual([]);
  });

  it('🔴 取失败（page 复位到 0）→ 下次进屏自动再取，不把用户留在错误态里', async () => {
    fail = true;
    (page['onShow'] as () => void)();
    await settle();
    expect(String(page.data['error'])).not.toBe('');
    calls = [];
    fail = false;
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    expect(page.data['error']).toBe('');
  });

  /**
   * BUG-003（全量审计 2026-10-14）：上面那条只覆盖了"从没成功过"这一种失败。
   * 首次成功之后 page 就 ≥1 了，而取失败**不复位**它——于是"翻到第 2 页 → 下拉刷新断了
   * → 切 tab 走 → 切回来"这条最常见的路径上，三条判据全落空，列表永久停在错误态。
   */
  it('🔴 已经翻到第 2 页之后再取失败 → 切走再切回仍然重取（失败把游标复位，不只是首屏能自愈）', async () => {
    await loadedTwoPages();
    fail = true;
    await call<Promise<void>>('onPullDownRefresh');
    expect(page.data['rows']).toEqual([]);
    expect(String(page.data['error'])).not.toBe('');
    // 切走（tab 页只是不再进 onShow）再切回
    calls = [];
    fail = false;
    (page['onShow'] as () => void)();
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20']);
    expect(page.data['error']).toBe('');
    expect(page.data['rows']).toHaveLength(20);
  });

  it('🔴 下拉刷新不受"按需"影响：仍然无条件重取并回到第 1 页', async () => {
    await loadedTwoPages();
    await call<Promise<void>>('onPullDownRefresh');
    // 取数是第 1 页，取完才收起动画（M-04 的老用例钉的是这个顺序，这里只多加一层"已翻到第 2 页"的前提）
    expect(calls).toEqual(['GET /api/v1/orders?page=1&size=20', 'stop']);
    expect(page.data['rows']).toHaveLength(20);
  });
});

// 全入口点击测试 2026-10-11：空页签的卡片顶着页签栏、文字与按钮挤在一起；改用与购物车 / 地址页同一个三段式状态块
describe('订单页空态的样子（全入口点击测试 2026-10-11）', () => {
  it('🔴 空态走 ws-state-block（kind=empty），按钮「去逛逛」走 onGoShopping', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    expect(wxml).toMatch(
      /<ws-state-block\s+wx:if="\{\{empty\}\}"\s+kind="empty"\s+title="\{\{emptyText\}\}"[^>]*actionText="去逛逛"[^>]*bindaction="onGoShopping"/,
    );
    expect(wxml).toMatch(
      /<ws-state-block\s+wx:if="\{\{loading && rows.length === 0\}\}"\s+kind="loading"/,
    );
  });
});

// 独立审查 2026-10-13 【7】：全项目 9 处"?id="跳转里唯一没编码的一处
describe('订单列表：行点击跳详情的 id 要编码', () => {
  it('🔴 id 含特殊字符时 URL 被编码，与其余 8 处同口径', async () => {
    const navs: string[] = [];
    vi.stubGlobal('wx', {
      navigateTo: (o: { url: string }) => navs.push(o.url),
      switchTab: () => undefined,
    });
    const p = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: {
        apiBase: 'http://api.test',
        token: 't',
        orderTab: '',
        api: () => Promise.resolve({ items: [], total: 0 }),
      },
    });
    (p['onRowTap'] as (e: unknown) => void)({ currentTarget: { dataset: { id: 'ord a&b' } } });
    expect(navs).toEqual(['/pages/order-detail/index?id=ord%20a%26b']);
  });
});
