/**
 * 职责：幂等执行器的 L1 真库测试（F8）。
 * 重点是**并发**：单线程下的"第二次返回首次结果"很容易做对，真正的难点是两个请求同时进来。
 * @why 用户狂点 / 前端超时重发是幂等的典型触发场景，两者都是并发的；不测并发等于没测。
 * @see server/src/idempotency.ts @limitation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../test/db/test-db.js';
import { requestFingerprint, scopeKey, withIdempotency, withIdempotencyTx } from './idempotency.js';
import { createLogger } from './logger.js';
import { MemorySink } from '../../test/helpers/memory-sink.js';

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
      withIdempotency(db, { ...args('k-live'), waitMs: 80, pollMs: 20 }, async () => ({
        status: 201,
        body: { order_no: 'SHOULD-NOT-RUN' },
      })),
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
      withIdempotency(db, { ...args('k-fp'), request: { sku: 'S2', qty: 9 } }, async () => ({
        status: 201,
        body: { order_no: 'W-SECOND' },
      })),
    ).rejects.toMatchObject({ code: 40908 });
  });

  it('键顺序不同但内容相同 → 仍算同一次请求（指纹必须稳定）', async () => {
    await withIdempotency(db, { ...args('k-fp2'), request: { sku: 'S1', qty: 1 } }, async () => ({
      status: 201,
      body: { order_no: 'W-ORDER-A' },
    }));
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

/**
 * N1（二审 P0-1）：租约被接管后，旧持有者的迟到写/删不得碰到新持有者的占位行。
 *
 * @why 交错剧本：A 抢到占位但慢于租约 → B 接管并执行 → A 迟到失败。
 *      没有栅栏令牌时，A 的"失败删占位"按 key 定位，会把**B 的**占位行删掉——
 *      随后 C 进入抢不到任何记录，handler 被执行第 3 次（同一幂等键建了三张单）。
 *      修复：写结果/删占位都必须携带本次抢占返回的 lease_token，0 行命中 = 租约已易主，
 *      只准落 error 日志，**不准**动那行数据。
 */
