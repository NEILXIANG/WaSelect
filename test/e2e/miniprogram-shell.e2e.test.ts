/**
 * 职责：小程序壳（F6c 客户端半边）的 L3 端到端测试——用**真服务端**验证 `miniprogram/utils/request.js`。
 *
 * @why `request.unit.test.ts` 注入的是假 `wx.request`，它只能证明"我们的 if 分支写对了"，
 *      证明不了**与真实服务端对齐**。下面这些是真实会发生、且单测一条也测不出来的：
 *        1. 服务端错误体到底叫 `code` 还是 `error.code`（取错 → 前端永远弹 undefined）；
 *        2. 微信把非 2xx 也交给 `success` 而不是 `fail`（写反 → 业务错误被当成网络错误）；
 *        3. `x-trace-id` 头是不是**真被服务端接受并沿用**（拼错一个字符就全程串不起来）；
 *        4. `idempotency-key` 由封装注入后，服务端是不是真的按它去重。
 *      这些全是"两端各自都对、接起来错"的类型，只有真跑一遍才会暴露。
 *
 * @why U6c 改写：骨架端点退役后，链路从"骨架演示单"改走**真实业务路径**——
 *      dev 登录 → 建地址 → 建单 → 发起支付（mock in_app）→ 模拟机构回调 → 读回订单。
 *      成本是要摆商品/运费 fixture，换来的是：客户端封装对齐的不再是"迟早要删的脚手架"，
 *      而是小程序上线第一天真的会走的那条链路。
 *
 * 假的部分只有两处：`wx.request` 这个宿主 HTTP 通道（见 `fake-wx-request.ts` 的边界说明），
 * 与支付机构本身（mock 通道 + 手工签名的模拟回调）。
 * 传输是真的：真端口、真 TCP、真 JSON 解析、真错误体。
 *
 * @see docs/地基搭建清单.md F6c；miniprogram/utils/request.js @limitation
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import { registerBusinessEventLog } from '../../server/src/app/business-events.js';
import { mountAllRoutes } from '../../server/src/app/mount.js';
import { createMemoryStorage } from '../../server/src/adapters/storage-memory.js';
import { PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { loadConfig } from '../../server/src/config.js';
import { createHttpApp, listen, type StartedServer } from '../../server/src/http.js';
import { createLogger } from '../../server/src/logger.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../db/test-db.js';
import { makeShippingRates } from '../factories/entities.js';
import { fakeWxRequest } from '../helpers/fake-wx-request.js';
import { MemorySink } from '../helpers/memory-sink.js';

// 被直接测的是小程序源码本身（js，非 ts）——allowJs 已开，v8 覆盖率也会统计到它
import { ApiError, NETWORK_ERROR_CODE, createRequester } from '../../miniprogram/utils/request.js';
import { createIntentIdempotency } from '../../miniprogram/utils/idempotency.js';
import { newTraceId } from '../../miniprogram/utils/trace.js';
import { createWxApi } from '../../miniprogram/utils/wx-api.js';

const JWT_SECRET = 'mp-shell-jwt-secret-'.repeat(3);
/** 模拟机构回调的 HMAC 密钥（装配处 mock 通道的 options.secret）。 */
const CALLBACK_SECRET = 'mp-shell-mock-callback-secret-2026-09-e2e';
const TERMS = 'TOS-TEST-1';

let db: Db;
let server: StartedServer;
let base = '';
let sink: MemorySink;

/** 请求层运行事件出口（`deps.log`：api_ok / api_failed …，只进实时日志）；用户行为五事件另走 /beacon（utils/beacon.js，M-21），不经这里。 */
let beacons: Array<Record<string, unknown>>;
let api: ReturnType<typeof createRequester>;
let token = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();

  // 与 order-routes.db.test 同一条装配路径：loadConfig + mountAllRoutes（生产形态的全量路由）。
  // WECHAT_DEV_LOGIN 让 dev 登录替身注册（仅 development/test 双保险，mount.ts @why）——
  // 本文件的"登录"走的就是小程序审核期与本地开发会走的那条 dev 登录路径。
  sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: CALLBACK_SECRET,
    TERMS_VERSION: TERMS,
    WECHAT_DEV_LOGIN: 'dev-',
  });
  const app = createHttpApp({
    logger,
    // 回调验签必须用原始字节（main.ts 同口径）：少配这一环 = 所有回调 50000 断链
    rawBodyPaths: [PAY_CALLBACK_PREFIX],
    mount: (a) => {
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() });
    },
  });
  server = await listen(app);
  base = `http://127.0.0.1:${server.port}`;

  beacons = [];
  api = createRequester({
    // 宿主能力注入走 F14 的封装层（`wx: createWxApi({ request })`），不再传单个 `request`
    wx: createWxApi({ request: fakeWxRequest }),
    getToken: () => token,
    // request.js 是 js（allowJs 未开 checkJs），回调参数无推断，这里显式标注
    log: (fields: unknown) => beacons.push(fields as Record<string, unknown>),
  });
}, 30_000);

