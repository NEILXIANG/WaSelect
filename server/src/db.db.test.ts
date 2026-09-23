/**
 * 职责：DB 层的 L1 集成测试（F7）——**真库**，不 mock。
 * 重点：事务提交/回滚、嵌套事务（savepoint）、以及"DB 级约束是否真的生效"。
 * @why 约束写在文档里不算数，只有真库拒绝才算数——MVP 只卖日本原产这条硬约束若只在代码里，
 *      一次直接的 SQL 或后台脚本就能绕过（D-43）。
 * @see migrations/001_init.sql；docs/地基搭建清单.md F7
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPostgresMajor,
  closeDb,
  createDb,
  MIN_POSTGRES_MAJOR,
  ping,
  postgresMajorVersion,
  withSavepoint,
  withTransaction,
  type Db,
} from './db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../test/db/test-db.js';

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
    // 库名故意不存在；主机/角色沿用测试库连接串，避免把本机用户名写死在测试里
    const bad = createDb({ url: TEST_DB_URL.replace(/\/[^/]+$/, '/no_such_db_xyz'), max: 1 });
    try {
      await expect(ping(bad)).resolves.toBe(false);
    } finally {
      await closeDb(bad);
    }
  });

  it(`Postgres 大版本 >= ${MIN_POSTGRES_MAJOR}（与生产一致，代码里有硬闸门）`, async () => {
    await expect(postgresMajorVersion(db)).resolves.toBeGreaterThanOrEqual(MIN_POSTGRES_MAJOR);
    await expect(assertPostgresMajor(db)).resolves.toBeGreaterThanOrEqual(MIN_POSTGRES_MAJOR);
  });

  it('版本闸门在版本不足时抛错而不是静默放行', async () => {
    // 用一个必然不可能满足的下限（当前版本 + 1）验证闸门真的会拦
    const actual = await postgresMajorVersion(db);
    await expect(assertPostgresMajor(db, actual + 1)).rejects.toThrow(/版本过低/);
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
    const appliedNames = applied.map((r) => r.name);
    expect(appliedNames).toContain('001_init');
    expect(appliedNames).toContain('002_hardening');

    const tables = (
      await db`select tablename from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations' order by tablename`
    ).map((r) => r.tablename);
    // 13（001）+ 2（002 的 user_events / admin_audit，ADR-29 流 B/C 落点）。
    // ⚠️ 技术文档 v0.5 §3 仍写"13 张表"，需同步补这两张——见 002_hardening.sql @limitation 二。
    expect(tables).toHaveLength(15);
    expect(tables).toContain('orders');
    expect(tables).toContain('job_runs');
    expect(tables).toContain('user_events');
    expect(tables).toContain('admin_audit');
  });

  it('job_runs 有 seed（否则看门狗永远读不到心跳）', async () => {
    const rows = await db`select name from job_runs order by name`;
    expect(rows.map((r) => r.name)).toEqual(['daily', 'tick']);
  });
});

/**
 * 002 加固迁移（P1）：外键索引 / 状态域约束 / append-only / ADR-29 审计表。
 * @why 这些约束的失败形态是"缺了也不报错"，只能用真库断言"它真的会拒绝/真的存在"。
 */
describe('002 加固：约束真的会拦', () => {
  /** 每条用例前 beforeEach 都会 TRUNCATE，所以依赖 users 的用例必须自己建用户。 */
  async function ensureUser(): Promise<void> {
    await db`insert into users (id, openid) values ('u-1', 'o-1') on conflict (id) do nothing`;
  }

  it('orders.status 写入未登记状态被拒（否则订单会从所有查询里静默消失）', async () => {
    await ensureUser();
    await expect(
      db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
         values ('o-1', '260923-K7Q2MN', 'u-1', 'payed', 100, 100, '{}', '{}', 'TOS', now())`,
    ).rejects.toThrow(/orders_status_domain/);
  });

  it('orders.status 写入 10 个登记状态都通过（约束没有误伤合法值）', async () => {
    await ensureUser();
    const statuses = [
      'created',
      'pending_payment',
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'expired',
      'refunding',
      'refunded',
    ];
    for (const [i, status] of statuses.entries()) {
      await db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
         values (${`o-s-${i}`}, ${`260923-K7Q2M${i}`}, 'u-1', ${status}, 100, 100, '{}', '{}', 'TOS', now())`;
    }
    const rows = await db`select status from orders where id like 'o-s-%'`;
    expect(rows).toHaveLength(statuses.length);
  });

  it('审计表 append-only：order_events 的 UPDATE / DELETE 都被拒', async () => {
    await ensureUser();
    await db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
       values ('o-2', '260923-K7Q2MP', 'u-1', 'created', 100, 100, '{}', '{}', 'TOS', now())`;
    await db`insert into order_events (order_id, status, actor) values ('o-2', 'created', 'user')`;
    await expect(
      db`update order_events set note = 'tampered' where order_id = 'o-2'`,
    ).rejects.toThrow(/只允许 INSERT/);
    await expect(db`delete from order_events where order_id = 'o-2'`).rejects.toThrow(
      /只允许 INSERT/,
    );
  });

  it('user_events / admin_audit 可写且同样 append-only（ADR-29 流 B/C 的落点）', async () => {
    await ensureUser();
    await db`insert into user_events (user_id, event, props, trace_id) values ('u-1', 'view_product', '{"sku":"p-1"}', 't-1')`;
    await db`insert into admin_audit (actor, action, target, after) values ('admin@x.com', 'product.update', 'p-1', '{"price":100}')`;
    const ue = await db`select event from user_events where trace_id = 't-1'`;
    expect(ue[0]?.event).toBe('view_product');
    await expect(db`update admin_audit set action = 'x' where target = 'p-1'`).rejects.toThrow(
      /只允许 INSERT/,
    );
  });

  it('外键列都有索引（否则父表删改会退化成子表全表扫描）', async () => {
    const rows = await db`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join unnest(c.conkey) k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    `;
    // ⚠️ 必须排除**部分索引**（indpred is not null）：payments 上有个
    //    `uq_payments_one_initiated ... WHERE status='initiated'` 的部分唯一索引，首列也是 order_id。
    //    不排除的话，把通用外键索引删掉这条用例**仍然全绿**——看起来在验，其实没验到。
    //    这是本次写测试时真实踩到的：注回缺陷后未变红，才回头发现的。
    const indexed = await db`
      select t.relname as tbl, a.attname as col
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where t.relnamespace = 'public'::regnamespace
        and i.indpred is null
        and i.indisvalid
    `;
    const have = new Set(indexed.map((r) => `${r.tbl}.${r.col}`));
    // orders.user_id / order_events.order_id 在 001 已建复合索引，前缀列即生效
    const expectIdx = [
      'addresses.user_id',
      'order_items.order_id',
      'order_items.product_id',
      'payments.order_id',
      'shipments.order_id',
      'orders.user_id',
      'order_events.order_id',
    ];
    for (const key of expectIdx) expect(have.has(key)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