describe('租约栅栏（N1）', () => {
  it('A 慢于租约被 B 接管后，A 迟到失败不得删掉 B 的占位（handler 不得执行第 3 次）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    let executions = 0;
    const KEY = 'k-fence';

    // A：租约 150ms，续期关闭（模拟事件循环卡死导致续期停滞），handler 跑 400ms 后失败
    const a = withIdempotency(
      db,
      { ...args(KEY), leaseMs: 150, renew: false, logger },
      async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 400));
        throw new Error('A late failure');
      },
    );
    // 等 A 的占位行真的出现（不依赖"sleep 一个应该够了的时间"）
    const deadline = Date.now() + 2000;
    for (;;) {
      const rows = await db`select key from idempotency_keys where key = ${KEY}`;
      if (rows.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // B：claim 循环会在租约过期后接管；handler 同样跑 400ms（A 失败时 B 仍在执行中）
    const b = withIdempotency(db, { ...args(KEY), leaseMs: 150, waitMs: 3000 }, async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 400));
      return { status: 201, body: { by: 'B' } };
    });

    await expect(a).rejects.toThrow('A late failure');
    // C：在 A 失败之后进入。修复前 A 已把 B 的占位删掉 → C 会第三次执行 handler
    const c = await withIdempotency(db, { ...args(KEY), waitMs: 3000 }, async () => {
      executions += 1;
      return { status: 201, body: { by: 'C' } };
    });
    const bResult = await b;

    expect(executions).toBe(2); // 关键断言：只有 A 和 B 执行过
    expect(bResult.body).toEqual({ by: 'B' });
    expect(c.replayed).toBe(true);
    expect(c.body).toEqual({ by: 'B' }); // C 重放的是 B 的结果，不是自己又跑了一次
    // A 的迟到删除被栅栏拦下时必须落 error 日志（租约易主是异常，不能静默）
    expect(sink.find('idempotency_lease_lost').length).toBeGreaterThan(0);
  });

  it('结果写回时租约已易主 → 抛 50000 + error 日志，不覆盖他人结果', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const KEY = 'k-fence-write';
    await expect(
      withIdempotency(db, { ...args(KEY), leaseMs: 5000, renew: false, logger }, async () => {
        // 模拟"handler 执行期间租约被接管"：直接把行的 lease_token 换掉
        await new Promise((r) => setTimeout(r, 50));
        await db`update idempotency_keys set lease_token = gen_random_uuid() where key = ${KEY}`;
        return { status: 201, body: { by: 'A' } };
      }),
    ).rejects.toMatchObject({ code: 50000 });
    expect(sink.find('idempotency_lease_lost').length).toBeGreaterThan(0);
  });

  it('接管过期占位时指纹不符 → 40908（不得覆盖指纹后执行）', async () => {
    await db.unsafe(
      `insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until)
       values ('k-fence-fp', 'u-1', 'POST /orders', 0, '{}'::jsonb, '${requestFingerprint({ sku: 'S1' })}', now() - interval '1 minute')`,
    );
    await expect(
      withIdempotency(db, { ...args('k-fence-fp'), request: { sku: 'S2' } }, async () => ({
        status: 201,
        body: { by: 'takeover' },
      })),
    ).rejects.toMatchObject({ code: 40908 });
  });

  it('占位仍在租约内但指纹不符 → 立即 40908（而不是等超时给 40903）', async () => {
    // 先入一条"正在执行中"的占位（租约远未到期），指纹属于请求 1
    await db.unsafe(
      `insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until)
       values ('k-fence-live', 'u-1', 'POST /orders', 0, '{}'::jsonb, '${requestFingerprint({ sku: 'S1' })}', now() + interval '1 hour')`,
    );
    // 同一个键发**另一个**请求：结果永远不可能合法重放给我们，等再久也是 40908，不该拿 40903 拖延
    await expect(
      withIdempotency(
        db,
        { ...args('k-fence-live'), request: { sku: 'S2' }, waitMs: 100, pollMs: 20 },
        async () => ({ status: 201, body: { by: 'other' } }),
      ),
    ).rejects.toMatchObject({ code: 40908 });
  });
});

/**
 * 租约续期：handler 活着但慢于租约时，续期让占位不被接管。
 * @why 栅栏令牌（上一条）解决的是"接管后不乱删"，但没有续期时，
 *      凡是 handler 超过租约时长的正常请求都会被接管 → 重复执行。
 *      续期把"慢"和"死"区分开：活着的 handler 定期刷新租约，死掉的才轮到别人接管。
 */
describe('租约续期', () => {
  it('handler 超过租约时长但持续续期 → 不被接管，并发方重放同一结果', async () => {
    let executions = 0;
    const run = () =>
      withIdempotency(db, { ...args('k-renew'), leaseMs: 200, waitMs: 3000 }, async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 800)); // 4 倍于租约：续期生效才能不被接管
        return { status: 201, body: { order_no: 'W-RENEW' } };
      });
    const p = run();
    // 等占位行出现再发第二个
    const deadline = Date.now() + 2000;
    for (;;) {
      const rows = await db`select key from idempotency_keys where key = 'k-renew'`;
      if (rows.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [first, second] = await Promise.all([p, run()]);
    expect(executions).toBe(1); // 没有续期时第二个会在 200ms 后接管并再执行一次
    expect(first.body).toEqual(second.body);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  });
});

/**
 * N2（二审 P0-2）：单事务幂等——占位、业务写入、结果写回在**同一个事务**里。
 *
 * @why 非事务模式下"handler 的业务事务"与"结果写回"是两个事务：
 *      进程在两者之间崩溃 → 业务已提交（单建了）、幂等行还是占位 →
 *      后续请求要么接管再执行一次（重复建单），要么永久 40903。
 *      单事务模式让"崩溃 = 整体回滚"：占位从未存在过，键自动释放，
 *      不存在两个事务之间的崩溃窗口。
 * @why 并发靠 `INSERT ... ON CONFLICT DO NOTHING` 撞上未提交行时的**阻塞**实现自然串行：
 *      第二个请求阻塞到第一个提交/回滚——提交则读到结果重放，回滚则自己拿到占位执行。
 *      不需要轮询占位行，也不需要租约/栅栏（事务本身就是栅栏）。
 */
