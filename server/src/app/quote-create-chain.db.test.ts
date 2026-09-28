/**
 * 职责：**报价与建单两条路径的"同源"回路**（U-J1）——把 `POST /orders/quote` 的输出
 *      **原样喂给** `POST /orders`，并验证"管理端改配置 → 买家报价金额真的跟着变"。
 *
 * @why 本文件补的是一类此前**完全没有测试覆盖**的失效：报价与建单各自都测过
 *      （`quote-routes.db.test.ts` / `order-routes.db.test.ts`），
 *      但**没有任何一条测试验证过它们算出来一样**。
 *      40905（`expected_total_jpy` 与服务端重算不符）此前全库只有一条用例，而且是
 *      **手工构造的错值**（`TOTAL + 1`）——它证明了"错的值会被拒"，
 *      证明不了"**对的值不会被拒**"。真出事故的方向恰恰是后者：
 *      报价页显示 20,150、建单重算出 20,151，于是**每一单都被 40905 挡住**，
 *      而两边的单测全绿（各自都对，合起来错）。
 *      所以本文件第一条就是"报价返回值 → 原样建单 → 201"。
 *
 * @why 配置侧同理：`admin-ops-routes.db.test.ts` 只验到"库里的值改了"，
 *      `quote-routes.db.test.ts` 自己插库造 fx / shipping——
 *      **没有任何测试走"管理端改配置 → 买家报价变化"这一跳**。
 *      这一跳断掉的失效形态是：运营在后台把运费改成 6000、买家看到的还是 4950
 *      （或反向），且两边单测全绿。报价与建单共用 `app/quote-assembly.ts`，
 *      所以"配置有没有真的流到买家侧"必须**从买家端点的响应**取证，不能从配置端点取证。
 *
 * @why 断言一律查**库** + 独立复算（shared 的 toMinor/toRateInt），不从响应抄数：
 *      本文件要证的正是"两个端点说的一样"，拿其中一个的响应去断言另一个等于自证
 *      （§2 第 21 条）。唯一例外是"把报价的 total 喂给建单"那一跳——
 *      那一跳**故意**用响应值，因为要测的就是"响应值能不能被建单接受"。
 *
 * @limitation 一：只覆盖"报价 → 建单"与"配置 → 报价"这两段接缝，
 *              支付/回调/落账那一段在 `test/e2e/pay-callback-pipeline.e2e.test.ts`（既有）。
 *              **本文件不追求"一条测试跑完整条购买链路"**——那会让失败定位变难，
 *              且报价与支付之间隔着一个 30 分钟 TTL，串起来跑反而测不到本节缝。
 * @limitation 二：运费/汇率的"合理区间"护栏尚未拍板（`fx-input.ts` @limitation 二、
 *              `shipping-rates-input.ts` @limitation 一同源），本文件只验"改了会跟着变"，
 *              **不验"改得离谱会被拦"**——那件事等运营给阈值后再补。
 *
 * @see app/quote-routes.ts；app/order-routes.ts；app/quote-assembly.ts（两条路径的共同出处）；
 *      app/admin-ops-routes.ts（配置写入侧）；adapters/catalog.ts（D-46 唯一取档 SQL）；
 *      docs/自主决策记录.md AJ-170
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMinor, toRateInt } from '@waselect/shared';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'quote-chain-test-jwt-secret-'.repeat(3);
const TERMS = 'TOS-TEST-1';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

/** 每用例重建 app：限流计数器随之清零（store 在 mount 时建，进程级）。 */
async function buildServer(): Promise<{
  url: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: TERMS,
  });
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: createMemoryStorage(),
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, sink, close: server.close };
}

let userToken = '';
let adminToken = '';

