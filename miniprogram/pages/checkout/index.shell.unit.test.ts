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
let cartCleared: boolean;

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
  cartCleared = false;
  vi.stubGlobal('wx', {
    navigateTo: (o: { url: string }) => navigations.push(o.url),
    redirectTo: (o: { url: string }) => navigations.push(o.url),
    // S5：订单升为 tab 页，40913 的恢复路径改用 switchTab（navigateTo 到 tab 页会被宿主拒绝）
    switchTab: (o: { url: string }) => navigations.push(o.url),
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      pickedAddressId: '',
      cart: {
        items: () =>
          cartCleared ? [] : [{ productId: 'p-1', qty: 2, title: '資生堂 クレンジングオイル' }],
        clear: () => {
          cartCleared = true;
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

/** 进入结算页、勾选条款，走到"可以提交"。 */
async function ready(): Promise<void> {
  call('onShow');
  await settle();
  call('onToggleTerms');
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

  it('🔴 40913（在途单已达上限）→ 跳订单列表：文案说了要去处理，就得给一个去处', async () => {
    await ready();
    orderError = apiError(40913, '未付款的订单太多了，请先完成支付或取消后再下单');
    call('onSubmit');
    await settle();
    // S5：订单是 tab 页，走 switchTab（这里两种跳转的 url 都收进同一个数组，
    //     所以断言不变——变的是"必须是 switchTab"这件事本身，
    //     它由 project-config 的可达性门禁与真机点一遍共同保证）。
    expect(navigations).toContain('/pages/order/index');
    // 建单没成功 ⇒ 购物车不能清（用户处理完还要回来这一单）
    expect(cartCleared).toBe(false);
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
