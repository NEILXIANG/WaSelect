/**
 * 职责：`/admin/disputes` 与 `/admin/users/{id}/block` 的接线级真库用例（I2 U-E3）。
 *
 * @why 守卫与两条拒绝路径（40403 / 40911）都要**接线级**测：`requireRole` 与
 *      `parseDisputeStatus` 各自都有单测，但"这条路由有没有挂它们"只有接线级能证明。
 *      ⚠️ 拉黑尤其：返回 200 的话运营以为风控生效了、实际什么都没发生，
 *      而单测层（仓储返回 not_found）根本看不出路由有没有转码。
 *
 * @why 断言一律查**库**：响应里拉黑是空体（ADR-28），"到底封没封"只能查库（§2 第 21 条）。
 *
 * @limitation 拒付行是裸 SQL 造的（`payments.dispute_*` 目前没有服务端写入方，
 *      与 risk-admin.db.test.ts 同口径）。
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
const JWT_SECRET = 'admin-risk-test-jwt-secret-'.repeat(3);

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
  await db`insert into users (id, openid, email) values ('u-1', 'o-1', 'buyer@example.com')`;
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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-risk-route-test',
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

async function seedDispute(
  payId: string,
  orderId: string,
  dispute: { id: string; status: string | null; amount: number; openedAt?: string },
): Promise<void> {
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values (${orderId}, ${`W-${orderId}`}, 'u-1', 'paid', 1000, 0, 0, 1000, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
  await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                                 dispute_id, dispute_status, dispute_amount, dispute_opened_at)
           values (${payId}, ${orderId}, 'stripe', 'succeeded', 'USD', ${dispute.amount},
                   ${dispute.id}, ${dispute.status}, ${dispute.amount}, ${dispute.openedAt ?? null})`;
}

describe('守卫', () => {
  it('两条路由：无 token → 40101；买家 token → 40301', async () => {
    const { url, close } = await buildServer();
    try {
      for (const [method, path] of [
        ['GET', '/api/v1/admin/disputes'],
        ['POST', '/api/v1/admin/users/u-1/block'],
      ] as Array<['GET' | 'POST', string]>) {
        const anon = await call(url, method, path);
        expect(anon.status, `${method} ${path} 无 token`).toBe(401);
        expect(code(anon)).toBe(40101);
        const buyer = await call(url, method, path, undefined, await bearer(false));
        expect(buyer.status, `${method} ${path} 买家 token`).toBe(403);
        expect(code(buyer)).toBe(40301);
      }
      // 买家 token 那条必须**没有副作用**（守卫先于业务）
      expect(
        Number(
          (await db`select count(*)::int as n from users where blocked_at is not null`)[0]?.['n'],
        ),
      ).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('GET /admin/disputes', () => {
  it('200：带出 order_no / 原币金额 / 开案时间；无拒付的支付行不出现', async () => {
    const { url, close } = await buildServer();
    try {
      await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                   total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
               values ('o-0', 'W-o-0', 'u-1', 'paid', 1000, 0, 0, 1000, 500,
                       '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
      await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
               values ('p-0', 'o-0', 'stripe', 'succeeded', 'USD', 1000)`;
      await seedDispute('p-1', 'o-1', {
        id: 'dp-1',
        status: 'open',
        amount: 4200,
        openedAt: '2026-09-01T00:00:00Z',
      });
      const r = await call(url, 'GET', '/api/v1/admin/disputes', undefined, await bearer());
      expect(r.status).toBe(200);
      const rows = r.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['dispute_id']).toBe('dp-1');
      expect(rows[0]?.['order_no']).toBe('W-o-1');
      expect(rows[0]?.['dispute_amount']).toBe(4200);
      expect(rows[0]?.['charge_currency']).toBe('USD');
      expect(rows[0]?.['opened_at']).toBe('2026-09-01T00:00:00.000Z');
      expect(rows[0]?.['closed_at']).toBeUndefined(); // null → 字段缺席
    } finally {
      await close();
    }
  });

  it('status 过滤生效；非法值 → 40001（不是静默"不过滤"）', async () => {
    const { url, close } = await buildServer();
    try {
      await seedDispute('p-1', 'o-1', { id: 'dp-open', status: 'open', amount: 100 });
      await seedDispute('p-2', 'o-2', { id: 'dp-lost', status: 'lost', amount: 200 });
      const token = await bearer();
      const filtered = await call(
        url,
        'GET',
        '/api/v1/admin/disputes?status=lost',
        undefined,
        token,
      );
      expect(filtered.status).toBe(200);
      expect((filtered.body as Array<Record<string, unknown>>).map((x) => x['dispute_id'])).toEqual(
        ['dp-lost'],
      );
      const bad = await call(url, 'GET', '/api/v1/admin/disputes?status=opened', undefined, token);
      expect(bad.status).toBe(400);
      expect(code(bad)).toBe(40001);
    } finally {
      await close();
    }
  });
});

describe('POST /admin/users/{id}/block', () => {
  it('200 空体且库里真封了（blocked_at 非空、token_ver +1）', async () => {
    const { url, close } = await buildServer();
    try {
      const before = await db`select token_ver from users where id = 'u-1'`;
      const r = await call(url, 'POST', '/api/v1/admin/users/u-1/block', undefined, await bearer());
      expect(r.status).toBe(200);
      expect(r.body).toBeNull();
      const after = await db`select token_ver, blocked_at from users where id = 'u-1'`;
      expect(after[0]?.['blocked_at']).not.toBeNull();
      expect(Number(after[0]?.['token_ver'])).toBe(Number(before[0]?.['token_ver']) + 1);
    } finally {
      await close();
    }
  });

  it('🈲 id 不存在 → 40403（返回 200 会让运营以为风控生效了）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/nope/block',
        undefined,
        await bearer(),
      );
      expect(r.status).toBe(404);
      expect(code(r)).toBe(40403);
      expect(
        Number(
          (await db`select count(*)::int as n from users where blocked_at is not null`)[0]?.['n'],
        ),
      ).toBe(0);
    } finally {
      await close();
    }
  });

  it('🈲 对方是管理员 → 40911 且库里一点没动（拉黑管理员 = 把自己锁在门外）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`update users set is_admin = true where id = 'u-1'`;
      const r = await call(url, 'POST', '/api/v1/admin/users/u-1/block', undefined, await bearer());
      expect(r.status).toBe(409);
      expect(code(r)).toBe(40911);
      const row = await db`select blocked_at from users where id = 'u-1'`;
      expect(row[0]?.['blocked_at']).toBeNull();
    } finally {
      await close();
    }
  });

  it('幂等：已封禁的再来一次仍 200（不刷新 blocked_at）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      await call(url, 'POST', '/api/v1/admin/users/u-1/block', undefined, token);
      const mid = await db`select blocked_at from users where id = 'u-1'`;
      const again = await call(url, 'POST', '/api/v1/admin/users/u-1/block', undefined, token);
      expect(again.status).toBe(200);
      const end = await db`select blocked_at from users where id = 'u-1'`;
      expect((end[0]?.['blocked_at'] as Date | null)?.getTime()).toBe(
        (mid[0]?.['blocked_at'] as Date | null)?.getTime(),
      );
    } finally {
      await close();
    }
  });

  it('拉黑写业务日志（含 target_user_id；**不得**写保留键 actor）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'POST', '/api/v1/admin/users/u-1/block', undefined, await bearer());
      expect(r.status).toBe(200);
      const rows = sink.find('admin_user_blocked');
      expect(rows).toHaveLength(1);
      const obj = rows[0] as unknown as Record<string, unknown>;
      const ctx = (obj['ctx'] ?? {}) as Record<string, unknown>;
      expect(ctx['target_user_id']).toBe('u-1');
      expect(ctx['already_blocked']).toBe(false);
      // §2 第 41 条：`actor` 是 logger 的**保留键**，由 requireRole 通过 patchContext 写入；
      // 调用点传它会抛 TypeError → 500。所以这里要断言的是"它**存在且来自请求上下文**"
      // （上面已断言 200，等于证明了调用点没传），并且 ctx 里没有同名字段。
      expect(obj['actor']).toBe('admin:u-admin');
      expect(Object.keys(ctx)).not.toContain('actor');
    } finally {
      await close();
    }
  });
});
