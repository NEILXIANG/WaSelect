/**
 * 职责：`admin-web/src/orders/api.ts` 的单测（假 fetch 注入，不碰真实网络）。
 *
 * @why 钉的是"契约漂移 / 打错接口"在接口层硬失败：
 *      ① 200 但形状不对 → 必须抛（否则整列空白却不报错，客服以为"这单没金额"）；
 *      ② 缺 total → 分页判断不了"到底了没有"；
 *      ③ 路径 / method 错了 → 打到别的接口，UI 上只看到"点了没反应"；
 *      ④ 请求体键名错了（trackingNo vs tracking_no）→ 服务端 40001，运营不知道自己填错了什么。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../api/client.js';
import { NETWORK_ERROR_CODE } from '../api/errors.js';
import { getOrder, listOrders, refundOrder, shipOrder, updateOrderAddress } from './api.js';

/** 造一个假 fetch：记录每一次请求，返回预定响应。 */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    seen.push({ url: u, init: i });
    return handler(u, i);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const json = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as Response;

const api = (fetchImpl: typeof fetch) =>
  createAdminApi({ baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl });

const ORDER = { order_id: 'o-2609-0013', order_no: 'WS-20260927-0013', status: 'paid' };

describe('listOrders', () => {
  it('拼出 status/keyword/page/size，并原样返回 items', async () => {
    const { impl, seen } = stubFetch(() => json({ items: [ORDER], total: 1 }));
    const res = await listOrders(api(impl), {
      status: 'paid',
      keyword: 'WS-20260927',
      page: 2,
      size: 20,
    });
    expect(seen[0]?.url).toBe(
      'http://localhost:3000/api/v1/admin/orders?status=paid&keyword=WS-20260927&page=2&size=20',
    );
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
  });

  it('⚠️ 空 keyword 不进 query（带空值会让服务端去匹配空串，筛出 0 条）', async () => {
    const { impl, seen } = stubFetch(() => json({ items: [], total: 0 }));
    await listOrders(api(impl), { keyword: '' });
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/orders');
  });

  it('无参数时不带 query', async () => {
    const { impl, seen } = stubFetch(() => json({ items: [], total: 0 }));
    await listOrders(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/orders');
  });

  it('⚠️ items 不是数组 → 抛形状错（不是静默当空列表）', async () => {
    const { impl } = stubFetch(() => json({ items: 'oops', total: 0 }));
    await expect(listOrders(api(impl))).rejects.toThrow(/形状与契约不符/);
  });

  it('⚠️ 缺 total → 抛（分页判断不了"到底了没有"，会一直翻页）', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listOrders(api(impl))).rejects.toThrow(/缺 total/);
  });

  it('⚠️ 元素缺 order_id → 抛（没 id 的行点了会打到 /admin/orders/undefined）', async () => {
    const { impl } = stubFetch(() => json({ items: [{ order_no: 'WS-1' }], total: 1 }));
    await expect(listOrders(api(impl))).rejects.toThrow(/形状与契约不符/);
  });

  it('形状错带 NETWORK_ERROR_CODE（与"业务失败"区分开）', async () => {
    const { impl } = stubFetch(() => json({ items: null, total: 0 }));
    await expect(listOrders(api(impl))).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });
  });
});

describe('getOrder', () => {
  it('GET 单条路径，id 被 encode', async () => {
    const { impl, seen } = stubFetch(() => json({ ...ORDER, has_dispute: false }));
    const res = await getOrder(api(impl), 'o 1/x');
    expect(seen[0]?.url).toContain('/api/v1/admin/orders/o%201%2Fx');
    expect(seen[0]?.init.method).toBe('GET');
    expect(res.order_id).toBe('o-2609-0013');
  });

  it('⚠️ 缺 order_id → 抛（详情页面会整体空白，而以为是"这单不存在"）', async () => {
    const { impl } = stubFetch(() => json({ order_no: 'WS-1' }));
    await expect(getOrder(api(impl), 'o-1')).rejects.toThrow(/缺 order_id/);
  });
});

