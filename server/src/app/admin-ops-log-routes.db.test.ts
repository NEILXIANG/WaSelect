/**
 * 职责：运营日志接口（剩余清单 3-2）——管理员操作审计分页查询 + 最近一次每日对账结果。
 * @why 两份数据此前只在库表 / 日志里，管理端没有任何入口；运营要回答"谁昨天改了价格""昨晚对账有没有异常"只能找开发。
 * @see ./admin-ops-log-routes.ts
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
import { seedCreatedOrder } from '../../../test/helpers/seed-order.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-opslog-test-jwt-secret-'.repeat(3);

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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-opslog-route-test',
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

async function audit(n: number, actor: string, action: string, at: string): Promise<void> {
  await db`insert into admin_audit (actor, action, target, before, after, status_code, created_at)
           values (${actor}, ${action}, ${`o-${String(n)}`}, ${db.json({ secret: 'x' })}, null, 200, ${at})`;
}

describe('GET /api/v1/admin/audit（3-2）', () => {
  it('🔴 按时间倒序分页，带 total；不下发 before / after（可能含改动前后的业务数据）', async () => {
    await audit(1, 'admin:u-a', 'POST /api/v1/admin/orders/:id/refund', '2026-10-01T00:00:00Z');
    await audit(2, 'admin:u-b', 'PUT /api/v1/admin/products/:id', '2026-10-02T00:00:00Z');
    await audit(3, 'cli:admin-create', 'CLI admin.create', '2026-10-03T00:00:00Z');
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'GET',
        '/api/v1/admin/audit?page=1&size=2',
        undefined,
        await bearer(),
      );
      expect(r.status).toBe(200);
      const body = r.body as { items: Array<Record<string, unknown>>; total: number };
      expect(body.total).toBe(3);
      expect(body.items.map((i) => i['target'])).toEqual(['o-3', 'o-2']);
      expect(body.items[0]).toMatchObject({
        actor: 'cli:admin-create',
        action: 'CLI admin.create',
      });
      expect(body.items[1]?.['status_code']).toBe(200);
      expect(body.items[0]).not.toHaveProperty('before');
      expect(body.items[0]).not.toHaveProperty('after');
    } finally {
      await close();
    }
  });

  it('按 actor 精确过滤；按 target 精确过滤', async () => {
    await audit(1, 'admin:u-a', 'A', '2026-10-01T00:00:00Z');
    await audit(2, 'admin:u-b', 'B', '2026-10-02T00:00:00Z');
    const { url, close } = await buildServer();
    try {
      const a = await call(
        url,
        'GET',
        '/api/v1/admin/audit?actor=admin:u-a',
        undefined,
        await bearer(),
      );
      expect((a.body as { items: unknown[] }).items).toHaveLength(1);
      const t = await call(url, 'GET', '/api/v1/admin/audit?target=o-2', undefined, await bearer());
      expect((t.body as { items: Array<{ actor: string }> }).items.map((i) => i.actor)).toEqual([
        'admin:u-b',
      ]);
    } finally {
      await close();
    }
  });

  it('🔴 带操作人邮箱；按邮箱（不区分大小写）筛（三端联动 UI 模拟 2026-10-08）', async () => {
    const tk = await bearer(); // 建了 u-admin（u-admin@example.com）
    await audit(1, 'admin:u-admin', 'PUT /admin/products/:id', '2026-10-01T00:00:00Z');
    await audit(2, 'cli:admin-create', 'CLI admin.create', '2026-10-02T00:00:00Z');
    const { url, close } = await buildServer();
    try {
      const all = await call(url, 'GET', '/api/v1/admin/audit', undefined, tk);
      const items = (all.body as { items: Array<{ actor: string; actor_email?: string }> }).items;
      expect(items.find((i) => i.actor === 'admin:u-admin')?.actor_email).toBe(
        'u-admin@example.com',
      );
      expect(items.find((i) => i.actor === 'cli:admin-create')).not.toHaveProperty('actor_email');
      const byEmail = await call(
        url,
        'GET',
        '/api/v1/admin/audit?actor=U-Admin@Example.com',
        undefined,
        tk,
      );
      expect(
        (byEmail.body as { items: Array<{ actor: string }> }).items.map((i) => i.actor),
      ).toEqual(['admin:u-admin']);
    } finally {
      await close();
    }
  });

  // AJ-499：对象列原只有内部 id（ord-… / 商品 uuid），运营认不出是哪张单、哪件商品——带出订单号 / 商品名
  it('🔴 对象是订单 → target_label 为订单号；是商品 → 商品名；认不出（图片键、分类键）→ 不带', async () => {
    const tk = await bearer();
    await db`insert into users (id, openid) values ('u-buyer', 'o-buyer') on conflict do nothing`;
    await seedCreatedOrder(db, 'ord-label-1', { userId: 'u-buyer' });
    await db`insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
             values ('7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f', '南部铁器 铁壶 0.6L', 'kitchen', 16500, 1350, 'JP', 'active')`;
    for (const [i, action, target] of [
      [1, 'POST /admin/orders/:id/ship', 'ord-label-1'],
      [2, 'PUT /admin/products/:id', '7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f'],
      [3, 'POST /admin/upload', 'img/abc'],
      [4, 'CLI admin.password.reset', 'u-admin'],
    ] as const) {
      await db`insert into admin_audit (actor, action, target, status_code, created_at)
               values ('admin:u-admin', ${action}, ${target}, 200, ${`2026-10-0${String(i)}T00:00:00Z`})`;
    }
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/audit', undefined, tk);
      const items = (r.body as { items: Array<{ target?: string; target_label?: string }> }).items;
      const label = (t: string) => items.find((i) => i.target === t);
      expect(label('ord-label-1')?.target_label).toBe('W-ord-label-1');
      expect(label('7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f')?.target_label).toBe(
        '南部铁器 铁壶 0.6L',
      );
      expect(label('img/abc')).not.toHaveProperty('target_label');
      // 对象是账号（命令行改密、拉黑）→ 账号邮箱（有邮箱时；全入口点击测试 2026-10-12：原显示 adm-… / u-… 内部 id）
      expect(label('u-admin')?.target_label).toBe('u-admin@example.com');

      // 两端输入测试 2026-10-12：对象列显示订单号 / 商品名 / 邮箱，筛选框却只认内部 id——照着表格填进去查出 0 条
      const by = async (t: string) =>
        (
          (
            await call(
              url,
              'GET',
              `/api/v1/admin/audit?target=${encodeURIComponent(t)}`,
              undefined,
              tk,
            )
          ).body as { items: Array<{ target?: string }> }
        ).items.map((i) => i.target);
      expect(await by('W-ord-label-1')).toEqual(['ord-label-1']);
      expect(await by('南部铁器 铁壶 0.6L')).toEqual(['7f3c2a10-4b5e-4c6d-8e9f-0a1b2c3d4e5f']);
      expect(await by('U-ADMIN@example.com')).toEqual(['u-admin']);
      expect(await by('ord-label-1')).toEqual(['ord-label-1']); // 内部 id 照旧可用（订单详情的"操作记录"链接用它）
      expect(await by('南部铁器')).toEqual([]); // 商品名要整名相同，不做模糊
    } finally {
      await close();
    }
  });

  it('🔴 订单号不分大小写（运营照着手写或口头报的单号输入小写）', async () => {
    const tk = await bearer();
    await db`insert into users (id, openid) values ('u-buyer', 'o-buyer') on conflict do nothing`;
    await seedCreatedOrder(db, 'ord-case-1', { userId: 'u-buyer' });
    await db`update orders set order_no = '261009-F2Z45G' where id = 'ord-case-1'`;
    await db`insert into admin_audit (actor, action, target, status_code, created_at)
             values ('admin:u-admin', 'POST /admin/orders/:id/ship', 'ord-case-1', 200, '2026-10-01T00:00:00Z')`;
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/audit?target=261009-f2z45g', undefined, tk);
      expect((r.body as { items: Array<{ target?: string }> }).items.map((i) => i.target)).toEqual([
        'ord-case-1',
      ]);
    } finally {
      await close();
    }
  });

  it('size 超上限 / page 非法 → 40001；非管理员 → 403', async () => {
    const { url, close } = await buildServer();
    try {
      expect(
        code(await call(url, 'GET', '/api/v1/admin/audit?size=1000', undefined, await bearer())),
      ).toBe(40001);
      expect(
        code(await call(url, 'GET', '/api/v1/admin/audit?page=0', undefined, await bearer())),
      ).toBe(40001);
      expect(
        (await call(url, 'GET', '/api/v1/admin/audit', undefined, await bearer(false))).status,
      ).toBe(403);
    } finally {
      await close();
    }
  });
});

describe('GET /api/v1/admin/reconciliation/latest（3-2）', () => {
  it('🔴 没跑过 → { run: null }；跑过两次 → 最近一次（计数 + 取样）', async () => {
    const { url, close } = await buildServer();
    try {
      const none = await call(
        url,
        'GET',
        '/api/v1/admin/reconciliation/latest',
        undefined,
        await bearer(),
      );
      expect(none.body).toEqual({ run: null });
      await db`insert into reconciliation_runs (ran_at, counts, samples)
               values ('2026-10-04T18:00:00Z', ${db.json({ stuck_refunds: 1 })}, ${db.json({ stuck_refunds: ['o-9'] })}),
                      ('2026-10-05T18:00:00Z', ${db.json({ stuck_refunds: 0 })}, ${db.json({})})`;
      const r = await call(
        url,
        'GET',
        '/api/v1/admin/reconciliation/latest',
        undefined,
        await bearer(),
      );
      expect(r.body).toEqual({
        run: { ran_at: '2026-10-05T18:00:00.000Z', counts: { stuck_refunds: 0 }, samples: {} },
      });
    } finally {
      await close();
    }
  });
});

/** 评估 P2（2026-10-09）：运营日志按日期范围筛（日本时间、两端含当天；口径同订单列表 created_from / created_to）。 */
describe('GET /api/v1/admin/audit?created_from&created_to', () => {
  it('🔴 只出范围内的记录（JST 日界）；范围倒置 / 格式不对 → 40001', async () => {
    // JST 10-02 00:00 = UTC 10-01 15:00；JST 10-03 23:59 = UTC 10-03 14:59
    await audit(1, 'admin:u-a', 'POST /admin/x', '2026-10-01T14:59:59Z'); // JST 10-01 23:59:59 → 范围外
    await audit(2, 'admin:u-a', 'POST /admin/x', '2026-10-01T15:00:00Z'); // JST 10-02 00:00 → 范围内
    await audit(3, 'admin:u-a', 'POST /admin/x', '2026-10-03T14:59:59Z'); // JST 10-03 23:59:59 → 范围内
    await audit(4, 'admin:u-a', 'POST /admin/x', '2026-10-03T15:00:00Z'); // JST 10-04 00:00 → 范围外
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'GET',
        '/api/v1/admin/audit?created_from=2026-10-02&created_to=2026-10-03',
        undefined,
        await bearer(),
      );
      expect(r.status).toBe(200);
      const body = r.body as { items: Array<Record<string, unknown>>; total: number };
      expect(body.total).toBe(2);
      expect(body.items.map((i) => i['target'])).toEqual(['o-3', 'o-2']);
      for (const qs of [
        'created_from=2026-10-05&created_to=2026-10-01',
        'created_from=10/02/2026',
      ]) {
        const bad = await call(url, 'GET', `/api/v1/admin/audit?${qs}`, undefined, await bearer());
        expect(bad.status).toBe(400);
        expect((bad.body as { code: number }).code).toBe(40001);
      }
    } finally {
      await close();
    }
  });
});
