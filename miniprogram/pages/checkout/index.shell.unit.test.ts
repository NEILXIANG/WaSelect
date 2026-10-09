/**
 * 职责：结算页薄壳的**行为**用例——幂等键跟着"请求内容"走、闸门在每个时刻都完整、失败时说人话（AJ-228）。
 *
 * @why 结算页是全站唯一会**建出订单并扣库存**的页面，而它的关键逻辑全在薄壳里：
 *      ① A5（AJ-190）让"失败后再点"沿用同一个幂等键，但键只在"成功"与"选了新地址"时作废。
 *         超时后用户改了邮箱、或切后台回来重报价金额变了，再点就是**同键不同内容** ⇒ 40908，
 *         且此后这一页每次再点都是 40908，只能退出重进（而退出重进又会建出第二张单）。
 *      ② `refresh()` 另算了一遍闸门，漏了"超过单笔上限"与"邮箱填错"两项 ⇒ 每次 onShow 都有一段
 *         窗口按钮可点，点下去必然 40906 / 邮箱被静默丢掉。
 *      ③ 条款版本没取到时闸门照样放行 ⇒ 用户看到的是 vm 里一句给开发者看的报错；
 *         报价失败时闸门永远说"还在计算中"，没有出路。
 *      这些都不在任何纯函数里，只有把页面跑起来才测得到。
 *
 * @see ../../../test/helpers/mp-page.ts；./index.js；./index.vm.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

interface Req {
  url: string;
  method?: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}

const ADDR = {
  id: 'addr-1',
  recipient: 'Alice Wang',
  phone: '+14155550123',
  line1: '1 Market St',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94105',
  is_default: true,
};

let page: LoadedPage;
let posts: Req[];
let quote: Record<string, unknown>;
let termsFail: boolean;
let quoteFail: boolean;
/** 建单接口的下一次行为：抛这个错；为 null 则成功。 */
let orderError: (Error & { code?: number }) | null;
/** 非空 = 把 `POST /orders/quote` 挂起（用来观察"重报价在途"这一瞬间的闸门）。 */
let quoteHold: ReturnType<typeof deferred<unknown>> | null;
/** 非空 = 把 `POST /orders` 挂起（用来观察"建单在途"这一瞬间的页面）。 */
let orderHold: ReturnType<typeof deferred<unknown>> | null;
let navigations: string[];
/** 剩余清单 4-8：单独记 redirectTo（结算 → 支付必须"替换"本页，不留空结算页在返回栈里）。 */
let redirects: string[];
let switches: string[];
interface Modal {
  content?: string;
  success?: (r: { confirm?: boolean; cancel?: boolean }) => void;
}
let modals: Modal[];
let cartCleared: boolean;
/** A3：建单成功后从购物车移除的那几件。 */
let removedIds: string[] | null;
/**
 * M-16（AJ-406）：`GET /pay/channels` 的替身——按 currency 返回通道（只声明 USD 的银行卡，与生产 stripe 同形）。
 * `channelFail` 为 true 时抛错（预告必须静默消失，不顶错误条）。
 */
let channelsByCurrency: Record<string, unknown[]>;
let channelFail: boolean;
let channelUrls: string[];
/** 本地存储替身（A5：记住联系邮箱）。 */
let stored: Record<string, string>;

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};
const gate = (): { ok: boolean; reason: string } =>
  page.data['gate'] as { ok: boolean; reason: string };
const apiError = (code: number, message: string): Error & { code: number } =>
  Object.assign(new Error(message), { code });
/** 网络层失败（超时 / 断网）：结果未知——服务端可能已经建单。 */
const networkError = (): Error & { code: number } => apiError(-1, 'request:fail timeout');

