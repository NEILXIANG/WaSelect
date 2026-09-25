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
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';

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

  /**
   * D20：连接池必须带 `statement_timeout`。
   * @why 默认是 0（不限时）。一条慢查询（缺索引、锁等待、笛卡尔积）会**永久**占住连接，
   *      连接池耗尽后表现是"全站下单超时"，而根因在十几分钟前那一条查询——日志上完全看不出来。
   *      设了超时，它至少会以 `57014 query_canceled` 的形式报错，能在日志里被检索到。
   */
  it('默认连接池带 statement_timeout（不能是 0 = 不限时）', async () => {
    const rows = await db`show statement_timeout`;
    // `show` 的取值形态随服务端而定：'15s' / '300ms' / '0'，三种都要解析得对
    const raw = String(rows[0]?.statement_timeout ?? '0');
    const m = /^(\d+)(ms|s|min)?$/.exec(raw);
    const n = Number(m?.[1] ?? '0');
    const unit = m?.[2];
    const ms = unit === 'ms' ? n : unit === 'min' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    expect(ms).toBeGreaterThan(0);
  });

  it('超时真的会被取消：pg_sleep 超过限制时抛 57014（不是挂到平台超时）', async () => {
    const limited = createDb({ url: TEST_DB_URL, statementTimeoutMs: 300, max: 1 });
    try {
      await expect(limited`select pg_sleep(3) as slept`).rejects.toThrow(/57014|cancel/i);
    } finally {
      await closeDb(limited);
    }
  }, 15_000);

  /**
   * N32：`lock_timeout` 与 `idle_in_transaction_session_timeout` 不能靠 statement_timeout 兜底。
   * @why ① 锁等待：一个长事务持锁不放，等待方只能等满 15s 语句超时——
   *      期间该请求的所有日志都像"慢"而不是"被堵"，5s 的锁超时把"堵"提前暴露成 55P03。
   *      ② 闲事务：代码 bug（忘了 await、事件循环卡死）把事务晾在半开状态，
   *      行锁会一直扣着——60s 后 PG 杀掉这条连接，把事故从"全表锁死"降级成"一条请求失败"。
   *      （withIdempotencyTx 按等待预算用 SET LOCAL 覆盖 lock_timeout，两者不冲突。）
   */
  it('默认连接池带 lock_timeout 与 idle_in_transaction_session_timeout（N32）', async () => {
    const parseMs = (raw: string): number => {
      const m = /^(\d+)(ms|s|min)?$/.exec(raw);
      const n = Number(m?.[1] ?? '0');
      const unit = m?.[2];
      return unit === 'ms' ? n : unit === 'min' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    };
    const lock = await db`show lock_timeout`;
    expect(parseMs(String(lock[0]?.lock_timeout ?? '0'))).toBeGreaterThan(0);
    const idle = await db`show idle_in_transaction_session_timeout`;
    expect(parseMs(String(idle[0]?.idle_in_transaction_session_timeout ?? '0'))).toBeGreaterThan(0);
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

/**
 * int8 / numeric 的类型映射（D2）。
 *
 * @why postgres.js 默认把 int8 与 numeric 都返回 **string**。于是业务代码里
 *      `items_jpy + shipping_jpy` 从"相加"变成"字符串拼接"——实测 `1000 + 1000`
 *      得到 `"10001000"`：不报错、类型检查也过（列值是动态类型），金额静默变十倍。
 *      这类缺陷不会在测试里表现为红灯，除非**专门断言算术结果**。
 */
describe('int8 / numeric 映射（D2）', () => {
  it('int8 读回来是 number，且相加是算术而不是拼接', async () => {
    const rows = await db`select 1000::int8 as a, 1000::int8 as b`;
    const a = rows[0]?.a;
    const b = rows[0]?.b;
    expect(typeof a).toBe('number');
    // 这一条就是缺陷本身：string + string = '10001000'
    expect((a as number) + (b as number)).toBe(2000);
  });

  it('count(*) 是 number 而不是字符串（"3" 会让计数比较全部失配）', async () => {
    await db`insert into users (id, openid) values ('u-c1', 'o-c1')`;
    await db`insert into users (id, openid) values ('u-c2', 'o-c2')`;
    const rows = await db`select count(*) as c from users`;
    expect(rows[0]?.c).toBe(2);
  });

  it('订单金额列读回是 number（金额字段全为 BIGINT）', async () => {
    await db`insert into users (id, openid) values ('u-amt', 'o-amt')`;
    await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
             values ('o-amt', '260923-K7Q2MQ', 'u-amt', 'created', 1000, 500, 1500, '{}', '{}', 'TOS', now())`;
    const rows = await db`select items_jpy, shipping_jpy, total_jpy from orders where id = 'o-amt'`;
    const row = rows[0];
    expect(row?.items_jpy).toBe(1000);
    expect(row?.shipping_jpy).toBe(500);
    // 若还是 string，这里会得到 1000500 或 '1000500' 之外的拼接结果
    expect((row?.items_jpy as number) + (row?.shipping_jpy as number)).toBe(1500);
    expect(row?.total_jpy).toBe(1500);
  });

  it('超出 JS 安全整数范围时抛错，而不是静默丢精度', async () => {
    await expect(db`select 9223372036854775807::int8 as huge`).rejects.toThrow(/安全整数/);
  });

  it('numeric 仍然是 string（汇率精度不能交给 number）', async () => {
    // @why 汇率是 numeric(…,8)；Number('0.00670000') 之后再做 ×1e8 的换算会在高位丢精度。
    //      换算统一走 shared/money.ts 的 toRateInt()（它接受 string）。
    const rows = await db`select 0.00670000::numeric(12,8) as rate`;
    expect(typeof rows[0]?.rate).toBe('string');
  });

  it('写入方向不受影响：numeric / double / int4 参数仍按各自类型落库', async () => {
    // @why 自定义 int8 类型若劫持了"所有 number 参数"的序列化，
    //      这条用例会红（汇率 0.0067 会被当成 bigint 写入而变 0 或报错）。
    const rows =
      await db`select ${0.0067}::numeric(12,6) as n, ${1.5}::double precision as d, ${42}::integer as i`;
    expect(String(rows[0]?.n)).toBe('0.006700');
    expect(rows[0]?.d).toBe(1.5);
    expect(rows[0]?.i).toBe(42);
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
  it('迁移已应用，且业务表清单与预期逐项一致', async () => {
    // ⚠️ 标题**刻意不写数字**：它曾经写"13 张业务表"，而正文断言是 16，
    //    两边都是手写的、都不是真值——加一张表就要改两个地方，
    //    而这类"标题 + 正文"双份数字正是最容易漂移到互相矛盾的地方（单一来源，F2 铁律）。
    //    真值只有正文这一处，且加表时它必然先红。
    const applied = await db`select name from pgmigrations order by name`;
    const appliedNames = applied.map((r) => r.name);
    expect(appliedNames).toContain('001_init');
    expect(appliedNames).toContain('002_hardening');

    const tables = (
      await db`select tablename from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations' order by tablename`
    ).map((r) => r.tablename);
    // 13（001）+ 2（002 的 user_events / admin_audit，ADR-29 流 B/C 落点）
    // + 1（003 的 webhook_events）+ 1（007 的 country_profiles，F11 单元④）= 17。
    // ⚠️ 技术文档 v0.5 §3 仍写"13 张表"；ADR-28 写"13 → 17（新增四张）"，
    //    那份推演的基准是它成文时的 13 张。两者都与当前实际不符，
    //    统一口径以本断言为准，文档同步已登记在 docs/地基搭建清单.md 的欠账里。
    //    ADR-28 四张新增中已落地 1 张（country_profiles），
    //    余下 duty_rates / payment_channels / app_config 属 I1（P1），全部落地后是 20 张。
    expect(tables).toHaveLength(17);
    expect(tables).toContain('orders');
    expect(tables).toContain('job_runs');
    expect(tables).toContain('user_events');
    expect(tables).toContain('admin_audit');
    expect(tables).toContain('webhook_events');
    expect(tables).toContain('country_profiles');
  });

  it('job_runs 有 seed（否则看门狗永远读不到心跳）', async () => {
    const rows = await db`select name from job_runs order by name`;
    expect(rows.map((r) => r.name)).toEqual(['daily', 'tick']);
  });

  it('orders.terms_version 列宽已加宽（008：条款改一版不该撑爆建单路径）', async () => {
    // @why 体检 P2：VARCHAR(16) 对 `TOS-2026-09-20`（14 字符）余量只有 2，
    //      下次条款改版建单就会撑爆——用真库的列宽断言钉住，回退迁移立刻红。
    const rows = await db`
      select character_maximum_length as len
      from information_schema.columns
      where table_schema = 'public' and table_name = 'orders' and column_name = 'terms_version'
    `;
    expect(Number(rows[0]?.len)).toBeGreaterThanOrEqual(32);
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

  /**
   * D19：邮箱唯一必须**大小写不敏感**。
   * @why `UNIQUE(email)` 只保证精确唯一：`Bob@Example.com` 与 `bob@example.com` 能共存，
   *      于是同一个管理员有两个账号，登录时大小写不一致还会"找不到人"。
   *      这类问题在 seed 阶段看不出来（seed 只用一种写法），要到第二个管理员加入时才暴露。
   */
  it('email 仅大小写不同也算重复（lower(email) 唯一索引）', async () => {
    await db`insert into users (id, email) values ('u-mail-1', 'Bob@Example.com')`;
    await expect(
      db`insert into users (id, email) values ('u-mail-2', 'bob@example.com')`,
    ).rejects.toThrow(/users_email_lower_key|duplicate key/i);
  });

  it('email 为 NULL 时不触发唯一冲突（多人没填邮箱是正常的）', async () => {
    await db`insert into users (id, openid) values ('u-no-mail-1', 'o-nm-1')`;
    await db`insert into users (id, openid) values ('u-no-mail-2', 'o-nm-2')`;
    const rows = await db`select id from users where id like 'u-no-mail-%'`;
    expect(rows).toHaveLength(2);
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

/**
 * 结构不变量（防复发机制）。
 *
 * @why 002 是"补"上了外键索引与状态域约束，但**补只管得了一批**。
 *      下一次有人加 003 迁移、建一张带外键和 `status` 列的表，同样的缺陷会一模一样地再发生一次——
 *      因为没有任何东西会提醒他。所以这里不写"这几张表要有索引"，而写
 *      "**任何**外键列都必须有索引、**任何** status 列都必须有域约束"：
 *      断言的是不变量而不是清单，于是新表自动进入覆盖范围，漏了就红。
 *
 * @limitation 豁免名单必须**逐条写原因**。没有原因的豁免会让这个机制在几张表之后失效。
 */
describe('结构不变量：对新表自动生效', () => {
  /** 豁免：契约（api-contract.yaml）尚未枚举这两个状态域。等 0.6 补枚举后加约束并从这里移除。 */
  const STATUS_EXEMPT: Readonly<Record<string, string>> = {
    'payments.status': '契约未枚举该状态域；编一套取值会在契约补全后开始误拒合法数据',
    'shipments.status': '同上',
    'order_events.status':
      '审计快照：CHECK 作用于全部历史行，一旦将来收敛状态枚举就会立刻违反约束，反而让枚举无法演进',
  };

  const keyOf = (tbl: unknown, col: unknown): string => `${String(tbl)}.${String(col)}`;

  it('任何外键列都有（非部分）索引', async () => {
    const fks = await db`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join unnest(c.conkey) k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    `;
    const indexed = await db`
      select t.relname as tbl, a.attname as col
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where t.relnamespace = 'public'::regnamespace
        and i.indpred is null
        and i.indisvalid
    `;
    const have = new Set(indexed.map((r) => keyOf(r.tbl, r.col)));
    const missing = fks.map((r) => keyOf(r.tbl, r.col)).filter((key) => !have.has(key));
    expect(missing).toEqual([]);
    expect(fks.length).toBeGreaterThan(5);
  });

  it('任何 status 列都有域约束（或在豁免名单里并写明原因）', async () => {
    const cols = await db`
      select c.relname as tbl, a.attname as col
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace
        and a.attnum > 0 and not a.attisdropped
        and a.attname = 'status'
        -- 只看普通表：索引在 pg_class 里也是一条关系、也有名为 status 的属性，
        -- 不过滤会把 idx_orders_open_status 当成一张"缺约束的表"（实测踩到）
        and c.relkind in ('r', 'p')
    `;
    const checks = await db`
      select con.conrelid::regclass::text as tbl, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      where con.contype = 'c' and con.connamespace = 'public'::regnamespace
    `;
    const constrained = new Set(
      checks.filter((r) => String(r.def).includes('status')).map((r) => String(r.tbl)),
    );
    const keys = cols.map((r) => keyOf(r.tbl, r.col));
    const missing = keys.filter(
      (key) => !constrained.has(key.split('.')[0] ?? '') && STATUS_EXEMPT[key] === undefined,
    );
    expect(missing).toEqual([]);
    // 豁免名单里的键必须真的存在（防止名字写错后豁免永久失效）
    for (const key of Object.keys(STATUS_EXEMPT)) expect(keys).toContain(key);
  });
});
