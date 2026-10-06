/**
 * 职责：**购买主链路逐表对账**——从买家入口一路走到落账、关单、对账，
 *      每一跳之后把**所有相关表**（订单 / 明细 / 事件 / 支付 / 库存 / 回调登记 / 业务事件日志 / 买家读路径）
 *      一起钉住（测试审查 U-J5）。
 *
 * @why 此前唯一走完整条购买链的测试是 `test/e2e/miniprogram-shell.e2e.test.ts`，
 *      它只断言最终 `status === 'paid'`：payments 没封口成 succeeded、order_events 少了 pending_payment、
 *      webhook_events.result 没写、order.paid 业务事件没发、关单作业把已付单的库存回补了——
 *      这些"链上某一环断了"的失效**它都照样绿**。本文件的每一条用例都在链的**每一跳**断言全部相关表。
 * @why 走的是生产装配（`test/helpers/chain-server.ts`：loadConfig → rawBodyPaths → mountAllRoutes
 *      → 业务事件订阅者），回调带真 HMAC 签名、经真 rawBody 中间件；关单与对账跑的是
 *      **生产作业本体 + 生产调度框架 + 与路由同一条总线**。没有任何 mock 替换业务模块——
 *      唯一的"替身"是 mock 支付通道，它本身就是生产注册表里的一条通道。
 *
 * @limitation 一：路由侧时钟不可注入（mount.ts 写死 systemClock），"到点"通过改库里的
 *              `expires_at` 或给作业传未来时钟实现——与 expire-orders / mark-paid 既有用例同口径。
 * @limitation 二：Stripe 通道的同一条链（会话 → 短链 → 托管页 → 回调）不在本文件：
 *              回调侧由 `test/e2e/stripe-callback.e2e.test.ts` 覆盖，意图/短链侧由
 *              pay-intent / pay-link 的 db 测试覆盖；两侧串起来的缺口登记在测试审查报告"仍存缺口"。
 *
 * @see test/helpers/chain-server.ts；docs/测试策略与验证门禁.md §3.3；docs/自主决策记录.md AJ-174
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  CHAIN_ITEMS,
  CHAIN_ITEMS_JPY,
  CHAIN_SHIPPING_JPY,
  CHAIN_TOTAL_JPY,
  domainEvents,
  mockCallback,
  orderBody,
  reconciliationSample,
  runDailyReconciliation,
  runExpireJob,
  seedChainFixture,
  snapshotState,
  tokenFor,
  waitUntil,
  withoutCallbackTrace,
  withoutWebhooks,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { RESULT_PAID_ALREADY } from './webhook-results.js';

let db: Db;
let srv: ChainServer;
let buyer = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db);
}, 30_000);

afterAll(async () => {
  await srv.close();
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  buyer = await tokenFor('u-1');
  srv.sink.clear();
});

const HOUR = 3600_000;

/** 报价 → 原样建单 → 发起支付（mock），返回订单号。每一跳都断言状态码。 */
async function quoteCreatePay(key = 'k-1'): Promise<string> {
  const q = await call(srv, 'POST', '/api/v1/orders/quote', {
    token: buyer,
    body: { items: CHAIN_ITEMS },
  });
  expect(q.status).toBe(200);
  expect(q.json['total_jpy']).toBe(CHAIN_TOTAL_JPY);

  const c = await call(srv, 'POST', '/api/v1/orders', {
    token: buyer,
    key,
    body: orderBody('addr-1', { expected_total_jpy: q.json['total_jpy'] }),
  });
  expect(c.status).toBe(201);
  const orderId = String(c.json['order_id']);

  const p = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
    token: buyer,
    key: `pay-${key}`,
    body: { channel: 'mock' },
  });
  expect(p.status).toBe(200);
  expect(p.json['charge']).toEqual({ currency: 'JPY', amount: CHAIN_TOTAL_JPY });
  return orderId;
}

