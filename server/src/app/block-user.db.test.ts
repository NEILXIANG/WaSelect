/**
 * 职责：**拉黑用例**的真库用例（B28 / AJ-213）——封号与"连带取消在途单"必须**同一个事务**。
 *
 * @why 这一组存在的理由（而不是把它并进 `risk-admin.db.test.ts`）：
 *      B28 之前拉黑只写 `blocked_at` + `token_ver+1`，被拉黑者手上的 `pending_payment` 单
 *      **在支付窗口内照样能付**（`/pay/link` 不鉴权）→ 付款后进 `paid` → 运营把货发给
 *      一个已知的拒付滥用者。修的是"封号"与"关掉他的单"之间的**接缝**，
 *      而接缝只有在真库、真事务、真事件总线上才验得出来。
 *
 * @why 用例清单里刻意留了两条**反向对照**（第 8、9 条）：
 *      ① 只调仓储（不经用例）→ 单必须**还在** pending_payment
 *         （防止"取消其实写在仓储里、用例只是转调"这种假象）；
 *      ② 拉黑之后真去落账 → 必须是 `late_payment`
 *         （证明"关掉单"真的带来了下游闭环，而不只是多了一个状态值）。
 *      没有这两条，"拉黑会取消在途单"可以被任意一种实现方式骗过。
 *
 * @see app/block-user.ts（被测）；adapters/risk-admin.ts（封号 SQL）；
 *      app/close-session-events.ts（`order.cancelled` 的订阅者：作废机构会话）；
 *      app/mark-paid.ts @limitation 一b（迟到付款：本用例的下游）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createRiskAdminRepo } from '../adapters/risk-admin.js';
import { blockUser, type BlockUserResult } from './block-user.js';
import { markOrderPaid } from './mark-paid.js';
import type { PaidSettlement } from './mark-paid.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');
const clock = fixedClock(NOW.toISOString());

let db: Db;
const sink = new MemorySink();

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink.clear();
  await db`insert into users (id, openid) values ('u-b', 'o-b')`;
});

/** 造一件商品并把库存按"建单已扣"改掉，返回扣减后的值。 */
async function seedProduct(pid: string, stock: number, qtySold: number): Promise<void> {
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values (${pid}, ${`Probe ${pid}`}, 'kitchen', 1000, 100, ${stock}, 'JP', 'active')
  `;
  await db`update products set stock = ${stock - qtySold} where id = ${pid}`;
}

async function seedOrder(id: string, status: string): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, 'u-b', ${status}, 1000, 0, 0, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', ${new Date(NOW.getTime() + 30 * 60_000)})
  `;
}

async function seedItem(oi: string, orderId: string, pid: string, qty: number): Promise<void> {
  await db`
    insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, declared_value_usd)
    values (${oi}, ${orderId}, ${pid}, ${`Probe ${pid}`}, ${qty}, 1000, 700)
  `;
}

async function seedInitiatedPayment(payId: string, orderId: string): Promise<void> {
  await db`
    insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
    values (${payId}, ${orderId}, 'stripe', 'initiated', 'USD', 1000)
  `;
}

function makeDeps() {
  const logger = createLogger({ env: 'test', destination: sink });
  // ⚠️ 必须**共用同一个总线实例**：各造一个的话，订阅者挂在 A 上、事件发到 B 上，
  //    "事件被分发"这条断言会永远绿（[] 就等于"没收到"，而没人会发现）。
  const events = createEventBus(logger);
  return { logger, events, deps: { db, events, clock, logger, repo: createRiskAdminRepo(db) } };
}

/** 收窄判别联合：不是 `blocked` 就把测试打红（漏掉这条会让"没封上"静默通过）。 */
function blocked(out: BlockUserResult): { already: boolean; cancelledOrderIds: string[] } {
  if (out.kind !== 'blocked') throw new Error(`期望 blocked，实际 ${out.kind}`);
  return { already: out.already, cancelledOrderIds: out.cancelledOrderIds };
}

async function statusOf(id: string): Promise<string> {
  const rows = await db`select status from orders where id = ${id}`;
  return String(rows[0]?.['status']);
}

async function stockOf(pid: string): Promise<number> {
  const rows = await db`select stock from products where id = ${pid}`;
  return Number(rows[0]?.['stock']);
}

const SETTLEMENT: PaidSettlement = {
  provider: 'stripe',
  channel: 'stripe',
  providerRef: 'ch_1',
  currency: 'USD',
  amountMinor: 1000,
} as unknown as PaidSettlement;

