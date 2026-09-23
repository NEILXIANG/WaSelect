/**
 * 职责：幂等执行器的 L1 真库测试（F8）。
 * 重点是**并发**：单线程下的"第二次返回首次结果"很容易做对，真正的难点是两个请求同时进来。
 * @why 用户狂点 / 前端超时重发是幂等的典型触发场景，两者都是并发的；不测并发等于没测。
 * @see server/src/idempotency.ts @limitation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../test/db/test-db.js';
import { scopeKey, withIdempotency } from './idempotency.js';

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
});

const args = (key: string) => ({
  key,
  userId: 'u-1',
  route: 'POST /orders',
  waitMs: 1500,
  pollMs: 20,
});

describe('基本语义', () => {
  it('首次真正执行并记录，第二次重放且 handler 不再执行', async () => {
    let calls = 0;
    const run = () =>
      withIdempotency(db, args('k-1'), async () => {
        calls += 1;
        return { status: 201, body: { order_no: 'W20260922-000001' } };
      });

    const first = await run();
    expect(first).toEqual({ status: 201, body: { order_no: 'W20260922-000001' }, replayed: false });

    const second = await run();
    expect(second.body).toEqual(first.body);
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1); // 关键：handler 只跑了一次
  });

  it('不同 key 各自执行（幂等键必须按路由与用户分作用域）', async () => {
    let calls = 0;
    const run = (key: string) =>
      withIdempotency(db, args(key), async () => {
        calls += 1;
        return { status: 200, body: { key } };
      });
    await run('k-a');
    await run('k-b');
    expect(calls).toBe(2);
  });

  it('handler 抛错后不留下毒记录：同 key 可以重试成功', async () => {
    await expect(
      withIdempotency(db, args('k-err'), async () => {
        throw new Error('provider down');
      }),
    ).rejects.toThrow('provider down');

    const rows = await db`select key from idempotency_keys where key = 'k-err'`;
    expect(rows).toHaveLength(0);

    const ok = await withIdempotency(db, args('k-err'), async () => ({
      status: 200,
      body: { ok: true },
    }));
    expect(ok.replayed).toBe(false);
  });

  it('响应体按 JSONB 原样回读（对象与数组都不变形）', async () => {
    const body = { items: [{ sku: 'S1', qty: 2 }], total_jpy: 12800 };
    await withIdempotency(db, args('k-json'), async () => ({ status: 200, body }));
    const replay = await withIdempotency(db, args('k-json'), async () => ({
      status: 200,
      body: {},
    }));
    expect(replay.body).toEqual(body);
  });
});

describe('并发', () => {
  it('同时发起的同一 key：只有一个真正执行，另一个拿到同一结果', async () => {
    let calls = 0;
    const run = () =>
      withIdempotency(db, args('k-concurrent'), async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 100)); // 拉长执行窗口，确保两者重叠
        return { status: 201, body: { order_no: 'W20260922-000002' } };
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a.body).toEqual(b.body);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  /**
   * 首次执行超时未出结果 → 第二个请求拿 40903（不重复下单，宁可提示处理中）。
   *
   * @why 这里必须**等占位行真的出现**再发起第二个请求：两个 `withIdempotency` 都是异步的，
   *      谁先抢到占位行取决于 DB 往返的调度——在 unit+db 合并跑（机器更忙）时，
   *      `impatient()` 会先抢到，于是它自己执行了 handler，`rejects` 变成 `resolves`，
   *      表现为**偶发红灯**。测试不能依赖调度顺序，只能依赖可观测的状态（占位行是否已写入）。
   */
  it('首次执行超时未出结果 → 第二个请求拿 40903（不重复下单，宁可提示处理中）', async () => {
    const slow = (): Promise<{ status: number; body: { done: boolean } }> =>
      withIdempotency(db, args('k-slow'), async () => {
        await new Promise((r) => setTimeout(r, 800));
        return { status: 201, body: { done: true } };
      });
    const impatient = () =>
      withIdempotency(db, { ...args('k-slow'), waitMs: 60, pollMs: 20 }, async () => ({
        status: 201,
        body: { done: true },
      }));

    const p = slow();
    // 轮询直到 slow 抢到占位行（而不是 sleep 一个"应该够了"的时间）
    const deadline = Date.now() + 2000;
    for (;;) {
      const rows = await db`select key from idempotency_keys where key = 'k-slow'`;
      if (rows.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    await expect(impatient()).rejects.toMatchObject({ code: 40903 });
    await p; // 让慢的那个跑完，避免影响后续用例
  });
});