const orderRow = async (id: string): Promise<Record<string, unknown>> =>
  ({ ...(await db`select * from orders where id = ${id}`)[0] }) as Record<string, unknown>;
const eventTrail = async (id: string): Promise<string[]> =>
  (await db`select status from order_events where order_id = ${id} order by id`).map((r) =>
    String(r['status']),
  );
const paymentRows = async (id: string): Promise<Record<string, unknown>[]> =>
  (
    await db`select provider, status, charge_currency, charge_amount, paid_amount, paid_currency
               from payments where order_id = ${id} order by created_at`
  ).map((r) => ({ ...r }));
const stock = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await db`select id, stock from products order by id`).map((r) => [
      String(r['id']),
      Number(r['stock']),
    ]),
  );
const webhookResult = async (eventId: string): Promise<string | null> => {
  const r = await db`select result from webhook_events where event_id = ${eventId}`;
  return r[0] === undefined ? null : (r[0]['result'] as string | null);
};

describe('主链路：报价 → 建单 → 发起支付 → 回调落账 → 买家读 → 关单作业 → 每日对账', () => {
  it('每一跳之后所有相关表同时正确，且下游作业不会误伤已付单', async () => {
    const orderId = await quoteCreatePay();

    // ── 跳 1：建单 + 发起支付之后 ─────────────────────────────────────────────
    expect(await stock()).toEqual({ 'p-cup': 8, 'p-knife': 4 }); // 扣一次，不多不少
    expect((await orderRow(orderId))['status']).toBe('pending_payment');
    expect(await eventTrail(orderId)).toEqual(['created', 'pending_payment']);
    expect(await paymentRows(orderId)).toEqual([
      {
        provider: 'mock',
        status: 'initiated',
        charge_currency: 'JPY',
        charge_amount: CHAIN_TOTAL_JPY,
        paid_amount: null,
        paid_currency: null,
      },
    ]);

    // ── 跳 2：机构回调（真签名 / 真 rawBody）─────────────────────────────────
    const cb = await mockCallback(srv, db, orderId, { eventId: 'evt-gold-1' });
    expect(cb.status).toBe(200);

    const o = await orderRow(orderId);
    expect(o['status']).toBe('paid');
    expect(o['paid_at']).not.toBeNull();
    expect(o['total_jpy']).toBe(CHAIN_TOTAL_JPY);
    expect(await eventTrail(orderId)).toEqual(['created', 'pending_payment', 'paid']);
    // 支付行封口：金额 = 建单金额 = 回调金额（三处同源）
    expect(await paymentRows(orderId)).toEqual([
      {
        provider: 'mock',
        status: 'succeeded',
        charge_currency: 'JPY',
        charge_amount: CHAIN_TOTAL_JPY,
        paid_amount: CHAIN_TOTAL_JPY,
        paid_currency: 'JPY',
      },
    ]);
    expect(await webhookResult('evt-gold-1')).toBe('paid');
    // 下游订阅者：业务事件各恰好一次（重复分发 / 漏发都会被这里兜住）
    const evs = domainEvents(srv.sink, orderId);
    expect(evs.filter((e) => e === 'order.created')).toHaveLength(1);
    expect(evs.filter((e) => e === 'order.paid')).toHaveLength(1);
    expect(await stock()).toEqual({ 'p-cup': 8, 'p-knife': 4 }); // 落账不动库存

    // ── 跳 3：买家读路径看得到落账结果（不是只有库里对）─────────────────────
    const g = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer });
    expect(g.status).toBe(200);
    expect(g.json['status']).toBe('paid');
    expect(g.json['items_jpy']).toBe(CHAIN_ITEMS_JPY);
    expect(g.json['shipping_jpy']).toBe(CHAIN_SHIPPING_JPY);
    expect(g.json['total_jpy']).toBe(CHAIN_TOTAL_JPY);
    expect((g.json['timeline'] as unknown[]).map((t) => (t as { status: string }).status)).toEqual([
      'created',
      'pending_payment',
      'paid',
    ]);
    const list = await call(srv, 'GET', '/api/v1/orders', { token: buyer });
    const row = (list.json['items'] as Record<string, unknown>[]).find(
      (r) => r['order_id'] === orderId,
    );
    expect(row?.['status']).toBe('paid'); // 列表与详情是两个独立读取方，必须一致

    // ── 跳 4：关单作业在"早已过期的时刻"跑一轮——已付单必须纹丝不动 ─────────
    const before = await snapshotState(db);
    await runExpireJob(db, srv, new Date(Date.now() + 2 * HOUR));
    expect(await snapshotState(db)).toEqual(before);

    // ── 跳 5：每日对账——一条健康链路不产生任何账务异常 ───────────────────────
    const counts = await runDailyReconciliation(db, srv, new Date());
    expect(counts['dangling_initiated_payments']).toBe(0);
    expect(counts['paid_without_succeeded_payment']).toBe(0);
    expect(counts['callback_anomalies_48h']).toBe(0);
  });

  it('同一回调重投（机构重试）与同一笔钱换事件号再到：订单/支付/事件/库存全部不变', async () => {
    const orderId = await quoteCreatePay();
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-dup' })).status).toBe(200);
    const settled = await snapshotState(db);
    const paidEventsBefore = domainEvents(srv.sink, orderId).filter((e) => e === 'order.paid');

    // ① 同一 event_id 重投
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-dup' })).status).toBe(200);
    expect(await snapshotState(db)).toEqual(settled);

    // ② 同一笔钱、新 event_id（机构侧重建事件）：只多一行回调登记，其它不动
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-dup-2' })).status).toBe(200);
    const after = await snapshotState(db);
    expect(withoutWebhooks(after)).toEqual(withoutWebhooks(settled));
    expect(await webhookResult('evt-dup-2')).toBe(RESULT_PAID_ALREADY);
    expect(domainEvents(srv.sink, orderId).filter((e) => e === 'order.paid')).toEqual(
      paidEventsBefore,
    );
  });
});

