/**
 * 职责：订单详情薄壳的**行为**用例——M-04 下拉刷新、M-05 复制订单号（AJ-405）。
 *
 * @why 都是"接线"问题，纯函数里测不到：
 *      ① json 没开下拉 / 失败路径不收起动画（同订单列表）；
 *      ② 复制订单号复制的是**订单号**（order_no，买家与客服对话用的那串），不是内部 order_id；
 *         复制失败要告诉用户手动长按，而不是什么都不发生。
 * @limitation 不渲染（mp-page @limitation 一）：按钮位置、客服卡是否真的挪到了状态区下方只能看 wxml / 真机。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

const ORDER = {
  order_id: 'o-1',
  order_no: 'WS-20261008-0001',
  status: 'paid',
  total_jpy: 9150,
  contact_email: 'buyer@example.com',
};

let page: LoadedPage;
let calls: string[];
let fail: boolean;
/**
 * AJ-433：接口回 40301（账号被拉黑）。
 * ⚠️ 规律排查 2026-10-12：40301 **不止一种成因**，夹具原先只给码、不给 `data.reason`——
 *    等于把"被拉黑"当成这个码的唯一样子，缺陷（源站校验失败也被说成账号被限制）在用例里看不见
 *    （规律⑪：测试数据只覆盖主状态）。这里补上 reason，并另有用例钉另一个成因。
 */
let forbidden: boolean;
/** 40301 的成因（服务端 `{ reason }`）：`blocked` = 账号被拉黑；`origin_not_verified` = 源站校验失败。 */
let forbiddenReason: string;
/** 全入口点击测试 2026-10-11：接口回 40400（订单不存在 / 不是本人的）。 */
let notFound: boolean;
let clipFail: boolean;
/** MP-7：POST（取消 / 确认收货）抛这个错；null = 成功。 */
let postError: unknown;
let hold: ReturnType<typeof deferred<unknown>> | null;
/** A7：每次打开详情返回的订单（默认 ORDER）。 */
let order: Record<string, unknown>;
/** A7：再次购买时加进购物车的条目；`full` 为 true 时购物车拒收新品种。 */
let added: unknown[];
let full: boolean;
/** 全入口点击测试 2026-10-11：再次购买后 cart.focusOn 收到的 id。 */
let focused: string[];
/** 全入口点击测试 2026-10-11：购物车里已有的行（再次购买时改数量，不叠加）。 */
let inCart: Array<{ productId: string; qty: number }>;
let qtySet: Array<[string, number]>;
let nav: string[];

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

async function open(id = 'o-1', extra: Record<string, string> = {}): Promise<void> {
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: { url: string; method?: string }) => {
        const path = req.url.replace('http://api.test', '');
        calls.push(`${req.method ?? 'GET'} ${path}`);
        if (req.method === 'POST') {
          if (postError !== null) throw postError;
          return {};
        }
        if (path.endsWith('/support')) return { wechat: 'waselect_cs' };
        if (hold !== null) return hold.promise;
        if (fail) throw Object.assign(new Error('网络请求失败'), { code: -1 });
        if (forbidden)
          throw Object.assign(new Error('无权限'), {
            code: 40301,
            data: { reason: forbiddenReason },
          });
        if (notFound) throw Object.assign(new Error('请求的资源不存在'), { code: 40400 });
        return order;
      },
      cart: {
        add: (item: unknown) => {
          if (full) return { added: false, reason: 'full' };
          added.push(item);
          return { added: true };
        },
        focusOn: (ids: string[]) => focused.push(...ids),
        items: () => inCart,
        setQty: (id: string, qty: number) => qtySet.push([id, qty]),
      },
    },
  });
  // 真机生命周期：onLoad → onShow（取单在 onShow）
  call('onLoad', { id, ...extra });
  call('onShow');
  await settle();
  calls = [];
}

