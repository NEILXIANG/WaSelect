/**
 * 职责：测试库管理（F7）——建库、跑迁移、用例之间清空数据。
 * @why 用**真实 Postgres**而不是内存数据库或 mock：运费分档、CHECK 约束、事务与 savepoint、
 *      唯一索引并发冲突这些行为只有真库才一致。用假库等于把最危险的一类 bug 留到生产才暴露。
 * @limitation 迁移用子进程调 node-pg-migrate CLI（约 1s）。比 API 调用慢，但用的是与生产完全相同的
 *              执行路径（同一份 migration 文件、同一个 CLI），避免"测试走 API、生产走 CLI"两套行为。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createDb, type Db } from '../../server/src/db.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATE_BIN = resolve(root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

/** 测试库连接串（与开发库 japan_shop 分开，避免误删真实数据）。 */
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://neilxiang@localhost:5432/japan_shop_test';
/** 用来建库的管理库连接串。 */
const ADMIN_DB_URL =
  process.env.TEST_ADMIN_DB_URL ?? 'postgres://neilxiang@localhost:5432/postgres';
const TEST_DB_NAME = TEST_DB_URL.split('/').pop() ?? 'japan_shop_test';

/** 需要清空的表（pgmigrations 与 job_runs 保留：前者是迁移账本，后者是迁移 seed）。 */
const TRUNCATED_TABLES = [
  'order_events',
  'order_items',
  'payments',
  'shipments',
  'orders',
  'idempotency_keys',
  'banners',
  'shipping_rates',
  'products',
  'fx_rates',
  'addresses',
  'users',
] as const;

let ready: Promise<void> | undefined;

/** 确保测试库存在且迁移到最新；进程内只做一次。 */
export function ensureTestDb(): Promise<void> {
  ready ??= (async () => {
    const admin = createDb({ url: ADMIN_DB_URL });
    try {
      const rows = await admin`select 1 as ok from pg_database where datname = ${TEST_DB_NAME}`;
      if (rows.length === 0) {
        // 库名来自配置不是用户输入，无法参数化，只能拼接——这里做一次白名单校验
        if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DB_NAME)) {
          throw new Error(`测试库名不合法：${TEST_DB_NAME}`);
        }
        await admin.unsafe(`create database ${TEST_DB_NAME}`);
      }
    } finally {
      await admin.end();
    }
    execFileSync(process.execPath, [MIGRATE_BIN, '-m', 'migrations', 'up'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'ignore',
    });
  })();
  return ready;
}

/** 清空业务数据（保留迁移账本与 seed），保证用例之间互不污染。 */
export async function resetTestDb(db: Db): Promise<void> {
  await db.unsafe(`truncate table ${TRUNCATED_TABLES.join(', ')} restart identity cascade`);
}

/** 取一条测试库连接（用例结束后由调用方 closeTestDb 关闭）。 */
export function testDb(): Db {
  return createDb({ url: TEST_DB_URL, max: 4 });
}
