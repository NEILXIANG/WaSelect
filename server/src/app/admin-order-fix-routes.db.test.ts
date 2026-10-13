/**
 * 管理端"手滑出口"两条路由（第三轮缺口 P1-11 / P1-10，AJ-386）：真实路由 + 真实 Postgres + mock 通道。
 *
 * @why 运营最常见的两种手滑原先都没有出口：价格录错后的**未付**单只能等过期或拉黑买家（副作用过大）；
 *      运单号填错后只能改库（且错号已随邮件发出）。
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
const JWT_SECRET = 'admin-order-fix-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let token: string;
let published: string[];

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'admin@example.com', true)`;
  token = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-fix-test',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const events = createEventBus(logger);
  published = [];
  for (const n of ['order.cancelled', 'order.shipped', 'order.shipment_reverted']) {
    events.subscribe(n, (e) => {
      published.push(`${e.name}:${String(e.payload?.['mail_key'] ?? '')}`);
    });
  }
  const app = createHttpApp({
    logger,
    mount: (a) => mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() }),
  });
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

async function seed(
  id: string,
  status: string,
  extra: { carrier?: string; tracking?: string; shippedHoursAgo?: number } = {},
): Promise<void> {
  const shippedAt =
    status === 'shipped' ? new Date(Date.now() - (extra.shippedHoursAgo ?? 0) * 3_600_000) : null;
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`insert into products (id, title, category, price_jpy, weight_g, stock, origin_country)
           values (${`p-${id}`}, '抹茶粉', 'food', 5000, 400, 3, 'JP') on conflict do nothing`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at, carrier, tracking_no, shipped_at)
    values (${id}, ${`W-${id}`}, ${`u-${id}`}, ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() + interval '30 minutes', ${extra.carrier ?? null}, ${extra.tracking ?? null},
            ${shippedAt})
  `;
  await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
           values (${`oi-${id}`}, ${id}, ${`p-${id}`}, '抹茶粉', 2, 5000, 400, 3400)`;
}

async function post(
  path: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 服务端 `AppError(code, {...}, {reason})` 里那个 `reason`（同一个码有多因时必须看它，规律⑤）。 */
const reasonOf = (r: { json: Record<string, unknown> }): unknown =>
  (r.json['data'] as { reason?: unknown } | undefined)?.reason;

describe('POST /admin/orders/:id/cancel（P1-11）', () => {
  it('🔴 未付单 → cancelled、库存回补、事件 actor=admin 且带原因、发 order.cancelled、写审计', async () => {
    await seed('o-c1', 'created');
    const r = await post('/api/v1/admin/orders/o-c1/cancel', {
      reason: '价格录错，联系买家重新下单',
    });
    expect(r.status).toBe(200);
    const [o] = await db`select status from orders where id = 'o-c1'`;
    expect(o?.['status']).toBe('cancelled');
    const [p] = await db`select stock from products where id = 'p-o-c1'`;
    expect(p?.['stock']).toBe(5);
    const [ev] =
      await db`select actor, note from order_events where order_id = 'o-c1' and status = 'cancelled'`;
    expect(ev).toMatchObject({ actor: 'admin:u-admin', note: '价格录错，联系买家重新下单' });
    expect(published).toContain('order.cancelled:');
    // 审计写在响应之后（admin-audit.ts @limitation：客户端拿到 200 时不保证已落库）——
    // 全量 gate 负载下立即读曾读到空（2026-10-08 实测一次红），轮询等它落库
    let audit: readonly Record<string, unknown>[] = [];
    for (let i = 0; i < 50 && audit.length === 0; i++) {
      audit = await db`select action from admin_audit where target = 'o-c1'`;
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit.map((a) => String(a['action']))).toEqual(['POST /admin/orders/:id/cancel']);
  });

  it('🔴 已付单 → 40902（钱已收的单要走退款，不能取消）；原因为空 → 40001；不存在 → 40400', async () => {
    await seed('o-c2', 'paid');
    expect((await post('/api/v1/admin/orders/o-c2/cancel', { reason: 'x' })).json['code']).toBe(
      40902,
    );
    await seed('o-c3', 'pending_payment');
    expect((await post('/api/v1/admin/orders/o-c3/cancel', { reason: ' ' })).json['code']).toBe(
      40001,
    );
    expect((await post('/api/v1/admin/orders/o-none/cancel', { reason: 'x' })).json['code']).toBe(
      40400,
    );
  });
});

