/**
 * 职责：审核期测试单归档作业（剩余清单 3-4 / AJ-192 登记的待办）。
 * @why 审核期 mock 通道付的单（is_test）既不能发货（shipGuard）也不能退款（mock 下线后没有通道）——
 *      永远停在 paid，且**一直占着真实库存**。归档 = 迁 cancelled + 回补库存，留事件。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { createSchedulerDeps } from './scheduler-start.js';
import { runSchedulerOnce } from './scheduler.js';
import { ARCHIVE_TEST_ORDERS_JOB, createArchiveTestOrdersJob } from './archive-test-orders.js';

const NOW = new Date('2026-10-06T18:00:00.000Z');
const HOUR = 3_600_000;
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
  await db`insert into users (id, openid) values ('u-r', 'o-r')`;
  await db`insert into products (id, title, category, price_jpy, weight_g, stock, customs_desc_en, origin_country)
           values ('p-r', 'Cup', 'kitchen', 1000, 300, 5, 'Cup', 'JP')`;
});
afterEach(async () => {
  await db`delete from job_runs where name = 'archive-test'`;
});

async function seed(id: string, status: string, isTest: boolean, paidHoursAgo: number) {
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                               fx_snapshot, address_snapshot, terms_version, expires_at, is_test, paid_at)
           values (${id}, ${`NO-${id}`}, 'u-r', ${status}, 2000, 0, 0, 2000, 600, '{}'::jsonb, '{}'::jsonb, 'T',
                   ${NOW}, ${isTest}, ${new Date(NOW.getTime() - paidHoursAgo * HOUR)})`;
  await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
           values (${`oi-${id}`}, ${id}, 'p-r', 'Cup', 2, 1000, 300, 1340)`;
}

async function run(afterHours = 24) {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  await runSchedulerOnce(
    createSchedulerDeps(db, createEventBus(logger), fixedClock(NOW.toISOString()), logger, {
      name: 'archive-test',
      lockKey: 'archive-test',
    }),
    [createArchiveTestOrdersJob({ afterHours })],
  );
  return sink;
}

const status = async (id: string) =>
  String((await db`select status from orders where id = ${id}`)[0]?.['status']);
const stock = async () =>
  Number((await db`select stock from products where id = 'p-r'`)[0]?.['stock']);

describe('审核期测试单归档（3-4）', () => {
  it('🔴 is_test 且已付满 24 小时 → cancelled + cancelled_at + 事件（system，note=test_archived）+ 库存回补', async () => {
    await seed('o-old', 'paid', true, 25);
    const sink = await run();
    expect(await status('o-old')).toBe('cancelled');
    const [o] = await db`select cancelled_at from orders where id = 'o-old'`;
    expect((o?.['cancelled_at'] as Date).toISOString()).toBe(NOW.toISOString());
    const ev = await db`select status, note, actor from order_events where order_id = 'o-old'`;
    expect(ev.map((e) => ({ ...e }))).toEqual([
      { status: 'cancelled', note: 'test_archived', actor: 'system' },
    ]);
    expect(await stock()).toBe(7);
    expect(sink.find('test_orders_archived')[0]?.['count']).toBe(1);
  });

  it('不动：真实订单（is_test=false）、未满 24 小时的测试单、已不是 paid 的测试单', async () => {
    await seed('o-real', 'paid', false, 100);
    await seed('o-fresh', 'paid', true, 23);
    await seed('o-done', 'cancelled', true, 100);
    await run();
    expect(await status('o-real')).toBe('paid');
    expect(await status('o-fresh')).toBe('paid');
    expect(await status('o-done')).toBe('cancelled');
    expect(await stock()).toBe(5);
    expect(await db`select 1 from order_events`).toHaveLength(0);
  });

  it('跑两次只归档一次（库存不二次回补）', async () => {
    await seed('o-old', 'paid', true, 30);
    await run();
    await run();
    expect(await stock()).toBe(7);
    expect(await db`select 1 from order_events where order_id = 'o-old'`).toHaveLength(1);
  });

  it('作业名登记为常量（daily 列表与心跳共用）', () => {
    expect(ARCHIVE_TEST_ORDERS_JOB).toBe('archive_test_orders');
  });
});
