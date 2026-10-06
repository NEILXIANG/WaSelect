/**
 * 职责：**自动签收 / 自动完成**两个每日作业（PRD P0：发货 30 天自动签收、签收 7 天自动完成，D-39；O-12 / AJ-182）。
 *
 * @why 此前两项只有配置（AUTO_DELIVER_DAYS / AUTO_COMPLETE_DAYS）没有消费方：已发货订单永远停在 shipped，
 *      售后窗口永远不关，"已完成"这个状态在生产上从来不会出现——而 PRD 把它列为 P0。
 * @why 边界钉在**注入时钟**上（fixedClock）：阈值取"含等号"——恰好满 N 天即到期（与关单 expires_at 同口径）。
 * @why 拒付中的单两个作业都不碰：拒付未决时"签收 / 完成"会关掉售后与举证的窗口，那要人判断。
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
import type { SchedulerJob } from '../ports/scheduler.js';
import {
  AUTO_COMPLETE_JOB,
  AUTO_DELIVER_JOB,
  createAutoCompleteJob,
  createAutoDeliverJob,
} from './auto-fulfilment.js';

const NOW = new Date('2026-10-31T03:00:00.000Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

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
  await db`insert into users (id, openid) values ('u-f', 'o-f')`;
});

afterEach(async () => {
  // 心跳行不在 resetTestDb 清空范围内（D-45），不删会遗传给别的测试文件（chain-server runExpireJob 同口径）
  await db`delete from job_runs where name in (${AUTO_DELIVER_JOB}, ${AUTO_COMPLETE_JOB}, 'fulfil-test')`;
});

async function seed(
  id: string,
  status: string,
  at: { shipped?: Date; delivered?: Date },
  dispute = false,
) {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                        weight_g, fx_snapshot, address_snapshot, terms_version, expires_at,
                        shipped_at, delivered_at, has_dispute)
    values (${id}, ${`NO-${id}`}, 'u-f', ${status}, 1000, 0, 0, 1000, 500, '{}'::jsonb, '{}'::jsonb,
            'T', ${ago(40 * DAY)}, ${at.shipped ?? null}, ${at.delivered ?? null}, ${dispute})`;
}

async function run(jobs: SchedulerJob<Db>[]) {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  await runSchedulerOnce(
    createSchedulerDeps(db, createEventBus(logger), fixedClock(NOW.toISOString()), logger, {
      name: 'fulfil-test',
      lockKey: 'fulfil-test',
    }),
    jobs,
  );
  return sink;
}

async function state(id: string) {
  const [o] = await db`select status, delivered_at, completed_at from orders where id = ${id}`;
  const ev = await db`
    select status, note, actor, at from order_events where order_id = ${id} order by id`;
  return { status: String(o?.['status']), o, ev };
}

describe('自动签收（shipped → delivered，AUTO_DELIVER_DAYS）', () => {
  it('恰好满 30 天到期、差 1 秒不到期；拒付中不碰；事件 actor=system、时刻来自注入时钟', async () => {
    await seed('o-due', 'shipped', { shipped: ago(30 * DAY) });
    await seed('o-early', 'shipped', { shipped: ago(30 * DAY - 1000) });
    await seed('o-dispute', 'shipped', { shipped: ago(60 * DAY) }, true);
    const sink = await run([createAutoDeliverJob({ afterDays: 30 })]);

    const due = await state('o-due');
    expect(due.status).toBe('delivered');
    expect((due.o?.['delivered_at'] as Date).toISOString()).toBe(NOW.toISOString());
    expect(due.ev).toHaveLength(1);
    expect(due.ev[0]).toMatchObject({ status: 'delivered', actor: 'system', note: 'auto:30d' });
    expect((due.ev[0]?.['at'] as Date).toISOString()).toBe(NOW.toISOString());

    expect((await state('o-early')).status).toBe('shipped');
    expect((await state('o-dispute')).status).toBe('shipped');
    expect(sink.find('orders_auto_delivered')[0]?.['count']).toBe(1);
  });
});

/**
 * 剩余清单 2-1：自动签收发 `order.delivered`（提交后分发），供通知 / 日志订阅。
 * @why 签收是"售后窗口开始计时"的业务事实，此前只写了 order_events，没人能订阅它。
 */
describe('自动签收发出 order.delivered 事件（2-1）', () => {
  it('🔴 迁走一单就发一条，带 orderId；不到期的单不发', async () => {
    await seed('o-due', 'shipped', { shipped: ago(30 * DAY) });
    await seed('o-early', 'shipped', { shipped: ago(30 * DAY - 1000) });
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const bus = createEventBus(logger);
    const got: Array<string | undefined> = [];
    bus.subscribe('order.delivered', (e) => got.push(e.orderId));
    await runSchedulerOnce(
      createSchedulerDeps(db, bus, fixedClock(NOW.toISOString()), logger, {
        name: 'fulfil-test',
        lockKey: 'fulfil-test',
      }),
      [createAutoDeliverJob({ afterDays: 30 })],
    );
    expect(got).toEqual(['o-due']);
  });
});

describe('自动完成（delivered → completed，AUTO_COMPLETE_DAYS）', () => {
  it('恰好满 7 天到期、差 1 秒不到期；拒付中不碰；只迁 delivered（不越级迁 shipped）', async () => {
    await seed('o-due', 'delivered', { shipped: ago(40 * DAY), delivered: ago(7 * DAY) });
    await seed('o-early', 'delivered', { shipped: ago(40 * DAY), delivered: ago(7 * DAY - 1000) });
    await seed('o-dispute', 'delivered', { shipped: ago(40 * DAY), delivered: ago(9 * DAY) }, true);
    await seed('o-shipped', 'shipped', { shipped: ago(1 * DAY) });
    const sink = await run([createAutoCompleteJob({ afterDays: 7 })]);

    const due = await state('o-due');
    expect(due.status).toBe('completed');
    expect((due.o?.['completed_at'] as Date).toISOString()).toBe(NOW.toISOString());
    expect(due.ev[0]).toMatchObject({ status: 'completed', actor: 'system', note: 'auto:7d' });
    expect((await state('o-early')).status).toBe('delivered');
    expect((await state('o-dispute')).status).toBe('delivered');
    expect((await state('o-shipped')).status).toBe('shipped');
    expect(sink.find('orders_auto_completed')[0]?.['count']).toBe(1);
  });

  it('同一轮先签收后完成：刚被自动签收的单不会在同一轮被连带完成（delivered_at = 本轮时刻）', async () => {
    await seed('o-old', 'shipped', { shipped: ago(90 * DAY) });
    await run([createAutoDeliverJob({ afterDays: 30 }), createAutoCompleteJob({ afterDays: 7 })]);
    expect((await state('o-old')).status).toBe('delivered');
  });
});