describe('PATCH /admin/orders/:id/shipment（P1-10）', () => {
  it('🔴 已发货单改运单号 → 更新、事件记旧→新、重发发货邮件（独立幂等键）、返回 tracking_recognized', async () => {
    await seed('o-s1', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JX' });
    const r = await post(
      '/api/v1/admin/orders/o-s1/shipment',
      { carrier: 'EMS', tracking_no: 'EE123456789JP', reason: '运单号少打一位' },
      'PATCH',
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      carrier: 'EMS',
      tracking_no: 'EE123456789JP',
      tracking_recognized: true,
    });
    const [o] = await db`select tracking_no from orders where id = 'o-s1'`;
    expect(o?.['tracking_no']).toBe('EE123456789JP');
    const [ev] =
      await db`select note from order_events where order_id = 'o-s1' and status = 'shipment_fixed'`;
    expect(String(ev?.['note'])).toContain('EE123456789JX');
    expect(published.filter((p) => p.startsWith('order.shipped:fix-'))).toHaveLength(1);
  });

  it('🔴 未发货 / 已签收 → 40902；原因为空 → 40001；运单号超长 → 40001', async () => {
    await seed('o-s2', 'paid');
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s2/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40902);
    await seed('o-s3', 'delivered', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s3/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40902);
    await seed('o-s4', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s4/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: ' ' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40001);
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s4/shipment',
          { carrier: 'EMS', tracking_no: 'x'.repeat(65), reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40001);
  });

  it('首次发货也返回 tracking_recognized（形状认不出时 false，供管理端提示核对，不拦）', async () => {
    await seed('o-s5', 'paid');
    const r = await post('/api/v1/admin/orders/o-s5/ship', {
      carrier: 'EMS',
      tracking_no: '=HYPERLINK("x")',
    });
    expect(r.status).toBe(200);
    expect(r.json['tracking_recognized']).toBe(false);
  });
});

/**
 * @why 运单号原样落库（AJ-410 / N20a）：运营打出 `em 123456789 jp`，这一串进了买家的发货邮件与订单页。
 *      单单发货与改运单号两条路径都要落**归一值**（去空白、转大写），时间线与审计也记归一值——
 *      审计若仍记请求体，回溯时看到的是一串与库里对不上的单号。
 */
describe('运单号服务端归一（N20a）：单单发货 / 改运单号', () => {
  async function auditAfter(target: string, action: string): Promise<Record<string, unknown>> {
    let rows: readonly Record<string, unknown>[] = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      rows =
        await db`select after from admin_audit where target = ${target} and action = ${action}`;
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows, `admin_audit 没有 ${action}`).toHaveLength(1);
    return rows[0]?.['after'] as Record<string, unknown>;
  }

  it('🔴 单单发货：库、响应、shipped 事件、审计 after 都是归一值', async () => {
    await seed('o-n1', 'paid');
    const r = await post('/api/v1/admin/orders/o-n1/ship', {
      carrier: 'Japan Post',
      tracking_no: ' em 123456789 jp ',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tracking_no: 'EM123456789JP', tracking_recognized: true });
    const [o] = await db`select tracking_no from orders where id = 'o-n1'`;
    expect(o?.['tracking_no']).toBe('EM123456789JP');
    const [ev] =
      await db`select note from order_events where order_id = 'o-n1' and status = 'shipped'`;
    expect(ev?.['note']).toBe('Japan Post / EM123456789JP');
    expect(await auditAfter('o-n1', 'POST /admin/orders/:id/ship')).toMatchObject({
      carrier: 'Japan Post',
      tracking_no: 'EM123456789JP',
    });
  });

  it('🔴 改运单号：库、响应、shipment_fixed 事件、审计 after 都是归一值（保留连字符）', async () => {
    await seed('o-n2', 'shipped', { carrier: 'Yamato', tracking: '1234-5678-9011' });
    const r = await post(
      '/api/v1/admin/orders/o-n2/shipment',
      { carrier: 'Yamato', tracking_no: 'ab 1234-5678\u30009012', reason: '单号抄错' },
      'PATCH',
    );
    expect(r.status).toBe(200);
    expect(r.json['tracking_no']).toBe('AB1234-56789012');
    const [o] = await db`select tracking_no from orders where id = 'o-n2'`;
    expect(o?.['tracking_no']).toBe('AB1234-56789012');
    const [ev] =
      await db`select note from order_events where order_id = 'o-n2' and status = 'shipment_fixed'`;
    expect(String(ev?.['note'])).toContain('→ Yamato / AB1234-56789012；');
    expect(await auditAfter('o-n2', 'PATCH /admin/orders/:id/shipment')).toMatchObject({
      tracking_no: 'AB1234-56789012',
      reason: '单号抄错',
    });
  });
});

