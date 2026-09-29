/**
 * 职责：**落账事务中途数据库故障**（测试审查第二轮补测，AJ-175）——回调打进来，
 *      `markOrderPaid` 已改了订单、写了事件，最后一步写支付行时库报错：
 *      断言整笔回滚、领域事件不分发、机构拿到 5xx、租约挡住紧随其后的重投、
 *      租约过期后的重投把单补上且只补一次；以及"再也没人重投"时对账作业把它捞出来。
 *
 * @why 此前的失败链路测试只覆盖**业务拒绝**（40400/40902：金额不符、状态冲突），
 *      它们在进事务前或第一条写之前就抛了——"写到一半库挂了"这一类从没被触发过。
 *      而它正是 `withUnitOfWork`"提交后才分发"与回调租约设计要防的场景：
 *      半截提交 = 订单已付而支付行未封口（对账口径分裂）；提交前分发 = 通知了用户"已付款"而库里没付。
 * @why 故障用**真 Postgres 触发器**注入（`before update on payments` 抛 53100 disk_full），
 *      而不是 mock 数据库：只有真库才能证明"前两条写真的被回滚了"。
 *      触发器挂在独立 schema `fault_inj` 的开关表上，默认关，用例只在需要的那一刻打开。
 *
 * @limitation 一：故障点选了两处——事务里**最后一条写**（最能暴露半截提交）与 **COMMIT 本身**
 *              （延迟约束触发器，最能暴露"提交前分发"）；前两条写失败是前者的子集。
 * @limitation 二："租约过期"通过把 `processing_until` 改到过去来模拟（真实等待 10 秒会拖慢套件），
 *              租约长度本身由 webhooks.db.test.ts 覆盖。
 * @limitation 三：触发器与 schema 在 afterAll 删除；进程被杀时残留会在下次 beforeAll 先清掉。
 *
 * @see app/mark-paid.ts；app/pay-callback.ts @limitation 三；app/daily-reconciliation.ts（unfinished_callbacks）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  domainEvents,
  mockCallback,
  orderBody,
  reconciliationSample,
  runDailyReconciliation,
  seedChainFixture,
  snapshotState,
  tokenFor,
  waitUntil,
  withoutWebhooks,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

let db: Db;

async function dropFaultInfra(): Promise<void> {
  await db`drop trigger if exists fault_payments_succeeded on payments`;
  await db`drop trigger if exists fault_commit_payments on payments`;
  await db`drop schema if exists fault_inj cascade`;
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  await dropFaultInfra();
  await db`create schema fault_inj`;
  await db`create table fault_inj.flags (name text primary key)`;
  await db.unsafe(`
    create function fault_inj.fail_payment_succeeded() returns trigger language plpgsql as $$
    begin
      if new.status = 'succeeded' and exists (select 1 from fault_inj.flags where name = 'payments_succeeded') then
        raise exception 'injected fault: payments succeeded write' using errcode = '53100';
      end if;
      return new;
    end $$`);
  await db`
    create trigger fault_payments_succeeded before update on payments
    for each row execute function fault_inj.fail_payment_succeeded()`;
  // 第二个故障点：**COMMIT 那一刻**才失败（延迟约束触发器在提交时执行）——
  // 此时事务体已经跑完、`emit` 已经登记了 order.paid；"提交后才分发"要证明的正是这一刻不外泄
  await db.unsafe(`
    create function fault_inj.fail_at_commit() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from fault_inj.flags where name = 'commit') then
        raise exception 'injected fault: commit' using errcode = '40001';
      end if;
      return null;
    end $$`);
  await db.unsafe(`
    create constraint trigger fault_commit_payments after update on payments
    deferrable initially deferred
    for each row execute function fault_inj.fail_at_commit()`);
}, 30_000);

afterAll(async () => {
  await dropFaultInfra();
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  await db`delete from fault_inj.flags`;
});

async function pendingOrder(srv: ChainServer, key: string): Promise<string> {
  const token = await tokenFor('u-1');
  const c = await call(srv, 'POST', '/api/v1/orders', { token, key, body: orderBody() });
  const orderId = String(c.json['order_id']);
  const p = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
    token,
    key: `pay-${key}`,
    body: { channel: 'mock' },
  });
  expect(p.status).toBe(200);
  return orderId;
}

describe('落账事务中途库故障', () => {
  it('写支付行时库报错 → 整笔回滚、不分发 order.paid、回 5xx；紧随重投被租约挡 503；租约过后重投补上且只补一次', async () => {
    const srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder(srv, 'k-fault');
      const before = await snapshotState(db);
      srv.sink.clear();

      await db`insert into fault_inj.flags values ('payments_succeeded')`;
      const r1 = await mockCallback(srv, db, orderId, { eventId: 'evt-fault' });
      expect(r1.status).toBe(500);
      // 零副作用：订单没付、事件没写、支付行没封口——唯一多出来的是回调登记行（未封口）
      expect(withoutWebhooks(await snapshotState(db))).toEqual(withoutWebhooks(before));
      const [wh] = await db`
        select processed_at, result, processing_until > now() as leased
          from webhook_events where event_id = 'evt-fault'`;
      expect(wh?.['processed_at']).toBeNull();
      expect(wh?.['result']).toBeNull();
      expect(wh?.['leased']).toBe(true);
      // 提交后才分发：回滚了就一条 order.paid 都不能出去
      await new Promise((r) => setTimeout(r, 100));
      expect(domainEvents(srv.sink, orderId)).not.toContain('order.paid');
      // 失败要能被看见：error 级日志里有这次故障
      expect(
        srv.sink
          .rows()
          .some((l) => l.level === 'error' && JSON.stringify(l).includes('injected fault')),
      ).toBe(true);

      // 故障排除后**立刻**重投：上一个持有者的租约还在 → 503 + Retry-After，不并发处理
      await db`delete from fault_inj.flags`;
      const r2 = await mockCallback(srv, db, orderId, { eventId: 'evt-fault' });
      expect(r2.status).toBe(503);
      expect(r2.json['reason']).toBe('already_processing');

      // 租约到期（模拟 10 秒过去）→ 重投接管 → 落账
      await db`update webhook_events set processing_until = now() - interval '1 second' where event_id = 'evt-fault'`;
      const r3 = await mockCallback(srv, db, orderId, { eventId: 'evt-fault' });
      expect(r3.status).toBe(200);
      const [o] = await db`select status from orders where id = ${orderId}`;
      expect(o?.['status']).toBe('paid');
      const [p] = await db`select status from payments where order_id = ${orderId}`;
      expect(p?.['status']).toBe('succeeded');
      const paidEvents = await db`
        select count(*)::int n from order_events where order_id = ${orderId} and status = 'paid'`;
      expect(paidEvents[0]?.['n']).toBe(1);
      await waitUntil(
        async () => domainEvents(srv.sink, orderId).includes('order.paid'),
        'order.paid 分发',
      );
      expect(domainEvents(srv.sink, orderId).filter((e) => e === 'order.paid')).toHaveLength(1);
      const [wh2] =
        await db`select processed_at is not null as done from webhook_events where event_id = 'evt-fault'`;
      expect(wh2?.['done']).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('COMMIT 时失败（事务体已跑完、事件已登记）→ 一条 order.paid 都不分发，库里一行没动', async () => {
    const srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder(srv, 'k-commit');
      const before = await snapshotState(db);
      srv.sink.clear();
      await db`insert into fault_inj.flags values ('commit')`;
      const r = await mockCallback(srv, db, orderId, { eventId: 'evt-commit' });
      expect(r.status).toBe(500);
      expect(withoutWebhooks(await snapshotState(db))).toEqual(withoutWebhooks(before));
      await new Promise((res) => setTimeout(res, 100));
      expect(domainEvents(srv.sink, orderId)).toEqual([]);
      expect(JSON.stringify(srv.sink.rows())).toContain('injected fault: commit');
    } finally {
      await srv.close();
    }
  });

  it('故障后机构再也没重投 → 15 分钟后每日对账把这条回调列为 unfinished_callbacks（error 级）', async () => {
    const srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder(srv, 'k-lost');
      await db`insert into fault_inj.flags values ('payments_succeeded')`;
      expect((await mockCallback(srv, db, orderId, { eventId: 'evt-lost' })).status).toBe(500);
      await db`delete from fault_inj.flags`;

      const at = new Date(Date.now() + 16 * 60_000);
      const summary = await runDailyReconciliation(db, srv, at);
      expect(summary['unfinished_callbacks']).toBe(1);
      expect(reconciliationSample(srv.sink, 'unfinished_callbacks')).toEqual(['evt-lost']);
      const anomaly = srv.sink
        .find('reconciliation_anomaly')
        .find((l) => (l['ctx'] as { class?: string }).class === 'unfinished_callbacks');
      expect(anomaly?.level).toBe('error');
    } finally {
      await srv.close();
    }
  });
});
