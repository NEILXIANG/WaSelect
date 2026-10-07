/**
 * 全局停售开关（AJ-384；工程缺口第二轮 §6.3 G10）：真实路由 + 真实 Postgres。
 *
 * @why 事故止血的唯一一步：价格录错时，原先只能逐个下架或改 env 重启。开关存在 app_config，管理端一键、立即生效。
 *      钉住三件事：① 报价 / 建单 / 发起支付三个入口都拦；② 不需要重启（同一个进程里开、关都生效）；
 *      ③ 拦的是"新的钱"——回调、退款、发货不受影响（这里用"管理端订单列表照常"代表后者不被误拦）。
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

let db: Db;
const JWT_SECRET = 'sales-pause-route-test-jwt-sec-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let url: string;
let close: () => Promise<void>;
let admin: string;
let buyer: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`delete from app_config where key = 'sales.paused'`;
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'admin@example.com', true), ('u-b', 'o-b', null, false)`;
  admin = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  buyer = await signToken({ sub: 'u-b', role: 'user' }, { secret: JWT_SECRET, issuer: 'waselect' });
  const logger = createLogger({ env: 'test', destination: new MemorySink() });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-sales-pause-test',
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
  const s = await listen(app);
  url = `http://127.0.0.1:${String(s.port)}`;
  close = s.close;
  return async () => {
    await db`delete from app_config where key = 'sales.paused'`;
    await close();
  };
});

async function req(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const ITEMS = { items: [{ product_id: 'p-ghost', qty: 1 }] };

describe('全局停售开关', () => {
  it('默认未停售：GET 返回 paused=false；报价走到业务（商品不存在 40401，而不是 40916）', async () => {
    expect((await req('GET', '/api/v1/admin/ops/sales-pause', admin)).json).toMatchObject({
      paused: false,
    });
    expect((await req('POST', '/api/v1/orders/quote', buyer, ITEMS)).json['code']).toBe(40401);
  });

  it('🔴 停售 → 报价 / 建单 / 发起支付都 40916（不重启）；恢复 → 报价立即恢复', async () => {
    const on = await req('PUT', '/api/v1/admin/ops/sales-pause', admin, {
      paused: true,
      reason: '价格录错，紧急止血',
    });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ paused: true, reason: '价格录错，紧急止血' });
    expect((await req('POST', '/api/v1/orders/quote', buyer, ITEMS)).json['code']).toBe(40916);
    expect((await req('POST', '/api/v1/orders', buyer, ITEMS)).json['code']).toBe(40916);
    expect(
      (await req('POST', '/api/v1/orders/o-x/pay', buyer, { channel: 'mock' })).json['code'],
    ).toBe(40916);
    const audit = await db`select before from admin_audit where action like '%sales-pause%'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['before']).toMatchObject({ paused: false });
    // 管理端照常（不是全站停机）
    expect((await req('GET', '/api/v1/admin/orders', admin)).status).toBe(200);

    const off = await req('PUT', '/api/v1/admin/ops/sales-pause', admin, {
      paused: false,
      reason: '价格已改正',
    });
    expect(off.json).toMatchObject({ paused: false });
    expect((await req('POST', '/api/v1/orders/quote', buyer, ITEMS)).json['code']).toBe(40401);
  });

  it('🔴 原因必填（进审计）；paused 不是布尔 → 40001；买家 token → 403', async () => {
    expect(
      (await req('PUT', '/api/v1/admin/ops/sales-pause', admin, { paused: true, reason: ' ' }))
        .json['code'],
    ).toBe(40001);
    expect(
      (await req('PUT', '/api/v1/admin/ops/sales-pause', admin, { paused: 'yes', reason: 'x' }))
        .json['code'],
    ).toBe(40001);
    expect(
      (await req('PUT', '/api/v1/admin/ops/sales-pause', buyer, { paused: true, reason: 'x' }))
        .status,
    ).toBe(403);
    const audit = await db`select action from admin_audit where action like '%sales-pause%'`;
    expect(audit).toHaveLength(0);
  });
});

describe('P2-24（AJ-386）：停售守卫跑在报价限流**之后**', () => {
  /**
   * @why 匿名刷 `/orders/quote` 时，限流挡在前面才保护得了守卫那次 DB 读；
   *      守卫在前 = 每个被限流的请求照样先打一次库。被限流的请求应拿到 42901 而不是 40916。
   */
  it('🔴 报价超限 + 停售中 → 第二次是 42901（限流先判），不是 40916', async () => {
    const logger = createLogger({ env: 'test', destination: new MemorySink() });
    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '1',
      HOST: '127.0.0.1',
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET,
      PAYMENT_CHANNELS: 'mock',
      MOCK_CALLBACK_SECRET: 'mock-secret-for-sales-pause-test',
      TERMS_VERSION: 'TOS-TEST-1',
      RATE_LIMIT_QUOTE_PER_MIN: '1',
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
    const s = await listen(app);
    try {
      await db`insert into app_config (key, value) values ('sales.paused', '{"paused":true,"reason":"t"}'::jsonb)
               on conflict (key) do update set value = excluded.value`;
      const hit = async () =>
        (
          await fetch(`http://127.0.0.1:${String(s.port)}/api/v1/orders/quote`, {
            method: 'POST',
            headers: { authorization: `Bearer ${buyer}`, 'content-type': 'application/json' },
            body: JSON.stringify(ITEMS),
          })
        ).json() as Promise<{ code: number }>;
      expect((await hit()).code).toBe(40916);
      expect((await hit()).code).toBe(42901);
    } finally {
      await db`delete from app_config where key = 'sales.paused'`;
      await s.close();
    }
  });
});
