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

const ORDER_ID = 'o-1';

function order() {
  return {
    id: ORDER_ID,
    status: orderStatus,
    total_jpy: 12_000,
    display: { USD: 8_040 },
    created_at: '2026-09-29T01:00:00.000Z',
    expires_at: '2026-09-29T01:30:00.000Z',
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
  vi.stubGlobal('wx', {
    setClipboardData: (o: { data: string; success?: () => void }) => {
      clipboard.push(o.data);
      o.success?.();
    },
    redirectTo: (o: { url: string }) => {
      redirects.push(o.url);
    },
    navigateTo: () => undefined,
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

  it('重查两次仍未确认 → 不再显示确认中（不让页面永远停在"确认中"）', async () => {
    await toCopylinkScreen();
    vi.useFakeTimers();
    call('onShow');
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    await settle();
    expect(page.data['confirmNote']).toBe('');
    expect(page.data['payUrl']).toBe('https://pay.test/o/link-1');
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
      call('onRetry');
      await settle();
      expect(page.data['countdown']).toBe('请在 10:00 内完成支付');
      vi.advanceTimersByTime(1000);
      expect(page.data['countdown']).toBe('请在 09:59 内完成支付');
      call('onUnload');
      vi.advanceTimersByTime(5000);
      expect(page.data['countdown']).toBe('请在 09:59 内完成支付');
    } finally {
      vi.useRealTimers();
    }
  });

  it('已过截止 → 显示"支付时间已到"，且不起表', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T02:00:00.000Z'));
      call('onRetry');
      await settle();
      expect(page.data['countdown']).toContain('支付时间已到');
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
      call('onRetry');
      await settle();
      page.setData({ payUrl: 'https://pay.test/o/link-x' });
      call('onHide');
      vi.setSystemTime(new Date('2026-09-29T01:25:00.000Z'));
      vi.advanceTimersByTime(1000);
      call('onShow');
      await settle();
      expect(page.data['countdown']).toBe('请在 04:59 内完成支付');
      call('onUnload');
    } finally {
      vi.useRealTimers();
    }
  });
});
