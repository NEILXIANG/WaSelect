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
import { waitUntil } from '../../../test/helpers/chain-server.js';
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

/** 造一张属于指定用户的在途单（拉黑凭据核对用；不需要拒付行）。 */
async function seedOrderOf(orderId: string, userId: string): Promise<void> {
  await db`insert into users (id, openid, email) values (${userId}, ${`o-${userId}`}, ${`${userId}@example.com`})
           on conflict (id) do nothing`;
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values (${orderId}, ${`W-${orderId}`}, ${userId}, 'created', 1000, 0, 0, 1000, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
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
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '测试拉黑' },
        await bearer(),
      );
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
        { reason: '测试拉黑' },
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
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '测试拉黑' },
        await bearer(),
      );
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
      await call(url, 'POST', '/api/v1/admin/users/u-1/block', { reason: '测试拉黑' }, token);
      const mid = await db`select blocked_at from users where id = 'u-1'`;
      const again = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '测试拉黑' },
        token,
      );
      expect(again.status).toBe(200);
      const end = await db`select blocked_at from users where id = 'u-1'`;
      expect((end[0]?.['blocked_at'] as Date | null)?.getTime()).toBe(
        (mid[0]?.['blocked_at'] as Date | null)?.getTime(),
      );
    } finally {
      await close();
    }
  });

  it('🈲 带**别人**的 order_id → 40915，且库里**一点没动**（纵深防御 / AJ-290）', async () => {
    const { url, close } = await buildServer();
    try {
      await seedOrderOf('o-1', 'u-1');
      await seedOrderOf('o-2', 'u-2');
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { order_id: 'o-2', reason: '测试拉黑' },
        await bearer(),
      );
      expect(r.status).toBe(409);
      expect(code(r)).toBe(40915);
      // 三条"一点没动"：人没封、他自己的单没被取消、别人的单也没被取消
      const u1 = await db`select blocked_at from users where id = 'u-1'`;
      expect(u1[0]?.['blocked_at']).toBeNull();
      const o1 = await db`select status from orders where id = 'o-1'`;
      expect(String(o1[0]?.['status'])).toBe('created');
      const o2 = await db`select status from orders where id = 'o-2'`;
      expect(String(o2[0]?.['status'])).toBe('created');
    } finally {
      await close();
    }
  });

  it('🈲 带**不存在**的 order_id → 40915（与"属于别人"同码：处置动作相同）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { order_id: 'o-none', reason: '测试拉黑' },
        await bearer(),
      );
      expect(r.status).toBe(409);
      expect(code(r)).toBe(40915);
      const u1 = await db`select blocked_at from users where id = 'u-1'`;
      expect(u1[0]?.['blocked_at']).toBeNull();
    } finally {
      await close();
    }
  });

  it('🈲 order_id 不是字符串 / 是空串 → 40001（🈲 静默当成"没传"——那等于关掉校验）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      for (const bad of [42, '', '   ', null, {}, ['o-1']]) {
        const r = await call(
          url,
          'POST',
          '/api/v1/admin/users/u-1/block',
          { order_id: bad, reason: '测试拉黑' },
          token,
        );
        expect(r.status, `order_id=${JSON.stringify(bad)}`).toBe(400);
        expect(code(r), `order_id=${JSON.stringify(bad)}`).toBe(40001);
      }
      const u1 = await db`select blocked_at from users where id = 'u-1'`;
      expect(u1[0]?.['blocked_at']).toBeNull();
    } finally {
      await close();
    }
  });

  it('带**自己**的 order_id → 200 照常封（凭据不挡正当操作；日志里带 order_id）', async () => {
    const { url, close } = await buildServer();
    try {
      await seedOrderOf('o-1', 'u-1');
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { order_id: 'o-1', reason: '测试拉黑' },
        await bearer(),
      );
      expect(r.status).toBe(200);
      const u1 = await db`select blocked_at from users where id = 'u-1'`;
      expect(u1[0]?.['blocked_at']).not.toBeNull();
      const ctx = (sink.find('admin_user_blocked')[0] as unknown as Record<string, unknown>)[
        'ctx'
      ] as Record<string, unknown>;
      expect(ctx['order_id']).toBe('o-1');
      expect(ctx['cancelled_order_ids']).toEqual(['o-1']);
    } finally {
      await close();
    }
  });

  it('🔴 AJ-449 拉黑必填原因：缺原因 → 40001 且库里一点没动；带原因 → 连带取消的事件 actor=admin:<sub>、note 记原因', async () => {
    const { url, close } = await buildServer();
    try {
      await seedOrderOf('o-1', 'u-1');
      const bad = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '  ' },
        await bearer(),
      );
      expect(bad.status).toBe(400);
      expect(
        (await db`select blocked_at from users where id = 'u-1'`)[0]?.['blocked_at'],
      ).toBeNull();
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '同一张卡 30 天内 3 次拒付' },
        await bearer(),
      );
      expect(r.status).toBe(200);
      const [ev] =
        await db`select actor, note from order_events where order_id = 'o-1' and status = 'cancelled'`;
      expect(ev?.['actor']).toBe('admin:u-admin');
      expect(String(ev?.['note'])).toContain('同一张卡 30 天内 3 次拒付');
    } finally {
      await close();
    }
  });

  it('拉黑写业务日志（含 target_user_id；**不得**写保留键 actor）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/users/u-1/block',
        { reason: '测试拉黑' },
        await bearer(),
      );
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