/**
 * D3：崩溃遗留的占位行必须能被接管。
 *
 * @why 没有租约时，"抢到占位之后、写回结果之前"进程崩溃，那行会永远停在占位态——
 *      同一个幂等键**永久**返回 40903。崩溃在小内存实例上是常态（OOM / 平台重启 / 部署），
 *      而这事的后果是"用户这一单再也下不了"，且服务端看不出任何异常（只是又一个 40903）。
 */
describe('崩溃遗留的占位行（D3）', () => {
  /** 手工造一条"抢到占位后进程就没了"的行：占位态 + 租约已过期。 */
  async function insertStalePlaceholder(key: string, lockedUntilSql: string): Promise<void> {
    await db.unsafe(
      `insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until)
       values ('${key}', 'u-1', 'POST /orders', 0, '{}'::jsonb, '', ${lockedUntilSql})`,
    );
  }

  it('租约已过期的占位可以被接管，键不会永久卡死', async () => {
    await insertStalePlaceholder('k-crash', "now() - interval '1 minute'");
    const result = await withIdempotency(
      db,
      { ...args('k-crash'), waitMs: 300, pollMs: 20 },
      async () => ({ status: 201, body: { order_no: 'W20260922-000003' } }),
    );
    expect(result.replayed).toBe(false);
    expect(result.body).toEqual({ order_no: 'W20260922-000003' });
  });

  it('租约**未**过期时不得接管（否则就是重复执行 handler）', async () => {
    await insertStalePlaceholder('k-live', "now() + interval '1 hour'");
    await expect(
      withIdempotency(
        db,
        { ...args('k-live'), waitMs: 80, pollMs: 20 },
        async () => ({ status: 201, body: { order_no: 'SHOULD-NOT-RUN' } }),
      ),
    ).rejects.toMatchObject({ code: 40903 });
  });
});

/**
 * D4：同一个键换了内容，必须报错而不是返回首次结果。
 * @why 不比对指纹时，客户端复用键的 bug 会被静默吞掉：用户以为下了第二单，
 *      实际上第二单从未创建——而这条日志与正常重放**长得一模一样**，事后无从分辨。
 */
describe('请求指纹（D4）', () => {
  it('同键不同内容 → 40908，绝不返回首次结果', async () => {
    const first = await withIdempotency(
      db,
      { ...args('k-fp'), request: { sku: 'S1', qty: 1 } },
      async () => ({ status: 201, body: { order_no: 'W-FIRST' } }),
    );
    expect(first.replayed).toBe(false);

    await expect(
      withIdempotency(
        db,
        { ...args('k-fp'), request: { sku: 'S2', qty: 9 } },
        async () => ({ status: 201, body: { order_no: 'W-SECOND' } }),
      ),
    ).rejects.toMatchObject({ code: 40908 });
  });

  it('键顺序不同但内容相同 → 仍算同一次请求（指纹必须稳定）', async () => {
    await withIdempotency(
      db,
      { ...args('k-fp2'), request: { sku: 'S1', qty: 1 } },
      async () => ({ status: 201, body: { order_no: 'W-ORDER-A' } }),
    );
    const replay = await withIdempotency(
      db,
      { ...args('k-fp2'), request: { qty: 1, sku: 'S1' } }, // 键顺序反了
      async () => ({ status: 201, body: { order_no: 'W-ORDER-B' } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual({ order_no: 'W-ORDER-A' });
  });

  it('不传 request 时不校验指纹（给确实没有入参的接口留口子）', async () => {
    await withIdempotency(db, args('k-noreq'), async () => ({ status: 200, body: { ok: 1 } }));
    const replay = await withIdempotency(db, args('k-noreq'), async () => ({
      status: 200,
      body: { ok: 2 },
    }));
    expect(replay.replayed).toBe(true);
  });
});

describe('scopeKey', () => {
  it('按用户 + 路由 + 客户端键分作用域，避免跨用户撞键', () => {
    expect(scopeKey({ userId: 'u-1', route: 'POST /orders', clientKey: 'abc' })).toBe(
      'u-1:POST /orders:abc',
    );
    expect(scopeKey({ route: 'POST /orders', clientKey: 'abc' })).toBe('anon:POST /orders:abc');
    expect(scopeKey({ userId: 'u-2', route: 'POST /orders', clientKey: 'abc' })).not.toBe(
      scopeKey({ userId: 'u-1', route: 'POST /orders', clientKey: 'abc' }),
    );
  });
});