afterAll(async () => {
  await server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  // 建单 fixture（与 order-routes.db.test 同一组事实：厨刀+茶杯、占位运费表、USD/CNY 汇率）
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active'),
           ('p-cup', 'Tea Cup', 'kitchen', 3200, 480, 10, 'JP', 'active')
  `;
  for (const s of makeShippingRates('placeholder')) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 hour'),
           ('CNY', 0.049, 0.048, 0.03, now() - interval '1 hour')
  `;
  beacons = [];
  token = '';
  sink.clear();
});

/** dev 登录（等价"微信扫码后换 token"）：dev 替身把 code 直接映射成 openid。 */
async function login(code: string, traceId?: string): Promise<void> {
  const r = (await api({
    url: `${base}/api/v1/auth/wechat/login`,
    method: 'POST',
    data: { code },
    ...(traceId !== undefined ? { traceId } : {}),
  })) as { token: string };
  token = r.token;
}

/** 建一张美国收货地址（业务端点，不走插库——客户端封装要对齐的是真路径）。 */
async function createAddress(traceId?: string): Promise<string> {
  const r = (await api({
    url: `${base}/api/v1/addresses`,
    method: 'POST',
    data: {
      recipient: 'Jane Doe',
      phone: '+14155550123',
      line1: '1 Infinite Loop',
      city: 'Cupertino',
      state: 'CA',
      postal_code: '95014',
      country: 'US',
      is_default: true,
    },
    ...(traceId !== undefined ? { traceId } : {}),
  })) as { id: string };
  return r.id;
}

/** 建单请求体（厨刀×1 + 茶杯×2，与 order-routes.db.test 同一组 fixture 事实）。 */
function orderBody(addressId: string): Record<string, unknown> {
  return {
    items: [
      { product_id: 'p-knife', qty: 1 },
      { product_id: 'p-cup', qty: 2 },
    ],
    address_id: addressId,
    terms_version: TERMS,
  };
}

async function createOrder(addressId: string, key: string, traceId?: string): Promise<string> {
  const r = (await api({
    url: `${base}/api/v1/orders`,
    method: 'POST',
    data: orderBody(addressId),
    idempotencyKey: key,
    ...(traceId !== undefined ? { traceId } : {}),
  })) as { order_id: string };
  return r.order_id;
}

/**
 * 模拟机构回调（不走客户端封装——这是机构→服务端的方向，不是小程序的动作）。
 * 带上同一条 trace_id：让"一次用户操作一条链"的日志断言不被这一跳打断。
 * provider_ref 从 payments 行读：它是发起支付时机构侧的会话号，客户端拿不到也不该拿。
 */
