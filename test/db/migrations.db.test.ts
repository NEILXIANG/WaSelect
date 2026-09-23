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
import type { Db } from '../../server/src/db.js';
import { closeDb } from '../../server/src/db.js';
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
    expect(await businessTables()).toContain('webhook_events');
  });
});
