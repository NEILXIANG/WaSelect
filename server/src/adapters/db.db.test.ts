/**
 * 职责：DB 层的 L1 集成测试（F7）——**真库**，不 mock。
 * 重点：事务提交/回滚、嵌套事务（savepoint）、以及"DB 级约束是否真的生效"。
 * @why 约束写在文档里不算数，只有真库拒绝才算数——MVP 只卖日本原产这条硬约束若只在代码里，
 *      一次直接的 SQL 或后台脚本就能绕过（D-43）。
 * @see migrations/001_init.sql；docs/地基搭建清单.md F7
 */
import type { TransactionSql } from 'postgres';
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
    expect(appliedNames).toContain('010_config_tables');

    const tables = (
      await db`select tablename from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations' order by tablename`
    ).map((r) => r.tablename);
    // 13（001）+ 2（002 的 user_events / admin_audit，ADR-29 流 B/C 落点）
    // + 1（003 的 webhook_events）+ 1（007 的 country_profiles，F11 单元④）
    // + 3（010 的 duty_rates / payment_channels / app_config，I1-U7a）
    // + 1（015 的 login_attempts，A1+B14：登录额度从 users 两列搬到独立表）
    // + 1（019 的 order_address_history，AJ-293：改址旧值迁出 append-only）
    // + 1（028 的 reconciliation_runs，剩余清单 3-2：对账结果落库供运营日志页读）
    // + 1（030 的 order_refunds，AJ-383：部分退款 / 完成后售后退款）
    // + 1（034 的 order_notes，AJ-396：订单内部备注，append-only）
    // + 1（037 的 mail_deliveries，AJ-419：订单通知邮件发信记录，daily 补发据此找漏发）
    // + 1（038 的 after_sale_requests，AJ-420：买家售后申请）
    // + 1（039 的 product_categories，AJ-491：商品分类改为后台可配置）= 28。
    // ✅ 文档侧已同步（2026-09-28，一致性审计 AJ-176）：010 落地后文档一度仍写 17（上一轮"已同步"只到 17），
    //    本轮 jp 技术文档 §3/§3.1、工程框架文档、PRD §5、jp README、本库 README / 测试策略 / 架构设计 / 日志规范 /
    //    地基清单统一改为"以本断言为准"（写数字的地方写 20 并注明真源），避免下一次加表再漂移。
    //    ADR-28 写"13 → 17（新增四张）"那份推演的基准是它成文时的 13 张，现以本断言为准。
    expect(tables).toHaveLength(28);
    expect(tables).toContain('after_sale_requests');
    expect(tables).toContain('product_categories');
    expect(tables).toContain('mail_deliveries');
    expect(tables).toContain('order_notes');
    expect(tables).toContain('order_refunds');
    expect(tables).toContain('orders');
    expect(tables).toContain('reconciliation_runs');
    expect(tables).toContain('login_attempts');
    expect(tables).toContain('job_runs');
    expect(tables).toContain('user_events');
    expect(tables).toContain('admin_audit');
    expect(tables).toContain('webhook_events');
    expect(tables).toContain('country_profiles');
    expect(tables).toContain('duty_rates');
    expect(tables).toContain('payment_channels');
    expect(tables).toContain('app_config');
    // AJ-293：改址旧地址的归档表。它**刻意不挂 append-only 触发器**（否则匿名化出口又被堵回去），
    // 所以必须在这里守住"它真的建出来了"——少一张表，取证链就是断的。
    expect(tables).toContain('order_address_history');
  });

  it('job_runs 有 seed（否则看门狗永远读不到心跳）', async () => {
    const rows = await db`select name from job_runs order by name`;
    expect(rows.map((r) => r.name)).toEqual(['daily', 'tick']);
  });

  /**
   * 三审 P3-2：003 的 `idx_webhook_events_pending` 与 005 的 `idx_webhook_events_unfinished`
   * 定义逐字相同（`(provider, processed_at) WHERE processed_at IS NULL`）——每次 claim/finish/release
   * 都多维护一份索引。009 删掉重复的一份；本用例作为通用不变量守住"同表不得有定义相同的两个索引"。
   */
  it('同一张表上不得存在定义完全相同的两个索引（009 之后 webhook_events 只剩一份待处理索引）', async () => {
    const rows = await db`
      select tablename, regexp_replace(indexdef, 'INDEX \S+ ON', 'INDEX ? ON') as def, count(*)::int as n
      from pg_indexes
      where schemaname = 'public'
      group by tablename, def
      having count(*) > 1
    `;
    expect(rows).toEqual([]);
    const names = await db`
      select indexname from pg_indexes where schemaname = 'public' and tablename = 'webhook_events'
    `;
    expect(names.map((r) => r.indexname)).not.toContain('idx_webhook_events_pending');
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

  it('🔴 products.status 三值（035 / AJ-403）：active / offline / draft 可写，其它值被 products_status_domain 拒', async () => {
    for (const [i, st] of ['active', 'offline', 'draft'].entries()) {
      await db`insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
               values (${`p-dom-${i}`}, 'dom', 'beauty', 100, 100, 'JP', ${st})`;
    }
    await expect(
      db`insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
         values ('p-dom-bad', 'dom', 'beauty', 100, 100, 'JP', 'deleted')`,
    ).rejects.toThrow(/products_status_domain/);
  });

  it('payments.status 写入未登记状态被拒（009 payments_status_domain；三审 P3-C1）', async () => {
    await ensureUser();
    await db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('o-ps', '260925-PSDOM1', 'u-1', 'created', 100, 100, '{}', '{}', 'TOS', now())`;
    await expect(
      db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
         values ('pay-ps', 'o-ps', 'mock', 'paid', 'JPY', 100)`,
    ).rejects.toThrow(/payments_status_domain/);
    for (const [i, st] of ['initiated', 'succeeded', 'failed', 'cancelled', 'refunded'].entries()) {
      await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
         values (${`pay-ps-${i}`}, 'o-ps', ${`p${i}`}, ${st}, 'JPY', 100)`;
    }
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
    // 036 给 user_events 换了触发器函数（事务内 GUC 窄口，AJ-413）：普通的 UPDATE / DELETE 必须仍被拒
    await expect(db`update user_events set event = 'x' where trace_id = 't-1'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    await expect(db`delete from user_events where trace_id = 't-1'`).rejects.toThrow(
      /只允许 INSERT/,
    );
  });

  it('reconciliation_runs 同样 append-only（对账历史不可改，剩余清单 3-2）', async () => {
    await db`insert into reconciliation_runs (ran_at, counts, samples) values (now(), '{}', '{}')`;
    await expect(db`update reconciliation_runs set counts = '{"x":1}'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    await expect(db`delete from reconciliation_runs`).rejects.toThrow(/只允许 INSERT/);
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

  /**
   * 024 的两条索引（DB-13 / CAT-19）。
   *
   * @why 这两条**不是**外键索引，所以上面那条"外键列都有索引"的不变量**覆盖不到**它们——
   *      它们对应的是两条具体的查询（清理作业的按时间删除、公开商品列表的按状态排序）。
   *      索引被误删时没有任何查询会报错，只会**慢慢变慢**，而"变慢"在 MVP 阶段
   *      根本不会有人注意到——等到注意到时，表已经大到要在活表上建索引了。
   *      所以这里钉的是"索引还在"，不是"查询有多快"（后者是基准测试的事，不在门禁里）。
   * @limitation 只断言"首列 + 表名"在索引里，不断言索引名与列顺序：
   *              PG 用得上索引靠的是列的可匹配性，不是名字；把名字钉死会让
   *              "换个更合适的列顺序"这种正常改动变成改测试。
   */
  it('024 的两条查询索引都在（清理作业按时间删、商品列表按状态排序）', async () => {
    const rows = await db`
      select t.relname as tbl, a.attname as col
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where t.relnamespace = 'public'::regnamespace
        and i.indpred is null
        and i.indisvalid
    `;
    const have = new Set(rows.map((r) => `${String(r.tbl)}.${String(r.col)}`));
    // ⚠️ 两条都带说明文案：写成 `expect(have.has(k)).toBe(true)` 的话，
    //    注入（DROP INDEX）后只报 `expected false to be true`——红灯是对的，
    //    但**看不出是哪一条索引没了**（实测就是如此）。
    // ① 清理作业 deleteStaleLoginAttempts 的 `last_failed_at < cutoff`
    expect(
      have.has('login_attempts.last_failed_at'),
      '缺 login_attempts(last_failed_at) 索引：清理作业会每天全表扫描一张只增不删的表',
    ).toBe(true);
    // ② catalog.ts 公开列表的 `status = 'active' … order by created_at desc, id`
    expect(
      have.has('products.status'),
      '缺 products(status, created_at desc, id) 索引：公开商品列表每次请求全表扫描 + 排序',
    ).toBe(true);
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
  /**
   * 豁免必须逐条写原因。`payments.status` 曾以"契约未枚举"为由豁免——三审指出技术文档 §3
   * 早已枚举五个取值（且 001 的部分唯一索引依赖 `'initiated'`），理由不成立，009 已补约束并移出名单。
   */
  const STATUS_EXEMPT: Readonly<Record<string, string>> = {
    'shipments.status':
      '技术文档 §3 只给了 DEFAULT created、未枚举取值集合（轨迹状态随承运商 P1 接入再定）；编一套取值会在口径定下后误拒合法数据',
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
    // TST3-05（第三轮审查）两处收紧：
    // ① 列名按 `status` 或 `*_status` 匹配——原来只认恰好叫 status 的列，
    //    `payments.dispute_status`（决定 has_dispute 是否复位的状态机列）因此从未进过覆盖；
    // ② 判定按**列**而不是按表：约束的 conkey 必须包含这一列。原来只看"这张表上任意 CHECK 的定义含 status 子串"，
    //    给 dispute_status 加一条 CHECK 之后，主状态列的约束即使被删，这条仍然是绿的。
    const cols = await db`
      select c.relname as tbl, a.attname as col, a.attnum as num, c.oid::int as rel
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace
        and a.attnum > 0 and not a.attisdropped
        and a.attname ~ '(^|_)status$'
        -- 只看普通表：索引在 pg_class 里也是一条关系、也有名为 status 的属性，
        -- 不过滤会把 idx_orders_open_status 当成一张"缺约束的表"（实测踩到）
        and c.relkind in ('r', 'p')
    `;
    const checks = await db`
      select con.conrelid::int as rel, con.conkey as keys
      from pg_constraint con
      where con.contype = 'c' and con.connamespace = 'public'::regnamespace
    `;
    const covered = new Set<string>();
    for (const c of checks) {
      for (const k of (c.keys as number[] | null) ?? []) covered.add(`${String(c.rel)}:${k}`);
    }
    const keys = cols.map((r) => keyOf(r.tbl, r.col));
    const missing = cols
      .filter((r) => !covered.has(`${String(r.rel)}:${String(r.num)}`))
      .map((r) => keyOf(r.tbl, r.col))
      .filter((key) => STATUS_EXEMPT[key] === undefined);
    expect(missing).toEqual([]);
    expect(keys, '列名匹配规则失效（一个 status 列都没找到）').toContain('orders.status');
    expect(keys).toContain('payments.dispute_status');
    // 豁免名单里的键必须真的存在（防止名字写错后豁免永久失效）
    for (const key of Object.keys(STATUS_EXEMPT)) expect(keys).toContain(key);
  });

  /**
   * 同上，**金额列**的版本（DB-07 / 023 迁移）。
   *
   * @why 与 status 那条同一个道理：023 补的是"今天已经在的"那批金额列，
   *      但下一次有人建一张带 `*_jpy` 列的新表，同样的缺口会一模一样地再出现一次。
   *      断言"不变量"而不是"这几列要有约束"，新表才会自动进入覆盖范围。
   * @why 命名约定（`_jpy` / `_amount` 后缀）在本仓是**一致的**——
   *      最小货币单位的整数金额一律这两个后缀，没有第三种写法。
   *      这是一条**约定**而不是 PG 的性质，所以它靠这条用例维持：
   *      谁要是加了个叫 `money` 的列，这条不会红——那条缝由 review 兜，
   *      与"列名匹配规则"本身的局限同类（已在下面用 `expect(keys).toContain(...)` 钉住规则没失效）。
   *
   * @limitation 只判"**有没有**覆盖这一列的 CHECK"，**不判约束写的是不是 >= 0**：
   *              读 CHECK 表达式的语义需要解析 SQL，成本远高于收益——
   *              漏约束是主要失败模式（今天就是它），写错方向是次要的。
   * @limitation 汇率列 `fx_rates.rate` / `raw_rate` 不在这个正则里（`rate` 没有后缀），
   *              由 023 单独加的 `fx_rates_*_positive` 钉住；这里不硬凑一个更宽的正则——
   *              那会把 `duty_rates.rate`（比率，合法区间 [0,1)，语义完全不同）也卷进来。
   */
  const MONEY_EXEMPT: Readonly<Record<string, string>> = {
    'payments.fee_jpy':
      '至今没有任何写入方（全仓只读）；给一个没人写的列定域等于"顺手编一套取值"，口径定了之后会误拒合法数据（同 002 @limitation 一）',
    'payments.settled_jpy':
      '语义是净结算（收款 − 手续费），手续费大于收款时**可以为负**——那不是错误，而是"这一笔亏了"。定死 >= 0 会把这个真实形态变成一条永远写不进去的约束',
  };

  it('任何金额列（_jpy / _amount）都有符号约束（或在豁免名单里并写明原因）', async () => {
    const cols = await db`
      select c.relname as tbl, a.attname as col, a.attnum as num, c.oid::int as rel
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped
        and a.attname ~ '(_jpy|_amount)$'
    `;
    const checks = await db`
      select con.conrelid::int as rel, con.conkey as keys
      from pg_constraint con
      where con.contype = 'c' and con.connamespace = 'public'::regnamespace
    `;
    const covered = new Set<string>();
    for (const c of checks) {
      for (const k of (c.keys as number[] | null) ?? []) covered.add(`${String(c.rel)}:${k}`);
    }
    const keys = cols.map((r) => keyOf(r.tbl, r.col));
    const missing = cols
      .filter((r) => !covered.has(`${String(r.rel)}:${String(r.num)}`))
      .map((r) => keyOf(r.tbl, r.col))
      .filter((key) => MONEY_EXEMPT[key] === undefined);
    expect(
      missing,
      `以下金额列没有任何 CHECK 兜底（负号一旦写进去不会报错）：${missing.join(' / ')}`,
    ).toEqual([]);
    // 规则没失效：已知的两条必须被扫到（否则正则写错时会"零命中 = 全绿"）
    expect(keys).toContain('orders.total_jpy');
    expect(keys).toContain('payments.charge_amount');
    // 豁免名单里的键必须真的存在（防止名字写错后豁免永久失效）
    for (const key of Object.keys(MONEY_EXEMPT)) expect(keys).toContain(key);
  });

  /**
   * 023 的约束**真的会拒绝**，而不只是"约束对象存在"（DB-07）。
   *
   * @why 上面两条不变量验的是"这一列有没有被 CHECK 覆盖"，属于**结构**；
   *      "覆盖了"和"约束体写对了"是两件事——把 `>= 0` 写成 `>= -1000000` 同样满足结构检查。
   *      这里补的是行为：真的往里写一次不合法的值，看 PG 拒不拒。
   * @limitation 只挑每类一个代表（`link_type` / `category` / 运费档金额 / 汇率），
   *              不是穷举全部 023 约束——穷举会让"加一条约束"变成"补一条用例"，
   *              与"不变量自动覆盖"的初衷相冲。结构那层兜住"有没有"，这里兜住"写得对不对"。
   * @limitation ⚠️ 每次试写都放在**必然回滚**的事务里：本仓踩过一次——
   *              让"被测行为失败"来顺带触发 ROLLBACK，等于"行为失败的那天才有清理"，
   *              而那天恰恰是最不需要清理的一天（§2 第 14 条）。所以一律显式抛哨兵。
   */
  describe('023 的约束真的会拒绝不合法的值', () => {
    const ROLLBACK = '__rollback__';

    /** 在必然回滚的事务里试写一次；返回"被拒的错误对象"，没被拒则返回 undefined。 */
    async function tryWrite(work: (tx: TransactionSql<{ int8: number }>) => Promise<unknown>) {
      let seen: unknown;
      const outcome = await db
        .begin(async (tx) => {
          seen = await work(tx).then(
            () => undefined,
            (e: unknown) => e,
          );
          throw new Error(ROLLBACK);
        })
        .catch((e: unknown) => e);
      expect(String((outcome as Error).message), '试写必须被哨兵带进回滚').toContain(ROLLBACK);
      return seen;
    }

    /**
     * ⚠️ 必须**可选链**：写成 `(e as {code?: string}).code` 的话，
     *    "约束被删了、写入没被拒"时 `e` 是 undefined，还没走到断言就先抛
     *    `TypeError: Cannot read properties of undefined`——红灯是对的，
     *    但**看不出是哪一条约束没了**（注入实验里就是这个表现）。
     *    返回 `'undefined'` 字符串，让后面那条带说明的断言来报。
     */
    const codeOf = (e: unknown): string => String((e as { code?: string } | undefined)?.code);

    it('🔴 banner 的 link_type 出枚举就被拒（否则配了跳转但点了没反应，查配置查不出）', async () => {
      const e = await tryWrite(
        (tx) => tx`
          insert into banners (id, image_key, link_type)
          values ('probe-banner', 'probe-key', 'url')
        `,
      );
      expect(codeOf(e), 'link_type=url 应被 banners_link_type_domain 拒').toBe('23514');
      expect(String((e as Error).message)).toContain('banners_link_type_domain');
    });

    // AJ-491（039）：分类从写死的 CHECK 改为外键引用 product_categories——"不在分类表里的键"仍被库拒，只是错误码变成外键违约
    it('🔴 商品的 category 不在分类表里就被拒（否则 tab 上没有它，只能靠搜索找到）', async () => {
      const e = await tryWrite(
        (tx) => tx`
          insert into products (id, title, category, price_jpy, weight_g, origin_country)
          values ('probe-product', 'probe', 'books', 100, 100, 'JP')
        `,
      );
      expect(codeOf(e), 'category=books 应被 products_category_fk 拒').toBe('23503');
      expect(String((e as Error).message)).toContain('products_category_fk');
    });

    it('🔴 运费档：price_jpy 为负被拒；为 0 放行（免运费档是合法配置）', async () => {
      const negative = await tryWrite(
        (tx) => tx`
          insert into shipping_rates (carrier, max_weight_g, price_jpy)
          values ('probe-carrier', 1000, -1)
        `,
      );
      expect(codeOf(negative), '负运费应被 shipping_rates_price_jpy_nonneg 拒').toBe('23514');

      // @why 反向也要钉：只测"负的被拒"的话，把 `>= 0` 写成 `> 0` 照样是绿的，
      //      而那会让"免运费档"这一合法业务形态存不进去。
      const zero = await tryWrite(
        (tx) => tx`
          insert into shipping_rates (carrier, max_weight_g, price_jpy)
          values ('probe-carrier', 1000, 0)
        `,
      );
      expect(zero, 'price_jpy = 0（免运费档）必须放行').toBeUndefined();
    });

    it('🔴 运费档：max_weight_g = 0 被拒（0g 的档永远取不到）', async () => {
      const e = await tryWrite(
        (tx) => tx`
          insert into shipping_rates (carrier, max_weight_g, price_jpy)
          values ('probe-carrier', 0, 500)
        `,
      );
      expect(codeOf(e), 'max_weight_g = 0 应被 positive 约束拒').toBe('23514');
    });
  });
});