beforeEach(async () => {
  posts = [];
  quote = { items_jpy: 8000, shipping_jpy: 1150, total_jpy: 9150, split_hint: false };
  termsFail = false;
  quoteFail = false;
  orderError = null;
  quoteHold = null;
  orderHold = null;
  navigations = [];
  redirects = [];
  switches = [];
  modals = [];
  cartCleared = false;
  removedIds = null;
  channelsByCurrency = {
    JPY: [],
    USD: [{ channel: 'stripe', label: '银行卡', entryMode: 'copylink' }],
  };
  channelFail = false;
  channelUrls = [];
  stored = {};
  vi.stubGlobal('wx', {
    navigateTo: (o: { url: string }) => navigations.push(o.url),
    redirectTo: (o: { url: string }) => {
      navigations.push(o.url);
      redirects.push(o.url);
    },
    showModal: (o: Modal) => modals.push(o),
    // S5：订单升为 tab 页，40913 的恢复路径改用 switchTab（navigateTo 到 tab 页会被宿主拒绝）
    switchTab: (o: { url: string }) => {
      navigations.push(o.url);
      switches.push(o.url);
    },
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      pickedAddressId: '',
      storage: {
        getString: (k: string, fallback = '') => stored[k] ?? fallback,
        setString: (k: string, v: string) => {
          stored[k] = v;
        },
      },
      cart: {
        items: () =>
          cartCleared ? [] : [{ productId: 'p-1', qty: 2, title: '資生堂 クレンジングオイル' }],
        // A3（AJ-416）：建单成功后只移除买走的那几件；车里只有 p-1，移除它 = 车空了
        removeMany: (ids: string[]) => {
          removedIds = ids;
          if (ids.includes('p-1')) cartCleared = true;
        },
      },
      api: async (req: Req) => {
        if (req.url.endsWith('/terms')) {
          if (termsFail) throw apiError(50000, '服务器内部错误');
          return { version: 'TOS-TEST-1' };
        }
        if (req.url.endsWith('/addresses')) return [ADDR];
        if (req.url.endsWith('/orders/quote')) {
          if (quoteFail) throw apiError(40401, '商品不存在或已下架');
          if (quoteHold !== null) return quoteHold.promise;
          return quote;
        }
        if (req.url.includes('/pay/channels')) {
          channelUrls.push(req.url);
          if (channelFail) throw apiError(50000, '服务器内部错误');
          const cur = new URL(req.url).searchParams.get('currency') ?? '';
          return { items: channelsByCurrency[cur] ?? [] };
        }
        posts.push(req);
        if (orderHold !== null) return orderHold.promise;
        if (orderError !== null) throw orderError;
        return { order_id: 'o-1' };
      },
    },
  });
  call('onLoad');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 进入结算页、勾选条款、填联系邮箱，走到"可以提交"。
 * M-01（AJ-405）：邮箱改为前端必填后，原先"只勾条款就可提交"的前提不再成立——补上填邮箱这一步（不是放宽断言）。
 */
async function ready(): Promise<void> {
  call('onShow');
  await settle();
  call('onToggleTerms');
  call('onEmailInput', { detail: { value: 'buyer@example.com' } });
  expect(gate()).toEqual({ ok: true, reason: '' });
}

describe('结算页薄壳：幂等键跟着请求内容走（AJ-228）', () => {
  it('超时后**原样**再点：同一个键（服务端重放，不建第二张单）——A5 原有行为', async () => {
    await ready();
    orderError = networkError();
    call('onSubmit');
    await settle();
    orderError = null;
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey);
    expect(posts[1]!.data).toEqual(posts[0]!.data);
  });

  it('🔴 超时后改了邮箱再点：内容变了 ⇒ 换新键（否则是同键不同内容的 40908 死路）', async () => {
    await ready();
    orderError = networkError();
    call('onSubmit');
    await settle();
    call('onEmailInput', { detail: { value: 'alice@example.com' } });
    orderError = null;
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.data?.['contact_email']).toBe('alice@example.com');
    expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
  });

  it('🔴 超时后切后台回来、合计变了再点：同样换新键', async () => {
    await ready();
    orderError = networkError();
    call('onSubmit');
    await settle();
    quote = { ...quote, shipping_jpy: 1650, total_jpy: 9650 }; // 运费表被改了
    call('onShow');
    await settle();
    orderError = null;
    call('onSubmit');
    await settle();
    expect(posts[1]!.data?.['expected_total_jpy']).toBe(9650);
    expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
  });

  it('🔴 服务端回 40908：作废键，下一次点击用新键（不会卡死在这一页）', async () => {
    await ready();
    orderError = apiError(40908, '幂等键复用但请求内容不一致');
    call('onSubmit');
    await settle();
    orderError = null;
    call('onSubmit');
    await settle();
    expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
    expect(navigations.some((u) => u.includes('/pages/pay/index?orderId=o-1'))).toBe(true);
  });

  it('成功后清车、作废键、跳支付页', async () => {
    await ready();
    call('onSubmit');
    await settle();
    expect(cartCleared).toBe(true);
    expect(navigations).toEqual(['/pages/pay/index?orderId=o-1']);
  });
});

