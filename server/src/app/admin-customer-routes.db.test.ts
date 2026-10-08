/**
 * 职责：管理端客户只读接口（`GET /admin/customers`、`GET /admin/customers/{id}`）与订单详情客户卡片的
 *       接线级真库用例（AJ-404；对标分析 §4.5 / §4.2 第 168 行）。
 *
 * @why 夹具按真实形态造：三个买家 + 一个管理员。
 *      A 有已付 / 已完成 / 已过期 / **测试单**四种单、两条地址簿、一笔进行中的拒付——
 *        测试单故意是**最新**的一单、且带一个别人的邮箱：任何"忘了排除 is_test"的聚合
 *        （单数、金额、最近下单、联系邮箱）都会被它带偏，而不是碰巧对上。
 *      B 已被拉黑、一张已付单；C 只登录过、没下过单（地址簿里有一条）——"没有订单的客户"是真实存在的形态
 *        （小程序登录即建 users 行，wechat-login.ts）。
 *      管理员与买家同表（users.is_admin）——客户列表绝不能把管理员列出来。
 * @why 金额断言写死具体数（21,380 円）而不是"> 0"：口径错一点（算进了测试单 / 算进了未付单）都会差出一个可辨认的数。
 * @why PII 不进日志：本文件每条用例结束后都对**全部**日志行查一遍邮箱 / 收件人 / 电话 / 街道 / openid
 *      （约束七脱敏红线），而不是只查某一条事件——泄露最常出现在没人盯的那一条（错误上下文、访问日志）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { US_ADDRESSES } from '../../../test/factories/catalog.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-customer-test-jwt-secret-'.repeat(2);

/** 夹具里出现的全部 PII（用于"日志里一个都不许有"的断言）。 */
const PII: string[] = [];

const [NY, LA, CHI, SEA] = [US_ADDRESSES[0]!, US_ADDRESSES[1]!, US_ADDRESSES[2]!, US_ADDRESSES[3]!];

function snapshot(a: (typeof US_ADDRESSES)[number], phone: string): Record<string, unknown> {
  return {
    id: null,
    recipient: a.recipient,
    phone,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postal_code: a.postalCode,
    country: 'US',
  };
}

interface OrderSeed {
  id: string;
  orderNo: string;
  userId: string;
  status: string;
  totalJpy: number;
  createdAt: string;
  paidAt: string | null;
  isTest?: boolean;
  email: string | null;
  address: Record<string, unknown>;
}

async function insertOrder(o: OrderSeed): Promise<void> {
  // 运费取 4950 档（≤2kg）；审核测试单是 1,000 円单件、不收运费（与 seed-order.ts 同口径）
  const shipping = o.isTest === true ? 0 : 4950;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                        weight_g, fx_snapshot, address_snapshot, contact_email, terms_version,
                        expires_at, paid_at, is_test, created_at)
    values (${o.id}, ${o.orderNo}, ${o.userId}, ${o.status}, ${o.totalJpy - shipping}, ${shipping}, 0,
            ${o.totalJpy}, 1200, '{}'::jsonb, ${db.json(o.address as never)}, ${o.email}, 'TOS-2026-09-20',
            ${o.createdAt}::timestamptz + interval '30 minutes', ${o.paidAt}, ${o.isTest ?? false},
            ${o.createdAt})
  `;
}

async function insertAddress(
  id: string,
  userId: string,
  a: (typeof US_ADDRESSES)[number],
  phone: string,
  isDefault: boolean,
  createdAt: string,
): Promise<void> {
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code, country,
                           is_default, created_at)
    values (${id}, ${userId}, ${a.recipient}, ${phone}, ${a.line1}, ${a.line2}, ${a.city}, ${a.state},
            ${a.postalCode}, 'US', ${isDefault}, ${createdAt})
  `;
}

const PHONE_A1 = '+12125550143';
const PHONE_A2 = '+12135550178';
const PHONE_B = '+13125550109';
const PHONE_C = '+12065550166';