beforeEach(() => {
  calls = [];
  fail = false;
  forbidden = false;
  forbiddenReason = 'blocked';
  notFound = false;
  clipFail = false;
  postError = null;
  hold = null;
  order = ORDER;
  added = [];
  full = false;
  focused = [];
  inCart = [];
  qtySet = [];
  nav = [];
  vi.stubGlobal('wx', {
    stopPullDownRefresh: () => calls.push('stop'),
    setClipboardData: (o: { data: string; success?: () => void; fail?: () => void }) => {
      calls.push(`clip ${o.data}`);
      if (clipFail) o.fail?.();
      else o.success?.();
    },
    navigateTo: (o: { url: string }) => nav.push(o.url),
    switchTab: (o: { url: string }) => nav.push(o.url),
    showModal: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订单详情：下拉刷新（M-04）', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重取这张单，取完才收起动画；状态区带"下一步"', async () => {
    await open();
    hold = deferred<unknown>();
    const done = call<Promise<void>>('onPullDownRefresh');
    await settle();
    expect(calls).toEqual(['GET /api/v1/orders/o-1']);
    hold.resolve({ ...ORDER, status: 'shipped' });
    await done;
    expect(calls).toEqual(['GET /api/v1/orders/o-1', 'stop']);
    const view = page.data['view'] as { statusText: string; nextText: string };
    expect(view.statusText).toBe('已发货 · 国际运输中');
    expect(view.nextText).toContain('确认收货');
  });

  it('🔴 取单在途时离开页面：结果回来后不改页面（审计 BUG-03）', async () => {
    await open();
    const before = page.data['view'];
    hold = deferred<unknown>();
    const done = call<Promise<void>>('load');
    await settle();
    call('onUnload');
    hold.resolve({ ...ORDER, status: 'shipped' });
    await done;
    expect(page.data['view']).toBe(before);
  });

  it('🔴 取数失败也收起动画，并显示错误', async () => {
    await open();
    fail = true;
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['GET /api/v1/orders/o-1', 'stop']);
    expect(page.data['error']).not.toBe('');
  });

  it('链接里没有订单 id → 不发请求，直接收起动画（空 id 会撞上列表路由）', async () => {
    await open('');
    await call<Promise<void>>('onPullDownRefresh');
    expect(calls).toEqual(['stop']);
  });
});

describe('订单详情：复制订单号（M-05）', () => {
  it('🔴 复制的是订单号 order_no（客服认这串），成功后按钮处显示"已复制"', async () => {
    await open();
    call('onCopyOrderNo');
    expect(calls).toEqual(['clip WS-20261008-0001']);
    expect(page.data['copied']).toBe('order');
  });

  it('🔴 复制失败 → 就近告诉用户长按手动复制（不是什么都不发生）；不弹顶部错误态（F9：订单本身没问题）', async () => {
    await open();
    clipFail = true;
    call('onCopyOrderNo');
    expect(page.data['copied']).toBe('');
    expect(String(page.data['copyError'])).toContain('订单号');
    expect(page.data['copyErrorAt']).toBe('order');
    expect(page.data['error']).toBe('');
  });

  it('订单还没取到（没有订单号）→ 不调剪贴板', async () => {
    await open();
    page.setData({ view: null });
    call('onCopyOrderNo');
    expect(calls).toEqual([]);
  });

  it('客服联系方式照常取到（卡片挪位置不影响取数）', async () => {
    await open();
    expect(page.data['support']).toEqual([
      { key: 'wechat', label: '客服微信', value: 'waselect_cs', copyable: true },
    ]);
  });
});