beforeEach(async () => {
  await resetTestDb(db);
  await db`
    insert into users (id, openid, email, is_admin)
    values ('u-1', 'o-1', null, false), ('u-admin', 'o-admin', 'admin@example.com', true)
  `;
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
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country, is_default)
    values ('addr-1', 'u-1', 'Jane Doe', '+14155550123', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'US', true)
  `;
  userToken = await signToken(
    { sub: 'u-1', role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  adminToken = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
});

/** 报价与建单共用的一份行项目：620 + 480×2 = 1580g，加 250g 包材 = 1830g。 */
const ITEMS = [
  { product_id: 'p-knife', qty: 1 },
  { product_id: 'p-cup', qty: 2 },
];
const ITEMS_JPY = 8800 + 3200 * 2; // 15200
const WEIGHT_G = 620 + 480 * 2 + 250; // 1830 → 向上取 2000 档

async function postQuote(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/v1/orders/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: ITEMS }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function createOrder(
  url: string,
  expectedTotalJpy: number,
  key: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${userToken}`,
      'idempotency-key': key,
    },
    body: JSON.stringify({
      items: ITEMS,
      address_id: 'addr-1',
      terms_version: TERMS,
      expected_total_jpy: expectedTotalJpy,
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const orderCount = async (): Promise<number> =>
  Number((await db`select count(*)::int as n from orders`)[0]?.['n'] ?? -1);

describe('报价 → 建单：两条路径必须同源（40905 的"不误伤"侧）', () => {
  it('报价返回的 total 原样喂给建单 → 201，且库内金额/重量与报价**逐项相等**', async () => {
    const srv = await buildServer();
    try {
      const q = await postQuote(srv.url, userToken);
      // D-46 取档方向的自测向量（w=1830 → 4950；返回 4050 即错）
      //   ⚠️ 这条刻意放在**全链路层**再钉一次：`adapters/catalog.db.test.ts` 的向量
      //      只证明"取档 SQL 对"，证明不了"报价端点把档取对了"（中间还隔着装配）
      expect(q['weight_g']).toBe(WEIGHT_G);
      expect(q['shipping_jpy']).toBe(4950);
      expect(q['shipping_jpy']).not.toBe(4050);
      expect(q['items_jpy']).toBe(ITEMS_JPY);

      const total = Number(q['total_jpy']);
      const r = await createOrder(srv.url, total, 'chain-ok');
      expect(r.status).toBe(201);

      const row = await db`
        select items_jpy, shipping_jpy, total_jpy, weight_g
          from orders where id = ${String(r.json['order_id'])}
      `;
      // 独立复算：不从报价响应抄数（15200 + 4950）
      expect(row[0]).toMatchObject({
        items_jpy: ITEMS_JPY,
        shipping_jpy: 4950,
        total_jpy: ITEMS_JPY + 4950,
        weight_g: WEIGHT_G,
      });
      // 且与报价响应逐项相等（这行的意义就是"两条路径同源"）
      expect(Number(row[0]?.['total_jpy'])).toBe(total);
      expect(Number(row[0]?.['shipping_jpy'])).toBe(Number(q['shipping_jpy']));
    } finally {
      await srv.close();
    }
  });

  it('报价后改**商品价** → 用旧 total 建单 → 40905，且库里零新增订单', async () => {
    const srv = await buildServer();
    try {
      const q = await postQuote(srv.url, userToken);
      const stale = Number(q['total_jpy']);
      const before = await orderCount();

      await db`update products set price_jpy = price_jpy + 1000 where id = 'p-knife'`;

      const r = await createOrder(srv.url, stale, 'chain-stale-price');
      expect(r.status).toBe(409);
      expect(r.json['code']).toBe(40905);
      expect(await orderCount()).toBe(before); // 拒了就是拒了，不能留下半张单
    } finally {
      await srv.close();
    }
  });

  it('报价后改**运费档** → 用旧 total 建单 → 40905（50004 之外，40905 也得抓得住运费漂移）', async () => {
    const srv = await buildServer();
    try {
      const q = await postQuote(srv.url, userToken);
      const stale = Number(q['total_jpy']);
      const before = await orderCount();

      await db`update shipping_rates set price_jpy = 6000 where max_weight_g = 2000`;

      const r = await createOrder(srv.url, stale, 'chain-stale-shipping');
      expect(r.json['code']).toBe(40905);
      expect(await orderCount()).toBe(before);
    } finally {
      await srv.close();
    }
  });
});

describe('管理端改配置 → 买家报价变化（此前无人验证的一跳）', () => {
  it('PUT /admin/shipping-rates 改档 → 重新报价 shipping/total 跟着变，且新 total 能被建单接受', async () => {
    const srv = await buildServer();
    try {
      const before = await postQuote(srv.url, userToken);
      expect(before['shipping_jpy']).toBe(4950);

      const res = await fetch(`${srv.url}/api/v1/admin/shipping-rates`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify([
          { carrier: 'placeholder', max_weight_g: 1000, price_jpy: 3150, active: true },
          { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 6000, active: true },
          { carrier: 'placeholder', max_weight_g: 3000, price_jpy: 6600, active: true },
        ]),
      });
      expect(res.status).toBe(200);

      const after = await postQuote(srv.url, userToken);
      // 关键断言：买家侧真的吃到了新配置（不是只有库里变了）
      expect(after['shipping_jpy']).toBe(6000);
      expect(after['total_jpy']).toBe(ITEMS_JPY + 6000);
      expect(after['total_jpy']).not.toBe(before['total_jpy']);

      // 新配置下报价与建单仍然同源（改配置不能把两条路径改岔）
      const r = await createOrder(srv.url, Number(after['total_jpy']), 'chain-after-shipping');
      expect(r.status).toBe(201);
      const row = await db`
        select shipping_jpy, total_jpy from orders where id = ${String(r.json['order_id'])}
      `;
      expect(row[0]).toMatchObject({ shipping_jpy: 6000, total_jpy: ITEMS_JPY + 6000 });
    } finally {
      await srv.close();
    }
  });

  it('POST /admin/fx 改汇率 → 报价 display 变、**total_jpy 不变**（JPY 唯一定价锚，D-24）', async () => {
    const srv = await buildServer();
    try {
      const before = await postQuote(srv.url, userToken);
      const totalBefore = Number(before['total_jpy']);
      const usdBefore = Number((before['display'] as Record<string, number>)['USD']);

      const res = await fetch(`${srv.url}/api/v1/admin/fx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ quote: 'USD', raw_rate: 0.007 }),
      });
      expect(res.status).toBe(201);

      const after = await postQuote(srv.url, userToken);
      // 🔴 JPY 锚：展示汇率怎么改，日币总价都不许动（D-24 的可执行版本）
      expect(after['total_jpy']).toBe(totalBefore);
      expect(after['items_jpy']).toBe(ITEMS_JPY);

      const usdAfter = Number((after['display'] as Record<string, number>)['USD']);
      expect(usdAfter).not.toBe(usdBefore);
      // 独立复算：期望值来自**库里**那一行（DB 是事实），不是从响应抄
      const row = await db`
        select rate from fx_rates where quote = 'USD' order by effective_from desc limit 1
      `;
      expect(usdAfter).toBe(toMinor(totalBefore, toRateInt(String(row[0]?.['rate']))));
    } finally {
      await srv.close();
    }
  });

  it('管理端改配置的权限仍是闸门：买家 token 改运费 → 40301，且报价不受影响', async () => {
    const srv = await buildServer();
    try {
      const before = await postQuote(srv.url, userToken);
      const res = await fetch(`${srv.url}/api/v1/admin/shipping-rates`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
        body: JSON.stringify([
          { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 1, active: true },
        ]),
      });
      expect(res.status).toBe(403);
      expect((await postQuote(srv.url, userToken))['shipping_jpy']).toBe(
        Number(before['shipping_jpy']),
      );
    } finally {
      await srv.close();
    }
  });
});
