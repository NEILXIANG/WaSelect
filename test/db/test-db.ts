/**
 * 职责：测试库管理（F7）——建库、跑迁移、用例之间清空数据。
 * @why 用**真实 Postgres**而不是内存数据库或 mock：运费分档、CHECK 约束、事务与 savepoint、
 *      唯一索引并发冲突这些行为只有真库才一致。用假库等于把最危险的一类 bug 留到生产才暴露。
 * @limitation 迁移用子进程调 node-pg-migrate CLI（约 1s）。比 API 调用慢，但用的是与生产完全相同的
 *              执行路径（同一份 migration 文件、同一个 CLI），避免"测试走 API、生产走 CLI"两套行为。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { assertPostgresMajor, createDb, type Db } from '../../server/src/db.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATE_BIN = resolve(root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

/**
 * 加载仓库根的 `.env`（若存在）。
 * @why 用 Node 内置的 `process.loadEnvFile`（21.7+）而不是引 dotenv——
 *      少一个依赖，且行为与 `node --env-file` 一致。已存在的环境变量**不会被覆盖**，
 *      因此 CI 注入的 TEST_DATABASE_URL 优先于 .env。
 */
function loadDotEnv(): void {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}
loadDotEnv();

/**
 * 本地默认角色名。
 * @why 曾经把连接串写成 `postgres://neilxiang@localhost/...`——那是**本机用户名**，
 *      被提交进仓库（.env.example / 测试默认值）。两个后果：① 换台机器/换个人就跑不起来；
 *      ② 把个人标识写进了公开仓库。Homebrew 装的 Postgres 默认就是"当前 OS 用户 + 免密"，
 *      所以从 `USER`/`LOGNAME` 推导既通用又不泄个人信息。
 * @limitation 只在 Unix（macOS/Linux）成立；Windows 上这两个变量通常为空 → 回落 `postgres`。
 */
function localRole(): string {
  return process.env.USER ?? process.env.LOGNAME ?? 'postgres';
}

const TEST_DB_NAME = 'japan_shop_test';

/**
 * 推导测试库连接串：优先从 `DATABASE_URL` 换库名得到（CI 上 DATABASE_URL 指向专用实例，
 * 换库名比另配一个变量更不容易配错），否则用本机 OS 角色名拼一个本地地址。
 */
function deriveTestUrl(): string {
  const base = process.env.DATABASE_URL;
  if (base !== undefined && base.trim().length > 0) {
    const url = new URL(base.trim());
    url.pathname = `/${TEST_DB_NAME}`;
    return url.toString();
  }
  return `postgres://${localRole()}@localhost:5432/${TEST_DB_NAME}`;
}

/** 同 {@link deriveTestUrl}，但库名换成 `postgres`（建库/删库用的管理库）。 */
function deriveAdminUrl(): string {
  const base = process.env.DATABASE_URL;
  if (base !== undefined && base.trim().length > 0) {
    const url = new URL(base.trim());
    url.pathname = '/postgres';
    return url.toString();
  }
  return `postgres://${localRole()}@localhost:5432/postgres`;
}

/** 测试库连接串（与开发库 japan_shop 分开，避免误删真实数据）。 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? deriveTestUrl();
/** 用来建库的管理库连接串。 */
const ADMIN_DB_URL = process.env.TEST_ADMIN_DB_URL ?? deriveAdminUrl();

let ready: Promise<void> | undefined;
let cachedTables: readonly string[] | undefined;

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

    // 版本闸门：库版本不符合要求就在这里炸，而不是让某个 SQL 行为差异变成"偶发红灯"
    const probe = createDb({ url: TEST_DB_URL, max: 1 });
    try {
      await assertPostgresMajor(probe);
    } finally {
      await probe.end();
    }
  })();
  return ready;
}

/**
 * 需要清空的表：**从 information_schema 动态取**，不写死名单。
 * @why 写死名单的失败模式是"加了新表忘了加进名单"——新表的数据会跨用例残留，
 *      表现为"某个用例单跑通过、整套跑就红"，这类幽灵红灯极难归因，
 *      而且必然发生在加新表的人身上（他对残留毫无预期）。动态取表把这个失败模式彻底消除。
 * @limitation 排除 `pgmigrations`（迁移账本）与 `job_runs`（迁移 seed）；
 *              将来若新增"不该清空的字典表"，在这里加白名单并写明原因。
 */
async function truncateTargets(db: Db): Promise<readonly string[]> {
  if (cachedTables !== undefined) return cachedTables;
  const rows = await db`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename not in ('pgmigrations', 'job_runs')
    order by tablename`;
  const tables = rows.map((r) => String(r.tablename));
  if (tables.length === 0) {
    // 空名单会让 `truncate table` 变成语法错误或静默无操作，两种情况都比直接报错更难排查
    throw new Error('测试库里没有找到任何业务表：迁移是不是没跑成功？');
  }
  cachedTables = tables;
  return tables;
}

/** 清空业务数据（保留迁移账本与 seed），保证用例之间互不污染。 */
export async function resetTestDb(db: Db): Promise<void> {
  const tables = await truncateTargets(db);
  // 表名来自 pg_tables 且经过 not-in 过滤，但仍是拼接进 SQL 的标识符——逐个做一次形状校验兜底
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`表名形状异常，拒绝拼接：${t}`);
  }
  await db.unsafe(`truncate table ${tables.join(', ')} restart identity cascade`);
}

/** 取一条测试库连接（用例结束后由调用方 closeTestDb 关闭）。 */
export function testDb(): Db {
  return createDb({ url: TEST_DB_URL, max: 4 });
}
