/**
 * 职责：e2e 层**运行时**确实连在 `japan_shop_e2e_test` 上（AJ-216 分库的防复发，第三轮审查 TST3-08）。
 *
 * @why `test-db.unit.test.ts` 原有的断言是在配置文件里找字符串 `TEST_DB_PROJECT: 'e2e'`——
 *      同一行也加到 db 项目上、挪进注释、或 vitest 升级后 project 级 env 注入时机变了，它都照绿，
 *      而 db 与 e2e 会重新互相 TRUNCATE（"刚写入就读回 0"的随机红灯）。
 *      这里问数据库本身：`select current_database()`。db 层有对称的一条。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, testDb } from '../db/test-db.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
});
afterAll(async () => {
  await db.end();
});

describe('测试库分库（运行时）', () => {
  it('e2e 层连的是 japan_shop_e2e_test', async () => {
    const [row] = await db<{ name: string }[]>`select current_database() as name`;
    expect(row?.name).toBe('japan_shop_e2e_test');
  });
});