async function seed(): Promise<void> {
  await db`insert into users (id, openid, created_at) values
    ('u-cust-a', 'oWx-openid-cust-a-9f8e7d', '2026-08-20T03:00:00Z'),
    ('u-cust-b', 'oWx-openid-cust-b-1a2b3c', '2026-08-25T03:00:00Z'),
    ('u-cust-c', 'oWx-openid-cust-c-4d5e6f', '2026-09-30T03:00:00Z')`;
  await db`update users set blocked_at = '2026-09-28T05:00:00Z' where id = 'u-cust-b'`;
  await db`insert into users (id, email, password_hash, is_admin) values
    ('u-admin', 'owner@waselect.example', 'x', true)`;

  await insertAddress('addr-a1', 'u-cust-a', NY, PHONE_A1, true, '2026-08-21T00:00:00Z');
  await insertAddress('addr-a2', 'u-cust-a', LA, PHONE_A2, false, '2026-09-10T00:00:00Z');
  await insertAddress('addr-c1', 'u-cust-c', SEA, PHONE_C, true, '2026-09-30T04:00:00Z');

  const snapA = snapshot(NY, PHONE_A1);
  await insertOrder({
    id: 'o-a1',
    orderNo: '260901-K7Q2MN',
    userId: 'u-cust-a',
    status: 'paid',
    totalJpy: 8930,
    createdAt: '2026-09-01T02:00:00Z',
    paidAt: '2026-09-01T02:05:00Z',
    email: 'zhang.wei@example.com',
    address: snapA,
  });
  await insertOrder({
    id: 'o-a2',
    orderNo: '260920-P3XR8T',
    userId: 'u-cust-a',
    status: 'completed',
    totalJpy: 12450,
    createdAt: '2026-09-20T09:00:00Z',
    paidAt: '2026-09-20T09:03:00Z',
    email: 'zhang.wei@example.com',
    address: snapA,
  });
  await insertOrder({
    id: 'o-a3',
    orderNo: '261001-ABCD23',
    userId: 'u-cust-a',
    status: 'expired',
    totalJpy: 5000,
    createdAt: '2026-10-01T01:00:00Z',
    paidAt: null,
    email: null,
    address: snapA,
  });
  // 最新的一单是测试单，且留了另一个邮箱：任何没排除 is_test 的聚合都会被它带偏
  await insertOrder({
    id: 'o-a4',
    orderNo: '261005-TEST01',
    userId: 'u-cust-a',
    status: 'paid',
    totalJpy: 1000,
    createdAt: '2026-10-05T01:00:00Z',
    paidAt: '2026-10-05T01:01:00Z',
    isTest: true,
    email: 'app-reviewer@example.com',
    address: snapshot(LA, PHONE_A2),
  });
  await insertOrder({
    id: 'o-b1',
    orderNo: '260925-ZZ9Y8X',
    userId: 'u-cust-b',
    status: 'paid',
    totalJpy: 4980,
    createdAt: '2026-09-25T06:00:00Z',
    paidAt: '2026-09-25T06:02:00Z',
    email: 'chen.hao@example.com',
    address: snapshot(CHI, PHONE_B),
  });
  // A 的第一单有一笔进行中的拒付（未结案）
  await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                                 dispute_id, dispute_status, dispute_amount, dispute_opened_at)
           values ('pay-a1', 'o-a1', 'stripe', 'succeeded', 'USD', 6125,
                   'dp_1Q2w3E4r5T6y', 'open', 6125, '2026-09-15T00:00:00Z')`;

  PII.length = 0;
  PII.push(
    'zhang.wei@example.com',
    'chen.hao@example.com',
    'app-reviewer@example.com',
    NY.recipient,
    LA.recipient,
    CHI.recipient,
    SEA.recipient,
    NY.line1,
    LA.line1,
    CHI.line1,
    SEA.line1,
    PHONE_A1,
    PHONE_A2,
    PHONE_B,
    PHONE_C,
    'oWx-openid-cust-a-9f8e7d',
    'oWx-openid-cust-b-1a2b3c',
    'oWx-openid-cust-c-4d5e6f',
  );
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink = new MemorySink();
  await seed();
});

afterEach(() => {
  // 约束七：地址 / 电话 / 邮箱 / openid 不进日志——查**全部**日志行，不只查业务事件
  const all = sink.lines.join('\n');
  for (const p of PII) expect(all, `日志里出现了 PII：${p}`).not.toContain(p);
});

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-customer-route-test',
    TERMS_VERSION: 'TOS-2026-09-20',
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
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function bearer(sub: string, role: 'admin' | 'user'): Promise<string> {
  const t = await signToken({ sub, role }, { secret: JWT_SECRET, issuer: 'waselect' });
  return `Bearer ${t}`;
}

async function get(
  url: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    headers: token === undefined ? {} : { authorization: token },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const code = (r: { body: Record<string, unknown> }): number => Number(r.body['code']);

async function withServer(fn: (url: string, admin: string) => Promise<void>): Promise<void> {
  const { url, close } = await buildServer();
  try {
    await fn(url, await bearer('u-admin', 'admin'));
  } finally {
    await close();
  }
}

const ROW_A = {
  id: 'u-cust-a',
  created_at: '2026-08-20T03:00:00.000Z',
  blocked: false,
  order_count: 3,
  paid_order_count: 2,
  paid_total_jpy: 21380,
  last_order_at: '2026-10-01T01:00:00.000Z',
  contact_email: 'zhang.wei@example.com',
  last_recipient: NY.recipient,
};
const ROW_B = {
  id: 'u-cust-b',
  created_at: '2026-08-25T03:00:00.000Z',
  blocked: true,
  blocked_at: '2026-09-28T05:00:00.000Z',
  order_count: 1,
  paid_order_count: 1,
  paid_total_jpy: 4980,
  last_order_at: '2026-09-25T06:00:00.000Z',
  contact_email: 'chen.hao@example.com',
  last_recipient: CHI.recipient,
};
const ROW_C = {
  id: 'u-cust-c',
  created_at: '2026-09-30T03:00:00.000Z',
  blocked: false,
  order_count: 0,
  paid_order_count: 0,
  paid_total_jpy: 0,
};

describe('守卫', () => {
  it('两条路由：无 token → 40101；买家 token → 40301', async () => {
    await withServer(async (url) => {
      const buyer = await bearer('u-cust-a', 'user');
      for (const path of ['/api/v1/admin/customers', '/api/v1/admin/customers/u-cust-a']) {
        expect(code(await get(url, path))).toBe(40101);
        expect(code(await get(url, path, buyer))).toBe(40301);
      }
    });
  });
});

describe('GET /admin/customers', () => {
  it('列出全部买家（不含管理员）：聚合排除测试单；按最近下单倒序，没下过单的排最后', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers', admin);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ items: [ROW_A, ROW_B, ROW_C], total: 3 });
    });
  });

  it('分页：size=1&page=2 → 第二位；total 仍是全部', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers?size=1&page=2', admin);
      expect(r.body).toEqual({ items: [ROW_B], total: 3 });
    });
  });

  it('搜索：邮箱（大小写不敏感）/ 订单号 / 订单收件人 / 地址簿收件人 / 用户 id', async () => {
    await withServer(async (url, admin) => {
      const ids = async (kw: string): Promise<unknown[]> => {
        const r = await get(
          url,
          `/api/v1/admin/customers?keyword=${encodeURIComponent(kw)}`,
          admin,
        );
        expect(r.status).toBe(200);
        return (r.body['items'] as Array<{ id: string }>).map((x) => x.id);
      };
      expect(await ids('ZHANG.WEI@')).toEqual(['u-cust-a']);
      expect(await ids('260925-zz9')).toEqual(['u-cust-b']);
      expect(await ids(CHI.recipient.toLowerCase())).toEqual(['u-cust-b']);
      // C 没下过单，只能从地址簿里找到
      expect(await ids(SEA.recipient)).toEqual(['u-cust-c']);
      expect(await ids('u-cust-c')).toEqual(['u-cust-c']);
      // 测试单的单号也能找到人（"找这个人"是显式动作，与 /admin/orders 关键字同口径）
      expect(await ids('261005-TEST01')).toEqual(['u-cust-a']);
      // % 不是通配符（position 语义）；管理员的邮箱搜不出管理员
      expect(await ids('%')).toEqual([]);
      expect(await ids('owner@waselect')).toEqual([]);
    });
  });

  it('搜索的 total 与过滤后的行数一致（两条 SQL 共用同一个 WHERE）', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers?keyword=example.com', admin);
      expect(r.body['total']).toBe(2);
      expect((r.body['items'] as unknown[]).length).toBe(2);
    });
  });

  it('参数不合法 → 40001（reason 指明哪一项），不静默当成默认值', async () => {
    await withServer(async (url, admin) => {
      // reason 按全站口径只进日志（AppError.details → request_rejected），不进响应体：取最近一条拒绝日志
      const reason = (_r: unknown): unknown => {
        const rows = sink.find('request_rejected');
        return (rows[rows.length - 1]?.['details'] as Record<string, unknown> | undefined)?.[
          'reason'
        ];
      };
      const big = await get(url, '/api/v1/admin/customers?size=101', admin);
      expect([big.status, code(big), reason(big)]).toEqual([400, 40001, 'page_size_invalid']);
      const zero = await get(url, '/api/v1/admin/customers?page=0', admin);
      expect([code(zero), reason(zero)]).toEqual([40001, 'page_size_invalid']);
      const long = await get(url, `/api/v1/admin/customers?keyword=${'a'.repeat(65)}`, admin);
      expect([code(long), reason(long)]).toEqual([40001, 'keyword_too_long']);
      const dup = await get(url, '/api/v1/admin/customers?keyword=a&keyword=b', admin);
      expect([code(dup), reason(dup)]).toEqual([40001, 'keyword_invalid']);
    });
  });

  it('业务日志 admin_customers_listed：有分页与命中数、只记"有没有关键字"，不记关键字本身', async () => {
    await withServer(async (url, admin) => {
      await get(url, '/api/v1/admin/customers?keyword=zhang.wei%40example.com', admin);
      const rows = sink.find('admin_customers_listed');
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toBe('admin:u-admin');
      expect(row['ctx']).toEqual({ page: 1, size: 20, has_keyword: true, total: 1 });
    });
  });
});

describe('GET /admin/customers/{id}', () => {
  it('详情：资料 + 统计（排除测试单）+ 地址簿 + 订单历史（含测试单并标出）+ 风险', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers/u-cust-a', admin);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        id: 'u-cust-a',
        created_at: '2026-08-20T03:00:00.000Z',
        blocked: false,
        contact_email: 'zhang.wei@example.com',
        stats: {
          order_count: 3,
          paid_order_count: 2,
          paid_total_jpy: 21380,
          test_order_count: 1,
          first_order_at: '2026-09-01T02:00:00.000Z',
          last_order_at: '2026-10-01T01:00:00.000Z',
        },
        addresses: [
          {
            id: 'addr-a1',
            recipient: NY.recipient,
            phone: PHONE_A1,
            line1: NY.line1,
            city: NY.city,
            state: NY.state,
            postal_code: NY.postalCode,
            country: 'US',
            is_default: true,
          },
          {
            id: 'addr-a2',
            recipient: LA.recipient,
            phone: PHONE_A2,
            line1: LA.line1,
            line2: LA.line2,
            city: LA.city,
            state: LA.state,
            postal_code: LA.postalCode,
            country: 'US',
            is_default: false,
          },
        ],
        orders: [
          {
            order_id: 'o-a4',
            order_no: '261005-TEST01',
            status: 'paid',
            total_jpy: 1000,
            is_test: true,
            has_dispute: false,
            created_at: '2026-10-05T01:00:00.000Z',
            paid_at: '2026-10-05T01:01:00.000Z',
          },
          {
            order_id: 'o-a3',
            order_no: '261001-ABCD23',
            status: 'expired',
            total_jpy: 5000,
            is_test: false,
            has_dispute: false,
            created_at: '2026-10-01T01:00:00.000Z',
          },
          {
            order_id: 'o-a2',
            order_no: '260920-P3XR8T',
            status: 'completed',
            total_jpy: 12450,
            is_test: false,
            has_dispute: false,
            created_at: '2026-09-20T09:00:00.000Z',
            paid_at: '2026-09-20T09:03:00.000Z',
          },
          {
            order_id: 'o-a1',
            order_no: '260901-K7Q2MN',
            status: 'paid',
            total_jpy: 8930,
            is_test: false,
            has_dispute: false,
            created_at: '2026-09-01T02:00:00.000Z',
            paid_at: '2026-09-01T02:05:00.000Z',
          },
        ],
        risk: { dispute_count: 1, open_dispute_count: 1 },
      });
      // openid 绝不下发（约束七 + 任务要求）
      expect(JSON.stringify(r.body)).not.toContain('oWx-openid');
    });
  });

  it('已拉黑的客户：blocked + blocked_at；结案的拒付不算进行中', async () => {
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                                   dispute_id, dispute_status, dispute_amount, dispute_opened_at, dispute_closed_at)
             values ('pay-b1', 'o-b1', 'stripe', 'succeeded', 'USD', 3415,
                     'dp_9Z8x7C6v5B4n', 'won', 3415, '2026-09-26T00:00:00Z', '2026-10-03T00:00:00Z')`;
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers/u-cust-b', admin);
      expect(r.body['blocked']).toBe(true);
      expect(r.body['blocked_at']).toBe('2026-09-28T05:00:00.000Z');
      expect(r.body['risk']).toEqual({ dispute_count: 1, open_dispute_count: 0 });
    });
  });

  it('没下过单的客户：统计为 0、无时间字段、订单为空数组（形状固定）', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/customers/u-cust-c', admin);
      expect(r.body['stats']).toEqual({
        order_count: 0,
        paid_order_count: 0,
        paid_total_jpy: 0,
        test_order_count: 0,
      });
      expect(r.body['orders']).toEqual([]);
      expect(r.body['contact_email']).toBeUndefined();
      expect((r.body['addresses'] as unknown[]).length).toBe(1);
    });
  });

  it('不存在 / 管理员 id → 40403（管理员不是客户，不暴露其资料）', async () => {
    await withServer(async (url, admin) => {
      for (const id of ['u-nobody', 'u-admin']) {
        const r = await get(url, `/api/v1/admin/customers/${id}`, admin);
        expect([r.status, code(r)]).toEqual([404, 40403]);
      }
    });
  });

  it('业务日志 admin_customer_viewed：谁看了哪个客户（只记 id，不记资料）', async () => {
    await withServer(async (url, admin) => {
      await get(url, '/api/v1/admin/customers/u-cust-a', admin);
      const rows = sink.find('admin_customer_viewed');
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row['actor']).toBe('admin:u-admin');
      expect(row['ctx']).toEqual({ target_user_id: 'u-cust-a' });
    });
  });
});