/**
 * AJ-384：拉黑原先**没有解除接口**（工程缺口第二轮 §6.3 G7），误拉黑只能直接改库——
 * 而直接改库绕过审计，事后答不出"谁、为什么解封的"。
 */
describe('POST /admin/users/{id}/unblock + GET /admin/users?blocked=true', () => {
  it('🔴 拉黑 → 列表里能看到 → 解除（必填原因）→ 列表里没了，被拉黑者能再次通过身份校验', async () => {
    const srv = await buildServer();
    try {
      const admin = await bearer(true);
      await seedOrderOf('o-ub', 'u-ub');
      expect(
        (
          await call(
            srv.url,
            'POST',
            '/api/v1/admin/users/u-ub/block',
            { reason: '测试拉黑' },
            admin,
          )
        ).status,
      ).toBe(200);

      const listed = await call(
        srv.url,
        'GET',
        '/api/v1/admin/users?blocked=true',
        undefined,
        admin,
      );
      expect(listed.status).toBe(200);
      expect((listed.body as { items: Array<{ id: string }> }).items.map((u) => u.id)).toEqual([
        'u-ub',
      ]);

      const noReason = await call(
        srv.url,
        'POST',
        '/api/v1/admin/users/u-ub/unblock',
        { reason: ' ' },
        admin,
      );
      expect(code(noReason)).toBe(40001);

      const ok = await call(
        srv.url,
        'POST',
        '/api/v1/admin/users/u-ub/unblock',
        { reason: '误拉黑：拒付已撤回' },
        admin,
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ already_unblocked: false });
      const [u] = await db`select blocked_at from users where id = 'u-ub'`;
      expect(u?.['blocked_at']).toBeNull();
      const after = await call(
        srv.url,
        'GET',
        '/api/v1/admin/users?blocked=true',
        undefined,
        admin,
      );
      expect((after.body as { items: unknown[] }).items).toEqual([]);
      // 审计行在响应之后写（admin-audit.ts：prefinish 之后）——不等就偶发只读到第一行（gate 2026-10-12 实测撞到一次）
      const auditOf = async () =>
        db`select action from admin_audit where target = 'u-ub' order by id`;
      await waitUntil(async () => (await auditOf()).length === 2, '解除拉黑的审计行没写进来');
      const audit = await auditOf();
      expect(audit.map((a) => String(a['action']))).toEqual([
        expect.stringContaining('/block'),
        expect.stringContaining('/unblock'),
      ]);
    } finally {
      await srv.close();
    }
  });

  it('未拉黑的用户 → 200 already_unblocked（幂等）；不存在 → 40403；买家 token → 403', async () => {
    const srv = await buildServer();
    try {
      const admin = await bearer(true);
      await seedOrderOf('o-ub2', 'u-ub2');
      const r = await call(
        srv.url,
        'POST',
        '/api/v1/admin/users/u-ub2/unblock',
        { reason: '核对' },
        admin,
      );
      expect(r.body).toMatchObject({ already_unblocked: true });
      expect(
        code(
          await call(srv.url, 'POST', '/api/v1/admin/users/u-nope/unblock', { reason: 'x' }, admin),
        ),
      ).toBe(40403);
      const buyer = await bearer(false);
      expect(
        (await call(srv.url, 'POST', '/api/v1/admin/users/u-ub2/unblock', { reason: 'x' }, buyer))
          .status,
      ).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
