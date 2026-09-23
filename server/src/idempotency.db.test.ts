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