describe('shipOrder', () => {
  it('POST 到 /ship，键名是服务端的 tracking_no', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await shipOrder(api(impl), 'o-2609-0013', {
      carrier: 'Japan Post',
      tracking_no: 'EL123456789JP',
    });
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/orders/o-2609-0013/ship');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      carrier: 'Japan Post',
      tracking_no: 'EL123456789JP',
    });
  });

  it('服务端的 409（已发货）原样抛出，不被当成网络错', async () => {
    const { impl } = stubFetch(() => json({ code: 40903, message: '订单状态不允许发货' }, 409));
    await expect(
      shipOrder(api(impl), 'o-1', { carrier: 'c', tracking_no: 't' }),
    ).rejects.toMatchObject({ code: 40903 });
  });
});

describe('refundOrder', () => {
  it('POST 到 /refund，body 只有 reason', async () => {
    const { impl, seen } = stubFetch(() => json({}, 202));
    await refundOrder(api(impl), 'o-2609-0013', { reason: '缺货，整单退款' });
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/orders/o-2609-0013/refund');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ reason: '缺货，整单退款' });
  });

  it('⚠️ 202 也当作成功（契约的退款就是 202；只有 2xx 判定会把它当失败）', async () => {
    const { impl } = stubFetch(() => json({}, 202));
    await expect(refundOrder(api(impl), 'o-1', { reason: 'x' })).resolves.toBe('unknown');
  });

  /**
   * B41 / AJ-215：`outcome` 必须被读出来。
   * @why 此前 `refundOrder` 返回 `void`，于是 `pending`（机构处理中）在界面上
   *      **没有任何提示**——运营看到订单停在"退款中"、提示语又写着"失败可重试"，
   *      会转去 Stripe 后台手工退同一笔（AJ-178 反向风险①：同一笔钱退两次）。
   */
  describe('outcome（B41 / AJ-215）', () => {
    it('🔴 succeeded → 钱已退（界面可以说"已完成"）', async () => {
      const { impl } = stubFetch(() => json({ order_id: 'o-1', outcome: 'succeeded' }, 202));
      await expect(refundOrder(api(impl), 'o-1', { reason: 'x' })).resolves.toBe('succeeded');
    });

    it('🔴 pending → 机构处理中（**不是**失败：界面必须说出来，否则运营会去手工退）', async () => {
      const { impl } = stubFetch(() => json({ order_id: 'o-1', outcome: 'pending' }, 202));
      await expect(refundOrder(api(impl), 'o-1', { reason: 'x' })).resolves.toBe('pending');
    });

    it('⚠️ 认不出 → unknown，**不许猜成 pending**（那是在编造一个我们并不知道的事实）', async () => {
      const { impl } = stubFetch(() => json({ order_id: 'o-1', outcome: 'weird' }, 202));
      await expect(refundOrder(api(impl), 'o-1', { reason: 'x' })).resolves.toBe('unknown');
      const { impl: b } = stubFetch(() => json({}, 202));
      await expect(refundOrder(api(b), 'o-1', { reason: 'x' })).resolves.toBe('unknown');
    });
  });

  it('⚠️ 40907（拒付中）原样抛出：文案要能让运营知道去拒付列表处理', async () => {
    const { impl } = stubFetch(() => json({ code: 40907, message: '订单存在进行中的拒付' }, 409));
    await expect(refundOrder(api(impl), 'o-1', { reason: 'x' })).rejects.toMatchObject({
      code: 40907,
    });
  });
});

describe('updateOrderAddress', () => {
  it('POST 到 /address，原样透传 AddressInput', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    const body = {
      recipient: 'Emily Carter',
      phone: '+12065550123',
      line1: '500 Union St',
      line2: '',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      country: 'US',
    };
    await updateOrderAddress(api(impl), 'o-2609-0013', body);
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/orders/o-2609-0013/address');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(body);
  });
});