describe('blockUser（B28 / AJ-213）', () => {
  it('🔴 在途单被连带取消：created 与 pending_payment 两张都变 cancelled', async () => {
    await seedProduct('p-b-a', 10, 2);
    await seedProduct('p-b-z', 10, 3);
    await seedOrder('o-a', 'created');
    await seedOrder('o-b', 'pending_payment');
    // 交叉装配（o-a 拿 z、o-b 拿 a）：批量回补若把"单→商品"映射串了，这里就会串
    await seedItem('oi-1', 'o-a', 'p-b-z', 3);
    await seedItem('oi-2', 'o-b', 'p-b-a', 2);

    const { deps } = makeDeps();
    const out = await blockUser(deps, 'u-b');
    expect(blocked(out).cancelledOrderIds.sort()).toEqual(['o-a', 'o-b']);
    expect(await statusOf('o-a')).toBe('cancelled');
    expect(await statusOf('o-b')).toBe('cancelled');
  });

  it('🔴 库存回补到扣减前，且**每个商品各自**回对（批量回补的映射没串）', async () => {
    await seedProduct('p-b-a', 10, 2);
    await seedProduct('p-b-z', 10, 3);
    await seedOrder('o-a', 'created');
    await seedOrder('o-b', 'pending_payment');
    await seedItem('oi-1', 'o-a', 'p-b-z', 3);
    await seedItem('oi-2', 'o-b', 'p-b-a', 2);

    const { deps } = makeDeps();
    await blockUser(deps, 'u-b');
    expect(await stockOf('p-b-a')).toBe(10);
    expect(await stockOf('p-b-z')).toBe(10);
  });

  it('🔴 已付单**不**被取消，它的库存也**不**回补（已付的钱只能走退款链路）', async () => {
    await seedProduct('p-b-p', 10, 1);
    await seedOrder('o-paid', 'paid');
    await seedItem('oi-p', 'o-paid', 'p-b-p', 1);

    const { deps } = makeDeps();
    const out = await blockUser(deps, 'u-b');
    expect(blocked(out).cancelledOrderIds).toEqual([]);
    expect(await statusOf('o-paid')).toBe('paid');
    expect(await stockOf('p-b-p')).toBe(9); // 还在用户手上，不能回血
  });

  it('🔴 幂等：重复拉黑 already=true，库存**不再**回血（回补不幂等，回两次 = 凭空多出库存）', async () => {
    await seedProduct('p-b-a', 10, 2);
    await seedOrder('o-a', 'created');
    await seedItem('oi-1', 'o-a', 'p-b-a', 2);

    const { deps } = makeDeps();
    const first = await blockUser(deps, 'u-b');
    expect(blocked(first).already).toBe(false);
    expect(await stockOf('p-b-a')).toBe(10);

    const second = await blockUser(deps, 'u-b');
    expect(blocked(second).already).toBe(true);
    expect(blocked(second).cancelledOrderIds).toEqual([]);
    expect(await stockOf('p-b-a')).toBe(10);
  });

  it('🔴 `order.cancelled` 真的被分发（提交后），订阅者能读到已提交的状态', async () => {
    await seedOrder('o-a', 'created');
    await seedOrder('o-b', 'pending_payment');
    const { deps, events } = makeDeps();
    const seen: string[] = [];
    // 订阅者里**新开一个连接**去读：能读到 cancelled 才证明事件是在提交**之后**分发的
    events.subscribe('order.cancelled', async (e) => {
      const id = e.orderId ?? '';
      seen.push(id);
      expect(await statusOf(id)).toBe('cancelled');
    });

    await blockUser(deps, 'u-b');
    expect(seen.sort()).toEqual(['o-a', 'o-b']);
  });

  it('🔴 在途支付行被作废：initiated → cancelled（短链因此拿不到 pay_url）', async () => {
    await seedOrder('o-b', 'pending_payment');
    await seedInitiatedPayment('pay-b', 'o-b');
    const { deps } = makeDeps();
    await blockUser(deps, 'u-b');
    const rows = await db`select status from payments where id = 'pay-b'`;
    expect(String(rows[0]?.['status'])).toBe('cancelled');
  });

  it('🔴 订单时间线写 actor=admin:block（审计要答得出"是谁关的"，不能显示成用户自己取消）', async () => {
    await seedOrder('o-a', 'created');
    const { deps } = makeDeps();
    await blockUser(deps, 'u-b');
    const ev =
      await db`select status, actor from order_events where order_id = 'o-a' and status = 'cancelled'`;
    expect(String(ev[0]?.['actor'])).toBe('admin:block');
  });

  it('🔴 下游闭环：拉黑之后那笔钱到账 → 40902 late_payment（不是照常落账）', async () => {
    await seedOrder('o-b', 'pending_payment');
    await seedInitiatedPayment('pay-b', 'o-b');
    const { deps } = makeDeps();
    await blockUser(deps, 'u-b');

    await expect(markOrderPaid(db, deps.events, clock, 'o-b', SETTLEMENT)).rejects.toMatchObject({
      code: 40902,
      details: { reason: 'late_payment' },
    });
    expect(await statusOf('o-b')).toBe('cancelled');
  });

  it('反向对照：**不经用例**、只调仓储封号 → 在途单**仍在** pending_payment（取消不在仓储里）', async () => {
    // @why 少了这条，"拉黑会取消在途单"可能被实现成"仓储的 update 里顺手做"，
    //      那样就绕过了事务边界与事件分发（机构会话不会作废）——而所有正向用例照样全绿。
    await seedOrder('o-b', 'pending_payment');
    const out = await createRiskAdminRepo(db).blockUser(db, 'u-b');
    expect(out).toEqual({ kind: 'blocked', already: false });
    expect(await statusOf('o-b')).toBe('pending_payment');
  });
});
