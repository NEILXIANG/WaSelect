/**
 * 职责：超时关单 job 的**接线级**真库用例（I1-U2，L1 层）——不验 SQL 细节
 *      （那在 adapters/orders.db.test.ts），验"插进调度器之后整条链是对的"：
 *      状态迁移真的发生、审计事件落库、`order.expired` 在**提交后**分发、
 *      心跳记录、幂等（第二轮 0 处理）、批量上限、与落账并发时跳过不阻塞。
 *
 * @why 走 `runSchedulerOnce` + `createSchedulerDeps` 而不是直接调 job.run：
 *      job 单跑验不出"savepoint 里的写入在整轮提交后才可见"与"事件在提交后才分发"
 *      ——这两个性质恰恰是 scheduler 接线（而不是 job 本身）提供的（F13 既定验收形态）。
 *
 * @see app/expire-orders.ts（被测）；app/scheduler-start.db.test.ts（接线测试的模板）；
 *      adapters/orders.db.test.ts（SQL 语义）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { runSchedulerOnce } from './scheduler.js';
import type { SchedulerTickResult } from '../ports/scheduler.js';
import { createSchedulerDeps } from './scheduler-start.js';
import { createExpireOrdersJob, EXPIRE_ORDERS_JOB } from './expire-orders.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');
/** 固定时钟：判定基准必须钉死，"到点/未到点"才可断言。 */
const clock: Clock = { now: () => NOW };

let db: Db;
const sink = new MemorySink();

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await db`delete from job_runs where name = ${EXPIRE_ORDERS_JOB}`;
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink.clear();
  await db`insert into users (id, openid) values ('u-exj', 'o-exj')`;
});