describe('异常链路：钱与订单状态不一致时，系统必须留下"人能看见"的痕迹且不污染数据', () => {
  it('迟到付款：到点后到账 → 拒落账 + error 日志 → 关单释放库存、作废在途支付 → 对账列出待退款', async () => {
    const orderId = await quoteCreatePay();
    await db`update orders set expires_at = now() - interval '1 second' where id = ${orderId}`;

    const cb = await mockCallback(srv, db, orderId, { eventId: 'evt-late' });
    expect(cb.status).toBe(200);
    expect(await webhookResult('evt-late')).toBe('late_payment');
    expect(srv.sink.find('callback_late_payment')).toHaveLength(1);
    expect(srv.sink.find('callback_late_payment')[0]?.['level']).toBe('error');
    // 拒落账：订单与支付行都没有被推进
    expect((await orderRow(orderId))['status']).toBe('pending_payment');
    expect((await paymentRows(orderId))[0]?.['status']).toBe('initiated');

    // 关单作业（同一条总线）→ expired + 库存回补 + 关单连带作废支付行（提交后异步）
    await runExpireJob(db, srv, new Date());
    expect((await orderRow(orderId))['status']).toBe('expired');
    // late_paid：迟到付款凭据（剩余清单 1-5），订单状态不因它变化
    expect(await eventTrail(orderId)).toEqual([
      'created',
      'pending_payment',
      'late_paid',
      'expired',
    ]);
    expect(await stock()).toEqual({ 'p-cup': 10, 'p-knife': 5 });
    await waitUntil(
      async () => (await paymentRows(orderId))[0]?.['status'] === 'cancelled',
      '关单连带作废在途支付行',
    );
    const g = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer });
    expect(g.json['status']).toBe('expired');

    // 对账：这笔"钱到了、单没了"的回调必须出现在待人工清单里
    await runDailyReconciliation(db, srv, new Date());
    expect(reconciliationSample(srv.sink, 'callback_anomalies_48h')).toContain('evt-late');
    // 剩余清单 2-4：有异常 → 发 reconciliation.anomalies_found（运营告警邮件的订阅源），带各类计数
    const found = srv.sink
      .find('business_event')
      .map((l) => l['ctx'] as Record<string, unknown>)
      .find((c) => c['domain_event'] === 'reconciliation.anomalies_found');
    expect(found?.['callback_anomalies_48h']).toBeGreaterThanOrEqual(1); // 剩余清单 3-2：对账结果落库（运营日志页读最近一次），取样带上这条回调
    const [run] =
      await db`select counts, samples from reconciliation_runs order by id desc limit 1`;
    expect(
      (run?.['counts'] as Record<string, number>)['callback_anomalies_48h'],
    ).toBeGreaterThanOrEqual(1);
    expect((run?.['samples'] as Record<string, string[]>)['callback_anomalies_48h']).toContain(
      'evt-late',
    );
  });

  it('关单作业已把单关成 expired 之后才到账 → 同样按迟到付款分类（late_payment + error），对账可见（KD-7 回归）', async () => {
    const orderId = await quoteCreatePay();
    await runExpireJob(db, srv, new Date(Date.now() + 2 * HOUR));
    expect((await orderRow(orderId))['status']).toBe('expired');
    const before = await snapshotState(db);

    const cb = await mockCallback(srv, db, orderId, { eventId: 'evt-after-expire' });
    expect(cb.status).toBe(200);
    expect(await webhookResult('evt-after-expire')).toBe('late_payment');
    const late = srv.sink.find('callback_late_payment');
    expect(late).toHaveLength(1);
    expect(late[0]?.['level']).toBe('error');
    expect(srv.sink.find('callback_conflict')).toHaveLength(0); // 不再落到普通冲突的 warn
    expect(await eventTrail(orderId)).toContain('late_paid');
    expect(withoutCallbackTrace(await snapshotState(db))).toEqual(withoutCallbackTrace(before));

    await runDailyReconciliation(db, srv, new Date());
    expect(reconciliationSample(srv.sink, 'callback_anomalies_48h')).toContain('evt-after-expire');
  });

  it('发起支付后用户取消，机构回调随后到达：订单不复活、支付行不复活、库存不二次回补、对账可见', async () => {
    const orderId = await quoteCreatePay();

    const cancel = await call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, { token: buyer });
    expect(cancel.status).toBe(200);
    expect((await orderRow(orderId))['status']).toBe('cancelled');
    expect((await paymentRows(orderId))[0]?.['status']).toBe('cancelled');
    expect(await stock()).toEqual({ 'p-cup': 10, 'p-knife': 5 });
    const afterCancel = await snapshotState(db);

    const cb = await mockCallback(srv, db, orderId, { eventId: 'evt-after-cancel' });
    expect(cb.status).toBe(200);
    const o = await orderRow(orderId);
    expect(o['status']).toBe('cancelled');
    expect(o['paid_at']).toBeNull();
    expect(await paymentRows(orderId)).toEqual([
      {
        provider: 'mock',
        status: 'cancelled',
        charge_currency: 'JPY',
        charge_amount: CHAIN_TOTAL_JPY,
        paid_amount: null,
        paid_currency: null,
      },
    ]);
    expect(await eventTrail(orderId)).toEqual([
      'created',
      'pending_payment',
      'cancelled',
      'late_paid',
    ]);
    expect(await stock()).toEqual({ 'p-cup': 10, 'p-knife': 5 });
    expect(domainEvents(srv.sink, orderId)).not.toContain('order.paid');
    // 除了多一条回调登记与一条迟到付款凭据，其它一行没动
    expect(withoutCallbackTrace(await snapshotState(db))).toEqual(
      withoutCallbackTrace(afterCancel),
    );
    expect(await webhookResult('evt-after-cancel')).toBe('late_payment'); // KD-7：已关单的到账 = 迟到付款
    expect(srv.sink.find('callback_late_payment')[0]?.['level']).toBe('error');

    // 钱可能真的扣了：对账必须把它列给人看（否则这笔钱静默躺在机构账上）
    await runDailyReconciliation(db, srv, new Date());
    expect(reconciliationSample(srv.sink, 'callback_anomalies_48h')).toContain('evt-after-cancel');
  });

  it('给已取消的单发起支付 → 40902，且全表零副作用（不建支付行、不写事件）', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-cxl',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);
    expect(
      (await call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, { token: buyer })).status,
    ).toBe(200);
    const before = await snapshotState(db);

    const p = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: buyer,
      key: 'pay-cxl',
      body: { channel: 'mock' },
    });
    expect(p.status).toBe(409);
    expect(p.json['code']).toBe(40902);
    expect(await snapshotState(db)).toEqual(before);
  });

  it.each([
    ['amount_mismatch', { amount_minor: CHAIN_TOTAL_JPY - 1 }],
    ['currency_mismatch', { currency: 'USD' }],
    ['provider_ref_mismatch', { provider_ref: 'mock_someone-else' }],
  ] as const)(
    '核对不符（%s）经真 HTTP：200 告知机构别重发，但订单/支付不动、登记 mismatch、error 级日志',
    async (reason, override) => {
      const orderId = await quoteCreatePay();
      const before = await snapshotState(db);

      const cb = await mockCallback(srv, db, orderId, { eventId: `evt-${reason}`, override });
      expect(cb.status).toBe(200);
      expect(await webhookResult(`evt-${reason}`)).toBe(`mismatch:${reason}`);
      expect(withoutWebhooks(await snapshotState(db))).toEqual(withoutWebhooks(before));
      const logs = srv.sink.find('callback_settlement_mismatch');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.['level']).toBe('error');

      // 对账同样要能看见
      await runDailyReconciliation(db, srv, new Date());
      expect(reconciliationSample(srv.sink, 'callback_anomalies_48h')).toContain(`evt-${reason}`);
    },
  );
});

