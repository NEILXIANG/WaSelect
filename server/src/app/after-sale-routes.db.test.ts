/**
 * 售后申请最小闭环（AJ-420）：迁移 038 的库约束 + 买家发起 / 运营处理两条写路由 + 两个订单详情里的读。
 * 真实路由 + 真实 Postgres（约束三）。
 *
 * @why 库约束用例绕过路由直插（与 order_notes 同口径）：路由先锁订单再判"已有进行中"，
 *      只经路由测，部分唯一索引被删了也是绿的（约束八）。
 * @why 一条用例走完"买家提交 → 运营看到 → 处理 → 买家看到结果"：各段各自绿、拼起来有缝是约束九点名的形态。
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
import { waitUntil } from '../../../test/helpers/chain-server.js';

let db: Db;
const JWT_SECRET = 'after-sale-route-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let admin: string;
let buyer: string;
let other: string;

const sign = (sub: string, role: 'user' | 'admin') =>
  signToken({ sub, role }, { secret: JWT_SECRET, issuer: 'waselect' });

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'ops@example.com', true)`;
  await db`insert into users (id, openid) values ('u-buyer', 'o-buyer'), ('u-other', 'o-other')`;
  admin = await sign('u-admin', 'admin');
  buyer = await sign('u-buyer', 'user');
  other = await sign('u-other', 'user');
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-after-sale-route-test',
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
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

async function seedOrder(id: string, status: string, userId = 'u-buyer'): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at, paid_at, shipped_at)
    values (${id}, ${`W-${id}`}, ${userId}, ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() + interval '30 minutes', now() - interval '9 days', now() - interval '8 days')
  `;
}

async function call(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const apply = (
  token: string,
  orderId: string,
  body: unknown = {
    reason: 'damaged',
    description: '外箱压扁，抹茶罐凹了一块，粉洒出来一些',
  },
) => call(token, 'POST', `/api/v1/orders/${orderId}/after-sales`, body);

const resolve = (orderId: string, rid: string, body: unknown) =>
  call(admin, 'POST', `/api/v1/admin/orders/${orderId}/after-sales/${rid}/resolve`, body);

const reasonOf = (r: { json: Record<string, unknown> }): unknown =>
  (r.json['data'] as { reason?: unknown } | undefined)?.reason;

describe('迁移 038：after_sale_requests 库约束（绕过路由直插）', () => {
  const ins = (id: string, orderId: string, status = 'open') =>
    db`insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
       values (${id}, ${orderId}, 'u-buyer', 'damaged', '破了', ${status}, now(), now())`;

  it('🔴 同一订单同时只能有一条进行中（open / processing）；结案后可以再开', async () => {
    await seedOrder('o-c1', 'delivered');
    await ins('as-1', 'o-c1');
    await expect(ins('as-2', 'o-c1')).rejects.toThrow(/uq_after_sale_requests_open/);
    await expect(ins('as-3', 'o-c1', 'processing')).rejects.toThrow(/uq_after_sale_requests_open/);
    await db`update after_sale_requests set status = 'resolved' where id = 'as-1'`;
    await ins('as-4', 'o-c1');
  });

  it('🔴 原因 / 状态域约束；描述 1–500 码位；handled_by 只认 admin:<id>', async () => {
    await seedOrder('o-c2', 'delivered');
    await expect(
      db`insert into after_sale_requests (id, order_id, user_id, reason, description, created_at, updated_at)
         values ('x1', 'o-c2', 'u-buyer', 'refund_me', 'a', now(), now())`,
    ).rejects.toThrow(/after_sale_requests_reason_domain/);
    await expect(ins('x2', 'o-c2', 'closed')).rejects.toThrow(/after_sale_requests_status_domain/);
    for (const bad of ['', 'あ'.repeat(501)]) {
      await expect(
        db`insert into after_sale_requests (id, order_id, user_id, reason, description, created_at, updated_at)
           values ('x3', 'o-c2', 'u-buyer', 'other', ${bad}, now(), now())`,
      ).rejects.toThrow(/after_sale_requests_description_check/);
    }
    await ins('x4', 'o-c2');
    await expect(
      db`update after_sale_requests set handled_by = 'user:u-buyer' where id = 'x4'`,
    ).rejects.toThrow(/after_sale_requests_handled_by_check/);
  });
});

describe('POST /orders/:id/after-sales（买家发起）', () => {
  it('🔴 已签收的单：201，落库 open；描述去首尾空白；日志不带描述原话', async () => {
    await seedOrder('o-a1', 'delivered');
    const r = await apply(buyer, 'o-a1', { reason: 'damaged', description: '  罐子凹了  ' });
    expect(r.status).toBe(201);
    expect(r.json['after_sale']).toMatchObject({
      reason: 'damaged',
      description: '罐子凹了',
      status: 'open',
    });
    expect(r.json['after_sale']).not.toHaveProperty('handled_by');
    const [row] = await db`select user_id, status from after_sale_requests where order_id = 'o-a1'`;
    expect(row).toMatchObject({ user_id: 'u-buyer', status: 'open' });
    const logs = srv.sink.lines.join('\n');
    expect(logs).toContain('after_sale_requested');
    expect(logs).not.toContain('罐子凹了');
  });

  it('🔴 只有 已发货 / 已签收 / 已完成 可以申请；其它状态 → 409 / 40902 status_not_allowed', async () => {
    for (const s of ['shipped', 'completed']) {
      await seedOrder(`o-ok-${s}`, s);
      expect((await apply(buyer, `o-ok-${s}`)).status).toBe(201);
    }
    for (const [i, s] of ['pending_payment', 'paid', 'cancelled', 'refunded'].entries()) {
      await seedOrder(`o-no-${String(i)}`, s);
      const r = await apply(buyer, `o-no-${String(i)}`);
      expect([s, r.status, r.json['code'], reasonOf(r)]).toEqual([
        s,
        409,
        40902,
        'status_not_allowed',
      ]);
    }
  });

  it('🔴 已有进行中的申请 → 409 / 40902 after_sale_open（并发两次也只落一条）', async () => {
    await seedOrder('o-a3', 'delivered');
    const [a, b] = await Promise.all([apply(buyer, 'o-a3'), apply(buyer, 'o-a3')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(reasonOf(loser)).toBe('after_sale_open');
    const rows = await db`select 1 from after_sale_requests where order_id = 'o-a3'`;
    expect(rows).toHaveLength(1);
  });

  it('别人的单与不存在同为 404 / 40400；入参不合法 → 400 / 40001', async () => {
    await seedOrder('o-a4', 'delivered');
    expect((await apply(other, 'o-a4')).json['code']).toBe(40400);
    expect((await apply(buyer, 'o-none')).json['code']).toBe(40400);
    const bad = await apply(buyer, 'o-a4', { reason: 'refund_me', description: 'x' });
    expect([bad.status, bad.json['code']]).toEqual([400, 40001]);
  });
});

describe('POST /admin/orders/:id/after-sales/:rid/resolve（运营处理）', () => {
  it('🔴 闭环：买家提交 → 运营在详情看到 → 处理中 → 已处理（带说明）→ 买家详情看到结果', async () => {
    await seedOrder('o-r1', 'delivered');
    const created = await apply(buyer, 'o-r1');
    const rid = String((created.json['after_sale'] as { id: string }).id);

    const adminDetail = await call(admin, 'GET', '/api/v1/admin/orders/o-r1');
    expect(adminDetail.json['after_sales']).toEqual([
      expect.objectContaining({ id: rid, status: 'open', reason: 'damaged' }),
    ]);

    const p = await resolve('o-r1', rid, { status: 'processing' });
    expect(p.json['after_sale']).toMatchObject({
      status: 'processing',
      handled_by: 'admin:u-admin',
    });

    const done = await resolve('o-r1', rid, {
      status: 'resolved',
      note: '已安排部分退款 ¥1,500，3–5 个工作日到账',
    });
    expect(done.status).toBe(200);

    const buyerDetail = await call(buyer, 'GET', '/api/v1/orders/o-r1');
    expect(buyerDetail.json['after_sale']).toMatchObject({
      id: rid,
      status: 'resolved',
      resolution_note: '已安排部分退款 ¥1,500，3–5 个工作日到账',
    });
    expect(buyerDetail.json['after_sale']).not.toHaveProperty('handled_by');
    // 审计中间件自动写（处理历史的追溯来源，迁移 038 @limitation 一）
    // 审计行在响应之后写（admin-audit.ts：prefinish 之后），先等它落库再读——不等在全量负载下偶发读空（2026-10-12 复盘）
    const resolveAudits = async () => db`select 1 from admin_audit
                         where action = 'POST /admin/orders/:id/after-sales/:rid/resolve'`;
    await waitUntil(async () => (await resolveAudits()).length >= 2, '售后处理的审计行没写进来');
    const audits = await resolveAudits();
    expect(audits.length).toBe(2);
  });

  it('🔴 结案后不能再改 → 409 / 40902 after_sale_closed；不能退回 open', async () => {
    await seedOrder('o-r2', 'delivered');
    const rid = String(((await apply(buyer, 'o-r2')).json['after_sale'] as { id: string }).id);
    expect(
      (
        await resolve('o-r2', rid, {
          status: 'rejected',
          note: '照片显示外箱完好，请联系客服补充说明',
        })
      ).status,
    ).toBe(200);
    const again = await resolve('o-r2', rid, { status: 'resolved', note: '改判' });
    expect([again.status, reasonOf(again)]).toEqual([409, 'after_sale_closed']);
    const back = await resolve('o-r2', rid, { status: 'open' });
    expect([back.status, back.json['code']]).toEqual([400, 40001]);
  });

  it('结案必须写说明（40001 note_required）；申请不属于该订单 → 40400', async () => {
    await seedOrder('o-r3', 'delivered');
    await seedOrder('o-r4', 'delivered');
    const rid = String(((await apply(buyer, 'o-r3')).json['after_sale'] as { id: string }).id);
    const noNote = await resolve('o-r3', rid, { status: 'resolved' });
    expect([noNote.status, noNote.json['code']]).toEqual([400, 40001]);
    expect((await resolve('o-r4', rid, { status: 'processing' })).json['code']).toBe(40400);
  });

  it('没有售后申请时：管理端 after_sales 为空数组，买家详情不带 after_sale 键', async () => {
    await seedOrder('o-r5', 'delivered');
    expect((await call(admin, 'GET', '/api/v1/admin/orders/o-r5')).json['after_sales']).toEqual([]);
    expect((await call(buyer, 'GET', '/api/v1/orders/o-r5')).json).not.toHaveProperty('after_sale');
  });

  it('🔴 ADM-5（AJ-452）：处理售后写进订单时间线（after_sale_handled，actor=admin:<sub>，note 含结果与说明）', async () => {
    await seedOrder('o-ev', 'delivered');
    const rid = String(((await apply(buyer, 'o-ev')).json['after_sale'] as { id: string }).id);
    await resolve('o-ev', rid, { status: 'processing' });
    await resolve('o-ev', rid, { status: 'resolved', note: '已补发一件' });
    const ev = await db`select status, actor, note from order_events
                         where order_id = 'o-ev' and status = 'after_sale_handled' order by id`;
    expect(ev).toHaveLength(2);
    expect(ev[0]?.['actor']).toBe('admin:u-admin');
    expect(String(ev[0]?.['note'])).toContain('处理中');
    expect(String(ev[1]?.['note'])).toContain('已处理');
    expect(String(ev[1]?.['note'])).toContain('已补发一件');
    // 买家时间线只认订单状态值，这条伪状态不会外泄
    const buyerDetail = await call(buyer, 'GET', '/api/v1/orders/o-ev');
    expect(
      (buyerDetail.json['timeline'] as Array<{ status: string }>).map((t) => t.status),
    ).not.toContain('after_sale_handled');
  });
});
