/**
 * 职责：`/admin/orders*` 五条路由的接线级真库用例（I2 U-B2d）——守卫、准入闸门、
 *      落库、以及"闸门必须在调机构之前"这条顺序。
 *
 * @why 守卫与闸门都要**接线级**测（真 HTTP + 真 JWT + 真 identity 回源）：
 *      `requireRole` 与三个 guard 各自都有单测，但"这条路由有没有挂它们"
 *      只有接线级能证明——管理端接口漏守卫的代价是全库可读可写。
 *
 * @why 落库断言直接查 `orders` / `order_events` 表，不接受"响应说成功了"：
 *      响应是路由自己拼的，库才是事实（§2 第 21 条：自证断言不算证据）。
 *      退款那条尤其重要——它跨了两次事务，响应 202 并不代表钱真的退了。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'admin-order-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

/** 起一个只挂了正式路由清单的 server（与生产同一条装配路径）。 */
async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: new MemorySink() });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
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
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

/** 插一个用户（默认管理员）；id 由 tag 固定且 on conflict 幂等。 */
async function seedUser(isAdmin = true, tag = 'admin'): Promise<string> {
  const id = `u-${tag}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${tag}`}, ${`${tag}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  return id;
}

const adminToken = async (): Promise<string> =>
  signToken(
    { sub: await seedUser(true), role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
const userToken = async (): Promise<string> =>
  signToken(
    { sub: await seedUser(false, 'buyer'), role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );

/** 插一张订单 + 一条支付行（provider 用 mock：注册表里它可退款）。 */
async function seedOrder(o: {
  id: string;
  status?: string;
  hasDispute?: boolean;
  paymentStatus?: string;
  providerRef?: string | null;
}): Promise<void> {
  await db`
    insert into users (id, openid) values (${`u-${o.id}`}, ${`o-${o.id}`})
      on conflict (id) do nothing
  `;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${o.id}`}, '商品', 'daily', 1000, 500, 'JP')
      on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        has_dispute, expires_at)
    values (${o.id}, ${`NO-${o.id}`}, ${`u-${o.id}`}, ${o.status ?? 'paid'}, 1000, 500, 150, 1650,
            500, ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ id: 'a-1', recipient: 'Jane Doe', line1: '1 Infinite Loop', country: 'US' } as never)},
            'TOS-TEST-1', ${o.hasDispute ?? false}, now() + interval '30 minutes')
  `;
  await db`
    insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                             weight_g, declared_value_usd)
    values (${`oi-${o.id}`}, ${o.id}, ${`p-${o.id}`}, '商品', 1, 1000, 500, 7)
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency,
                          charge_amount)
    values (${`pay-${o.id}`}, ${o.id}, 'mock', ${o.providerRef ?? `mock_${o.id}`},
            ${o.paymentStatus ?? 'succeeded'}, 'JPY', 1650)
  `;
}

const ADDR = {
  recipient: 'SAN ZHANG',
  phone: '+14155552671',
  line1: '2 Main St',
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
  country: 'US',
};

/** 带管理员 token 的请求封装。 */
async function adminFetch(
  s: { url: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

describe('GET /admin/orders（管理端订单列表）', () => {
  it('无 token → 40101', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/orders`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: number }).code).toBe(40101);
    await s.close();
  });

  it('小程序用户 token → 40301；管理员 → 200', async () => {
    const s = await buildServer();
    const bad = await fetch(`${s.url}/api/v1/admin/orders`, {
      headers: { authorization: `Bearer ${await userToken()}` },
    });
    expect(bad.status).toBe(403);
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json.items)).toBe(true);
    expect(typeof ok.json.total).toBe('number');
    await s.close();
  });

  // @why 前端的形状断言**硬失败**在缺 `order_id` 上（api.ts @limitation 一），
  //      键名叫错的表现是整页空白 + "网络错误"，真因却只是键名——必须钉住。
  it('响应行的主键叫 order_id（不是 id）：前端按 order_id 硬校验', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders');
    const items = ok.json.items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(typeof items[0]?.order_id).toBe('string');
    expect(items[0]?.order_no).toBe('NO-o-1');
    expect(items[0]?.has_dispute).toBe(false);
    await s.close();
  });

  it('status 非法 → 40001；page/size 越界 → 40001', async () => {
    const s = await buildServer();
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?status=nope')).status).toBe(400);
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?page=0')).status).toBe(400);
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?size=101')).status).toBe(400);
    await s.close();
  });

  it('keyword 走真实 HTTP 也能命中单号（列取错 = 客服搜不到单）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    await seedOrder({ id: 'o-2' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders?keyword=NO-o-1');
    expect(ok.json.items as unknown[]).toHaveLength(1);
    await s.close();
  });

  it('列表行带收件人（0.6.9/KD-14）：按收件人搜中的行，收件人一栏能回显；其余地址字段不在列表', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-r1' });
    await db`update orders set address_snapshot = address_snapshot || '{"recipient":"Hanako Sato"}'::jsonb where id = 'o-r1'`;
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders?keyword=hanako');
    const items = r.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.['recipient']).toBe('Hanako Sato');
    expect(items[0]).not.toHaveProperty('address');
    expect(JSON.stringify(items[0])).not.toMatch(/phone|line1|postal_code/);
    await s.close();
  });

  it('五条路由**每一条**都对无 token 返回 40101（防"某条忘了挂守卫"）', async () => {
    const s = await buildServer();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/v1/admin/orders'],
      ['GET', '/api/v1/admin/orders/x'],
      ['POST', '/api/v1/admin/orders/x/ship'],
      ['POST', '/api/v1/admin/orders/x/refund'],
      ['POST', '/api/v1/admin/orders/x/address'],
    ];
    for (const [method, path] of cases) {
      const r = await fetch(`${s.url}${path}`, {
        method,
        ...(method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }),
      });
      expect(r.status, `${method} ${path} 疑似缺守卫`).toBe(401);
    }
    await s.close();
  });
});