/**
 * 撤销发货（严格检查 P0 A-1，AJ-440）：点错单 / 发错单后，订单原先没有回到"待发货"的出口。
 * @why 断言买家侧时间线：撤销后买家不该再看到那条"已发货"（状态已回到待发货，留着它会自相矛盾）。
 */
describe('POST /admin/orders/:id/shipment/revert（AJ-440）', () => {
  const REVERT = (id: string) => `/api/v1/admin/orders/${id}/shipment/revert`;

  it('🔴 已发货 → paid、清空承运商/运单号/发货时刻、事件记原运单号与原因、审计、发更正邮件事件', async () => {
    await seed('o-r1', 'paid');
    expect(
      (
        await post('/api/v1/admin/orders/o-r1/ship', {
          carrier: 'EMS',
          tracking_no: 'EE123456789JP',
        })
      ).status,
    ).toBe(200);
    const r = await post(REVERT('o-r1'), { reason: '点错单，这张还没打包' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ order_id: 'o-r1', status: 'paid' });
    const [o] =
      await db`select status, carrier, tracking_no, shipped_at from orders where id = 'o-r1'`;
    expect(o).toMatchObject({ status: 'paid', carrier: null, tracking_no: null, shipped_at: null });
    const [ev] = await db`
      select note, actor from order_events where order_id = 'o-r1' and status = 'shipment_reverted'`;
    expect(ev?.['actor']).toBe('admin:u-admin');
    expect(ev?.['note']).toBe('原 EMS / EE123456789JP；原因：点错单，这张还没打包');
    expect(published).toContain('order.shipment_reverted:revert-1');
    let audit: readonly Record<string, unknown>[] = [];
    for (let i = 0; i < 50 && audit.length === 0; i++) {
      audit = await db`select before, after from admin_audit
                        where target = 'o-r1' and action = 'POST /admin/orders/:id/shipment/revert'`;
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['before']).toMatchObject({ status: 'shipped', tracking_no: 'EE123456789JP' });
    expect(audit[0]?.['after']).toMatchObject({ status: 'paid', reason: '点错单，这张还没打包' });
  });

  it('🔴 撤销后再发货：发货邮件用新的一次性键（否则被当成首封重放吞掉）；买家时间线不再出现被撤的那次"已发货"', async () => {
    await seed('o-r2', 'paid');
    await post('/api/v1/admin/orders/o-r2/ship', { carrier: 'EMS', tracking_no: 'EE111111111JP' });
    await post(REVERT('o-r2'), { reason: '发错单' });
    const again = await post('/api/v1/admin/orders/o-r2/ship', {
      carrier: 'EMS',
      tracking_no: 'EE222222222JP',
    });
    expect(again.status).toBe(200);
    expect(published.filter((p) => p.startsWith('order.shipped:'))).toEqual([
      'order.shipped:',
      'order.shipped:reship-1',
    ]);
    const { listOrderTimeline } = await import('../adapters/orders.js');
    const tl = await listOrderTimeline(db, 'o-r2');
    expect(tl.filter((t) => t.status === 'shipped')).toHaveLength(1);
    // 第二次撤销 + 再发：键递增，不撞第一次
    await post(REVERT('o-r2'), { reason: '又发错了' });
    await post('/api/v1/admin/orders/o-r2/ship', { carrier: 'EMS', tracking_no: 'EE333333333JP' });
    expect(published).toContain('order.shipment_reverted:revert-2');
    expect(published).toContain('order.shipped:reship-2');
  });

  it('🔴 超过 72 小时 / 未发货 / 已签收 → 40902；拒付中 → 40909；售后进行中 → 40902；原因为空 → 40001；不存在 → 40400', async () => {
    await seed('o-r3', 'shipped', {
      carrier: 'EMS',
      tracking: 'EE123456789JP',
      shippedHoursAgo: 73,
    });
    expect((await post(REVERT('o-r3'), { reason: 'x' })).json).toMatchObject({ code: 40902 });
    await seed('o-r4', 'paid');
    expect((await post(REVERT('o-r4'), { reason: 'x' })).json['code']).toBe(40902);
    await seed('o-r5', 'delivered', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect((await post(REVERT('o-r5'), { reason: 'x' })).json['code']).toBe(40902);
    await seed('o-r6', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    await db`update orders set has_dispute = true where id = 'o-r6'`;
    expect((await post(REVERT('o-r6'), { reason: 'x' })).json['code']).toBe(40909);
    await seed('o-r7', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    await db`insert into after_sale_requests (id, order_id, user_id, reason, description, created_at, updated_at)
             values ('as-r7', 'o-r7', 'u-o-r7', 'not_received', '一直没收到', now(), now())`;
    expect((await post(REVERT('o-r7'), { reason: 'x' })).json['code']).toBe(40902);
    await seed('o-r8', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect((await post(REVERT('o-r8'), { reason: ' ' })).json['code']).toBe(40001);
    expect((await post(REVERT('o-none'), { reason: 'x' })).json['code']).toBe(40400);
    // 被拒的单一律原样不动
    const rows =
      await db`select id, status, tracking_no from orders where id in ('o-r3','o-r6','o-r7','o-r8') order by id`;
    expect(rows.map((x) => [x['status'], x['tracking_no']])).toEqual([
      ['shipped', 'EE123456789JP'],
      ['shipped', 'EE123456789JP'],
      ['shipped', 'EE123456789JP'],
      ['shipped', 'EE123456789JP'],
    ]);
    expect(published.filter((p) => p.startsWith('order.shipment_reverted'))).toEqual([]);
  });

  it('🔴「进行中」的两个状态都挡撤销发货（open / processing）；已结案的不挡', async () => {
    // 判据来自 shared 的 AFTER_SALE_OPEN_STATUSES，经 `hasOpenAfterSale` 走 SQL：
    //   `status in ${db([...AFTER_SALE_OPEN_STATUSES])}`（adapters/after-sales.ts）。
    // ⚠️ 上面那条用例插入售后时**省了 status** → 默认 'open'，所以 'processing' 这条腿从来没被走过：
    //   把 SQL 改成只认 'open'、或者把 shared 里的 'processing' 删掉，全都是绿的（规律⑪：造数只覆盖主状态）。
    //   两个状态各造一单，理由也一并钉住——服务端 40902 有多因（状态不对 / 售后进行中 / 超时…），
    //   只说"40902"等于没验证是**哪一条**拦下的。
    for (const [i, st] of ['open', 'processing'].entries()) {
      const oid = `o-op-${String(i)}`;
      await seed(oid, 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
      await db`insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
               values (${`as-${oid}`}, ${oid}, ${`u-${oid}`}, 'not_received', '一直没收到', ${st}, now(), now())`;
      const blocked = await post(REVERT(oid), { reason: 'x' });
      expect([st, blocked.json['code'], reasonOf(blocked)]).toEqual([st, 40902, 'after_sale_open']);
      const [o] = await db`select status from orders where id = ${oid}`;
      expect([st, o?.['status']]).toEqual([st, 'shipped']);
    }
    // 负例：已结案的不挡——否则「有售后就不能撤发货」会退化成一句过宽的规则
    await seed('o-op-2', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    await db`insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
             values ('as-o-op-2', 'o-op-2', 'u-o-op-2', 'not_received', '一直没收到', 'resolved', now(), now())`;
    expect((await post(REVERT('o-op-2'), { reason: 'x' })).status).toBe(200);
  });

  it('🔴 adapter 兜底：不是 shipped 的单直接调 revertShipment → false，订单与事件都不动（闸门之外的第二道）', async () => {
    const { revertShipment } = await import('../adapters/orders-admin.js');
    await seed('o-r9', 'delivered', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect(await revertShipment(db, 'o-r9', new Date(), 'admin:u-admin', 'x')).toBe(false);
    const [o] = await db`select status, tracking_no from orders where id = 'o-r9'`;
    expect(o).toMatchObject({ status: 'delivered', tracking_no: 'EE123456789JP' });
    expect(
      await db`select 1 from order_events where order_id = 'o-r9' and status = 'shipment_reverted'`,
    ).toHaveLength(0);
  });
});
