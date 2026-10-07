/**
 * 职责：`POST /orders/{id}/confirm-receipt`——买家确认收货（第三轮缺口 P2-13，AJ-387）。真库 + 生产装配。
 * @why 原先只有"发货 30 天后自动签收"一条路：货早到了，售后窗口也要多挂 3 周多，
 *      运营看到的"已发货"里混着大量其实已签收的单。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

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
  await db`insert into users (id, openid) values ('u-b', 'o-b'), ('u-x', 'o-x')`;
  srv = await buildChainServer(db);
});
afterEach(async () => {
  await srv.close();
});

async function seed(id: string, status: string, hasDispute = false) {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                        weight_g, fx_snapshot, address_snapshot, terms_version, expires_at,
                        carrier, tracking_no, shipped_at, has_dispute)
    values (${id}, ${`WS${id}`}, 'u-b', ${status}, 12800, 4950, null, 17750, 900, '{}'::jsonb, '{}'::jsonb,
            'T', now(), 'EMS', 'EM123456789JP', now() - interval '5 days', ${hasDispute})`;
}
const confirm = async (id: string, sub = 'u-b') =>
  call(srv, 'POST', `/api/v1/orders/${id}/confirm-receipt`, { token: await tokenFor(sub) });

describe('POST /orders/{id}/confirm-receipt（P2-13）', () => {
  it('🔴 shipped → 200 delivered：写 delivered_at、事件 actor=买家', async () => {
    await seed('o-1', 'shipped');
    const r = await confirm('o-1');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ order_id: 'o-1', status: 'delivered' });
    const [o] = await db`select status, delivered_at from orders where id = 'o-1'`;
    expect(o?.['status']).toBe('delivered');
    expect(o?.['delivered_at']).not.toBeNull();
    const ev =
      await db`select actor, note from order_events where order_id = 'o-1' and status = 'delivered'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]?.['actor']).toBe('user:u-b');
  });

  it('🔴 已签收 / 已完成 → 200 原样（重复点不报错、不多写事件）', async () => {
    await seed('o-2', 'delivered');
    await seed('o-3', 'completed');
    expect((await confirm('o-2')).json).toEqual({ order_id: 'o-2', status: 'delivered' });
    expect((await confirm('o-3')).json).toEqual({ order_id: 'o-3', status: 'completed' });
    expect(await db`select 1 from order_events where order_id in ('o-2','o-3')`).toHaveLength(0);
  });

  it('🔴 未发货 / 退款中 / 有拒付限制 → 409 40902，状态不动', async () => {
    await seed('o-4', 'paid');
    await seed('o-5', 'refunding');
    await seed('o-6', 'shipped', true);
    for (const id of ['o-4', 'o-5', 'o-6']) {
      const r = await confirm(id);
      expect(r.status, id).toBe(409);
      expect(r.json['code']).toBe(40902);
    }
    const [o6] = await db`select status from orders where id = 'o-6'`;
    expect(o6?.['status']).toBe('shipped');
  });

  it('别人的单 / 不存在 → 40400（不泄露存在性）', async () => {
    await seed('o-7', 'shipped');
    expect((await confirm('o-7', 'u-x')).json['code']).toBe(40400);
    expect((await confirm('o-ghost')).json['code']).toBe(40400);
    const [o] = await db`select status from orders where id = 'o-7'`;
    expect(o?.['status']).toBe('shipped');
  });
});
