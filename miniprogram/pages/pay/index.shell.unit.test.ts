/**
 * 职责：支付页薄壳的**行为**用例——银行卡（copylink）路径上"回到这一页"与"再点一次通道"两件事（AJ-227）。
 *
 * @why 银行卡支付是微信通道接通前**唯一**的付款路径：页面给出短链，用户去浏览器付款，再回到小程序。
 *      B35（AJ-218）想修的正是"付完回来页面还挂着支付方式、点了 40902"，但它的判定
 *      `shouldRefreshOnShow` 把 `payUrl !== ''`（= copylink 屏）整个排除在外——
 *      而"去浏览器付款"**只**发生在这一屏。于是修复恰好没覆盖到主路径，
 *      对应的 vm 用例还把"copylink 屏不刷新"钉成了正确。
 *      同一屏上的另一处：再点一次通道会轮换短链（服务端每次都换 token），
 *      而"已复制"的按钮状态不复位 ⇒ 按钮写着已复制，剪贴板里却是刚失效的旧链接。
 *
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js（`onShowAction`）
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

interface Req {
  url: string;
  method?: string;
  data?: unknown;
}

let page: LoadedPage;
let requests: Req[];
/** 订单当前状态（用例里改它来模拟"去浏览器付完了"）。 */
let orderStatus: string;
/** 剩余清单 4-8：true = 所有币种都没有可用通道。 */
let noChannels = false;
/** 发起支付时下发的短链序号（每次发起都换一条，与服务端轮换 token 同形）。 */
let linkSeq: number;
let failOrderFetch: boolean;
let clipboard: string[];
/** `POST /orders/{id}/pay` 下发的意图形状（切换通道 / auto 两种场景要用）。 */
let postPlan: 'copylink' | 'in_app' | 'auto';
/** 非空 = 把 `GET /orders/{id}` 挂起（MP3-07：编排两个 load 的先后）。 */
let orderHold: ReturnType<typeof deferred<unknown>> | null;
/** `wx.requestPayment` 是否走 fail（收银台取消）。 */
let payFails: boolean;
/** `wx.redirectTo` 的落点（MP3-06：auto 之后必须离开这一页）。 */
let redirects: string[];
/** `wx.stopPullDownRefresh` 被调次数（A1：下拉刷新后必须收起动画）。 */
let stops: number;
/**
 * 订单的 `expires_at`。默认"现在起 30 分钟后"（P2-35 起已过期的待付款单直接是关闭屏，
 * 固定写死一个过去的时刻会让所有用例都落在关闭屏上）；倒计时用例自己改成固定时刻 + 假时钟。
 */
let expiresAt: string;
/** 订单收货国家（P2-39：通道按它过滤）。 */
let country: string;
/** 非空 = `POST /orders/{id}/pay` 抛这个错（P2-40）。 */
let postError: (Error & { code?: number }) | null;
/** 非空 = `GET /orders/{id}` 抛这个错（联动走查：账号被拉黑 → 40301）。 */
let orderFetchError: (Error & { code?: number }) | null;
/** `wx.switchTab` 的落点（联系客服去「我的」）。 */
let tabs: string[];
/** MP-10：`wx.navigateBack` 被调了几次。 */
let backs: number;
/** MP-4：非空 = `POST /orders/{id}/pay` 挂住，直到手动 resolve。 */
let postHold: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null;

const ORDER_ID = 'o-1';

function order() {
  return {
    id: ORDER_ID,
    status: orderStatus,
    total_jpy: 12_000,
    display: { USD: 8_040 },
    created_at: '2026-09-29T01:00:00.000Z',
    expires_at: expiresAt,
    address: { country },
  };
}

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const tapChannel = (channel: string): void =>
  call('onPay', { currentTarget: { dataset: { channel } } });
const orderFetches = (): number =>
  requests.filter((r) => r.url.endsWith(`/orders/${ORDER_ID}`)).length;
const channelFetches = (): number => requests.filter((r) => r.url.includes('/pay/channels')).length;

