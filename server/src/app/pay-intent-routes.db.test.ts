/**
 * 职责：`POST /orders/{id}/pay` 的接线级真库用例（I1-U6a）——HTTP 形状 / 幂等包装 /
 *      限流挂载 / mock 通道全链路。
 *
 * @why 造单走真实建单端点（与 order-routes.db.test.ts 同 harness）：
 *      支付意图依赖建单落库的 fx_snapshot / expires_at / address_snapshot——
 *      手写插行容易造出真链路不会产生的形状。
 *
 * @why 通道层面的复用/换通道/守卫已在 pay-intent.db.test.ts（核心、假注册表）钉过；
 *      这里只钉**接线**：路由把 HTTP 请求正确地送进核心、把核心结果正确地写成响应。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import type { Clock } from '../ports/clock.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { registerBusinessEventLog } from './business-events.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'pay-intent-route-test-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

/**
 * 起一个接线完整的 server。
 * @param clock 可选时钟。**不传 = 真实时钟**（其余用例不受影响）；
 *               传固定时钟则全站时间受控——限流用例依赖它（见该用例里的 @why）。
 */
async function buildServer(clock?: Clock): Promise<{ url: string; close: () => Promise<void> }> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const app = createHttpApp({
    logger,
    mount: (a) => {
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage(), clock });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, close: server.close };
}