describe('GET /admin/orders/{id}（详情）', () => {
  it('存在 → 200 且带 items / payments / events 与地址', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
    expect(ok.status).toBe(200);
    expect(ok.json.order_id).toBe('o-1');
    expect(ok.json.items as unknown[]).toHaveLength(1);
    const pays = ok.json.payments as Record<string, unknown>[];
    expect(pays[0]?.provider).toBe('mock');
    // 契约 Order.payment = {channel, charge_currency, charge_amount, …}：曾原样透传 payments 末条（键叫 provider），
    // admin-web 读 payment.channel 永远为空（一致性审计 C5，AJ-176）
    const payment = ok.json.payment as Record<string, unknown>;
    expect(payment.channel).toBe('mock');
    expect(payment.charge_currency).toBe(pays[0]?.charge_currency);
    expect(payment.charge_amount).toBe(pays[0]?.charge_amount);
    expect(payment).not.toHaveProperty('provider');
    expect(ok.json.events as unknown[]).toHaveLength(0);
    expect((ok.json.address as { recipient?: string }).recipient).toBe('Jane Doe');
    await s.close();
  });

  it('不存在 → 40400', async () => {
    const s = await buildServer();
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders/no-such');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe(40400);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/ship（发货）', () => {
  it('paid → 200 且库里真的 shipped（carrier / tracking_no / shipped_at 都落了）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(200);
    const rows =
      await db`select status, carrier, tracking_no, shipped_at from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('shipped');
    expect(String(rows[0]?.carrier)).toBe('JPPOST');
    expect(String(rows[0]?.tracking_no)).toBe('TRACK-1');
    expect(rows[0]?.shipped_at).not.toBeNull();
    await s.close();
  });

  it('已发货 → 40902（不是静默成功）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'shipped' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await s.close();
  });

  // @why AJ-145 的核心守护：**拒付中不发货**。这条同时钉住"用 40909 而不是 40902"——
  //      给 40902 会让客服以为状态不对而去改状态。
  it('has_dispute=true → 40909 且状态没动（拒付中不发货，AJ-145）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40909);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    await s.close();
  });

  it('缺 carrier / tracking_no → 40001', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    expect((await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {})).status).toBe(400);
    await s.close();
  });

  it('订单不存在 → 40400', async () => {
    const s = await buildServer();
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/no-such/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(404);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/refund（全额退款）', () => {
  it('paid + mock 通道 → 202 且库里最终 refunded（钱真的退了，不只看响应）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
    expect(r.status).toBe(202);
    const rows = await db`select status, refunded_at from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('refunded');
    expect(rows[0]?.refunded_at).not.toBeNull();
    const p = await db`select status from payments where id = 'pay-o-1'`;
    expect(String(p[0]?.status)).toBe('refunded');
    await s.close();
  });

  // @why 这条守的是"闸门在调机构**之前**"：若顺序反了，拒付单的钱会被真的退出去，
  //      而响应还是 409——那时错误码对了，钱却已经没了。所以必须同时断言库里没变。
  it('has_dispute=true → 40907 且状态与支付行都没动（钱没被退出去）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40907);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    expect((await db`select status from payments where id = 'pay-o-1'`)[0]?.status).toBe(
      'succeeded',
    );
    await s.close();
  });

  // KD-4（AJ-175）：上一次机构调用失败后订单停在 refunding——此前重试被 40902 拒，这张单从此退不了
  it('停在 refunding 的单（上次机构调用失败）→ 重试 202 → refunded；只有一条 refunding 事件；重试沿用首次理由', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    // 造"上一次失败"的现场：迁到 refunding 并记下首次理由，但钱没退成
    await db`update orders set status = 'refunding' where id = 'o-1'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-1', 'refunding', '首次理由：缺货', 'admin', now() - interval '5 minutes')`;
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', {
      reason: '再试一次',
    });
    expect(r.status).toBe(202);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('refunded');
    expect((await db`select status from payments where id = 'pay-o-1'`)[0]?.status).toBe(
      'refunded',
    );
    const ev =
      await db`select status, note from order_events where order_id = 'o-1' and status = 'refunding'`;
    expect(ev.map((e) => e['note'])).toEqual(['首次理由：缺货']); // 重试不写第二条
    // 已退完的单不能再退（重试放行只对 refunding，不对 refunded）
    const again = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe(40902);
    await s.close();
  });

  it('未付款（created）→ 40902；缺 reason → 40001', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'created', paymentStatus: 'initiated' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await seedOrder({ id: 'o-2' });
    expect((await adminFetch(s, 'POST', '/api/v1/admin/orders/o-2/refund', {})).status).toBe(400);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/address（发货前改址）', () => {
  it('paid + 合法地址 → 200，快照改了、事件记了、**状态没动**', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', ADDR);
    expect(r.status).toBe(200);
    const rows = await db`select status, address_snapshot from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('paid');
    const snap = rows[0]?.address_snapshot as { recipient?: string; country?: string };
    expect(snap.recipient).toBe('SAN ZHANG');
    expect(snap.country).toBe('US');
    const evs = await db`select status, actor from order_events where order_id = 'o-1'`;
    expect(String(evs[0]?.status)).toBe('address_changed');
    expect(String(evs[0]?.actor)).toMatch(/^admin:/);
    await s.close();
  });

  it('已发货 → 40902（改址不动已发出的货）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'shipped' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', ADDR);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await s.close();
  });

  it('非 ASCII 收件人 → 40002（与买家地址簿同一份校验，不是第二份）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', {
      ...ADDR,
      recipient: '张三',
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40002);
    await s.close();
  });

  it('国家不可下单（ZZ）→ 40002（表驱动，不写死 US）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', {
      ...ADDR,
      country: 'ZZ',
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40002);
    await s.close();
  });
});
