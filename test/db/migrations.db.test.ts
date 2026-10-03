/**
 * 职责：迁移脚本本身的 L1 测试（T7）——**up → down → up** 必须回到同一个 schema。
 *
 * @why down 脚本写错**只会在真要回滚那天才发现**，而那一天通常是线上出事的时候。
 *      清单 F7 把"up→down→up"列为验收项，但此前没有任何东西真的跑过 down。
 *      这类缺陷的形态很隐蔽：down 里漏 DROP 一个索引，脚本"执行成功"，
 *      然后 up 因为对象已存在而失败——回滚根本不可用，而没人知道。
 *
 * @limitation 断言的是"表集合与约束集合一致"，不是逐列 diff。
 *              列级比对会让每次加列都要改测试，维护成本高于收益；
 *              表/约束/触发器这三层足以抓住"漏 DROP"这一主要失败模式。
 * @limitation 必须在 db project（串行）里跑：它会把整库 DROP 再建回来，
 *              并行会让别的用例读到"表不存在"。
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { closeDb } from '../../server/src/adapters/db.js';
import { ensureTestDb, runMigrations, testDb } from './test-db.js';

/**
 * 迁移文件名（不含扩展名），即 `pgmigrations.name`。
 *
 * @why 曾经在测试里写死 `['001_init', '002_hardening']` 和 `down 2`：
 *      新增 003 之后这两处**同时**变红，而它们红的理由跟"迁移写得对不对"毫无关系——
 *      纯粹是计数漂移。这类断言会让"加一张迁移"变成"改测试"的心理负担，
 *      久而久之有人会为了不改测试而把改动塞进旧迁移（那才是真正危险的做法）。
 *      从目录推导，加迁移时本测试自动跟随，只有 down 脚本真写错时它才会红。
 */
function migrationNames(): string[] {
  // ESM 下没有 __dirname：用 import.meta.url 推导（比 `import.meta.dirname` 兼容性更好）
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  // 兜底：万一中间某步失败，也要把库恢复到 migrated 状态，否则后续文件全红
  runMigrations('up');
  await closeDb(db);
});

async function businessTables(): Promise<string[]> {
  const rows = await db`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'pgmigrations'
    order by tablename
  `;
  return rows.map((r) => String(r.tablename));
}

async function pgTriggers(): Promise<string[]> {
  const rows = await db`
    select tgname from pg_trigger where not tgisinternal order by tgname
  `;
  return rows.map((r) => String(r.tgname));
}

async function domainChecks(): Promise<string[]> {
  const rows = await db`
    select conname from pg_constraint
    where contype = 'c' and connamespace = 'public'::regnamespace
      and conname like '%_domain'
    order by conname
  `;
  return rows.map((r) => String(r.conname));
}

/**
 * schema 的结构快照：表 / 列（含类型与默认值）/ 约束 / 索引 / 触发器五层。
 *
 * @why "down 到底再 up" 这一条断言有一个致命盲区（B51 / DB-03）：
 *      它只比对**终点**。015 的 down 要把 `users` 的两列按 014 原样补回，
 *      但只要它补回的**类型或约束写错**（比如漏掉 CHECK、把 timestamptz 写成 timestamp），
 *      紧接着的 014 down 就会把这两列再删掉——错误的补回被下一条迁移的 down 抹平，
 *      终点照样一致，测试照样是绿的。而真到"只回滚 015"那天（015 上了线发现有问题、
 *      要退到 014 的代码），读这两列的旧代码会读到错的类型或丢掉的约束。
 *      换句话说：**这个测试此前只证明"回滚到底可用"，没证明"回滚一步可用"**，
 *      而生产上真正会发生的是后者。
 * @limitation 不比对 COMMENT ON（注释不影响行为，且它的存在与否不值得让回滚变红）；
 *              不比对数据行（迁移里 seed 的数据是否原样恢复属于另一类问题，见 §4）。
 *              列用 `format_type` 而不是 `information_schema.data_type`——
 *              后者对 `VARCHAR(20)` 只给 `character varying`，**会把长度写错放过去**。
 */