describe('订单详情的客户卡片（§4.2 第 168 行）', () => {
  it('GET /admin/orders/{id} 带 customer：历史单数 + 累计实付（排除测试单）+ 是否拉黑', async () => {
    await withServer(async (url, admin) => {
      const r = await get(url, '/api/v1/admin/orders/o-a1', admin);
      expect(r.status).toBe(200);
      expect(r.body['customer']).toEqual({
        user_id: 'u-cust-a',
        order_count: 3,
        paid_total_jpy: 21380,
        blocked: false,
      });
      const b = await get(url, '/api/v1/admin/orders/o-b1', admin);
      expect(b.body['customer']).toEqual({
        user_id: 'u-cust-b',
        order_count: 1,
        paid_total_jpy: 4980,
        blocked: true,
      });
    });
  });
});

describe('客户详情页上的拉黑 / 解除（复用 /admin/users/{id}/block|unblock）', () => {
  it('拉黑后详情立刻显示 blocked；解除后恢复', async () => {
    await withServer(async (url, admin) => {
      const post = async (path: string, body?: unknown): Promise<number> =>
        (
          await fetch(`${url}${path}`, {
            method: 'POST',
            headers: { authorization: admin, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        ).status;
      expect(await post('/api/v1/admin/users/u-cust-c/block')).toBe(200);
      const after = await get(url, '/api/v1/admin/customers/u-cust-c', admin);
      expect(after.body['blocked']).toBe(true);
      expect(
        await post('/api/v1/admin/users/u-cust-c/unblock', { reason: '误拉黑，客服核实后解除' }),
      ).toBe(200);
      const back = await get(url, '/api/v1/admin/customers/u-cust-c', admin);
      expect(back.body['blocked']).toBe(false);
      expect(back.body['blocked_at']).toBeUndefined();
    });
  });
});

/**
 * AJ-413：`DELETE /admin/customers/{id}/events`——APPI「用户要求删除」的后台路径。
 * @why 真库 + 真路由：要证明的不只是"回了 200"，而是行真的没了、别人的行还在、admin_audit 里有谁 / 为什么。
 */
async function del(
  url: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: token }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function auditRows(target: string): Promise<Record<string, unknown>[]> {
  // 审计是异步落库（在途表），最多等 2s
  const deadline = Date.now() + 2000;
  for (;;) {
    const rows =
      await db`select actor, action, target, after, status_code from admin_audit where target = ${target}`;
    if (rows.length > 0 || Date.now() > deadline) return rows as Record<string, unknown>[];
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('DELETE /admin/customers/{id}/events（AJ-413）', () => {
  beforeEach(async () => {
    await db`insert into user_events (user_id, session_id, event, props, created_at)
             values ('u-cust-a', 's', 'page_view', '{"page":"home"}', now() - interval '1 day'),
                    ('u-cust-a', 's', 'add_to_cart', '{"product_id":"p-1"}', now() - interval '300 days'),
                    ('u-cust-b', 's', 'page_view', '{"page":"home"}', now()),
                    (null, 's', 'page_view', '{"page":"home"}', now())`;
  });

  it('🔴 删掉该客户全部行为记录（不论多旧）→ 200 {deleted}；别人的与匿名的不动；审计带 actor / reason', async () => {
    await withServer(async (url, admin) => {
      const r = await del(url, '/api/v1/admin/customers/u-cust-a/events', admin, {
        reason: '买家邮件要求删除',
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ deleted: 2 });
      const left = await db`select user_id from user_events order by user_id nulls first`;
      expect(left.map((x) => x['user_id'])).toEqual([null, 'u-cust-b']);
      const audit = await auditRows('u-cust-a');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: 'admin:u-admin',
        action: 'DELETE /admin/customers/:id/events',
        status_code: 200,
      });
      expect(audit[0]?.['after']).toEqual({ reason: '买家邮件要求删除' });
      const line = sink.find('admin_user_events_purged');
      expect(line).toHaveLength(1);
      expect(line[0]?.['ctx']).toMatchObject({ target_user_id: 'u-cust-a', count: 2 });
    });
  });

  it('没有记录的客户 → 200 {deleted: 0}（请求已兑现，照样留审计）', async () => {
    await withServer(async (url, admin) => {
      const r = await del(url, '/api/v1/admin/customers/u-cust-c/events', admin, {
        reason: '买家要求',
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ deleted: 0 });
      expect(await auditRows('u-cust-c')).toHaveLength(1);
    });
  });

  it('🔴 原因必填：空 / 非字符串 → 40001，一行不删；超长 → 40001', async () => {
    await withServer(async (url, admin) => {
      for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 1 }]) {
        const r = await del(url, '/api/v1/admin/customers/u-cust-a/events', admin, body);
        expect(r.status).toBe(400);
        expect(code(r)).toBe(40001);
      }
      // 上限恰好值（审查 2026-10-09 C7）：500 放行、501 拒——魔法数 2001 对"上限误写成 2000"也绿
      const long = await del(url, '/api/v1/admin/customers/u-cust-a/events', admin, {
        reason: 'x'.repeat(ADMIN_NOTE_MAX_LENGTH + 1),
      });
      expect(code(long)).toBe(40001);
      const edge = await del(url, '/api/v1/admin/customers/u-cust-b/events', admin, {
        reason: 'x'.repeat(ADMIN_NOTE_MAX_LENGTH),
      });
      expect(edge.status).toBe(200);
      const left = await db`select count(*)::int as n from user_events where user_id = 'u-cust-a'`;
      expect(left[0]?.['n']).toBe(2);
    });
  });

  it('不存在 / 管理员 id → 40403；无 token → 40101；买家 token → 40301', async () => {
    await withServer(async (url, admin) => {
      expect(
        code(await del(url, '/api/v1/admin/customers/u-nope/events', admin, { reason: 'r' })),
      ).toBe(40403);
      expect(
        code(await del(url, '/api/v1/admin/customers/u-admin/events', admin, { reason: 'r' })),
      ).toBe(40403);
      expect(
        code(await del(url, '/api/v1/admin/customers/u-cust-a/events', undefined, { reason: 'r' })),
      ).toBe(40101);
      const buyer = await bearer('u-cust-b', 'user');
      expect(
        code(await del(url, '/api/v1/admin/customers/u-cust-a/events', buyer, { reason: 'r' })),
      ).toBe(40301);
      const left = await db`select count(*)::int as n from user_events`;
      expect(left[0]?.['n']).toBe(4);
    });
  });
});
