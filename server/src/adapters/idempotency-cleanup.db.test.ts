/**
 * 职责：**清理过期幂等键**的真库测试（三审欠账 ①）。
 *
 * @why 让"24h 后同一个键可以重新执行"这句话**真的成立**：在此之前全仓没有一条
 *      `delete from idempotency_keys`，键写过一次就永久重放——用户隔天重试拿到的是
 *      **昨天的响应**（价格、库存、地址快照都可能是旧的），且不报错。
 *
 * @why 单独开一个文件而不是塞进 `idempotency.db.test.ts`：那份文件测的是**执行语义**
 *      （并发、租约、指纹），本文件测的是**生命周期**（什么时候该消失）。
 *      两者混在一起的话，"清理删错了行"会被归因成"执行器的问题"。
 *
 * @limitation 只验 SQL 语义；job 的接线（调度器 + 心跳）在
 *      `app/scheduler-start.db.test.ts` 的「真实 job」用例里验。
 *
 * @see ./idempotency.ts（SQL 与 {@link IDEMPOTENCY_TTL_HOURS}）；
 *      ../../app/cleanup-idempotency.ts（job）；docs/地基搭建清单.md 欠账 ①
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  deleteExpiredIdempotencyKeys,
  idempotencyCutoff,
  IDEMPOTENCY_TTL_HOURS,
} from './idempotency.js';

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

/**
 * 直接插一行：`created_at` 与 `completed_at` 都要精确控制，走执行器做不到
 * （执行器总是写"现在"）。这是唯一一处绕过执行器的地方——它验的是**清理**，
 * 不是"怎么进来的"。
 */
async function insertKey(
  key: string,
  createdMinutesAgo: number,
  completed: boolean,
  /** 未完成行的租约到期点（相对现在的分钟数，正 = 未来 = 仍在执行并续租）；默认 +5 分钟。 */
  leaseMinutesFromNow = 5,
): Promise<void> {
  await db`
    insert into idempotency_keys (key, route, status_code, response, request_hash,
                                  created_at, completed_at, locked_until)
    values (${key}, 'POST /orders', 201, '{"ok":true}'::jsonb, '',
            now() - ${`${createdMinutesAgo} minutes`}::interval,
            ${completed ? db`now() - interval '1 minute'` : null},
            ${completed ? null : db`now() + ${`${leaseMinutesFromNow} minutes`}::interval`})
  `;
}

const HOUR = 60;

describe('deleteExpiredIdempotencyKeys', () => {
  it('删掉**已完成且过期**的键；未过期的与还在执行的都不动', async () => {
    await insertKey('k-old-done', 25 * HOUR, true); // 超过 24h 且已完成 → 删
    await insertKey('k-new-done', 23 * HOUR, true); // 未过期 → 留
    await insertKey('k-old-running', 25 * HOUR, false); // 过期但没完成 → 留

    // 截止时刻走**同一个换算函数**（而不是在这里再写一遍 `- 24h`）：
    // TTL 只该被表达一次，测试里再抄一遍就又多了一个来源。
    await expect(deleteExpiredIdempotencyKeys(db, idempotencyCutoff(new Date()))).resolves.toBe(1);

    const left = await db`select key from idempotency_keys order by key`;
    expect(left.map((r) => r.key)).toEqual(['k-new-done', 'k-old-running']);
  });

  it('没有可删的行 → 返回 0（0 = 无事可做，不是失败）', async () => {
    await insertKey('k-fresh', 1, true);
    await expect(deleteExpiredIdempotencyKeys(db, idempotencyCutoff(new Date()))).resolves.toBe(0);
    expect(await db`select key from idempotency_keys`).toHaveLength(1);
  });

  it('⛔ 还在执行的键永不被清理：删掉它等于替另一个实例抹掉它的占位', async () => {
    await insertKey('k-inflight', 25 * HOUR, false);
    // 截止时刻推到"未来"——即便如此，未完成的行也不能动
    await deleteExpiredIdempotencyKeys(db, new Date(Date.now() + 3_600_000));
    expect(await db`select key from idempotency_keys where key = 'k-inflight'`).toHaveLength(1);
  });

  it('🔴 P2-21 崩溃遗留的占位行（未完成、租约早已过期）过了 TTL 也被清掉——否则永不回收', async () => {
    await insertKey('k-orphan', 25 * HOUR, false, -23 * HOUR); // 进程崩溃：租约 23h 前就到期了
    await insertKey('k-orphan-young', 2 * HOUR, false, -HOUR); // 未过 TTL：留给同键请求接管
    await insertKey('k-renewing', 25 * HOUR, false, 5); // 长任务仍在续租 → 不动
    await expect(deleteExpiredIdempotencyKeys(db, idempotencyCutoff(new Date()))).resolves.toBe(1);
    const left = await db`select key from idempotency_keys order by key`;
    expect(left.map((r) => r.key)).toEqual(['k-orphan-young', 'k-renewing']);
  });

  it('边界：恰好 24h 前创建且已完成的键被删（`<` 而不是 `<=` 的同一侧）', async () => {
    await insertKey('k-boundary', IDEMPOTENCY_TTL_HOURS * HOUR + 1, true);
    await insertKey('k-just-inside', IDEMPOTENCY_TTL_HOURS * HOUR - 1, true);
    await expect(deleteExpiredIdempotencyKeys(db, idempotencyCutoff(new Date()))).resolves.toBe(1);
    expect(await db`select key from idempotency_keys`).toHaveLength(1);
  });
});

describe('idempotencyCutoff', () => {
  /**
   * @why 这条断言钉的是**换算本身**而不是"job 有没有被接线"：
   *      job 传进来的是 `ctx.startedAt`（本轮 tick 的开始），它必须被原样回退 24h，
   *      不能被二次解释（比如按 JST 取整、按天截断）——那会让"多久之后允许重做"变成两个答案。
   * @why 换算住在 adapters（业务侧禁 `new Date()`，F10），所以它是这条链上唯一可测的点。
   */
  it('由给定时刻回退 {@link IDEMPOTENCY_TTL_HOURS} 小时（24h）', () => {
    expect(idempotencyCutoff(new Date('2026-09-25T12:00:00.000Z')).toISOString()).toBe(
      '2026-09-24T12:00:00.000Z',
    );
    // 跨日 / 跨月也成立（不做任何按天取整）：UTC 09-01T00:30 → 08-31T00:30
    expect(idempotencyCutoff(new Date('2026-09-01T00:30:00.000Z')).toISOString()).toBe(
      '2026-08-31T00:30:00.000Z',
    );
  });
});
