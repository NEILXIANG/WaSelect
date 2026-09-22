/**
 * 职责：DB 层的 L1 集成测试（F7）——**真库**，不 mock。
 * 重点：事务提交/回滚、嵌套事务（savepoint）、以及"DB 级约束是否真的生效"。
 * @why 约束写在文档里不算数，只有真库拒绝才算数——MVP 只卖日本原产这条硬约束若只在代码里，
 *      一次直接的 SQL 或后台脚本就能绕过（D-43）。
 * @see migrations/001_init.sql；docs/地基搭建清单.md F7
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createDb, ping, withSavepoint, withTransaction, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../test/db/test-db.js';

let db: Db;

// 首次运行要建库 + 跑迁移（子进程），给足超时——默认 5s 会让"第一次跑"偶发失败，这类红灯最难复现
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

describe('连接与探活', () => {
  it('ping 成功（连不上库的服务不该接流量）', async () => {
    await expect(ping(db)).resolves.toBe(true);
  });

  it('连错库时 ping 返回 false 而不是抛异常（/readyz 需要稳定的布尔值）', async () => {
    const bad = createDb({ url: 'postgres://neilxiang@localhost:5432/no_such_db_xyz', max: 1 });
    try {
      await expect(ping(bad)).resolves.toBe(false);
    } finally {
      await closeDb(bad);
    }
  });
});

describe('事务', () => {
  it('提交后数据可见', async () => {
    await withTransaction(db, async (tx) => {
      await tx`insert into users (id, openid) values ('u-1', 'openid-1')`;
    });
    const rows = await db`select id from users where id = 'u-1'`;
    expect(rows).toHaveLength(1);
  });

  it('抛错后回滚，不留痕', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await tx`insert into users (id, openid) values ('u-2', 'openid-2')`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db`select id from users where id = 'u-2'`;
    expect(rows).toHaveLength(0);
  });

  it('savepoint：内层回滚不影响外层已做的写入', async () => {
    await withTransaction(db, async (tx) => {
      await tx`insert into users (id, openid) values ('outer', 'o-outer')`;
      await expect(
        withSavepoint(tx, async (inner) => {
          await inner`insert into users (id, openid) values ('inner', 'o-inner')`;
          throw new Error('inner boom');
        }),
      ).rejects.toThrow('inner boom');
      await tx`insert into users (id, openid) values ('after-inner', 'o-after')`;
    });
    const ids = (await db`select id from users order by id`).map((r) => r.id);
    // 外层提交、内层回滚——F13 调度器"逐单处理，一条坏单不拖垮整批"就靠这个语义
    expect(ids).toEqual(['after-inner', 'outer']);
  });

  it('嵌套用 begin 会失败：明确报"不支持 savepoint"而不是 db.begin is not a function', async () => {
    await expect(
      withTransaction(db, async (_tx) => {
        await withSavepoint(db, async () => undefined); // 故意传连接池而不是事务对象
      }),
    ).rejects.toThrow(/savepoint/);
  });
});

describe('DB 级约束真的生效（不靠应用层自觉）', () => {
  it('products.origin_country ≠ JP 被拒（MVP 只卖日本原产，D-43）', async () => {
    await expect(
      db`insert into products (id, title, category, price_jpy, weight_g, origin_country)
         values ('p-cn', 'made in cn', 'daily', 1000, 100, 'CN')`,
    ).rejects.toThrow();
  });

  it('products.weight_g ≤ 0 被拒（否则报价阶段才炸成 50004）', async () => {
    await expect(
      db`insert into products (id, title, category, price_jpy, weight_g, origin_country)
         values ('p-0', 'no weight', 'daily', 1000, 0, 'JP')`,
    ).rejects.toThrow();
  });

  it('同一订单同时最多一个进行中的支付意图（唯一部分索引，D-33）', async () => {
    await db`insert into users (id, openid) values ('u-3', 'openid-3')`;
    await db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
             values ('o-1', 'W20260922-000001', 'u-3', 'created', 100, 100, '{}'::jsonb, '{}'::jsonb, 'TOS-1', now())`;
    const mk = (id: string) =>
      db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
         values (${id}, 'o-1', 'stripe', 'initiated', 'USD', 100)`;
    await mk('pay-1');
    await expect(mk('pay-2')).rejects.toThrow();
    // 已终态的意图不占位：可以再开一个
    await db`update payments set status = 'failed' where id = 'pay-1'`;
    await expect(mk('pay-3')).resolves.toBeDefined();
  });

  it('美国地址格式由 DB 校验（phone 必须 +1 开头 10 位）', async () => {
    await db`insert into users (id, openid) values ('u-4', 'openid-4')`;
    await expect(
      db`insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code)
         values ('a-1', 'u-4', 'Hanako', '09012345678', '1 Main St', 'Seattle', 'WA', '98101')`,
    ).rejects.toThrow();
  });
});

describe('迁移本身', () => {
  it('001_init 已应用，且 13 张业务表齐全', async () => {
    const applied = await db`select name from pgmigrations order by name`;
    expect(applied.map((r) => r.name)).toContain('001_init');

    const tables = (
      await db`select tablename from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations' order by tablename`
    ).map((r) => r.tablename);
    expect(tables).toHaveLength(13);
    expect(tables).toContain('orders');
    expect(tables).toContain('job_runs');
  });

  it('job_runs 有 seed（否则看门狗永远读不到心跳）', async () => {
    const rows = await db`select name from job_runs order by name`;
    expect(rows.map((r) => r.name)).toEqual(['daily', 'tick']);
  });
});