describe('单事务幂等 withIdempotencyTx（N2）', () => {
  // orders.user_id 有外键：handler 里要建单，先把属主用户种上
  beforeEach(async () => {
    await db`insert into users (id, openid) values ('u-1', 'o-tx') on conflict (id) do nothing`;
  });

  const txArgs = (key: string) => ({
    key,
    userId: 'u-1',
    route: 'POST /orders',
    request: { sku: 'S1', qty: 1 },
    waitMs: 1500,
    pollMs: 20,
  });

  it('首次真正执行并落结果，第二次重放且 handler 不再执行', async () => {
    let calls = 0;
    const run = () =>
      withIdempotencyTx(db, txArgs('ktx-1'), async (tx) => {
        calls += 1;
        await tx`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                     total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
                 values ('otx-1', 'W-TX-1', 'u-1', 'created', 1000, 0, 0, 1000, 500,
                         '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
        return { status: 201, body: { order_id: 'otx-1' } };
      });
    const first = await run();
    expect(first).toEqual({ status: 201, body: { order_id: 'otx-1' }, replayed: false });

    const second = await run();
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual({ order_id: 'otx-1' });
    expect(calls).toBe(1);
    // 结果行已提交在库里（重放不依赖任何内存状态）
    const rows = await db`select status_code from idempotency_keys where key = 'ktx-1'`;
    expect(Number(rows[0]?.status_code)).toBe(201);
  });

  it('handler 抛错 → 占位与业务写入一起回滚，不留任何痕迹，同 key 可重试成功', async () => {
    await expect(
      withIdempotencyTx(db, txArgs('ktx-err'), async (tx) => {
        await tx`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                     total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
                 values ('otx-err', 'W-TX-ERR', 'u-1', 'created', 1000, 0, 0, 1000, 500,
                         '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
        throw new Error('business failed after insert');
      }),
    ).rejects.toThrow('business failed after insert');

    // 核心断言（N2）：占位行和业务行都不存在——两个写同一个事务，回滚是整体的
    expect(await db`select key from idempotency_keys where key = 'ktx-err'`).toHaveLength(0);
    expect(await db`select id from orders where id = 'otx-err'`).toHaveLength(0);

    const ok = await withIdempotencyTx(db, txArgs('ktx-err'), async () => ({
      status: 200,
      body: { retried: true },
    }));
    expect(ok.replayed).toBe(false);
    expect(ok.body).toEqual({ retried: true });
  });

  it('并发同 key：阻塞式串行——一个执行，另一个等它提交后重放', async () => {
    let calls = 0;
    const run = () =>
      withIdempotencyTx(db, { ...txArgs('ktx-conc'), waitMs: 5000 }, async (tx) => {
        calls += 1;
        // 在事务内拉长窗口：另一个请求会阻塞在 ON CONFLICT 上，直到本事务提交
        await tx`select pg_sleep(0.3)`;
        return { status: 201, body: { by: 'winner' } };
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a.body).toEqual(b.body);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it('首次执行慢于 waitMs → 第二个请求拿 40903（lock_timeout 到点放手）', async () => {
    const slow = withIdempotencyTx(db, { ...txArgs('ktx-slow'), waitMs: 3000 }, async (tx) => {
      await tx`select pg_sleep(1)`;
      return { status: 201, body: { done: true } };
    });
    // 等占位行（未提交不可见——用"等一会"不行，改用 pg_locks 或直接相信时序：
    // slow 的 insert 是第一个语句，几乎立即生效；给 100ms 让事务跑起来）
    await new Promise((r) => setTimeout(r, 100));
    await expect(
      withIdempotencyTx(db, { ...txArgs('ktx-slow'), waitMs: 200 }, async () => ({
        status: 201,
        body: { done: false },
      })),
    ).rejects.toMatchObject({ code: 40903 });
    const done = await slow;
    expect(done.body).toEqual({ done: true });
  });

  it('同键不同内容 → 40908；键顺序不同但内容相同 → 重放', async () => {
    await withIdempotencyTx(db, txArgs('ktx-fp'), async () => ({
      status: 201,
      body: { v: 1 },
    }));
    await expect(
      withIdempotencyTx(db, { ...txArgs('ktx-fp'), request: { sku: 'S2', qty: 9 } }, async () => ({
        status: 201,
        body: { v: 2 },
      })),
    ).rejects.toMatchObject({ code: 40908 });

    const replay = await withIdempotencyTx(
      db,
      { ...txArgs('ktx-fp'), request: { qty: 1, sku: 'S1' } }, // 键顺序反了
      async () => ({ status: 201, body: { v: 3 } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual({ v: 1 });
  });
});

/**
 * N16 定向：覆盖率报告钉出的真实未走分支。每一条都对应一个具体场景，
 * 不是为凑数字——默认参数、竞态窗口、续期失败这三类恰好是"平时不炸、
 * 炸了看不懂"的地方（续期是后台定时器，错了没有调用栈可追，只有日志）。
 */
describe('默认参数与竞态窗口（N16 定向）', () => {
  it('非事务模式不显式传 waitMs/pollMs/userId 也能跑通（`??` 回落分支）', async () => {
    let calls = 0;
    const run = () =>
      withIdempotency(db, { key: 'k-defaults', route: 'POST /orders' }, async () => {
        calls += 1;
        return { status: 200, body: { ok: true } };
      });
    const first = await run();
    const second = await run();
    expect(calls).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // userId 未传 → 落 NULL 而不是崩（claim 的 `args.userId ?? null`）
    const rows = await db`select user_id from idempotency_keys where key = 'k-defaults'`;
    expect(rows[0]?.user_id).toBeNull();
  });

  it('claim 失败与 readRow 之间行被并发删除（竞态窗口）→ 按"无行"继续循环，最终自己抢到执行', async () => {
    // @why 这条分支在真库里只能靠编排到达：预置"别人正在执行"的占位（租约远未到期，
    //      接管必 0 行），然后在**接管返回之后、readRow 之前**把行删掉
    //      （模拟清理任务恰好落在这个窗口）。防御语义：不是抛错，而是当成"没行"继续循环——
    //      下一轮 claim 自然抢到执行权。
    await db`
      insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until, lease_token)
      values ('k-race', 'u-1', 'POST /orders', 0, '{}'::jsonb, '', now() + interval '1 hour', gen_random_uuid())
    `;
    let executions = 0;
    let queries = 0;
    const raceDb = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      queries += 1;
      const p = (
        db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>
      )(strings, ...vals);
      if (queries === 2) {
        // 第 2 个查询 = 接管 update（0 行命中）。它返回后立刻删行 → 紧随的 readRow 查不到
        return p.then(async (rows) => {
          await db`delete from idempotency_keys where key = 'k-race'`;
          return rows;
        });
      }
      return p;
    }) as unknown as Db;

    const r = await withIdempotency(
      raceDb,
      { key: 'k-race', route: 'POST /orders', waitMs: 1000, pollMs: 20, renew: false },
      async () => {
        executions += 1;
        return { status: 201, body: { by: 'me' } };
      },
    );
    expect(executions).toBe(1);
    expect(r.replayed).toBe(false);
  });
});

describe('tx 模式的默认形状与等待路径（N16 定向）', () => {
  it('不传 request 与 userId：指纹为空串、user_id 落 NULL，执行 + 重放', async () => {
    let calls = 0;
    const run = () =>
      withIdempotencyTx(db, { key: 'k-tx-noreq', route: 'POST /internal/x' }, async () => {
        calls += 1;
        return { status: 200, body: { ok: true } };
      });
    await run();
    const second = await run();
    expect(calls).toBe(1);
    expect(second.replayed).toBe(true);
    const rows = await db`select user_id, request_hash from idempotency_keys where key = 'k-tx-noreq'`;
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.request_hash).toBe('');
  });

  it('冲突到"别人正在做"（已提交占位）→ 轮询等待（sleep 分支）→ 对方完成后重放', async () => {
    // 预置已提交的占位行（模拟另一个进程正在执行，tx 模式的 ON CONFLICT 只阻塞未提交行）
    await db`
      insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until, lease_token)
      values ('k-tx-wait', null, 'POST /x', 0, '{}'::jsonb, '', null, gen_random_uuid())
    `;
    const finisher = (async () => {
      await new Promise((r) => setTimeout(r, 200));
      await db`
        update idempotency_keys
           set status_code = 201, response = '{"by":"other"}'::jsonb, completed_at = now()
         where key = 'k-tx-wait'
      `;
    })();
    const r = await withIdempotencyTx(
      db,
      { key: 'k-tx-wait', route: 'POST /x', request: { a: 1 }, waitMs: 2000, pollMs: 50 },
      async () => ({ status: 200, body: { by: 'me' } }),
    );
    await finisher;
    // 等到了对方的结果：pending → completed 的等待循环真的走了 sleep，而不是立刻 40903
    expect(r).toEqual({ status: 201, body: { by: 'other' }, replayed: true });
  });
});

describe('续期的失败留痕（N16 定向）', () => {
  it('续期时发现租约已易主（0 行命中）→ warn idempotency_lease_renew_lost，结果写回仍被栅栏兜住', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const KEY = 'k-renew-lost';
    await expect(
      // leaseMs 150 → 续期间隔 50ms；renew 默认开启
      withIdempotency(db, { ...args(KEY), leaseMs: 150, logger }, async () => {
        await new Promise((r) => setTimeout(r, 60));
        // handler 执行期间租约被接管（token 换人）：下一次续期 update 命中 0 行
        await db`update idempotency_keys set lease_token = gen_random_uuid() where key = ${KEY}`;
        await new Promise((r) => setTimeout(r, 150)); // 让续期至少 tick 两次
        return { status: 201, body: { by: 'A' } };
      }),
    ).rejects.toMatchObject({ code: 50000 });
    expect(sink.find('idempotency_lease_renew_lost').length).toBeGreaterThan(0);
  });

  /** 包一个只让"续期那句 SQL"失败的 db：续期失败绝不能拖垮 handler 本身。 */
  function flakyDb(failWith: () => unknown, shouldFail: () => boolean): Db {
    return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      if (shouldFail() && strings.join('?').includes('locked_until')) {
        return Promise.reject(failWith());
      }
      return (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(
        strings,
        ...vals,
      );
    }) as unknown as Db;
  }

  it('续期查询抛 Error → warn idempotency_lease_renew_failed，handler 与结果写回不受影响', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    let failing = false;
    const r = await withIdempotency(
      flakyDb(() => new Error('conn reset'), () => failing),
      { ...args('k-renew-fail'), leaseMs: 150, logger },
      async () => {
        failing = true; // claim 已成功，之后续期每 tick 都抛
        await new Promise((res) => setTimeout(res, 180));
        failing = false; // 结果写回前恢复，验证"续期失败不影响主流程"
        return { status: 201, body: { ok: true } };
      },
    );
    expect(r.replayed).toBe(false);
    const rows = sink.find('idempotency_lease_renew_failed');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.err).toBe('conn reset');
  });

  it('续期抛**非 Error** 值 → warn 的 err 字段是 String(reason)（`instanceof` 另一支）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    let failing = false;
    const r = await withIdempotency(
      flakyDb(() => 'string-boom', () => failing),
      { ...args('k-renew-fail-str'), leaseMs: 150, logger },
      async () => {
        failing = true;
        await new Promise((res) => setTimeout(res, 180));
        failing = false;
        return { status: 201, body: { ok: true } };
      },
    );
    expect(r.replayed).toBe(false);
    const rows = sink.find('idempotency_lease_renew_failed');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.err).toBe('string-boom');
  });
});
