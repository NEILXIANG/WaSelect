/**
 * 职责：每个列表接口的页码都有上界——超大页码回 40001，不能一路走到数据库变成 500。
 *
 * @why 规律排查 2026-10-12 实测：公开接口 `GET /products?page=9999999999999999999` 回 500（PostgresError，error 级进 Sentry），
 *      不用登录谁都能触发。AJ-502 给三个整数入参补过上界，页码这一类没扫到；五个列表各自解析页码，口径各写一份。
 * @why 按接口逐个列在这里，是因为页码解析散在五个文件：新增列表时要在这张表里加一行（同 LIST_PAGE_MAX 的 @see）。
 * @limitation 只验"超大页码被拒"，不验每个列表的其它参数（各自的用例管）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIST_PAGE_MAX } from '@waselect/shared';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  buildChainServer,
  call,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../helpers/chain-server.js';

let db: Db;
let srv: ChainServer;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db);
}, 30_000);

afterAll(async () => {
  await srv.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
});

const LISTS: ReadonlyArray<[string, 'none' | 'user' | 'admin']> = [
  ['/api/v1/products', 'none'],
  ['/api/v1/orders', 'user'],
  ['/api/v1/admin/orders', 'admin'],
  ['/api/v1/admin/products', 'admin'],
  ['/api/v1/admin/audit', 'admin'],
  ['/api/v1/admin/customers', 'admin'],
];

describe('列表页码上界（规律排查 2026-10-12）', () => {
  it.each(LISTS)('🔴 %s：上界内 200；上界 +1 与 19 位页码 → 400 / 40001', async (path, who) => {
    const token =
      who === 'none' ? undefined : await tokenFor(who === 'admin' ? 'u-admin' : 'u-1', who);
    const get = (page: string) =>
      call(srv, 'GET', `${path}?page=${page}`, token === undefined ? {} : { token });
    expect((await get(String(LIST_PAGE_MAX))).status).toBe(200);
    for (const page of [String(LIST_PAGE_MAX + 1), '9999999999999999999']) {
      const r = await get(page);
      expect(r.status, `${path}?page=${page}`).toBe(400);
      expect(r.json['code']).toBe(40001);
    }
  });
});