let token = '';

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active')
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
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country, is_default)
    values ('addr-1', 'u-1', 'Jane Doe', '+14155550123', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'US', true)
  `;
  token = await signToken({ sub: 'u-1', role: 'user' }, { secret: JWT_SECRET, issuer: 'waselect' });
});

const TOTAL = 8800 + 3150; // 1 把刀 8800；870g（620+250 包材）→ 1000g 档 3150 = 11950

/** 真实建单，返回 order_id。 */
async function createOrder(url: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': `create-${Math.random()}`,
    },
    body: JSON.stringify({
      items: [{ product_id: 'p-knife', qty: 1 }],
      address_id: 'addr-1',
      terms_version: 'TOS-TEST-1',
    }),
  });
  expect(res.status).toBe(201);
  return String(((await res.json()) as { order_id: string }).order_id);
}

async function pay(
  url: string,
  orderId: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (key !== undefined) headers['idempotency-key'] = key;
  const res = await fetch(`${url}/api/v1/orders/${orderId}/pay`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /orders/{id}/pay（mock 通道全链路）', () => {
  it('200：契约 PaymentIntent 形状 + payments 行 initiated + 订单 pending_payment', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url);
      const r = await pay(srv.url, orderId, { channel: 'mock' }, 'pay-1');
      expect(r.status).toBe(200);
      expect(r.json['channel']).toBe('mock');
      expect(r.json['charge']).toEqual({ currency: 'JPY', amount: TOTAL });
      const payload = r.json['payload'] as Record<string, unknown>;
      // mock 的自动确认信号（前端不写死通道名）：非审核模式服务端不会确认 → false（AJ-179；
      // 审核模式的 true + 已确认见 review-mode.db.test.ts）
      expect(payload['auto']).toBe(false);
      expect(payload['orderId']).toBe(orderId);
      expect(typeof r.json['expires_at']).toBe('string');

      const pays =
        await db`select provider, status, charge_currency, charge_amount from payments where order_id = ${orderId}`;
      expect(pays).toHaveLength(1);
      expect(pays[0]).toMatchObject({
        provider: 'mock',
        status: 'initiated',
        charge_currency: 'JPY',
        charge_amount: TOTAL,
      });
      const order = await db`select status from orders where id = ${orderId}`;
      expect(order[0]?.['status']).toBe('pending_payment');
    } finally {
      await srv.close();
    }
  });

  it('幂等：同 key 重放返回同一响应且 payments 仍 1 行；同 key 不同内容 → 40908；缺 key → 40001', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url);
      const first = await pay(srv.url, orderId, { channel: 'mock' }, 'pay-replay');
      const replay = await pay(srv.url, orderId, { channel: 'mock' }, 'pay-replay');
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      const pays = await db`select count(*)::int as n from payments where order_id = ${orderId}`;
      expect(Number(pays[0]?.['n'])).toBe(1);

      const conflict = await pay(srv.url, orderId, { channel: 'other' }, 'pay-replay');
      expect(conflict.json['code']).toBe(40908);

      const noKey = await pay(srv.url, orderId, { channel: 'mock' });
      expect(noKey.json['code']).toBe(40001);
    } finally {
      await srv.close();
    }
  });

  it('幂等作用域含路径里的 orderId：同键用在另一张单上 → 40908，且不为它建意图', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrder(srv.url);
      const b = await createOrder(srv.url);
      const first = await pay(srv.url, a, { channel: 'mock' }, 'shared-key');
      expect(first.status).toBe(200);

      // 🔴 指纹若不含 orderId，`b` 会命中 `a` 的幂等行并**重放 a 的响应**：
      //    copylink 拼成「a 的金额 + b 的短链」，in_app 直接把 a 的会话交给正在付 b 的人。
      //    小程序历史上每次点击都现造键，所以这条当年不可达（A5 改成键复用之后才变为可达）。
      const cross = await pay(srv.url, b, { channel: 'mock' }, 'shared-key');
      expect(cross.json['code']).toBe(40908);
      const paysB = await db`select count(*)::int as n from payments where order_id = ${b}`;
      expect(Number(paysB[0]?.['n'])).toBe(0);

      // 回归：防跨单不能把"同键同单同参"的正常重放一起打掉
      const replay = await pay(srv.url, a, { channel: 'mock' }, 'shared-key');
      expect(replay.status).toBe(200);
      const paysA = await db`select count(*)::int as n from payments where order_id = ${a}`;
      expect(Number(paysA[0]?.['n'])).toBe(1);
    } finally {
      await srv.close();
    }
  });

  /**
   * AJ-235（B10 修复的漏口，第二轮审查 PAY2-04 / INF2-04）：body 里自带 `order_id` 不得盖掉路径里的。
   * @why 指纹素材写成 `{ order_id: orderId, ...body }`——展开在后，body 的同名字段会覆盖路径参数。
   *      于是"同键用在另一张单上、body 里再带一个 `order_id: <上一张单>`"两次指纹相等，
   *      B10 要堵的跨单重放又可达了：正在付 b 的人拿到的是 a 的支付凭据。
   */
  it('🔴 body 里伪造 order_id 指向上一张单：指纹仍以**路径**为准 → 40908，不重放 a 的响应', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrder(srv.url);
      const b = await createOrder(srv.url);
      const first = await pay(srv.url, a, { channel: 'mock' }, 'forged-key');
      expect(first.status).toBe(200);

      const cross = await pay(srv.url, b, { channel: 'mock', order_id: a }, 'forged-key');
      expect(cross.json['code']).toBe(40908);
      const paysB = await db`select count(*)::int as n from payments where order_id = ${b}`;
      expect(Number(paysB[0]?.['n'])).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('形状守卫：缺 channel → 40001；未注册通道 → 40001；他人单 → 40400；已过期 → 40904', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url);
      const noChannel = await pay(srv.url, orderId, {}, 'g1');
      expect(noChannel.json['code']).toBe(40001);
      const bogus = await pay(srv.url, orderId, { channel: 'bogus' }, 'g2');
      expect(bogus.json['code']).toBe(40001);

      await db`insert into users (id, openid) values ('u-2', 'o-2')`;
      const token2 = await signToken(
        { sub: 'u-2', role: 'user' },
        { secret: JWT_SECRET, issuer: 'waselect' },
      );
      const res = await fetch(`${srv.url}/api/v1/orders/${orderId}/pay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token2}`,
          'idempotency-key': 'g3',
        },
        body: JSON.stringify({ channel: 'mock' }),
      });
      expect(((await res.json()) as { code: number }).code).toBe(40400);

      await db`update orders set status = 'expired' where id = ${orderId}`;
      const expired = await pay(srv.url, orderId, { channel: 'mock' }, 'g4');
      expect(expired.json['code']).toBe(40904);
    } finally {
      await srv.close();
    }
  });

  it('限流挂在发起支付上：前 30 次穿过（被业务拦），第 31 次 42901', async () => {
    // ⚠️ 必须注入**固定**时钟，不能省。限流是**时钟对齐**的固定窗口
    //    （ports/rate-limit.ts 的 windowStartOf = floor(now/60000)×60000）：
    //    这 31 次请求一旦跨过整分边界，计数就被重置，第 31 次拿不到 42901
    //    ——用例的成败取决于它相对窗口边界的**相位**，约 0.5% 概率随机红
    //    （2026-10-01 C3 全量重读实测撞上过一次：单独跑绿、整包跑绿、gate 里红）。
    //    冻结时钟后 31 次请求落在同一窗口，结果确定，概率归零。
    // @why 冻结在**此刻**而不是写死的日期：JWT 的 iat/exp 仍与真实时间对齐，
    //      否则这一条会先被 40101 拦下，测的根本不是限流。
    const srv = await buildServer(fixedClock(new Date()));
    try {
      // 直接插单，不走建单端点：限流 key 是 routeKey+IP（publicWrite 按入口分桶：orders.pay 自己一个桶），
      // 建单会预消耗 1 次配额，探针数就说不清了
      await db`
        insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                            fx_snapshot, address_snapshot, terms_version, expires_at)
        values ('o-rl', 'W-o-rl', 'u-1', 'created', 8800, ${TOTAL}, 870,
                ${db.json({ USD: 0.0067 })}, ${db.json({ country: 'US' })},
                'TOS-TEST-1', now() + interval '30 minutes')
      `;
      // 探针：未注册通道——穿过限流 → 40001；被限流 → 42901
      for (let i = 0; i < 30; i += 1) {
        const r = await pay(srv.url, 'o-rl', { channel: 'bogus' }, `probe-${i}`);
        expect(r.json['code']).toBe(40001);
      }
      const r = await pay(srv.url, 'o-rl', { channel: 'bogus' }, 'probe-31');
      expect(r.json['code']).toBe(42901);
    } finally {
      await srv.close();
    }
  });
});