describe('订单详情：再次购买 / 商品可点（A7，AJ-416）', () => {
  const DONE = {
    ...ORDER,
    status: 'completed',
    items: [
      { product_id: 'p-1', title: '白色恋人 12 枚装', qty: 2, unit_price_jpy: 2160 },
      { product_id: 'p-2', title: '南部铁器 急须', qty: 1, unit_price_jpy: 12800 },
    ],
  };

  it('🔴 再次购买：原样的商品与数量放回购物车，然后去购物车（tab 页用 switchTab）', async () => {
    order = DONE;
    await open();
    call('onBuyAgain');
    expect(added).toMatchObject([
      { productId: 'p-1', qty: 2 },
      { productId: 'p-2', qty: 1 },
    ]);
    expect(nav).toEqual(['/pages/cart/index']);
  });

  it('🔴 再次购买的几件排到购物车最上面、只勾它们（全入口点击测试 2026-10-11：原先混进旧的一起结算）', async () => {
    order = DONE;
    await open();
    call('onBuyAgain');
    expect(focused).toEqual(['p-1', 'p-2']);
  });

  it('🔴 购物车里已有这件 → 数量改成这单的数量，不再叠加（点两次「再次购买」不会变成双份）', async () => {
    order = DONE;
    inCart = [{ productId: 'p-1', qty: 1 }];
    await open();
    call('onBuyAgain');
    expect(qtySet).toEqual([['p-1', 2]]);
    expect(added).toMatchObject([{ productId: 'p-2', qty: 1 }]);
  });

  it('🔴 购物车里这件已有更多 → 不往下改（审计 BUG-14：买家自己加的数量不被这单覆盖少）', async () => {
    order = DONE;
    inCart = [{ productId: 'p-1', qty: 5 }];
    await open();
    call('onBuyAgain');
    expect(qtySet).toEqual([]);
  });

  it('🔴 部分放进去了 → 放进去的照样排到最上面并勾选，留在本页说明没放进的件数（审计 BUG-14）', async () => {
    order = DONE;
    inCart = [{ productId: 'p-1', qty: 1 }];
    full = true;
    await open();
    call('onBuyAgain');
    expect(focused).toEqual(['p-1']);
    expect(nav).toEqual([]);
    expect(page.data['buyAgainNote']).toContain('1 件没放进去');
  });

  it('🔴 购物车品种已满放不进去 → 留在本页说清楚，不假装成功地跳走', async () => {
    order = DONE;
    full = true;
    await open();
    call('onBuyAgain');
    expect(nav).toEqual([]);
    expect(page.data['buyAgainNote']).toContain('购物车');
  });

  it('🔴 点商品行 → 进商品详情（看看现在还卖不卖、什么价）', async () => {
    order = DONE;
    await open();
    call('onOpenItem', { currentTarget: { dataset: { id: 'p-2' } } });
    expect(nav).toEqual(['/pages/detail/index?id=p-2']);
  });
});

describe('订单详情：申请售后入口（AJ-420）', () => {
  it('🔴 可申请时 → 带内部 order_id 进售后申请页', async () => {
    order = { ...ORDER, status: 'delivered' };
    await open();
    call('onApplyAfterSale');
    expect(nav).toEqual(['/pages/after-sale/index?id=o-1']);
  });

  it('🔴 进售后页前把订单摘要交过去（全入口点击测试 2026-10-11：售后页要显示是哪一单）', async () => {
    order = {
      ...ORDER,
      status: 'delivered',
      items: [{ product_id: 'p-1', title: '虎屋 抹茶粉 40g', qty: 1, unit_price_jpy: 2000 }],
    };
    await open();
    call('onApplyAfterSale');
    const gd = (
      globalThis as unknown as { getApp: () => { globalData: Record<string, unknown> } }
    ).getApp().globalData;
    expect(gd['afterSaleBrief']).toMatchObject({
      orderId: 'o-1',
      orderNo: 'WS-20261008-0001',
      title: '虎屋 抹茶粉 40g',
    });
  });

  it('不可申请（待发货 / 已有进行中的申请）→ 点了也不跳', async () => {
    await open();
    call('onApplyAfterSale');
    order = {
      ...ORDER,
      status: 'delivered',
      after_sale: { id: 'as-1', reason: 'damaged', description: 'x', status: 'processing' },
    };
    await open();
    call('onApplyAfterSale');
    expect(nav).toEqual([]);
  });

  it('wxml 里入口绑的是 onApplyAfterSale，且只在 canApply 时出现', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    // 2026-10-11（全入口点击测试）：入口拆成两处（没申请过：与「售后」同一行；申请过：详情下方"再次申请"），两处都以 canApply 为前提
    expect(wxml).toMatch(
      /wx:if="\{\{view\.afterSale\.canApply && !view\.afterSale\.current\}\}"[\s\S]{0,120}bindtap="onApplyAfterSale"/,
    );
    expect(wxml).toMatch(
      /wx:if="\{\{view\.afterSale\.canApply && view\.afterSale\.current\}\}"[\s\S]{0,120}bindtap="onApplyAfterSale"/,
    );
    expect(wxml.match(/bindtap="onApplyAfterSale"/g)).toHaveLength(2);
  });
});

