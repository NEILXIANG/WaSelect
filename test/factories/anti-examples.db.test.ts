/**
 * 职责：反例库的真库验证（F9-e，L1 层）——**每条反例必须真的被库拒，且命中的是预期约束**。
 *
 * @why 反例库的价值不在"列了多少条"，而在"每条都能在真库里复现一次拒绝"。
 *      只在代码里断言"这个值非法"是在重复 schema；真库的 CHECK / 唯一约束 / 列宽
 *      才是唯一不会说谎的裁判（与 addresses.db.test.ts 的 FX5 同源）。
 *      这一层同时是**约束的健康检查**：哪天有人放松了某条 CHECK，对应反例会立刻红——
 *      不是测试错了，是约束的保护没了。
 *
 * @limitation 地址反例（`US_ADDRESS_INVALID`）**不在这里验**——它由 addresses.db.test.ts（FX5）负责。
 *              本文件只覆盖商品与回调两类（见 anti-examples.ts 的边界说明）。
 *
 * @see anti-examples.ts（被测）；migrations/001（products 约束）、003（webhook_events）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import { createIds } from './entities.js';
import { createRng } from './rng.js';
import { ANTI_PRODUCTS, ANTI_WEBHOOKS, type DbAntiCase } from './anti-examples.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetTestDb(db);
});

/**
 * 断言"promise 被库拒，且命中预期约束"。
 * @why 复刻 addresses.db.test.ts 的同名 helper 而不是抽公共：两处匹配口径可能独立演进
 *      （地址侧只撞 CHECK，回调侧还撞唯一约束与列宽），现在抽公共是把三处假设绑死在一处。
 *      postgres.js 把约束名放进 `message`、SQLSTATE 放在 `.code`——所以两个都要拼进来匹配。
 */
async function expectRejected(p: Promise<unknown>, needle: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `反例未被拒绝：${label}`).toBeInstanceOf(Error);
  const code =
    typeof caught === 'object' && caught !== null && 'code' in caught
      ? String((caught as { code: unknown }).code)
      : '';
  const message = caught instanceof Error ? caught.message : '';
  expect(`${code} ${message}`, `反例命中的约束不符合预期：${label}`).toContain(needle);
}

/** 逐条触发一组反例。 `nextId`/`rng` 供 trigger 造合法基线。 */
async function runCases(cases: readonly DbAntiCase[]): Promise<void> {
  for (const c of cases) {
    await expectRejected(c.trigger(db, createIds('anti'), createRng('anti')), c.expect, c.name);
  }
}

describe('商品反例：全部被库拒，且命中预期约束', () => {
  it('四类坏商品各自撞对约束', async () => {
    await runCases(ANTI_PRODUCTS);
  });

  it('反例一个都没进库（拒绝是真的拒绝，不是报错后仍写入）', async () => {
    await runCases(ANTI_PRODUCTS).catch(() => {
      /* 上一条已逐条断言；这里只关心"库里没有残留"，触发失败不影响本条 */
    });
    const rows = await db`select count(*)::int as n from products`;
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('回调反例：幂等唯一与列宽', () => {
  it('重复回调撞唯一约束，且第一条基线真的进了库', async () => {
    await runCases(ANTI_WEBHOOKS);
    // "重复回调"那条：第一条成功、第二条被拒 → 库里应该恰好 1 条该 event_id
    const dup = await db`
      select count(*)::int as n from webhook_events where event_id = 'evt_dup_fixture_0001'`;
    expect(Number(dup[0]?.n)).toBe(1);
    // "超长 event_id"那条：应该一条都没进去
    const long = await db`
      select count(*)::int as n from webhook_events where event_id like 'sha256:%'`;
    expect(Number(long[0]?.n)).toBe(0);
  });
});

describe('反例库的自检（防"清单空了"这种静默）', () => {
  it('反例清单非空，且每条三件套齐全', () => {
    // @why 反例库若哪天被清成空数组，上面所有"逐条触发"会**跑零次照样绿**——
    //      这是生成/清单类门禁最危险的形态（§2 第 34 条）。钉住非空 + 三件套，
    //      才能区分"每条都被拒了"与"根本没跑"。
    for (const c of [...ANTI_PRODUCTS, ...ANTI_WEBHOOKS]) {
      expect(c.name.length, '反例缺 name').toBeGreaterThan(0);
      expect(c.why.length, `反例 ${c.name} 缺 why`).toBeGreaterThan(0);
      expect(c.expect.length, `反例 ${c.name} 缺 expect`).toBeGreaterThan(0);
    }
    expect(ANTI_PRODUCTS.length).toBeGreaterThanOrEqual(3);
    expect(ANTI_WEBHOOKS.length).toBeGreaterThanOrEqual(2);
  });
});