async function mockPayCallback(orderId: string, traceId: string): Promise<void> {
  const rows =
    await db`select provider_ref, charge_currency, charge_amount from payments where order_id = ${orderId}`;
  const p = rows[0];
  expect(p, '发起支付后 payments 行必须存在（否则回调无的放矢）').toBeDefined();
  const body = JSON.stringify({
    event_id: `evt-mp-${orderId}`,
    type: 'payment.succeeded',
    order_id: orderId,
    provider_ref: p?.provider_ref,
    currency: p?.charge_currency,
    amount_minor: Number(p?.charge_amount),
  });
  const res = await fetch(`${base}${PAY_CALLBACK_PREFIX}/mock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex'),
      'x-trace-id': traceId,
    },
    body,
  });
  expect(res.status).toBe(200);
}

describe('小程序壳 → 真服务端：一条业务链路走到底', () => {
  it('dev 登录 → 建地址 → 建单 → 发起支付 → 机构回调 → 读回已支付，全程共用客户端生成的同一个 trace_id', async () => {
    // 客户端生成 trace，后续每一跳都传它——这是"一次用户操作一条链"的落地方式
    const traceId = newTraceId();

    await login('alice', traceId);
    expect(token.length).toBeGreaterThan(0);

    const addressId = await createAddress(traceId);
    const orderId = await createOrder(addressId, 'mp-key-1', traceId);

    // 发起支付（mock in_app 通道）：payload 里的 `auto` 是审核期的自动确认信号
    // （契约 PaymentIntent payload 的 mock 形状，D-56——前端据此走"模拟支付成功"，不硬编码通道名）。
    // 本链路不开审核模式 → auto=false、服务端不自动确认，由下面的机构回调落账（AJ-179）
    const pay = (await api({
      url: `${base}/api/v1/orders/${orderId}/pay`,
      method: 'POST',
      data: { channel: 'mock' },
      idempotencyKey: 'mp-pay-1',
      traceId,
    })) as { channel: string; payload: { auto?: boolean } };
    expect(pay.channel).toBe('mock');
    expect(pay.payload.auto).toBe(false);

    await mockPayCallback(orderId, traceId);

    const got = (await api({
      url: `${base}/api/v1/orders/${orderId}`,
      traceId,
    })) as { status: string };
    expect(got.status).toBe('paid');

    // 服务端日志：每一跳都在同一条链上（客户端的 ID 直接出现在服务端日志里）。
    // 这是"客户端的头真被服务端接受"的证据——日志里的 trace_id 只能来自请求头
    const traced = sink.rows().filter((r) => r.trace_id !== undefined);
    expect(traced.length).toBeGreaterThan(0);
    expect([...new Set(traced.map((r) => String(r.trace_id)))]).toEqual([traceId]);

    // 流 C 用户行为埋点：登录/地址/建单/支付/读回五次成功各一条，且带同一个 trace_id
    const okBeacons = beacons.filter((b) => b.event === 'api_ok');
    expect(okBeacons).toHaveLength(5);
    expect([...new Set(okBeacons.map((b) => String(b.trace_id)))]).toEqual([traceId]);
  });

  it('没带 token（未登录）→ ApiError 40101，且服务端没有落任何单', async () => {
    await login('bob');
    token = ''; // 模拟"本地 token 丢失/从未登录"
    await expect(
      api({
        url: `${base}/api/v1/orders`,
        method: 'POST',
        data: orderBody('addr-x'),
        idempotencyKey: 'mp-key-2',
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 40101 });

    const rows = await db`select id from orders`;
    expect(rows).toHaveLength(0);

    // 401 在微信里走 success 而不是 fail——如果封装写反，这里会变成 -1
    const failed = beacons.filter((b) => b.event === 'api_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.code).toBe(40101);
    expect(beacons.filter((b) => b.event === 'api_network_error')).toHaveLength(0);
  });

  it('连不上（端口没人听）→ code 为网络错误码，不是业务码', async () => {
    await expect(api({ url: 'http://127.0.0.1:1/api/v1/orders' })).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
    });
    expect(beacons.filter((b) => b.event === 'api_network_error')).toHaveLength(1);
  });

  it('封装注入的 Idempotency-Key 被服务端真的用上：连点两次只建一张单', async () => {
    await login('carol');
    const addressId = await createAddress();
    const traceId = newTraceId();
    const first = await createOrder(addressId, 'mp-dup-key', traceId);
    const second = await createOrder(addressId, 'mp-dup-key', traceId);
    expect(second).toBe(first);
    expect(await db`select id from orders`).toHaveLength(1);
  });

  /**
   * @why D32 的缺陷（每次点击 `mp-${Date.now()}`）在 L0/L3 现有用例里都测不出来：
   *      L0 只测键的生成与生命周期（不经过服务端），L3 的「连点两次」是**手工传同一个键**——
   *      页面到底传什么键，那条用例管不着。所以必须有一条走完整生命周期的真链路用例：
   *      「首试失败 → 重试」服务端必须认成同一个意图，而「成功后」必须真的是新单。
   */
  it('一次意图一个键：首试网络失败后重试仍是同一张单；成功后换键才是第二张', async () => {
    await login('dave');
    const addressId = await createAddress();
    const intent = createIntentIdempotency();
    const post = (key: string) => createOrder(addressId, key);

    // 1) 首试：故意打到没人听的端口，模拟网络抖动（服务端根本没收到请求）
    const first = intent.acquire();
    expect(first.isRetry).toBe(false);
    await expect(
      api({
        url: 'http://127.0.0.1:1/api/v1/orders',
        method: 'POST',
        data: orderBody(addressId),
        idempotencyKey: first.key,
      }),
    ).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });

    // 2) 重试：键必须还是同一个——这是 D32 的核心断言
    const retry = intent.acquire();
    expect(retry.key).toBe(first.key);
    expect(retry.isRetry).toBe(true);
    const created = await post(retry.key);
    expect(await db`select id from orders`).toHaveLength(1);

    // 3) 结果回来之前用户又点了一次（并发连点）→ 服务端重放，仍只有一张单
    const replayed = await post(intent.acquire().key);
    expect(replayed).toBe(created);
    expect(await db`select id from orders`).toHaveLength(1);

    // 4) 成功后 retire：下一次点击是**新意图**，必须建出第二张不同的单
    intent.retire();
    const next = await post(intent.acquire().key);
    expect(next).not.toBe(created);
    expect(await db`select id from orders`).toHaveLength(2);
  });

  it('ApiError 的 message 来自服务端错误体，不是占位符（否则用户看到的是空提示）', async () => {
    token = '';
    const err = (await api({
      url: `${base}/api/v1/orders`,
      method: 'POST',
      data: orderBody('addr-x'),
      idempotencyKey: 'mp-key-3',
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});
