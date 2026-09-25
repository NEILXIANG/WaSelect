/**
 * 职责：本地一键启动的**真库全链路**（F17 单元①，L1）：
 *      建库（不存在→创建→幂等）→ 迁移（真 CLI 子进程）→ 灌数据（两次幂等）→ 配置表种子保留。
 *      这就是「新机器从零到可用」的完整路径，只差起服务——
 *      起服务复用 `bootstrap()`，已由 main.db.test.ts 的真装配用例覆盖，这里不重复。
 *
 * @why 用一个一次性的 probe 库（japan_shop_devup_probe）而不是测试库 japan_shop_test：
 *      「库不存在 → 创建」这一步只有在**真的不存在**的库上才能验；
 *      且建/删库不触碰任何其它用例的数据，天然隔离。
 *
 * @limitation probe 库名刻意不含 prod 子串、主机来自 TEST_DB_URL（CI 的 PG service 也是 localhost）；
 *              若把测试实例迁到远端专用机（ALLOW_REMOTE_TEST_DB=1），ensureDatabase 的闸门会拒——
 *              那是闸门按设计工作，届时本文件需要显式放行，而不是把闸门改松。
 *
 * @see scripts/dev-up-lib.ts（被测）；test/db/test-db.ts（probe URL 的推导基准 TEST_DB_URL）
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../server/src/adapters/db.js';
import { TEST_DB_URL } from '../test/db/test-db.js';
import { ensureDatabase, migrateUp } from './dev-up-lib.js';
import { seedOnce } from './seed-lib.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_NAME = 'japan_shop_devup_probe';

function probeUrl(): string {
  const url = new URL(TEST_DB_URL);
  url.pathname = `/${PROBE_NAME}`;
  return url.toString();
}
function adminUrl(): string {
  const url = new URL(TEST_DB_URL);
  url.pathname = '/postgres';
  return url.toString();
}

async function dropProbe(): Promise<void> {
  const admin = createDb({ url: adminUrl(), max: 1 });
  try {
    // FORCE：probe 可能有残留连接（上次跑挂掉）；PG13+ 支持
    await admin.unsafe(`drop database if exists ${PROBE_NAME} with (force)`);
  } finally {
    await admin.end();
  }
}

describe('dev-up 真库全链路：建库 → 迁移 → 灌数据', () => {
  afterAll(async () => {
    await dropProbe();
  });

  it('库不存在 → 创建（created）；再调 → 幂等（exists）', async () => {
    await dropProbe(); // 防上次跑挂掉留下的残留
    expect(await ensureDatabase(probeUrl())).toBe('created');
    expect(await ensureDatabase(probeUrl())).toBe('exists');
  });

  it('迁移：真 CLI 跑完后，已应用数 == 磁盘上的迁移文件数', async () => {
    await migrateUp({ root, databaseUrl: probeUrl() });
    const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql'));
    const db: Db = createDb({ url: probeUrl(), max: 1 });
    try {
      const rows = await db<{ count: number }[]>`select count(*) as count from pgmigrations`;
      expect(Number(rows[0]?.count)).toBe(files.length);
      // 种子配置表来自迁移（007）：它不是灌数据灌进去的
      const profiles = await db<{ code: string }[]>`select code from country_profiles`;
      expect(profiles.map((r) => r.code)).toEqual(['US']);
    } finally {
      await closeDb(db);
    }
  });

  it('灌数据：连灌两次幂等，配置表种子保留', async () => {
    const db: Db = createDb({ url: probeUrl(), max: 2 });
    try {
      const first = await seedOnce(db);
      const second = await seedOnce(db);
      expect(second.counts, '同一场景灌两次，行数必须一致').toEqual(first.counts);
      const profiles = await db<{ code: string }[]>`select code from country_profiles`;
      expect(
        profiles.map((r) => r.code),
        '灌数据不得清掉配置表种子',
      ).toEqual(['US']);
    } finally {
      await closeDb(db);
    }
  });

  it('全链路之后建库仍幂等（exists，不会重复创建）', async () => {
    expect(await ensureDatabase(probeUrl())).toBe('exists');
  });
});