describe('结算页薄壳：联系邮箱必填（M-01）', () => {
  it('🔴 条款已勾、邮箱没填 → 闸门不放行，原因说明邮箱用途；点提交也发不出去', async () => {
    call('onShow');
    await settle();
    call('onToggleTerms');
    expect(gate().ok).toBe(false);
    expect(gate().reason).toContain('邮箱');
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(0);
  });

  it('🔴 填了又清空 → 输入框下给出原因、闸门重新关上', async () => {
    await ready();
    call('onEmailInput', { detail: { value: '  ' } });
    expect(gate().ok).toBe(false);
    expect(String(page.data['emailError'])).toContain('邮箱');
  });

  it('填好 → 建单请求带上 contact_email（去首尾空白）', async () => {
    await ready();
    call('onEmailInput', { detail: { value: ' jane@example.com ' } });
    call('onSubmit');
    await settle();
    expect(posts[0]!.data?.['contact_email']).toBe('jane@example.com');
  });

  it('🔴 再次 onShow 的那一瞬间（请求还没回来）闸门也不因邮箱为空而放行', async () => {
    call('onShow');
    await settle();
    call('onToggleTerms');
    call('onShow');
    expect(gate().ok).toBe(false);
    await settle();
    expect(gate().ok).toBe(false);
  });
});

describe('结算页薄壳：闸门在每个时刻都完整（AJ-228）', () => {
  it('🔴 已超单笔上限：再次 onShow 的那一瞬间闸门也不放行（refresh 不能另算一遍缺项的闸门）', async () => {
    quote = { ...quote, split_hint: true };
    call('onShow');
    await settle();
    call('onToggleTerms');
    expect(gate().ok).toBe(false);

    call('onShow'); // 同步部分跑完、请求还没回来的这一刻
    expect(gate().ok).toBe(false);
    await settle();
    expect(gate().ok).toBe(false);
  });

  it('🔴 邮箱填错：再次 onShow 的那一瞬间闸门也不放行', async () => {
    await ready();
    call('onEmailInput', { detail: { value: 'not-an-email' } });
    expect(gate().ok).toBe(false);
    call('onShow');
    expect(gate().ok).toBe(false);
    await settle();
  });

  it('🔴 条款版本没取到：闸门拦住并说明原因；不会把 vm 里给开发者看的报错摆到用户面前', async () => {
    termsFail = true;
    call('onShow');
    await settle();
    call('onToggleTerms');
    expect(gate().ok).toBe(false);
    // 说的是"取不到"（失败），不是"正在加载"——后者会让人一直等
    expect(gate().reason).toContain('取不到');
    expect(gate().reason).not.toContain('正在加载');
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(0);
    expect(String(page.data['error'])).not.toContain('orderBody');
    expect(String(page.data['error'])).not.toContain('terms_version');
  });

  it('🔴 报价失败：闸门说的是"报价失败、回购物车检查"，不是永远"还在计算中"', async () => {
    quoteFail = true;
    call('onShow');
    await settle();
    call('onToggleTerms');
    expect(gate().ok).toBe(false);
    expect(gate().reason).not.toContain('计算中');
    expect(gate().reason).toContain('购物车');
  });

  it('报价还没回来（不是失败）：仍然说"还在计算中"', () => {
    call('onShow'); // 不 settle：请求在途
    call('onToggleTerms');
    expect(gate().ok).toBe(false);
  });
});