async function seedOrder(id: string, status: string, expiresAt: Date): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, 'u-exj', ${status}, 1000, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', ${expiresAt})
  `;
}

function makeDeps() {
  const logger = createLogger({ env: 'test', destination: sink });
  const bus = createEventBus(logger);
  return { bus, deps: createSchedulerDeps(db, bus, clock, logger, { name: EXPIRE_ORDERS_JOB }) };
}

async function statusOf(id: string): Promise<string> {
  const rows = await db`select status from orders where id = ${id}`;
  return String(rows[0]?.status);
}

/** 取第一个 job 的 processed（判别联合必须先收窄：失败分支没有 processed 字段）。 */
function processedOf(r: SchedulerTickResult): number {
  if (!r.acquired) throw new Error('本轮未抢到锁');
  const j = r.jobs[0];
  if (j === undefined || !j.ok)
    throw new Error(`job 失败：${j?.ok === false ? j.error : '无结果'}`);
  return j.processed;
}

describe('expire-orders job（接线级）', () => {
  it('到点未支付的单被关掉：状态、审计事件、order.expired 分发三件套齐全；未到点与已支付不动', async () => {
    await seedOrder('o-due', 'created', new Date(NOW.getTime() - 1_000));
    await seedOrder('o-due-pending', 'pending_payment', new Date(NOW.getTime() - 2_000));
    await seedOrder('o-fresh', 'created', new Date(NOW.getTime() + 60_000));
    await seedOrder('o-paid', 'paid', new Date(NOW.getTime() - 5_000));

    const { bus, deps } = makeDeps();
    const expired: string[] = [];
    bus.subscribe('order.expired', (e) => expired.push(String(e.orderId)));

    const r = await runSchedulerOnce(deps, [createExpireOrdersJob()]);

    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(r.ok).toBe(true);
    expect(processedOf(r)).toBe(2);
    expect(await statusOf('o-due')).toBe('expired');
    expect(await statusOf('o-due-pending')).toBe('expired');
    expect(await statusOf('o-fresh')).toBe('created');
    expect(await statusOf('o-paid')).toBe('paid');
    // 审计事件（流 B）逐单落库
    const evs = await db`
      select order_id from order_events where status = 'expired' order by order_id`;
    expect(evs.map((e) => String(e.order_id))).toEqual(['o-due', 'o-due-pending']);
    // 领域事件在提交后分发（runSchedulerOnce 返回时已可断言）
    expect(expired.sort()).toEqual(['o-due', 'o-due-pending']);
  });

  it('关单回补库存：到点关单后 products.stock 回到扣减前；第二轮不再回血（全量审计 M20）', async () => {
    // @why 关单 job 里删掉 restoreStockForOrder 时既有用例全绿——"到点关单 → 库存永久少一件"
    //      是静默事故，必须由库存数字钉住。
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values ('p-exj', 'Probe', 'kitchen', 1000, 100, 3, 'JP', 'active')
    `;
    await seedOrder('o-restock', 'created', new Date(NOW.getTime() - 1_000));
    await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, declared_value_usd)
             values ('oi-exj', 'o-restock', 'p-exj', 'Probe', 2, 1000, 700)`;
    await db`update products set stock = 1 where id = 'p-exj'`; // 建单时扣掉了 2
    const { deps } = makeDeps();
    await runSchedulerOnce(deps, [createExpireOrdersJob()]);
    expect(await statusOf('o-restock')).toBe('expired');
    const after = await db`select stock from products where id = 'p-exj'`;
    expect(Number(after[0]?.stock)).toBe(3);
    await runSchedulerOnce(deps, [createExpireOrdersJob()]);
    const again = await db`select stock from products where id = 'p-exj'`;
    expect(Number(again[0]?.stock)).toBe(3);
  });

  it('幂等：第二轮处理 0 单、审计事件不翻倍', async () => {
    await seedOrder('o-due', 'created', new Date(NOW.getTime() - 1_000));
    const { deps } = makeDeps();
    const job = createExpireOrdersJob();
    await runSchedulerOnce(deps, [job]);
    const r2 = await runSchedulerOnce(deps, [job]);
    expect(r2.acquired).toBe(true);
    if (!r2.acquired) return;
    expect(processedOf(r2)).toBe(0);
    const evs = await db`select 1 from order_events where order_id = 'o-due'`;
    expect(evs).toHaveLength(1);
  });

  it('批量上限：超出部分留给下一轮（单轮事务时长有上界）', async () => {
    await seedOrder('o-1', 'created', new Date(NOW.getTime() - 3_000));
    await seedOrder('o-2', 'created', new Date(NOW.getTime() - 2_000));
    await seedOrder('o-3', 'created', new Date(NOW.getTime() - 1_000));
    const { deps } = makeDeps();
    const r = await runSchedulerOnce(deps, [createExpireOrdersJob({ batchLimit: 2 })]);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(processedOf(r)).toBe(2);
    // 最老的两张被关，最新那张等下一轮
    expect(await statusOf('o-1')).toBe('expired');
    expect(await statusOf('o-2')).toBe('expired');
    expect(await statusOf('o-3')).toBe('created');
  });

  it('心跳：job_runs 记下成功（看门狗的依据）', async () => {
    const { deps } = makeDeps();
    await runSchedulerOnce(deps, [createExpireOrdersJob()]);
    const rows =
      await db`select last_success_at, last_error from job_runs where name = ${EXPIRE_ORDERS_JOB}`;
    expect(rows[0]?.last_success_at).toBeInstanceOf(Date);
    expect(rows[0]?.last_error).toBeNull();
  });

  it('与落账并发：行锁被持有的单本轮跳过（不阻塞），下一轮再关', async () => {
    await seedOrder('o-race', 'created', new Date(NOW.getTime() - 1_000));
    const other = testDb();
    try {
      const holder = other.begin(async (tx) => {
        await tx`select id from orders where id = 'o-race' for update`;
        await new Promise((r) => setTimeout(r, 300));
      });
      await new Promise((r) => setTimeout(r, 50));

      const { deps } = makeDeps();
      const r1 = await runSchedulerOnce(deps, [createExpireOrdersJob()]);
      await holder;
      expect(r1.acquired).toBe(true);
      if (!r1.acquired) return;
      // 被跳过了：本轮 0 处理，单还活着（没有被错误地等锁拖到超时，也没有被强行关掉）
      expect(processedOf(r1)).toBe(0);
      expect(await statusOf('o-race')).toBe('created');

      // 锁释放后的下一轮：正常关掉
      const { deps: deps2 } = makeDeps();
      await runSchedulerOnce(deps2, [createExpireOrdersJob()]);
      expect(await statusOf('o-race')).toBe('expired');
    } finally {
      await closeDb(other);
    }
  });
});
