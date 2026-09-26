/**
 * 职责：`adapters/orders.ts` 的真库用例（I1-U2，L1 层）——关单扫描的**边界、状态过滤、
 *      限量、行锁竞争**四个语义钉在真库上。
 *
 * @why 这批用例必须在真库：`FOR UPDATE SKIP LOCKED` 的"跳过"语义、`expires_at <= now` 的
 *      边界（含等号）、部分状态下的扫描过滤，没有一条能在假存储上验——而它们错任何一种，
 *      表现都是"某张真实的单被错误地关掉"或"该关的单永远不关"，不报错。
 *
 * @why 边界判定（含等号）单独成组：这是与 mark-paid 守卫**共享的语义**（可支付窗口
 *      `[created, expires_at)`），方向错一毫秒，"恰在到点瞬间付款"的单就会两边说法不一。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { lockExpiredPayableOrders, markOrderExpired } from './orders.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-exp', 'o-exp')`;
});

/** 造一张单：默认 created + 已到点。 */
async function seedOrder(
  id: string,
  over: { status?: string; expiresAt?: Date } = {},
): Promise<void> {
  const status = over.status ?? 'created';
  const expiresAt = over.expiresAt ?? new Date(NOW.getTime() - 1_000);
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, 'u-exp', ${status}, 1000, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', ${expiresAt})
  `;
}

describe('lockExpiredPayableOrders：状态过滤', () => {
  it('只取 created / pending_payment：paid / expired / cancelled 即使到点也不取', async () => {
    await seedOrder('o-created');
    await seedOrder('o-pending', { status: 'pending_payment' });
    await seedOrder('o-paid', { status: 'paid' });
    await seedOrder('o-expired', { status: 'expired' });
    await seedOrder('o-cancelled', { status: 'cancelled' });
    const ids = await lockExpiredPayableOrders(db, NOW, 100);
    expect(ids.sort()).toEqual(['o-created', 'o-pending']);
  });

  it('未到点的可支付单不取', async () => {
    await seedOrder('o-future', { expiresAt: new Date(NOW.getTime() + 60_000) });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual([]);
  });
});

describe('lockExpiredPayableOrders：边界（与 mark-paid 守卫共享语义）', () => {
  it('expires_at 恰好等于基准时刻 → 已到点（可支付窗口是 [created, expires_at)）', async () => {
    await seedOrder('o-edge', { expiresAt: NOW });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual(['o-edge']);
  });

  it('expires_at 晚基准 1ms → 未到点', async () => {
    await seedOrder('o-edge', { expiresAt: new Date(NOW.getTime() + 1) });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual([]);
  });
});

describe('lockExpiredPayableOrders：限量与顺序', () => {
  it('超量时按 expires_at 升序取最老的，剩余的留给下一轮', async () => {
    await seedOrder('o-1', { expiresAt: new Date(NOW.getTime() - 3_000) });
    await seedOrder('o-2', { expiresAt: new Date(NOW.getTime() - 1_000) });
    await seedOrder('o-3', { expiresAt: new Date(NOW.getTime() - 2_000) });
    const ids = await lockExpiredPayableOrders(db, NOW, 2);
    expect(ids).toEqual(['o-1', 'o-3']);
  });
});

describe('lockExpiredPayableOrders：SKIP LOCKED', () => {
  it('行锁被别人持有的单**跳过而不是等锁**（关单不能被一笔落账拖住整批）', async () => {
    await seedOrder('o-locked');
    await seedOrder('o-free');
    const other = testDb();
    try {
      // 外部事务持有 o-locked 的行锁（不提交）
      const holder = other.begin(async (tx) => {
        await tx`select id from orders where id = 'o-locked' for update`;
        await new Promise((r) => setTimeout(r, 300));
      });
      await new Promise((r) => setTimeout(r, 50));
      const ids = await lockExpiredPayableOrders(db, NOW, 100);
      expect(ids).toEqual(['o-free']);
      await holder;
    } finally {
      await closeDb(other);
    }
  });
});

describe('markOrderExpired', () => {
  it('关单 + 写审计事件（actor=system，时刻取传入基准而不是 DB now()）', async () => {
    await seedOrder('o-1');
    const ok = await markOrderExpired(db, 'o-1', NOW);
    expect(ok).toBe(true);
    const rows = await db`select status from orders where id = 'o-1'`;
    expect(rows[0]?.status).toBe('expired');
    const evs = await db`select status, actor, at from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(1);
    expect(evs[0]?.status).toBe('expired');
    expect(evs[0]?.actor).toBe('system');
    expect((evs[0]?.at as Date).toISOString()).toBe(NOW.toISOString());
  });

  it('状态已被迁走（如已 paid）→ 返回 false 且不写事件（不是错误，防幽灵关单）', async () => {
    await seedOrder('o-1', { status: 'paid' });
    const ok = await markOrderExpired(db, 'o-1', NOW);
    expect(ok).toBe(false);
    const evs = await db`select 1 from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(0);
  });

  it('重复关单：第二次返回 false、事件不翻倍（幂等）', async () => {
    await seedOrder('o-1');
    expect(await markOrderExpired(db, 'o-1', NOW)).toBe(true);
    expect(await markOrderExpired(db, 'o-1', NOW)).toBe(false);
    const evs = await db`select 1 from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(1);
  });
});
