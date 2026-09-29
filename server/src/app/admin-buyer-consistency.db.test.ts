/**
 * 职责：**管理端写 → 买家侧读** 的跨端一致性，以及**拒付解锁回路**（U-J3）。
 *
 * @why 这两条此前都是断的，而且断得很安静：
 *      ① `order-query-routes.db.test.ts`（买家侧）全文 **0 处** `shipped` / `refunded`——
 *         它造的单都是 `created`。而 `admin-order-routes.db.test.ts`（管理端）断言的是"库里真的 shipped"。
 *         于是"客服点了发货、买家订单页还显示待发货"这个失效**没有任何测试会红**：
 *         两边各测一段，中间的"读路径能不能把新状态读出来"没人管。
 *      ② 拒付**解锁**那一半没人验：`mark-disputed.db.test.ts` 只验了结案把 `has_dispute` 复位 false
 *         （"闸门解锁"），但**结案之后 ship / refund 是不是真的重新放行**，全仓零覆盖。
 *         失效形态是：复位写对了、闸门仍读另一个字段（或读的是缓存的旧值），
 *         于是这张单**永远**不能发货也不能退款，而运营只看到"系统不让我操作"，没有任何一方报错。
 *
 * @why 断言一律走**真 HTTP + 真 JWT**：跨端一致性的要点就是"同一份库、两个鉴权身份、两个路由簇"。
 *      直接查库只能证明状态改了，证明不了买家侧**读得到**——那正是本节缝。
 *      库断言只作为辅助（确认不是响应层写死）。
 *
 * @limitation 一：结案这一步调的是 `markDisputeClosed`（真函数 + 真库 + 真总线），
 *              不是"回调 → 落账"那一整段——那一段由 `mark-disputed.db.test.ts` 的
 *              "接线（经回调管线）"用例覆盖。本文件关心的是**结案之后**的放行，
 *              不是结案本身怎么发生。
 * @limitation 二：只覆盖 shipped / refunded 两个终态，
 *              改址（address）那第三个写操作的跨端可见性留给后续——
 *              它改的是 `address_snapshot`，买家详情页已有专门的快照断言。
 *
 * @see app/admin-order-routes.ts（写侧）；app/order-query-routes.ts（读侧）；
 *      domain/admin-order-actions.ts（三个闸门）；app/mark-disputed.ts（结案）；
 *      docs/自主决策记录.md AJ-172
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
import { markDisputeClosed } from './mark-disputed.js';

let db: Db;
const JWT_SECRET = 'admin-buyer-consistency-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

/** 起一个只挂了正式路由清单的 server（与生产同一条装配路径）。 */
async function buildServer(): Promise<{
  url: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-buyer-consistency',
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
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, sink, close: server.close };
}

beforeEach(async () => {
  await resetTestDb(db);
  await db`
    insert into users (id, openid, email, is_admin)
    values ('u-admin', 'o-admin', 'admin@example.com', true),
           ('u-buyer', 'o-buyer', null, false)
  `;
});

/** 结案用的静默总线：本文件不验事件分发（那是 mark-disputed.db.test.ts 的活）。 */
const silentBus = (): ReturnType<typeof createEventBus> =>
  createEventBus(createLogger({ env: 'test', destination: new MemorySink() }));

const BEARER = async (isAdmin: boolean): Promise<string> =>
  `Bearer ${await signToken(
    { sub: isAdmin ? 'u-admin' : 'u-buyer', role: isAdmin ? 'admin' : 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  )}`;