describe('支付结果确认中：重查两次仍未确认（统一结论 5.3）', () => {
  it('🔴 放弃"刚付过"的假设后恢复按钮，同时说清：可能还没到账、请勿重复付款、稍后下拉刷新', async () => {
    vi.useFakeTimers();
    try {
      order = { ...ORDER, status: 'pending_payment', expires_at: '2099-01-01T00:00:00.000Z' };
      await open('o-1', { justPaid: '1' });
      expect(page.data['view']).toMatchObject({ confirming: true, canPay: false });
      await vi.advanceTimersByTimeAsync(1500);
      await settle();
      await vi.advanceTimersByTimeAsync(3000);
      await settle();
      const view = page.data['view'] as Record<string, unknown>;
      expect(view).toMatchObject({ confirming: false, canPay: true, canCancel: true });
      expect(String(view['confirmHint'])).toContain('请勿重复付款');
    } finally {
      vi.useRealTimers();
    }
  });
});

// 统一结论 5.3（用户授权代决，AJ-429）：订单号、建单时间、付款截止、"请提供订单号"是买家要照着做的信息，
// 原先用 .ws-caption（ink-faint）——白卡上对比度只有 2.18:1。改用已有的 ink-soft，不加新色、不改字号
describe('订单详情关键信息的对比度', () => {
  const wcag = (hex: string): number => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
    const l = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [wcag(a), wcag(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  it('🔴 四处关键信息都带 key-info，且 key-info 的颜色在白卡上 ≥ 4.5:1', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    for (const text of [
      '订单号 {{view.orderNo}}',
      '下单时间 {{view.createdAtText}}', // 2026-10-11：「建单」是内部用语，买家看到的改为「下单时间」
      '截止 {{view.expiresAtText}}', // 2026-10-11：原"请在 … 前完成支付"，改为先写剩余分钟、截止时刻放下一行
      '{{view.payLeftText}}',
      '联系客服时请提供订单号',
    ]) {
      const tag = new RegExp(
        `<text class="([^"]*)"[^>]*>[^<]*${text.replace(/[{}.]/g, '\\$&')}`,
      ).exec(wxml);
      expect(tag?.[1], text).toContain('key-info');
    }
    const wxss = readFileSync(new URL('./index.wxss', import.meta.url), 'utf8');
    const token = /\.key-info\s*\{[^}]*color:\s*var\((--ws-[a-z-]+)\)/.exec(wxss)?.[1];
    const app = readFileSync(new URL('../../app.wxss', import.meta.url), 'utf8');
    const hex =
      new RegExp(`${token ?? '--none'}:\\s*(#[0-9a-fA-F]{6})`).exec(app)?.[1] ?? '#ffffff';
    expect(ratio(hex, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('被拉黑的账号：错误态给「联系客服」（AJ-433，用户 2026-10-10 授权代决）', () => {
  it('🔴 40301 且是拉黑 → errorContact；点按钮去「我的」，不再重取', async () => {
    forbidden = true;
    await open();
    expect(page.data['error']).toBe('账号已被限制使用，如有疑问请联系客服');
    expect(page.data['errorContact']).toBe(true);
    call('onRetry');
    await settle();
    expect(nav).toEqual(['/pages/user/index']);
    expect(calls).toEqual([]);
  });

  /**
   * 规律排查（本轮）：40301 的另一个买家可达成因是**源站校验失败**（`server/src/http.ts` 的
   * `origin_not_verified`）。原先照码判 → 把这个基础设施故障说成"你的账号被限制使用"、
   * 并撤掉重取。真出这种事时全体买家都去找客服，而客服查不出任何问题（规律①：修一处不扫同类）。
   */
  it('🔴 40301 但成因是源站校验失败 → 不说账号被限制，仍去重取这张单', async () => {
    forbidden = true;
    forbiddenReason = 'origin_not_verified';
    calls = [];
    await open();
    expect(page.data['error']).not.toContain('账号已被限制');
    expect(page.data['errorContact']).toBe(false);
    forbidden = false;
    calls = [];
    call('onRetry');
    await settle();
    expect(nav).toEqual([]);
    expect(calls).toEqual(['GET /api/v1/orders/o-1']);
  });

  // 全入口点击测试 2026-10-11：原先"请求的资源不存在"+ 40400 + 「重试」——重试一万次也一样
  it('🔴 订单不存在（40400）：说人话、不出错误码；按钮去订单列表，不再重取', async () => {
    notFound = true;
    await open();
    expect(page.data['notFound']).toBe(true);
    expect(String(page.data['error'])).toContain('链接可能已失效');
    expect(page.data['errorRef']).toBe('');
    calls = [];
    call('onRetry');
    await settle();
    expect(nav).toEqual(['/pages/order/index']);
    expect(calls).toEqual([]);
  });

  it('网络错照旧重试：重取这张单', async () => {
    fail = true;
    await open();
    expect(page.data['errorContact']).toBe(false);
    fail = false;
    call('onRetry');
    await settle();
    expect(calls[0]).toBe('GET /api/v1/orders/o-1');
    expect(nav).toEqual([]);
  });
});

describe('取消 / 确认收货撞上状态已变（MP-7，第二轮审计 2026-10-11）', () => {
  const PENDING = { ...ORDER, status: 'pending_payment', expires_at: '2099-01-01T00:00:00.000Z' };
  const view = (): Record<string, unknown> => page.data['view'] as Record<string, unknown>;

  it('🔴 取消时 40902（服务端那边已付款）→ 重取这张单，按钮随新状态更新，并说一句为什么', async () => {
    order = PENDING;
    await open();
    expect(view()['canCancel']).toBe(true);
    postError = Object.assign(new Error('订单状态不允许此操作'), { code: 40902 });
    order = { ...ORDER, status: 'paid' };
    await call<Promise<void>>('cancel');
    await settle();
    expect(calls).toEqual(['POST /api/v1/orders/o-1/cancel', 'GET /api/v1/orders/o-1']);
    expect(view()['canCancel']).toBe(false);
    expect(page.data['error']).toBe('');
    expect(String(page.data['actionNote'])).toContain('已为你刷新');
    expect(page.data['cancelling']).toBe(false);
  });

  it('🔴 确认收货时 40902（如拒付冻结）→ 同样重取并说明，且提示可联系客服', async () => {
    order = { ...ORDER, status: 'shipped' };
    await open();
    postError = Object.assign(new Error('订单状态不允许此操作'), { code: 40902 });
    await call<Promise<void>>('confirmReceipt');
    await settle();
    expect(calls).toEqual(['POST /api/v1/orders/o-1/confirm-receipt', 'GET /api/v1/orders/o-1']);
    expect(String(page.data['actionNote'])).toContain('联系客服');
  });

  it('网络错 → 仍走通用错误态，不重取', async () => {
    order = PENDING;
    await open();
    postError = Object.assign(new Error('网络请求失败'), { code: -1 });
    await call<Promise<void>>('cancel');
    await settle();
    expect(calls).toEqual(['POST /api/v1/orders/o-1/cancel']);
    expect(String(page.data['error'])).not.toBe('');
    expect(page.data['actionNote']).toBe('');
  });
});

describe('并发取数只认最后一次（F12，第二轮审计 2026-10-11）', () => {
  it('🔴 先发的旧请求后回来 → 丢弃，不把新状态盖回去', async () => {
    await open();
    const slow = deferred<unknown>();
    hold = slow;
    const first = call<Promise<void>>('load'); // 旧请求挂住
    hold = null;
    order = { ...ORDER, status: 'cancelled' };
    await call<Promise<void>>('load'); // 新请求先回来：已取消
    slow.resolve({ ...ORDER, status: 'pending_payment' }); // 旧响应后到
    await first;
    await settle();
    expect((page.data['view'] as Record<string, unknown>)['statusText']).toBe('已取消');
    expect(page.data['loading']).toBe(false);
  });
});

describe('支付后退回原详情（MP-10，第二轮审计 2026-10-11）', () => {
  const gd = (): Record<string, unknown> =>
    (globalThis as unknown as { getApp: () => { globalData: Record<string, unknown> } }).getApp()
      .globalData;
  const PENDING = { ...ORDER, status: 'pending_payment', expires_at: '2099-01-01T00:00:00.000Z' };
  const view = (): Record<string, unknown> => page.data['view'] as Record<string, unknown>;

  it('🔴 去支付时带 from=detail（支付页据此付完退回本页，而不是再压一张详情）', async () => {
    order = PENDING;
    await open();
    call('onPay');
    expect(nav.at(-1)).toBe('/pages/pay/index?orderId=o-1&from=detail');
  });

  it('🔴 onShow 读到本单的 paidReturn（刚付过）→ 显示确认中，不给取消 / 继续支付；读完即清', async () => {
    order = PENDING;
    await open();
    expect(view()['canCancel']).toBe(true);
    gd()['paidReturn'] = { orderId: 'o-1', justPaid: true };
    call('onShow');
    await settle();
    expect(view()['confirming']).toBe(true);
    expect(view()['canCancel']).toBe(false);
    expect(gd()['paidReturn']).toBeNull();
    call('onUnload'); // 停掉确认中的重查定时器
  });

  it('别的单的 paidReturn 不认、也不清（那是别的详情页的）', async () => {
    order = PENDING;
    await open();
    gd()['paidReturn'] = { orderId: 'o-other', justPaid: true };
    call('onShow');
    await settle();
    expect(view()['confirming']).toBe(false);
    expect(gd()['paidReturn']).toEqual({ orderId: 'o-other', justPaid: true });
  });
});

// 三天提交复查 2026-10-12：64560e0 把付款截止改成"请在 N 分钟内完成支付"，但只在取数时算一次——
//   页面开着，过了 20 分钟还写"28 分钟"（原先写的是绝对时刻，不会过时）
describe('待付款剩余分钟随时间走', () => {
  it('🔴 开着页面 3 分钟后，剩余分钟跟着减少；离开页面停表', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    try {
      order = { ...ORDER, status: 'pending_payment', expires_at: '2026-10-12T10:10:00.000Z' };
      await open('o-1');
      expect(String((page.data['view'] as Record<string, unknown>)['payLeftText'])).toContain(
        '10 分钟',
      );
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(String((page.data['view'] as Record<string, unknown>)['payLeftText'])).toContain(
        '7 分钟',
      );
      call('onHide');
      const before = (page.data['view'] as Record<string, unknown>)['payLeftText'];
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect((page.data['view'] as Record<string, unknown>)['payLeftText']).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