beforeEach(async () => {
  requests = [];
  orderStatus = 'pending_payment';
  noChannels = false;
  linkSeq = 0;
  failOrderFetch = false;
  clipboard = [];
  postPlan = 'copylink';
  orderHold = null;
  payFails = false;
  redirects = [];
  stops = 0;
  expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  country = 'US';
  postError = null;
  orderFetchError = null;
  tabs = [];
  backs = 0;
  postHold = null;
  vi.stubGlobal('wx', {
    switchTab: (o: { url: string }) => {
      tabs.push(o.url);
    },
    setClipboardData: (o: { data: string; success?: () => void }) => {
      clipboard.push(o.data);
      o.success?.();
    },
    redirectTo: (o: { url: string }) => {
      redirects.push(o.url);
    },
    stopPullDownRefresh: () => {
      stops += 1;
    },
    navigateTo: () => undefined,
    navigateBack: () => {
      backs += 1;
    },
    // in_app 分支会真的调它（MP3-03 / MP3-07 用例要用）；用开关决定走 success 还是 fail
    requestPayment: (o: { success?: () => void; fail?: () => void }) => {
      if (payFails) o.fail?.();
      else o.success?.();
    },
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: Req) => {
        requests.push(req);
        if (req.url.includes('/pay/channels')) {
          if (noChannels) return { items: [] };
          return req.url.includes('currency=USD')
            ? { items: [{ channel: 'stripe', entryMode: 'copylink', label: '银行卡' }] }
            : { items: [] };
        }
        if (req.method === 'POST') {
          if (postHold !== null) await postHold.promise;
          if (postError !== null) throw postError;
          linkSeq += 1;
          if (postPlan === 'in_app') {
            return {
              payload: {
                timeStamp: '1',
                nonceStr: 'n',
                package: 'p',
                signType: 'RSA',
                paySign: 's',
              },
            };
          }
          if (postPlan === 'auto') return { payload: { auto: true } };
          return { payload: { pay_url: `https://pay.test/o/link-${String(linkSeq)}` } };
        }
        if (failOrderFetch) throw new Error('network down');
        if (orderFetchError !== null) throw orderFetchError;
        if (orderHold !== null) return orderHold.promise;
        return order();
      },
    },
  });
  call('onLoad', { orderId: ORDER_ID });
  await settle();
});