interface SchemaSnapshot {
  tables: string[];
  columns: string[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
}

async function snapshot(): Promise<SchemaSnapshot> {
  // ⚠️ 必须串行：`testDb()` 的连接池只有 4（test-db.ts:307），并发五个查询会撞上限
  const tables = await db`
    select tablename::text as v from pg_tables
    where schemaname = 'public' and tablename <> 'pgmigrations'
    order by tablename
  `;
  const columns = await db`
    select (c.relname::text || '.' || a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod)
            || ' notnull=' || a.attnotnull::text
            || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''))::text as v
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `;
  // ⚠️ `contype` 是 PG 内部的 `"char"` 单字节类型，`text || "char"` 在 PG 里**候选不唯一**
  //    （可以走 anynonarray、也可以隐式转 text），必须显式 `::text`，否则整条查询直接报错。
  const constraints = await db`
    select (conname::text || ' [' || contype::text || '] ' || pg_get_constraintdef(oid))::text as v
    from pg_constraint
    where connamespace = 'public'::regnamespace
    order by conname
  `;
  const indexes = await db`
    select (indexname::text || ' ' || indexdef)::text as v
    from pg_indexes
    where schemaname = 'public'
    order by indexname
  `;
  const triggers = await db`
    select tgname::text as v from pg_trigger where not tgisinternal order by tgname
  `;
  const pick = (rows: readonly Record<string, unknown>[]): string[] => rows.map((r) => String(r.v));
  return {
    tables: pick(tables as readonly Record<string, unknown>[]),
    columns: pick(columns as readonly Record<string, unknown>[]),
    constraints: pick(constraints as readonly Record<string, unknown>[]),
    indexes: pick(indexes as readonly Record<string, unknown>[]),
    triggers: pick(triggers as readonly Record<string, unknown>[]),
  };
}

/**
 * 两张快照的差异，**按层**报出"少了什么 / 多了什么"。
 *
 * @why 直接 `expect(actual).toEqual(expected)` 在 21 张表 × 上百列的规模下，
 *      vitest 打出来的 diff 是一整屏两边都长得一样的字符串，人眼找不出差别——
 *      等于把"哪一层不对"这个最关键的信息丢了。按层收成集合差，
 *      红的时候一眼就知道是丢了个索引还是某列的默认值变了。
 */
function diffSnapshot(actual: SchemaSnapshot, expected: SchemaSnapshot): string[] {
  const out: string[] = [];
  for (const layer of ['tables', 'columns', 'constraints', 'indexes', 'triggers'] as const) {
    const have = new Set(actual[layer]);
    const want = new Set(expected[layer]);
    const missing = expected[layer].filter((x) => !have.has(x));
    const extra = actual[layer].filter((x) => !want.has(x));
    if (missing.length === 0 && extra.length === 0) continue;
    out.push(
      `${layer}：少了 [${missing.join(' | ')}]${extra.length > 0 ? ` 多了 [${extra.join(' | ')}]` : ''}`,
    );
  }
  return out;
}

describe('迁移 up → down → up', () => {
  it('回滚到底后业务表清零，再上来后与原来完全一致', async () => {
    const before = await businessTables();
    expect(before.length).toBeGreaterThan(10);

    runMigrations('down', migrationNames().length);
    expect(await businessTables()).toEqual([]);

    runMigrations('up');
    expect(await businessTables()).toEqual(before);
  });

  it('up 之后 append-only 触发器与状态域约束都还在（002 的加固没被回滚漏掉）', async () => {
    const triggers = await pgTriggers();
    expect(triggers).toContain('trg_order_events_append_only');
    expect(triggers).toContain('trg_user_events_append_only');
    expect(triggers).toContain('trg_admin_audit_append_only');
    expect(await domainChecks()).toContain('orders_status_domain');
  });

  it('往返一轮后 job_runs 的 seed 仍在（否则调度器看门狗读不到心跳）', async () => {
    const rows = await db`select name from job_runs order by name`;
    expect(rows.map((r) => String(r.name))).toEqual(['daily', 'tick']);
  });

  it('迁移账本与 migrations/ 目录一一对应，没有重复也没有遗漏', async () => {
    const rows = await db`select name from pgmigrations order by name`;
    expect(rows.map((r) => String(r.name))).toEqual(migrationNames());
  });

  it('003 的加列与索引在往返之后仍然都在（漏 DROP 会让二次 up 失败）', async () => {
    const cols = await db`
      select column_name from information_schema.columns
      where table_name in ('users','idempotency_keys')
      order by column_name
    `;
    const names = cols.map((r) => String(r.column_name));
    expect(names).toContain('token_ver');
    expect(names).toContain('request_hash');
    expect(names).toContain('locked_until');
    expect(names).toContain('completed_at');
    // 004：栅栏令牌列——往返后仍在，证明 down/up 都带它（二审 N1）
    expect(names).toContain('lease_token');
    expect(await businessTables()).toContain('webhook_events');

    /**
     * 005：回调处理租约列——往返后仍在（二审 N22）。
     * @why 这两列一旦在 down 里漏 DROP，二次 up 会因"列已存在"而失败；
     *      更隐蔽的是**只漏 DROP 索引**：脚本照样成功，但并发回调的租约判定
     *      会退化成全表扫描（乃至在数据量上来后突然变慢），回滚本身却看不出来。
     */
    const whCols = await db`
      select column_name from information_schema.columns
      where table_name = 'webhook_events'
      order by column_name
    `;
    expect(whCols.map((r) => String(r.column_name))).toEqual(
      expect.arrayContaining(['processing_until', 'processing_token']),
    );
  });
});

/**
 * B51（DB-03）：**逐条** down 的往返。
 *
 * @why 上面那条"down 到底再 up"是一张安全网，但它只把网铺在**终点**上。
 *      生产上真正会发生的回滚不是"回到零"，而是"退一步"：某条迁移上线后发现问题，
 *      把它单独 down 掉、跑上一版代码。这一步能不能走，取决于那条迁移的 down
 *      是否把 schema 精确还原到"只 up 到前一条"的样子——而这一点此前**没有任何东西在验**。
 *      015 是最典型的一处：它的 down 要把 users 的两列按 014 原样补回，
 *      补错了（漏 CHECK、类型写窄）会被紧随的 014 down 抹平，终点比对照样是绿的。
 * @how 先做一趟正向：down 到底 → 一条一条 up，每一步存一张快照（这就是"只 up 到第 i 条"
 *      应有的样子，不写死、随目录自动跟随）；再做一趟反向：从最后一条开始一条一条 down，
 *      每一步与对应快照比对。任何一条 down 不精确，都会在**那一条**上红，而不是让终点兜住。
 * @limitation 跑一遍要 2N 次迁移进程（N=21 时约 40 次），是全套 db 用例里最慢的一个；
 *      这是为"逐条可回退"付的成本，换回来的是加迁移时不必再改本测试。
 */
describe('逐条 down 的往返（B51）', () => {
  it('每一条迁移单独 down 之后，schema 精确等于"只 up 到前一条"', async () => {
    const names = migrationNames();

    // 基准：空库（没有任何业务表时的样子）
    runMigrations('down', names.length);
    const empty = await snapshot();
    expect(empty.tables, '回滚到底之后不该还有业务表').toEqual([]);

    // 正向：一条一条上，存下每一步应有的样子
    const forward: SchemaSnapshot[] = [];
    for (let i = 0; i < names.length; i++) {
      runMigrations('up', 1);
      forward.push(await snapshot());
    }

    // 反向：一条一条退，每一步都要精确落在上一步的快照上
    for (let i = names.length - 1; i >= 0; i--) {
      const expected = i === 0 ? empty : (forward[i - 1] as SchemaSnapshot);
      const label = i === 0 ? '（空库）' : names[i - 1];

      runMigrations('down', 1);
      const actual = await snapshot();
      const diffs = diffSnapshot(actual, expected);
      expect(diffs, `${names[i]} 的 down 没有把 schema 还原成"只 up 到 ${label}"的样子`).toEqual(
        [],
      );

      const ledger = await db`select name from pgmigrations order by name`;
      const ledgerNames = ledger.map((r) => String(r.name));
      expect(ledgerNames, `${names[i]} down 之后迁移账本不对`).toEqual(names.slice(0, i));
    }

    // 复原：不管上面是否走完，都要把库带回 migrated（afterAll 还有一道兜底）
    runMigrations('up', names.length);
  }, 300_000);
});
