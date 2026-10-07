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
import { ensureDatabase, ensureDevFxStep, migrateUp, seedStep } from './dev-up-lib.js';
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

/**
 * 删库清理的超时预算：30s（同时给钩子与 DDL 语句）。
 *
 * @why 第一版只把**钩子**超时从默认 10s 提到 30s，结果第三次复现时报的却是
 *      `PostgresError: canceling statement due to statement timeout`——
 *      **卡住的不是钩子，是语句**：`drop database ... with (force)` 在全量 gate 末期
 *      跑满了 db.ts 给业务查询设的 15s 语句预算（57014，已实测一次）。
 *      加钩子预算是在错误的地方加数字（第三次才看清），所以对症状修两处：
 *      ① 拆成「先 `pg_terminate_backend` 再 `drop database`」——慢在哪一步变得可见
 *         （FORCE 把 terminate + 删文件压成一条语句，黑盒且不可诊断）；
 *      ② 这条 DDL 单独拿 30s 语句预算（`statementTimeoutMs`）——DDL 与业务查询
 *         本就不该共用一个预算：业务查询 15s 不返回基本等于写错了，DDL 删库 20s
 *         在负载高峰是正常的。
 * @limitation 若仍偶发，下一个要看的是 Postgres `max_connections`（本机实测 **100**，
 *             默认值偏小）是否被 gate 的并行 worker 打满——届时是资源上限问题，
 *             不是这两个数字的问题。
 */
const DROP_TIMEOUT_MS = 30_000;

async function dropProbe(): Promise<void> {
  const admin = createDb({ url: adminUrl(), max: 1, statementTimeoutMs: DROP_TIMEOUT_MS });
  try {
    // ① 先终止 probe 库上的残留连接（上次跑挂掉会留下）。拆出来是为了可诊断：
    //    这一步慢 = 有人连着 probe 库；②慢 = PG 自己在忙（IO/连接数）。
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PROBE_NAME}'`,
    );
    // ② 再删库（不带 force：连接已在 ① 终止，留着 force 只会把失败压回黑盒）
    await admin.unsafe(`drop database if exists ${PROBE_NAME}`);
  } finally {
    await admin.end();
  }
}

describe('dev-up 真库全链路：建库 → 迁移 → 灌数据', () => {
  afterAll(async () => {
    await dropProbe();
  }, DROP_TIMEOUT_MS);

  it(
    '库不存在 → 创建（created）；再调 → 幂等（exists）',
    async () => {
      await dropProbe(); // 防上次跑挂掉留下的残留
      expect(await ensureDatabase(probeUrl())).toBe('created');
      expect(await ensureDatabase(probeUrl())).toBe('exists');
    },
    // 同 DROP_TIMEOUT_MS：本用例的开头就是一次 dropProbe（见上）
    DROP_TIMEOUT_MS,
  );

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

  /**
   * 本地演练实测（2026-10-06）：开发库的汇率是灌数那天录的，过了 FX_MAX_AGE_HOURS（72h）就整店报价 50003；
   * 全新克隆则根本没有汇率。`npm run dev` 每次启动补一条"开发汇率"，已有新鲜汇率时不动。
   */
  it('🔴 开发汇率：没有或已过期 → 补 USD / CNY；新鲜的不动；再跑一次不重复补', async () => {
    const db: Db = createDb({ url: probeUrl(), max: 1 });
    try {
      await db`delete from fx_rates`;
      await db`insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
               values ('USD', 0.0067, 0.0067, 0, now() - interval '100 hours')`;
      expect(await ensureDevFxStep(db, 72)).toContain('USD');
      const fresh = await db<{ quote: string }[]>`
        select quote from fx_rates where effective_from > now() - interval '72 hours' order by quote`;
      expect(fresh.map((r) => r.quote)).toEqual(['CNY', 'USD']);
      // 套缓冲（三端联动 UI 模拟 2026-10-08）：生效汇率 = 原始 × (1 + 0.03)，与管理端录入同一口径
      const [usd] = await db`select rate, raw_rate, buffer from fx_rates
                              where quote = 'USD' and created_by = 'dev-up'`;
      expect([Number(usd?.['raw_rate']), Number(usd?.['buffer']), Number(usd?.['rate'])]).toEqual([
        0.0068, 0.03, 0.007004,
      ]);
      expect(await ensureDevFxStep(db, 72)).toContain('无需补录');
      expect((await db`select 1 from fx_rates`).length).toBe(3);
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

  /**
   * AJ-242（第二轮审查 DB2-01）：B31 的内容闸门把**日常开发**挡死了。
   * @why 闸门的前提是"dev 库的订单只可能是 is_test=true"。实际上 `is_test` 取自 `REVIEW_MODE`，
   *      而默认 `REVIEW_MODE=off`——本地下的每一张单都是 `is_test=false`。
   *      `npm run dev` 又默认每次都清表重灌：于是本地下过一张单之后，下一次 `npm run dev`
   *      就在"灌假数据"一步抛"拒绝清表…真订单…是否端口转发到生产"，服务起不来；
   *      而闸门刻意没有 --force，开发者只能每次加 --no-seed 或者删库。
   *      修法不是给闸门开后门，而是**默认不再清一个已经有数据的库**。
   */
  it('🔴 默认：库里已有商品数据 → 跳过灌数，本地下过的"真订单"原样保留（不抛、不清表）', async () => {
    const db: Db = createDb({ url: probeUrl(), max: 2 });
    try {
      await seedOnce(db); // 先有一个灌好的库
      const user = (await db<{ id: string }[]>`select id from users limit 1`)[0]?.id ?? '';
      await db`
        insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                            fx_snapshot, address_snapshot, terms_version, expires_at, is_test)
        values ('o-local', 'W-LOCAL', ${user}, 'pending_payment', 1, 1, 1,
                '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes', false)`;

      const msg = await seedStep(db, { full: false, reseed: false });
      expect(msg).toContain('跳过');
      expect(msg).toContain('--reseed');
      expect(await db`select 1 from orders where id = 'o-local'`).toHaveLength(1);
    } finally {
      await closeDb(db);
    }
  });

  it('🔴 --reseed：显式要求清空重灌时才过内容闸门——库里有 is_test=false 的单就拒绝', async () => {
    const db: Db = createDb({ url: probeUrl(), max: 2 });
    try {
      await expect(seedStep(db, { full: false, reseed: true })).rejects.toThrow(/拒绝清表/);
      // 拒绝之后那张单还在（闸门在清表之前）
      expect(await db`select 1 from orders where id = 'o-local'`).toHaveLength(1);
    } finally {
      await closeDb(db);
    }
  });

  it('全新的库（没有商品）→ 默认就灌；--reseed 在没有真订单的库上照常清空重灌', async () => {
    const db: Db = createDb({ url: probeUrl(), max: 2 });
    try {
      await db`delete from orders where id = 'o-local'`;
      await db`truncate table products restart identity cascade`;
      const first = await seedStep(db, { full: false, reseed: false });
      expect(first).toContain('已灌入');
      const n1 = (await db<{ n: number }[]>`select count(*)::int as n from products`)[0]?.n ?? 0;
      expect(n1).toBeGreaterThan(0);
      const again = await seedStep(db, { full: false, reseed: true });
      expect(again).toContain('已灌入');
    } finally {
      await closeDb(db);
    }
  });

  it('全链路之后建库仍幂等（exists，不会重复创建）', async () => {
    expect(await ensureDatabase(probeUrl())).toBe('exists');
  });
});