afterEach(() => {
  // 停掉"确认中"的重查定时器（W-02），否则它会在后面的用例里继续发请求
  call('onUnload');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 走到 copylink 屏：点银行卡 → 拿到短链。 */
async function toCopylinkScreen(): Promise<void> {
  expect(page.data['channels']).toHaveLength(1);
  tapChannel('stripe');
  await settle();
  expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
}

describe('支付页薄壳：银行卡路径（AJ-227）', () => {
  it('🔴 去浏览器付完款回来：页面改成"无需再支付"，支付方式与短链都收起', async () => {
    await toCopylinkScreen();
    orderStatus = 'paid'; // 用户在浏览器里付完了，回调已落账
    call('onShow');
    await settle();
    expect(page.data['closedText']).not.toBe('');
    expect(page.data['channels']).toEqual([]);
    expect(page.data['payUrl']).toBe('');
    expect((page.data['guide'] as { title: string }).title).toBe('');
    expect(page.data['copied']).toBe(false);
  });

  it('回来时还没付（或回调还没到）：短链原样保留，只多查一次订单、不重取支付方式', async () => {
    await toCopylinkScreen();
    const before = { orders: orderFetches(), channels: channelFetches() };
    call('onShow');
    await settle();
    // 刷掉短链等于把人回家的路拆了——这条是 B35 原本就要守的，现在与"已付则收起"并存
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
    expect(page.data['channels']).toHaveLength(1);
    expect(orderFetches()).toBe(before.orders + 1);
    expect(channelFetches()).toBe(before.channels);
  });

  it('回来时查订单失败：不打扰正在用的短链屏（不报错、不清短链）', async () => {
    await toCopylinkScreen();
    failOrderFetch = true;
    call('onShow');
    await settle();
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
    expect(page.data['error']).toBe('');
  });

  it('🔴 复制之后再点一次通道：短链换了新的，"已复制"必须复位', async () => {
    await toCopylinkScreen();
    call('onCopy');
    expect(page.data['copied']).toBe(true);
    expect(clipboard).toEqual(['https://pay.test/o/link-1']);

    tapChannel('stripe'); // 服务端轮换 token：旧链接就此失效
    await settle();
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-2');
    // 按钮若仍写"已复制"，用户会直接去浏览器粘贴——粘的是刚失效的 link-1
    expect(page.data['copied']).toBe(false);
  });

  it('首屏进来订单已付：不列支付方式（B35 原有行为，行为化）', async () => {
    orderStatus = 'paid';
    call('onShow'); // 普通屏 → 整页重取
    await settle();
    expect(page.data['channels']).toEqual([]);
    expect(page.data['closedText']).not.toBe('');
  });

  it('重新取数会清掉上一次的错误提示（否则旧错误会一直挂在新内容上面）', async () => {
    page.setData({ error: '上一次的错误' });
    call('onShow');
    await settle();
    expect(page.data['error']).toBe('');
  });
});

describe('支付页薄壳：换通道与审核期 auto（MP3-03 / MP3-06）', () => {
  it('🔴 拿到银行卡短链后改点 in_app：旧短链与引导屏必须一起收掉', async () => {
    await toCopylinkScreen();
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
    expect((page.data['guide'] as { title: string }).title).not.toBe('');

    postPlan = 'in_app';
    tapChannel('wechat');
    await settle();
    // 服务端换通道时已作废那个银行卡支付行：这条短链再被复制去浏览器就是失效页
    expect(page.data['payUrl']).toBe('');
    expect((page.data['guide'] as { title: string }).title).toBe('');
    expect(page.data['copied']).toBe(false);
  });

  it('🔴 审核期 auto（响应到达时订单已 paid）→ 离开这一页去订单详情', async () => {
    postPlan = 'auto';
    tapChannel('mock');
    await settle();
    expect(redirects).toEqual([`/pages/order-detail/index?id=${ORDER_ID}`]);
  });

  it('auto 分支也不留着上一次的短链（与 in_app 同一条口径）', async () => {
    await toCopylinkScreen();
    postPlan = 'auto';
    tapChannel('mock');
    await settle();
    expect(page.data['payUrl']).toBe('');
  });
});

describe('支付页薄壳：整页重取的序号与在途守卫（MP3-07）', () => {
  it('🔴 重取在途时再触发 onShow：不排第二次（两个 load 的结果会互相覆盖）', async () => {
    orderHold = deferred();
    call('onShow'); // 第一次重取：挂在订单查询上
    await settle();
    expect(page.data['loading']).toBe(true);

    const before = orderFetches();
    call('onShow'); // 第二次：应当被"在途"挡掉
    await settle();
    expect(orderFetches()).toBe(before);

    orderHold.resolve(order());
    await settle();
    expect(page.data['loading']).toBe(false);
  });

  it('🔴 两个 load 交错、旧的后到：不许把支付方式盖回"已付款"旁边', async () => {
    const first = deferred();
    orderHold = first;
    void call('load'); // load #1：挂在订单查询上（它更慢）
    await settle();

    // load #2 完整跑完：用户已经在浏览器里付完了
    orderHold = null;
    orderStatus = 'paid';
    await call('load');
    expect(page.data['closedText']).not.toBe('');
    expect(page.data['channels']).toEqual([]);

    // 此刻 load #1 的订单响应才回来（仍是待付款）——它必须被判为过期
    first.resolve({ ...order(), status: 'pending_payment' });
    await settle();
    expect(page.data['channels'], '旧响应不许把通道写回来').toEqual([]);
    expect(page.data['closedText']).not.toBe('');
  });

  it('🔴 收银台取消后的提示不被整页重取抹掉（payResult 与 error 分开）', async () => {
    postPlan = 'in_app';
    payFails = true;
    tapChannel('wechat');
    await settle();
    expect(page.data['payResult']).toContain('支付未完成');

    // 拉起收银台 → 平台触发 onShow → 整页重取
    call('onShow');
    await settle();
    expect(page.data['payResult'], '重取不许清掉上一次支付的结果').toContain('支付未完成');
  });

  it('取数的**错误**仍然会被重取清掉（payResult 分开不是为了把错误留住）', async () => {
    page.setData({ error: '上一次取数失败', payResult: '支付未完成' });
    call('onShow');
    await settle();
    expect(page.data['error']).toBe('');
    expect(page.data['payResult']).toContain('支付未完成');
  });
});

/** 浏览器付款后切回来（W-02）：通知还没到时显示"确认中"并重查，而不是照常给出支付方式。 */
describe('支付页薄壳：银行卡付款后的确认中（W-02）', () => {
  it('🔴 回来时仍是待付款 → 显示确认中；重查拿到已付 → 收起支付方式', async () => {
    await toCopylinkScreen();
    vi.useFakeTimers();
    call('onShow');
    await settle();
    expect(String(page.data['confirmNote'])).toContain('确认');
    orderStatus = 'paid';
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(page.data['closedText']).not.toBe('');
    expect(page.data['confirmNote']).toBe('');
  });

  it('🔴 重查两次仍未确认 → 不再自动重查，但"确认中"不撤掉、改为给出手动刷新的出口（小程序评估 A1）', async () => {
    // @why 原先两次重查（约 6 秒）后清掉提示，页面只剩支付按钮——回调慢时买家会以为没付成、再付一次
    await toCopylinkScreen();
    vi.useFakeTimers();
    call('onShow');
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    await settle();
    const fetches = orderFetches();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(orderFetches()).toBe(fetches); // 不再自动轮询
    expect(page.data['confirmNote']).toContain('请勿重复付款');
    expect(page.data['confirmNote']).toContain('刷新状态');
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
  });

  it('🔴 「我已付款，刷新状态」→ 立刻再查一次；已付 → 收起支付方式', async () => {
    await toCopylinkScreen();
    orderStatus = 'paid';
    const before = orderFetches();
    call('onRefreshPaid');
    await settle();
    expect(orderFetches()).toBe(before + 1);
    // 走查 2026-10-08 文案去重后：已付款态是"已付款，无需再支付"（精确断言，不放宽）
    expect(page.data['closedText']).toBe('已付款，无需再支付');
    expect(page.data['payUrl']).toBe('');
  });

  it('🔴 下拉刷新 → 同样只查状态（不重取支付方式、不换掉短链）并收起下拉动画', async () => {
    await toCopylinkScreen();
    const channels = channelFetches();
    call('onPullDownRefresh');
    await settle();
    expect(stops).toBe(1);
    expect(channelFetches()).toBe(channels);
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
  });

  it('🔴 「查看订单」→ 去这一单的详情（不是订单列表）', async () => {
    call('onViewOrders');
    expect(redirects.at(-1)).toBe(`/pages/order-detail/index?id=${ORDER_ID}`);
  });
});

/** 剩余清单 4-8（M11 / M13）：没有可用通道的空态、错误态可重试。 */
describe('支付页：无通道空态与重试（4-8）', () => {
  it('🔴 所有币种都没有通道 → noChannel = true（页面给空态，不是一片空白）；有通道 → false', async () => {
    expect(page.data['noChannel']).toBe(false);
    noChannels = true;
    call('onRetry');
    await settle();
    expect(page.data['noChannel']).toBe(true);
    expect(page.data['channels']).toEqual([]);
  });

  it('🔴 取订单失败 → 显示错误；点"重试" → 重新拉取，成功后错误清掉、通道出现', async () => {
    failOrderFetch = true;
    call('onRetry');
    await settle();
    expect(page.data['error']).not.toBe('');
    failOrderFetch = false;
    call('onRetry');
    await settle();
    expect(page.data['error']).toBe('');
    expect((page.data['channels'] as unknown[]).length).toBeGreaterThan(0);
  });
});

/** 剩余清单 4-11（A24）：待付款倒计时。 */
describe('支付页：待付款倒计时（4-11）', () => {
  it('🔴 可付的单 → countdown 按本机时钟显示剩余时间；每秒更新；离开页面停表', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T01:20:00.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      expect(page.data['countdown']).toBe('请在 10 分 00 秒内完成支付');
      vi.advanceTimersByTime(1000);
      expect(page.data['countdown']).toBe('请在 9 分 59 秒内完成支付');
      call('onUnload');
      vi.advanceTimersByTime(5000);
      expect(page.data['countdown']).toBe('请在 9 分 59 秒内完成支付');
    } finally {
      vi.useRealTimers();
    }
  });

  it('已过截止 → 直接是关闭屏（"支付时间已到"、不列通道），且不起表（P2-35）', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T02:00:00.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      expect(page.data['closedText']).toContain('支付时间已到');
      expect(page.data['channels']).toEqual([]);
      expect(page.data['goHome']).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 扫描 W-01：复制链接去浏览器付款，回到前台走的是"只查状态"——倒计时也要接着走。 */
describe('支付页：回前台后倒计时继续（扫描 W-01）', () => {
  it('🔴 有短链时 onHide → onShow：倒计时重新开始，不停在离开那一秒', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T01:20:00.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      page.setData({ payUrl: 'https://pay.test/o/link-x' });
      call('onHide');
      vi.setSystemTime(new Date('2026-09-29T01:25:00.000Z'));
      vi.advanceTimersByTime(1000);
      call('onShow');
      await settle();
      expect(page.data['countdown']).toBe('请在 4 分 59 秒内完成支付');
      call('onUnload');
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 发起支付在途时切后台再回来：倒计时照样重启（onShowAction 为 none 时也不能停在离开那一秒）', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T01:20:00.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      page.setData({ paying: true }); // 发起支付还在等机构
      call('onHide');
      vi.setSystemTime(new Date('2026-09-29T01:25:00.000Z'));
      call('onShow');
      await settle();
      expect(page.data['countdown']).toBe('请在 5 分 00 秒内完成支付');
      vi.advanceTimersByTime(1000);
      expect(page.data['countdown']).toBe('请在 4 分 59 秒内完成支付');
      call('onUnload');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** P2-35：倒计时走到 0 时只改了文案，通道按钮还能点。 */
describe('支付页：倒计时到点即关闭（P2-35）', () => {
  it('🔴 页面开着时走到 0 → 收起通道、换关闭屏、重查订单；再点通道不发请求', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T01:29:58.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      expect(page.data['channels']).toHaveLength(1);
      const fetchesBefore = orderFetches();
      vi.advanceTimersByTime(2000);
      await settle();
      expect(page.data['closedText']).toContain('支付时间已到');
      expect(page.data['channels']).toEqual([]);
      expect(page.data['countdown']).toBe('');
      expect(orderFetches()).toBe(fetchesBefore + 1);
      const posts = requests.filter((r) => r.method === 'POST').length;
      tapChannel('stripe');
      await settle();
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(posts);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** P2-39：通道按订单的收货国家查，不写死默认国家。 */
describe('支付页：通道目的国取自订单地址（P2-39）', () => {
  it('🔴 订单寄往 CA → /pay/channels 带 country=CA', async () => {
    country = 'CA';
    call('onRetry');
    await settle();
    const urls = requests.filter((r) => r.url.includes('/pay/channels')).map((r) => r.url);
    expect(urls.at(-1)).toContain('country=CA');
  });
});

/** P2-40：发起支付被 40902 / 40904 拒 → 重查订单，已关 / 已付就换关闭屏。 */
describe('支付页：发起被拒后重查订单（P2-40）', () => {
  it('🔴 40902 且订单其实已付 → 关闭屏（不再挂着通道让人一直点）', async () => {
    postError = Object.assign(new Error('订单状态不允许此操作'), { code: 40902 });
    orderStatus = 'paid';
    tapChannel('stripe');
    await settle();
    expect(page.data['closedText']).toContain('无需再支付');
    expect(page.data['channels']).toEqual([]);
  });

  it('其它错误（50000）→ 只显示错误，不重查', async () => {
    postError = Object.assign(new Error('服务器内部错误'), { code: 50000 });
    const before = orderFetches();
    tapChannel('stripe');
    await settle();
    expect(page.data['error']).not.toBe('');
    expect(orderFetches()).toBe(before);
    // 规律排查 2026-10-12：页面已经打开，错误块标题却写"支付页没能打开"
    expect(page.data['errorTitle']).toBe('没能发起支付');
  });
});

// 联动走查·跨角色（2026-10-10）：买家停在支付页时被运营拉黑——拉黑会立即取消未付款订单，
// 但支付页仍挂着倒计时与支付按钮，点了报"账号已被限制使用"、按钮却是「重试」，永远不会成功。
describe('账号被拉黑（40301）：支付页换成关闭屏 + 联系客服', () => {
  /**
   * ⚠️ 规律排查 2026-10-12：40301 **不止一种成因**，夹具原先只给码、不给 `data.reason`——
   * 等于把"被拉黑"当成这个码的唯一样子（规律⑪：测试数据只覆盖主状态）。
   * 下面另有一条用例钉"成因是源站校验失败"的那一侧。
   */
  const forbidden = (reason: string) =>
    Object.assign(new Error('无权限'), { code: 40301, data: { reason } });
  const blocked = () => forbidden('blocked');

  it('🔴 发起支付回 40301 → 收起支付方式与倒计时，说明原因，给「联系客服」；点它去「我的」', async () => {
    expect(page.data['channels']).toHaveLength(1);
    postError = blocked();
    tapChannel('stripe');
    await settle();
    expect(page.data['channels']).toEqual([]);
    expect(page.data['countdown']).toBe('');
    expect(page.data['closedText']).toBe(
      '账号已被限制使用，这笔订单无法支付（没有扣款）；如有疑问请联系客服',
    );
    expect(page.data['contactSupport']).toBe(true);
    expect(page.data['error']).toBe('');
    call('onContact');
    expect(tabs).toEqual(['/pages/user/index']);
  });

  it('🔴 进页取订单就回 40301 → 直接是同一个关闭屏（不显示"重试"）', async () => {
    orderFetchError = blocked();
    call('onLoad', { orderId: ORDER_ID });
    await settle();
    expect(page.data['closedText']).toBe(
      '账号已被限制使用，这笔订单无法支付（没有扣款）；如有疑问请联系客服',
    );
    expect(page.data['contactSupport']).toBe(true);
    expect(page.data['error']).toBe('');
    expect(page.data['channels']).toEqual([]);
  });

  // 严格检查（2026-10-10）：只在点击后立刻断言，漏了"倒计时还在走"——1 秒后倒计时写回关闭屏，到点又被换成"去首页重新下单"
  it('🔴 拉黑关闭屏之后倒计时停表：过 1 秒不写回倒计时，到截止也不换成"支付时间已到"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T01:20:00.000Z'));
      expiresAt = '2026-09-29T01:30:00.000Z';
      call('onRetry');
      await settle();
      expect(page.data['countdown']).toBe('请在 10 分 00 秒内完成支付');
      postError = blocked();
      tapChannel('stripe');
      await settle();
      vi.advanceTimersByTime(1000);
      expect(page.data['countdown']).toBe('');
      vi.advanceTimersByTime(11 * 60_000);
      expect(page.data['closedText']).toBe(
        '账号已被限制使用，这笔订单无法支付（没有扣款）；如有疑问请联系客服',
      );
      expect(page.data['contactSupport']).toBe(true);
      expect(page.data['goHome']).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('其它支付错误不受影响：仍是错误提示 + 支付方式还在', async () => {
    postError = Object.assign(new Error('服务器内部错误'), { code: 50000 });
    tapChannel('stripe');
    await settle();
    expect(page.data['contactSupport']).toBe(false);
    expect(page.data['channels']).toHaveLength(1);
  });

  /**
   * 规律排查（本轮）：40301 的另一个买家可达成因是**源站校验失败**（`server/src/http.ts` 的
   * `origin_not_verified`，只接受经 Cloudflare 的流量）。那是基础设施故障，不是"你的账号被限制"——
   * 原先 `pay/index.js` 两处都读 `contactFields(e).errorContact`，而 `contactFields` 按码判，
   * 于是 CF 头注入一坏，**全体买家**在支付页都看到"账号已被限制使用、这笔订单无法支付"，
   * 而订单其实是好的（规律①：修一处不扫同类）。
   */
  it('🔴 40301 但成因是源站校验失败 → 不换关闭屏、不说账号被限制（支付方式还在）', async () => {
    postError = forbidden('origin_not_verified');
    tapChannel('stripe');
    await settle();
    expect(page.data['contactSupport']).toBe(false);
    expect(String(page.data['closedText'])).not.toContain('账号已被限制');
    expect(page.data['channels']).toHaveLength(1);
  });
});

describe('链接里没有订单 id（F11，第二轮审计 2026-10-11）', () => {
  it('🔴 不发请求；错误态按钮去订单列表，而不是拿空 id 去请求（会撞上订单列表接口）', async () => {
    await settle(); // beforeEach 已用订单号打开过一次：等它收尾再清账
    requests = [];
    call('onLoad', {});
    await settle();
    expect(requests).toEqual([]);
    expect(page.data['noOrderId']).toBe(true);
    expect(String(page.data['error'])).toContain('订单');
    call('onRetry');
    await settle();
    expect(requests).toEqual([]);
    expect(tabs).toEqual(['/pages/order/index']);
  });
});

// 全入口点击测试 2026-10-11：订单号不存在 / 不是本人的（40400）时，原先显示"请求的资源不存在"+ 错误码 + 「重试」——
// 重试一万次也一样；底下的「查看订单」又进同一张不存在的单。改为：说人话、按钮去订单列表、不出错误码、不给死路按钮
describe('订单不存在（40400）', () => {
  it('🔴 说"没找到这张订单"、不出错误码；按钮去订单列表；底部「查看订单」不出现', async () => {
    await settle();
    orderFetchError = Object.assign(new Error('请求的资源不存在'), { code: 40400 });
    call('onLoad', { orderId: 'ord-nope' });
    await settle();
    expect(page.data['noOrderId']).toBe(true);
    expect(String(page.data['error'])).toContain('链接可能已失效');
    expect(page.data['errorRef']).toBe('');
    call('onRetry');
    await settle();
    expect(tabs).toEqual(['/pages/order/index']);
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toMatch(/<view class="ws-gutter ws-section cta" wx:if="\{\{!noOrderId\}\}">/);
    expect(wxml).toMatch(/<ws-state-block\s+wx:if="\{\{error\}\}"/);
  });
});

describe('从订单详情进来的支付：付完退回原详情（MP-10，第二轮审计 2026-10-11）', () => {
  const gd = (): Record<string, unknown> =>
    (globalThis as unknown as { getApp: () => { globalData: Record<string, unknown> } }).getApp()
      .globalData;

  it('🔴 微信支付成功 → navigateBack 回原来那张详情（不再 redirectTo 出第二张），并交回"刚付过"', async () => {
    call('onLoad', { orderId: ORDER_ID, from: 'detail' });
    await settle();
    postPlan = 'in_app';
    tapChannel('wechat');
    await settle();
    expect(backs).toBe(1);
    expect(redirects).toEqual([]);
    expect(gd()['paidReturn']).toEqual({ orderId: ORDER_ID, justPaid: true });
  });

  it('审核期 auto 从详情来 → 同样退回（不是"刚付过"：响应到达时服务端已确认）', async () => {
    call('onLoad', { orderId: ORDER_ID, from: 'detail' });
    await settle();
    postPlan = 'auto';
    tapChannel('mock');
    await settle();
    expect(backs).toBe(1);
    expect(redirects).toEqual([]);
    expect(gd()['paidReturn']).toEqual({ orderId: ORDER_ID, justPaid: false });
  });

  it('🔴 不是从详情来的（结算页 redirect 进来）→ 照旧 redirectTo 详情并带 justPaid=1', async () => {
    postPlan = 'in_app';
    tapChannel('wechat');
    await settle();
    expect(backs).toBe(0);
    expect(redirects).toEqual([`/pages/order-detail/index?id=${ORDER_ID}&justPaid=1`]);
  });
});

describe('点了支付方式后那个按钮显示加载中（MP-4，第二轮审计 2026-10-11）', () => {
  it('🔴 发起在途 → 被点的通道 payingChannel 有值；回来后清空', async () => {
    let release: (v: unknown) => void = () => undefined;
    postHold = { promise: new Promise((r) => (release = r)), resolve: (v) => release(v) };
    tapChannel('stripe');
    await settle();
    expect(page.data['paying']).toBe(true);
    expect(page.data['payingChannel']).toBe('stripe');
    postHold.resolve(undefined);
    postHold = null;
    await settle();
    expect(page.data['paying']).toBe(false);
    expect(page.data['payingChannel']).toBe('');
  });
});
