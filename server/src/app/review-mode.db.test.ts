/**
 * 职责：**审核模式闸门三件套**（技术文档 §2.9；提审前 P1 阻断项；AJ-179）——生产装配（`mountAllRoutes`）+ 真库。
 *   ① 只有 `REVIEW_SKU_ID` 能下单；② 审核期建的单一律 `is_test=true`；③ mock 发起支付后服务端**自动确认**。
 *
 * @why 此前三项只有配置层形状校验：小程序见 `auto:true` 就显示「支付已完成」，订单实际停在待付款直到过期——
 *      审核员看到的是"付了款、订单却是待付款"，而这正是最容易被判"功能不可用"的形态。
 * @why 自动确认走**真回调管线**（通道自签报文 → parseWebhook 验签 → handleProviderCallback → mark-paid），
 *      不另写一条"直接改 paid"的捷径：捷径会绕开金额/机构单号核对与去重登记，
 *      审核期验到的就不是生产要走的那条路。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  orderBody,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

const REVIEW = { REVIEW_MODE: 'on', REVIEW_SKU_ID: 'p-cup' };

let db: Db;
let srv: ChainServer;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
});

afterEach(async () => {
  await srv.close();
});

async function createOrder(items: unknown, key: string) {
  return call(srv, 'POST', '/api/v1/orders', {
    token: await tokenFor('u-1'),
    key,
    body: orderBody('addr-1', { items }),
  });
}

async function payMock(orderId: string, key: string) {
  return call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
    token: await tokenFor('u-1'),
    key,
    body: { channel: 'mock' },
  });
}

async function orderRow(orderId: string) {
  const [o] = await db`select status, is_test from orders where id = ${orderId}`;
  return { status: String(o?.['status']), isTest: o?.['is_test'] === true };
}

describe('审核模式（REVIEW_MODE=on）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db, REVIEW);
  });

  it('① 含非审核 SKU 的单 → 40401 整单拒（库存不动、不落单）；只含审核 SKU → 201 且 ② is_test=true', async () => {
    const rejected = await createOrder(
      [
        { product_id: 'p-cup', qty: 1 },
        { product_id: 'p-knife', qty: 1 },
      ],
      'rv-1',
    );
    expect(rejected.status).toBe(404);
    expect(rejected.json['code']).toBe(40401);
    expect(await db`select 1 from orders`).toHaveLength(0);
    const [knife] = await db`select stock from products where id = 'p-knife'`;
    expect(knife?.['stock']).toBe(5);
    const warned = srv.sink.find('order_review_sku_rejected');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain('p-knife');

    const ok = await createOrder([{ product_id: 'p-cup', qty: 1 }], 'rv-2');
    expect(ok.status).toBe(201);
    expect(await orderRow(String(ok.json['order_id']))).toEqual({
      status: 'created',
      isTest: true,
    });
  });

  it('③ mock 发起支付 → 响应 auto=true 时订单**已经** paid；落账经真回调管线（确定性 event_id、result=paid）', async () => {
    const created = await createOrder([{ product_id: 'p-cup', qty: 1 }], 'rv-3');
    const orderId = String(created.json['order_id']);
    const pay = await payMock(orderId, 'rv-pay-3');
    expect(pay.status).toBe(200);
    expect((pay.json['payload'] as Record<string, unknown>)['auto']).toBe(true);
    expect((await orderRow(orderId)).status).toBe('paid');

    const [p] = await db`select provider_ref, status from payments where order_id = ${orderId}`;
    expect(p?.['status']).toBe('succeeded');
    const hooks = await db`select event_id, provider, result from webhook_events`;
    expect(hooks).toEqual([
      { event_id: `auto:${String(p?.['provider_ref'])}`, provider: 'mock', result: 'paid' },
    ]);
    expect(srv.sink.find('pay_auto_confirmed')).toHaveLength(1);

    // 同键重放：回存的响应，不再建意图；登记表仍只有一行（没有第二次落账）
    const replay = await payMock(orderId, 'rv-pay-3');
    expect(replay.status).toBe(200);
    expect(await db`select 1 from webhook_events`).toHaveLength(1);
  });

  it('测试单付款后管理员点发货 → 409 / 40902（审核期测试单永不发货：假付款 + 真发货 = 白送）', async () => {
    const created = await createOrder([{ product_id: 'p-cup', qty: 1 }], 'rv-5');
    const orderId = String(created.json['order_id']);
    await payMock(orderId, 'rv-pay-5');
    expect((await orderRow(orderId)).status).toBe('paid');
    const ship = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/ship`, {
      token: await tokenFor('u-admin', 'admin'),
      key: 'rv-ship-5',
      body: { carrier: 'JPPOST', tracking_no: 'EJ123456789JP' },
    });
    expect(ship.status).toBe(409);
    expect(ship.json['code']).toBe(40902);
    expect((await orderRow(orderId)).status).toBe('paid');
  });

  it('第二道防线：订单不是测试单（is_test=false）→ 拒绝自动确认，订单停在待付款 + error 日志', async () => {
    const created = await createOrder([{ product_id: 'p-cup', qty: 1 }], 'rv-4');
    const orderId = String(created.json['order_id']);
    await db`update orders set is_test = false where id = ${orderId}`;
    const pay = await payMock(orderId, 'rv-pay-4');
    expect(pay.status).toBe(200);
    expect((await orderRow(orderId)).status).toBe('pending_payment');
    expect(await db`select 1 from webhook_events`).toHaveLength(0);
    expect(srv.sink.find('pay_auto_confirm_refused')).toHaveLength(1);
  });
});

describe('非审核模式（REVIEW_MODE=off）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db);
  });

  it('任何在售商品都能下单且 is_test=false；mock 的 auto=false、服务端不自动确认（等机构回调）', async () => {
    const created = await createOrder(
      [
        { product_id: 'p-cup', qty: 1 },
        { product_id: 'p-knife', qty: 1 },
      ],
      'nr-1',
    );
    expect(created.status).toBe(201);
    const orderId = String(created.json['order_id']);
    expect((await orderRow(orderId)).isTest).toBe(false);

    const pay = await payMock(orderId, 'nr-pay-1');
    expect(pay.status).toBe(200);
    expect((pay.json['payload'] as Record<string, unknown>)['auto']).toBe(false);
    expect((await orderRow(orderId)).status).toBe('pending_payment');
    expect(await db`select 1 from webhook_events`).toHaveLength(0);
  });
});