describe('结算页：连点防线落在 ws-button（约束：页面不得手写守卫，AJ-74）', () => {
  it('提交按钮必须把 submitting 交给 ws-button 的 loading（只有 disabled 挡不住同一帧的第二次点击）', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    const tag = /<ws-button[^>]*bindtap="onSubmit"[^>]*\/>/s.exec(wxml)?.[0] ?? '';
    expect(tag, '自检：找到了提交按钮').not.toBe('');
    expect(tag).toContain('loading="{{submitting}}"');
  });
});

describe('结算页薄壳：重报价窗口与两个跳转（MP3-05 / MP3-09 / MP3-10）', () => {
  it('🔴 40905 之后、新报价还没回来：闸门关闭，再点也发不出去（不能拿旧合计再吃一次 40905）', async () => {
    await ready();
    quoteHold = deferred();
    orderError = apiError(40905, '价格已变动');
    call('onSubmit');
    await settle();
    // 重报价在途的这一刻：quote 必须已经被置空，闸门落到"还在计算中"
    expect(gate().ok).toBe(false);
    expect(gate().reason).toContain('计算中');
    expect(page.data['quote']).toBeNull();
    // 旧合计还在时闸门是开的 ⇒ 再点一次就是同一个 40905（弱网下能循环好几轮）
    const before = posts.length;
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(before);

    quoteHold.resolve(quote);
    await settle();
    expect(gate().ok).toBe(true); // 新报价回来后才放行
  });

  // 统一结论 5.3：原先写完错误文案立刻 switchTab，结算页关掉、文案跟着没了——用户只看到被甩到订单页，不知道为什么
  it('🔴 40913（在途单已达上限）→ 先弹窗说清原因，点「去处理」才跳订单列表；购物车不清', async () => {
    await ready();
    orderError = apiError(40913, '未付款的订单太多了，请先完成支付或取消后再下单');
    call('onSubmit');
    await settle();
    expect(switches).toEqual([]); // 用户还没看到原因之前不跳
    expect(modals).toHaveLength(1);
    expect(modals[0]?.content).toContain('未付款的订单太多了');
    modals[0]?.success?.({ confirm: true });
    // S5：订单是 tab 页，走 switchTab
    expect(switches).toContain('/pages/order/index');
    // 建单没成功 ⇒ 购物车不能清（用户处理完还要回来这一单）
    expect(cartCleared).toBe(false);
  });

  it('🔴 40913 弹窗里选「留在本页」→ 不跳，页面内错误文案仍在', async () => {
    await ready();
    orderError = apiError(40913, '未付款的订单太多了，请先完成支付或取消后再下单');
    call('onSubmit');
    await settle();
    modals[0]?.success?.({ confirm: false, cancel: true });
    expect(switches).toEqual([]);
    expect(String(page.data['error'])).toContain('未付款的订单太多了');
  });

  it('🔴 建单在途时点「收货地址」/「查看条款全文」：不跳（支付页会压在地址页上面）', async () => {
    await ready();
    orderHold = deferred();
    call('onSubmit');
    await settle();
    call('onPickAddress');
    call('onOpenTerms');
    expect(navigations, '在途时不许离开这一页').toEqual([]);

    orderHold.resolve({ order_id: 'o-1' });
    await settle();
    expect(navigations).toContain('/pages/pay/index?orderId=o-1');
  });

  it('建单**不在**途时两个跳转照旧（不能把正常路径一起挡死）', async () => {
    await ready();
    call('onPickAddress');
    call('onOpenTerms');
    expect(navigations).toEqual(['/pages/address/index?pick=1', '/pages/legal/index']);
  });
});

