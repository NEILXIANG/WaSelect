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
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

interface Req {
  url: string;
  method?: string;
  data?: unknown;
}

let page: LoadedPage;
let requests: Req[];
/** 订单当前状态（用例里改它来模拟"去浏览器付完了"）。 */
let orderStatus: string;
/** 发起支付时下发的短链序号（每次发起都换一条，与服务端轮换 token 同形）。 */
let linkSeq: number;
let failOrderFetch: boolean;
let clipboard: string[];

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
  linkSeq = 0;
  failOrderFetch = false;
  clipboard = [];
  vi.stubGlobal('wx', {
    setClipboardData: (o: { data: string; success?: () => void }) => {
      clipboard.push(o.data);
      o.success?.();
    },
    redirectTo: () => undefined,
    navigateTo: () => undefined,
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: Req) => {
        requests.push(req);
        if (req.url.includes('/pay/channels')) {
          return req.url.includes('currency=USD')
            ? { items: [{ channel: 'stripe', entryMode: 'copylink', label: '银行卡' }] }
            : { items: [] };
        }
        if (req.method === 'POST') {
          linkSeq += 1;
          return { payload: { pay_url: `https://pay.test/o/link-${String(linkSeq)}` } };
        }
        if (failOrderFetch) throw new Error('network down');
        return order();
      },
    },
  });
  call('onLoad', { orderId: ORDER_ID });
  await settle();
});

afterEach(() => {
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
