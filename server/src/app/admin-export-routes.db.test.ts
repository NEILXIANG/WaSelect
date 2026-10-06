/**
 * 职责：CSV 导出接口（剩余清单 3-3）——订单 / 待采购 / 待发货报关三类。
 * @why 导出的是**含收件地址的 PII**：这里断言三件事——内容对、排除测试单、导出这一动作进审计（GET 不经审计中间件）。
 * @see ./admin-export-routes.ts
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
let sink: MemorySink;
const JWT_SECRET = 'admin-export-test-jwt-secret-'.repeat(3);

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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-export-route-test',
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
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function bearer(isAdmin = true): Promise<string> {
  const id = `u-${isAdmin ? 'admin' : 'buyer'}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${id}`}, ${`${id}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  // ⚠️ signToken 是 async——必须 await，否则拼出 "Bearer [object Promise]"
  const t = await signToken(
    { sub: id, role: isAdmin ? 'admin' : 'user' },
    {
      secret: JWT_SECRET,
      issuer: 'waselect',
    },
  );
  return `Bearer ${t}`;
}

async function call(
  url: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

const code = (r: { body: unknown }): number => Number((r.body as { code?: number })?.code);

const ADDR = {
  recipient: 'Jane Doe',
  phone: '+14155550123',
  line1: '1 Infinite Loop',
  line2: null,
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
  country: 'US',
};

async function seedOrder(id: string, status: string, isTest = false): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                               fx_snapshot, address_snapshot, terms_version, expires_at, is_test, created_at, paid_at)
           values (${id}, ${`WS${id}`}, ${`u-${id}`}, ${status}, 12800, 4950, null, 17750, 900, '{}'::jsonb,
                   ${db.json(ADDR)}, 'T', now(), ${isTest}, '2026-10-05T00:00:00Z', '2026-10-05T00:10:00Z')`;
  await db`insert into products (id, title, category, price_jpy, weight_g, stock, customs_desc_en, origin_country)
           values (${`p-${id}`}, 'Deba Knife', 'kitchen', 12800, 540, 3, 'Kitchen knife', 'JP') on conflict do nothing`;
  await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g,
                                    declared_value_usd, title_ja, jan_code, purchase_source, cost_jpy, hs_code, customs_desc_en)
           values (${`oi-${id}`}, ${id}, ${`p-${id}`}, 'Deba Knife 出刃包丁', 1, 12800, 540, 8576,
                   '出刃包丁 165mm', '4900000000011', '=HYPERLINK("x")', 6200, '8211.91', 'Kitchen knife, stainless')`;
}

const lines = (csv: string): string[] =>
  csv
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter((l) => l !== '');

describe('GET /api/v1/admin/exports/{kind}（3-3）', () => {
  it('🔴 customs：只出 paid 的单（不含测试单），一行一个行项目，带收件地址、HS 码、申报价（美元两位小数）', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'shipped');
    await seedOrder('o-t', 'paid', true);
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/customs', undefined, await bearer());
      expect(r.status).toBe(200);
      const body = r.body as { filename: string; csv: string };
      expect(body.filename).toMatch(/^customs-\d{8}\.csv$/);
      const ls = lines(body.csv);
      expect(ls).toHaveLength(2); // 表头 + o-1 一行
      expect(ls[0]).toContain('hs_code');
      expect(ls[1]).toContain('WSo-1');
      expect(ls[1]).toContain('Jane Doe');
      expect(ls[1]).toContain('95014');
      expect(ls[1]).toContain('8211.91');
      expect(ls[1]).toContain('85.76');
      expect(ls[1]).toContain('Kitchen knife, stainless');
    } finally {
      await close();
    }
  });

  it('purchase：paid 单的采购快照，公式注入被转义；不含收件地址', async () => {
    await seedOrder('o-1', 'paid');
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/purchase', undefined, await bearer());
      const csv = (r.body as { csv: string }).csv;
      expect(csv).toContain('出刃包丁 165mm');
      expect(csv).toContain('4900000000011');
      expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
      expect(csv).not.toContain('Jane Doe');
    } finally {
      await close();
    }
  });

  it('orders：全部非测试单（可按 status 过滤），一单一行', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'shipped');
    await seedOrder('o-t', 'paid', true);
    const { url, close } = await buildServer();
    try {
      const all = await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer());
      expect(lines((all.body as { csv: string }).csv)).toHaveLength(3);
      const shipped = await call(
        url,
        'GET',
        '/api/v1/admin/exports/orders?status=shipped',
        undefined,
        await bearer(),
      );
      expect(lines((shipped.body as { csv: string }).csv)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('🔴 每次导出都写一条审计（谁、导了哪类、多少行）；未知 kind → 40001；非管理员 → 403', async () => {
    await seedOrder('o-1', 'paid');
    const { url, close } = await buildServer();
    try {
      await call(url, 'GET', '/api/v1/admin/exports/customs', undefined, await bearer());
      const [a] = await db`select actor, action, target, after from admin_audit`;
      expect(a).toMatchObject({
        actor: 'admin:u-admin',
        action: 'GET /api/v1/admin/exports/:kind',
        target: 'customs',
      });
      expect(a?.['after']).toEqual({ rows: 1 });
      expect(
        code(await call(url, 'GET', '/api/v1/admin/exports/everything', undefined, await bearer())),
      ).toBe(40001);
      expect(
        (await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer(false)))
          .status,
      ).toBe(403);
    } finally {
      await close();
    }
  });
});