/** 连点「提交订单」（W-03）：页面必须自己挡住第二次，不能只靠按钮组件的属性。 */
describe('结算页薄壳：连点提交（W-03）', () => {
  it('🔴 建单在途时再点一次 → 只发出一次 POST /orders', async () => {
    await ready();
    orderHold = deferred();
    call('onSubmit');
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(1);
    orderHold.resolve({ order_id: 'o-1' });
    await settle();
  });
});

/** 剩余清单 4-4：立即购买进结算页。 */
describe('结算页薄壳：立即购买（4-4）', () => {
  it('🔴 mode=buynow：报价 / 建单只带那一件；建单成功后**不**清购物车', async () => {
    // 重新以 buynow 模式进页：单件放在 globalData.buyNow（详情页"立即购买"写入）
    page = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: {
        apiBase: 'http://api.test',
        pickedAddressId: '',
        buyNow: { productId: 'p-now', qty: 1, title: '出刃包丁' },
        cart: {
          items: () => [{ productId: 'p-1', qty: 2, title: '購物車里的別的東西' }],
          removeMany: () => {
            cartCleared = true;
          },
        },
        api: async (req: Req) => {
          if (req.url.endsWith('/terms')) return { version: 'TOS-TEST-1' };
          if (req.url.endsWith('/addresses')) return [ADDR];
          if (req.url.endsWith('/orders/quote')) {
            posts.push(req);
            return quote;
          }
          posts.push(req);
          return { order_id: 'o-now' };
        },
      },
    });
    call('onLoad', { mode: 'buynow' });
    await ready();
    call('onSubmit');
    await settle();
    const quoteReq = posts.find((p) => p.url.endsWith('/orders/quote'));
    expect(quoteReq?.data?.['items']).toEqual([{ product_id: 'p-now', qty: 1 }]);
    const orderReq = posts.find((p) => p.url.endsWith('/orders'));
    expect(orderReq?.data?.['items']).toEqual([{ product_id: 'p-now', qty: 1 }]);
    expect(cartCleared).toBe(false);
    expect(navigations).toEqual(['/pages/pay/index?orderId=o-now']);
  });
});

/** 剩余清单 4-8（M11 / M13）：结算 → 支付不留空页；空态"去逛逛"。 */
describe('结算页：不留空页与空态出口（4-8）', () => {
  it('🔴 建单成功 → redirectTo 支付页（返回键不会回到一个已经清空的结算页）', async () => {
    await ready();
    call('onSubmit');
    await settle();
    expect(redirects).toEqual(['/pages/pay/index?orderId=o-1']);
  });

  it('🔴 空态点"去逛逛" → switchTab 首页', () => {
    call('onGoShopping');
    expect(switches).toEqual(['/pages/home/index']);
  });
});

describe('结算页：缺货退款说明（4-10）', () => {
  it('🔴 data 里带说明（与订单详情同一句，付款前就让用户知道）', () => {
    expect(String(page.data['stockRefundNote'])).toContain('全额退款');
  });
});

describe('结算页：立即购买单件丢失时的空态文案（扫描附记）', () => {
  it('buynow 模式 → 不说"购物车是空的"；普通模式 → 说"购物车是空的"', () => {
    expect(page.data['emptyText']).toBe('购物车是空的');
    call('onLoad', { mode: 'buynow' });
    expect(String(page.data['emptyText'])).toContain('立即购买');
  });
});

describe('结算页薄壳：页面已销毁时不再跳转（P2-36）', () => {
  it('🔴 建单在途时用户按了返回（onUnload）→ 结果回来**不** redirectTo 支付页，但购物车照样清', async () => {
    await ready();
    orderHold = deferred<unknown>();
    call('onSubmit');
    await settle();
    call('onUnload');
    orderHold.resolve({ order_id: 'o-1' });
    await settle();
    expect(redirects).toEqual([]);
    // 订单已经建出来了：不清车的话用户回到购物车会再下一单
    expect(cartCleared).toBe(true);
  });

  it('页面还在 → 照常 redirectTo 支付页', async () => {
    await ready();
    call('onSubmit');
    await settle();
    expect(redirects).toEqual(['/pages/pay/index?orderId=o-1']);
  });
});