async function req(
  s: { url: string },
  method: 'GET' | 'POST',
  path: string,
  isAdmin: boolean,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      authorization: await BEARER(isAdmin),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** 插一张 **买家** 的已付款订单（管理端与买家端观测的是同一行）。 */
async function seedPaidOrder(orderId: string, hasDispute = false): Promise<void> {
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${orderId}`}, '商品', 'daily', 1000, 500, 'JP')
      on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        has_dispute, expires_at)
    values (${orderId}, ${`NO-${orderId}`}, 'u-buyer', 'paid', 1000, 500, 150, 1650,
            500, ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ id: 'a-1', recipient: 'Jane Doe', line1: '1 Infinite Loop', country: 'US' } as never)},
            'TOS-TEST-1', ${hasDispute}, now() + interval '30 minutes')
  `;
  await db`
    insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                             weight_g, declared_value_usd)
    values (${`oi-${orderId}`}, ${orderId}, ${`p-${orderId}`}, '商品', 1, 1000, 500, 7)
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values (${`pay-${orderId}`}, ${orderId}, 'mock', ${`mock_${orderId}`}, 'succeeded', 'JPY', 1650)
  `;
}

/** 买家侧看到的订单状态（列表与详情各一个读取方，互为交叉验证）。 */
async function buyerSees(
  s: { url: string },
  orderId: string,
): Promise<{
  detail: string;
  list: string | undefined;
  timeline: string[];
}> {
  const detail = await req(s, 'GET', `/api/v1/orders/${orderId}`, false);
  const list = await req(s, 'GET', '/api/v1/orders', false);
  const items = (list.json['items'] ?? []) as Array<Record<string, unknown>>;
  const hit = items.find((i) => i['order_id'] === orderId);
  const timeline = ((detail.json['timeline'] ?? []) as Array<Record<string, unknown>>).map((t) =>
    String(t['status']),
  );
  return {
    detail: String(detail.json['status']),
    list: hit?.['status'] as string | undefined,
    timeline,
  };
}

describe('管理端发货 → 买家侧可见', () => {
  it('POST /admin/orders/{id}/ship → 买家详情与列表都读到 shipped，timeline 也带上', async () => {
    const s = await buildServer();
    try {
      await seedPaidOrder('o-ship');
      const r = await req(s, 'POST', '/api/v1/admin/orders/o-ship/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-1',
      });
      expect(r.status).toBe(200);

      const seen = await buyerSees(s, 'o-ship');
      expect(seen.detail).toBe('shipped');
      expect(seen.list).toBe('shipped'); // 列表是另一个读取方（不是同一份映射）
      expect(seen.timeline).toContain('shipped');
      // 库里也确实是 shipped（防止"响应层写死"）
      expect((await db`select status from orders where id = 'o-ship'`)[0]?.['status']).toBe(
        'shipped',
      );
    } finally {
      await s.close();
    }
  });
});

describe('管理端退款 → 买家侧可见', () => {
  it('POST /admin/orders/{id}/refund → 买家侧读到 refunded', async () => {
    const s = await buildServer();
    try {
      await seedPaidOrder('o-refund');
      const r = await req(s, 'POST', '/api/v1/admin/orders/o-refund/refund', true, {
        reason: '缺货',
      });
      expect(r.status).toBe(202);

      const seen = await buyerSees(s, 'o-refund');
      expect(seen.detail).toBe('refunded');
      expect(seen.list).toBe('refunded');
      expect(seen.timeline).toContain('refunded');
    } finally {
      await s.close();
    }
  });
});