describe('每日对账：卡住的回调（KD-2 回归）', () => {
  it('登记了却没有结果、租约已过期、超过 15 分钟 → 列为 unfinished_callbacks；正在处理 / 刚到 / 已处理 / 超出 48h 的不列', async () => {
    const at = new Date();
    const mins = (m: number): Date => new Date(at.getTime() - m * 60_000);
    await db`
      insert into webhook_events (provider, event_id, event_type, received_at, processed_at, result, processing_until)
      values ('mock', 'evt-stuck',      'payment.succeeded', ${mins(120)}, null, null, ${mins(60)}),
             ('mock', 'evt-no-lease',   'payment.succeeded', ${mins(30)},  null, null, null),
             ('mock', 'evt-edge-15',    'payment.succeeded', ${mins(15)},  null, null, null),
             ('mock', 'evt-inflight',   'payment.succeeded', ${mins(120)}, null, null, ${new Date(at.getTime() + 60_000)}),
             ('mock', 'evt-fresh',      'payment.succeeded', ${mins(5)},   null, null, null),
             ('mock', 'evt-done',       'payment.succeeded', ${mins(120)}, ${mins(119)}, 'paid', null),
             ('mock', 'evt-too-old',    'payment.succeeded', ${mins(49 * 60)}, null, null, null)
    `;
    const counts = await runDailyReconciliation(db, srv, at);
    expect(counts['unfinished_callbacks']).toBe(3);
    const sample = reconciliationSample(srv.sink, 'unfinished_callbacks').sort();
    expect(sample).toEqual(['evt-edge-15', 'evt-no-lease', 'evt-stuck']);
    const row = srv.sink
      .find('reconciliation_anomaly')
      .find((r) => (r['ctx'] as { class?: string }).class === 'unfinished_callbacks');
    expect(row?.['level']).toBe('error');
  });
});