describe('M-16 扣款币种预告（AJ-406）', () => {
  it('🔴 银行卡只在 USD 下列出 → 报价区下出现"约 $X（以支付页为准）"，金额取报价 display.USD', async () => {
    quote = { ...quote, display: { USD: 6_100, CNY: 44_000 } };
    call('onShow');
    await settle();
    expect(page.data['chargePreview']).toEqual(['银行卡将以美元扣款，约 $61.00（以支付页为准）']);
    // 与支付页同一组查询：按地址国家 + 报价合计，逐币种查
    expect(channelUrls).toEqual([
      'http://api.test/api/v1/pay/channels?country=US&currency=JPY&amount_jpy=9150',
      'http://api.test/api/v1/pay/channels?country=US&currency=USD&amount_jpy=9150',
    ]);
  });

  it('报价缺 display（汇率缺失）→ 只说币种，金额指向支付页（不编数字）', async () => {
    call('onShow');
    await settle();
    expect(page.data['chargePreview']).toEqual(['银行卡将以美元扣款，金额以支付页为准']);
  });

  it('通道查询失败 → 预告静默消失，不顶错误条、不影响提交闸门', async () => {
    channelFail = true;
    await ready();
    expect(page.data['chargePreview']).toEqual([]);
    expect(page.data['error']).toBe('');
  });

  it('报价失败 → 不查通道、不显示预告', async () => {
    quoteFail = true;
    call('onShow');
    await settle();
    expect(channelUrls).toEqual([]);
    expect(page.data['chargePreview']).toEqual([]);
  });
});

describe('结算页：两次并发报价，旧的后到（审查 2026-10-09）', () => {
  it('🔴 改价前发出的报价后到，不许把新合计盖回旧值', async () => {
    call('onShow');
    await settle();
    const first = deferred<unknown>();
    quoteHold = first;
    call('onShow'); // 第一次刷新：报价挂起（旧价）
    await settle();
    quoteHold = null;
    quote = { ...quote, shipping_jpy: 1650, total_jpy: 9650 }; // 店家改了运费
    call('onShow'); // 第二次刷新：立刻拿到新价
    await settle();
    expect((page.data['quote'] as { totalJpy: number }).totalJpy).toBe(9650);
    first.resolve({ items_jpy: 8000, shipping_jpy: 1150, total_jpy: 9150, split_hint: false });
    await settle();
    expect((page.data['quote'] as { totalJpy: number }).totalJpy).toBe(9650);
  });
});

describe('结算页薄壳：记住联系邮箱（A5，AJ-416）', () => {
  it('🔴 下单成功后记下这次用的邮箱；再进结算页自动填上（不用每次重输）', async () => {
    await ready();
    call('onSubmit');
    await settle();
    expect(stored['checkout_email']).toBe('buyer@example.com');
    // 新的一次结算：onLoad 读回
    page.setData({ email: '' });
    call('onLoad');
    expect(page.data['email']).toBe('buyer@example.com');
  });

  it('下单失败不记（填错的邮箱不该被"记住"成下次的默认）', async () => {
    await ready();
    orderError = apiError(40905, '价格已变化');
    call('onSubmit');
    await settle();
    expect(stored['checkout_email']).toBeUndefined();
  });
});

describe('结算页模板：条款勾选看得出是个勾选框（A5，AJ-416）', () => {
  it('🔴 未勾选时也有框（☐），勾上是 ☑——原先未勾选只有一行字，看不出能点', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toContain(
      "{{termsAccepted ? '☑ 我已阅读并同意购买条款' : '☐ 我已阅读并同意购买条款'}}",
    );
  });
});

describe('结算页薄壳：只移除买走的（A3，AJ-416）', () => {
  it('🔴 建单成功后按这次结算的商品 id 移除（没勾的留在购物车里），不是整车清空', async () => {
    await ready();
    call('onSubmit');
    await settle();
    expect(removedIds).toEqual(['p-1']);
  });
});