describe('拒付解锁回路（此前只验了"复位"，没验"复位之后真的放行"）', () => {
  it('拒付中发货被 40909 拦下 → 结案后**同一个发货请求**真的成功，买家侧看到 shipped', async () => {
    const s = await buildServer();
    try {
      await seedPaidOrder('o-dispute', true);
      await db`
        update payments set dispute_id = 'dp_1', dispute_status = 'open',
                             dispute_amount = 1000, dispute_opened_at = now()
         where order_id = 'o-dispute'
      `;

      // ① 锁住：闸门必须在调机构之前（钱/货都没动）
      const blocked = await req(s, 'POST', '/api/v1/admin/orders/o-dispute/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-2',
      });
      expect(blocked.status).toBe(409);
      expect(blocked.json['code']).toBe(40909);
      expect((await db`select status from orders where id = 'o-dispute'`)[0]?.['status']).toBe(
        'paid',
      );

      // ② 结案：真函数 + 真库（"回调 → 落账"那一段由 mark-disputed.db.test.ts 覆盖）
      await markDisputeClosed(db, silentBus(), 'o-dispute', {
        channel: 'mock',
        disputeId: 'dp_1',
        result: 'won',
      });
      expect(
        (await db`select has_dispute from orders where id = 'o-dispute'`)[0]?.['has_dispute'],
      ).toBe(false);

      // ③ 解锁：同一个请求现在必须成功——此前全仓没有任何测试覆盖这一跳
      const after = await req(s, 'POST', '/api/v1/admin/orders/o-dispute/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-2',
      });
      expect(after.status).toBe(200);
      const seen = await buyerSees(s, 'o-dispute');
      expect(seen.detail).toBe('shipped');
      expect(seen.list).toBe('shipped');
    } finally {
      await s.close();
    }
  });

  it('拒付中退款被 40907 拦下 → **胜诉**结案后同一个退款请求真的成功，买家侧看到 refunded', async () => {
    const s = await buildServer();
    try {
      await seedPaidOrder('o-dispute2', true);
      await db`
        update payments set dispute_id = 'dp_2', dispute_status = 'open',
                             dispute_amount = 1000, dispute_opened_at = now()
         where order_id = 'o-dispute2'
      `;

      const blocked = await req(s, 'POST', '/api/v1/admin/orders/o-dispute2/refund', true, {
        reason: '缺货',
      });
      expect(blocked.json['code']).toBe(40907);
      expect(
        (await db`select status from payments where id = 'pay-o-dispute2'`)[0]?.['status'],
      ).toBe('succeeded');

      await markDisputeClosed(db, silentBus(), 'o-dispute2', {
        channel: 'mock',
        disputeId: 'dp_2',
        result: 'won',
      });

      const after = await req(s, 'POST', '/api/v1/admin/orders/o-dispute2/refund', true, {
        reason: '缺货',
      });
      expect(after.status).toBe(202);
      expect((await buyerSees(s, 'o-dispute2')).detail).toBe('refunded');
    } finally {
      await s.close();
    }
  });

  it('**败诉**结案后闸门不解锁：退款仍 40907、发货仍 40909（钱已被拉回；AJ-176 部分推翻 AJ-162 ③）', async () => {
    /**
     * @why 原用例在 lost 之后断言"退款 202 → refunded"——那是 mock 通道的假象：
     *      @measured(docs.stripe.com/error-codes)：对已被拒付的扣款退款，Stripe 返回 `charge_disputed` /
     *      `refund_disputed_payment`，订单会停在 refunding + 50000。发货则是把货白送出去。
     */
    const s = await buildServer();
    try {
      await seedPaidOrder('o-dispute3', true);
      await db`
        update payments set dispute_id = 'dp_4', dispute_status = 'open',
                             dispute_amount = 1000, dispute_opened_at = now()
         where order_id = 'o-dispute3'
      `;
      await markDisputeClosed(db, silentBus(), 'o-dispute3', {
        channel: 'mock',
        disputeId: 'dp_4',
        result: 'lost',
      });
      const refund = await req(s, 'POST', '/api/v1/admin/orders/o-dispute3/refund', true, {
        reason: '缺货',
      });
      expect(refund.json['code']).toBe(40907);
      const ship = await req(s, 'POST', '/api/v1/admin/orders/o-dispute3/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-4',
      });
      expect(ship.json['code']).toBe(40909);
      expect((await buyerSees(s, 'o-dispute3')).detail).toBe('paid');
    } finally {
      await s.close();
    }
  });

  it('解锁**只**解开拒付那一维：结案后重复发货仍 40902（状态机那一维没被顺手放掉）', async () => {
    const s = await buildServer();
    try {
      await seedPaidOrder('o-unlock-scope');
      const first = await req(s, 'POST', '/api/v1/admin/orders/o-unlock-scope/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-3',
      });
      expect(first.status).toBe(200);

      // 无拒付也再开一次案 → 结案 → 闸门仍应因"已发货"而拦（40902），不是 40909
      await db`update orders set has_dispute = true where id = 'o-unlock-scope'`;
      await db`
        update payments set dispute_id = 'dp_3', dispute_status = 'open',
                             dispute_amount = 1000, dispute_opened_at = now()
         where order_id = 'o-unlock-scope'
      `;
      await markDisputeClosed(db, silentBus(), 'o-unlock-scope', {
        channel: 'mock',
        disputeId: 'dp_3',
        result: 'won',
      });

      const again = await req(s, 'POST', '/api/v1/admin/orders/o-unlock-scope/ship', true, {
        carrier: 'yamato',
        tracking_no: 'TRACK-3',
      });
      expect(again.status).toBe(409);
      expect(again.json['code']).toBe(40902); // 状态机拦的，不是拒付拦的
    } finally {
      await s.close();
    }
  });
});
