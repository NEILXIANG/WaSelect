/**
 * 职责：建单核心的**可注入路径**真库用例（I1-U5b）——D32 单号冲突重试与关单释放库存。
 *
 * @why D32 只能在核心层测：撞号序列要靠**可控的 IdGen**（第一次撞、第二次成），
 *      而 mountAllRoutes 装配的是 systemIdGen——核心函数可注入正是为了这个用例存在
 *      （"单号冲突重试"除了靠运气撞上一次之外永远测不到——骨架期的既定教训）。
 *
 * @why 关单释放库存在这里测端到端（建单扣 → 关单回）而不是单测 restoreStockForOrder：
 *      真正的风险是"扣了但忘了回"——只有两个动作都走真路径，"回到原值"的断言才有意义。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTransaction, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createOrder, ORDER_NO_MAX_ATTEMPTS, type CreateOrderDeps } from './create-order.js';
import { cancelOrder } from './cancel-order.js';
import {
  markOrderExpired,
  restoreStockForOrder,
  restoreStockForOrders,
  stockRestorePlan,
} from '../adapters/orders.js';
import { buildOrderNo } from '../domain/order-no.js';
import { AppError } from '../errors.js';
import type { IdGen } from '../ports/ids.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

const CLOCK = fixedClock('2026-01-02T12:00:00.000Z');

function deps(idGen: IdGen, sink: MemorySink): CreateOrderDeps {
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://localhost/japan_shop_test',
    JWT_SECRET: 'create-order-test-secret-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    // 本文件的用例按需要反复给同一个用户建单；在途单上限（AJ-240）另有专门用例（order-routes.db.test.ts）
    MAX_OPEN_ORDERS_PER_USER: '1000',
  });
  return {
    config,
    clock: CLOCK,
    idGen,
    logger: createLogger({ env: 'test', destination: sink }),
  };
}

/** 序列 IdGen：orderSeq 依次给出 seqs（用完后给最后一个）；uuid 每次带序号防 PK 撞。 */
function seqIdGen(seqs: readonly string[]): IdGen {
  let seqCalls = 0;
  let uuidCalls = 0;
  return {
    orderSeq: () => seqs[Math.min(seqCalls++, seqs.length - 1)] ?? 'AAAAAA',
    uuid: () => `00000000-0000-4000-8000-${String(uuidCalls++).padStart(12, '0')}`,
  };
}

const INPUT = {
  userId: 'u-1',
  items: [{ productId: 'p-knife', qty: 2 }],
  addressId: 'addr-1',
  termsVersion: 'TOS-TEST-1',
};

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active')
  `;
  for (const s of makeShippingRates('placeholder')) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
  // ⚠️ effective_from 必须早于注入的固定时钟（2026-01-02），用 now() 会落在"未来"而被过滤
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, '2026-01-02T00:00:00Z'),
           ('CNY', 0.049, 0.048, 0.03, '2026-01-02T00:00:00Z')
  `;
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country)
    values ('addr-1', 'u-1', 'Jane Doe', '+14155550123', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'US')
  `;
});

describe('D32：order_no 撞唯一约束 → savepoint 重试', () => {
  it('第一次撞、第二次成：建单成功且 order_no 是第二个候选（事务没死在 aborted 态）', async () => {
    const colliding = buildOrderNo(CLOCK, 'AAAAAA');
    // 预先占掉第一个候选单号（同业务日）
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                          fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('ord-existing', ${colliding}, 'u-1', 'created', 100, 100, 100,
              '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')
    `;
    const sink = new MemorySink();
    const created = await withTransaction(db, (tx) =>
      createOrder(tx, deps(seqIdGen(['AAAAAA', 'BBBBBB']), sink), INPUT),
    );
    expect(created.orderNo).toBe(buildOrderNo(CLOCK, 'BBBBBB'));
    expect(sink.find('order_no_collision_retry')).toHaveLength(1);
  });

  it('连撞 3 次 → 50000 + error 日志（随机源坏了要响亮，不静默循环）', async () => {
    const colliding = buildOrderNo(CLOCK, 'AAAAAA');
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                          fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('ord-existing', ${colliding}, 'u-1', 'created', 100, 100, 100,
              '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')
    `;
    const sink = new MemorySink();
    try {
      await withTransaction(db, (tx) => createOrder(tx, deps(seqIdGen(['AAAAAA']), sink), INPUT));
      expect.unreachable('应当抛 50000');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(50000);
    }
    expect(sink.find('order_no_collision_retry')).toHaveLength(ORDER_NO_MAX_ATTEMPTS - 1);
    expect(sink.find('order_no_collision_exhausted')).toHaveLength(1);
    // 整单回滚：库存一粒都没扣
    const p = await db`select stock from products where id = 'p-knife'`;
    expect(Number(p[0]?.['stock'])).toBe(5);
  });
});

describe('关单释放库存（建单扣 → 到点关 → 回，端到端）', () => {
  it('建单扣 2 → markOrderExpired + restoreStockForOrder → 回到 5；重复释放被状态守卫挡住', async () => {
    const sink = new MemorySink();
    const created = await withTransaction(db, (tx) =>
      createOrder(tx, deps(seqIdGen(['CCCCCC']), sink), INPUT),
    );
    const afterCreate = await db`select stock from products where id = 'p-knife'`;
    expect(Number(afterCreate[0]?.['stock'])).toBe(3);

    await withTransaction(db, async (tx) => {
      const marked = await markOrderExpired(tx, created.orderId, CLOCK.now());
      expect(marked).toBe(true);
      await restoreStockForOrder(tx, created.orderId);
    });
    const afterClose = await db`select stock from products where id = 'p-knife'`;
    expect(Number(afterClose[0]?.['stock'])).toBe(5);

    // 第二次 mark 返回 false（状态守卫）→ 调用方不会释放 → 库存不双倍回血
    await withTransaction(db, async (tx) => {
      const again = await markOrderExpired(tx, created.orderId, CLOCK.now());
      expect(again).toBe(false);
    });
    const final = await db`select stock from products where id = 'p-knife'`;
    expect(Number(final[0]?.['stock'])).toBe(5);
  });
});

describe('并发建单：相同商品、相反顺序（全量审计 P1：行锁顺序不确定 → 40P01 死锁 → 500）', () => {
  it('20 轮 AB / BA 交叉建单：零死锁，库存精确扣减', async () => {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values ('p-bowl', 'Rice Bowl', 'kitchen', 1200, 300, 100, 'JP', 'active')
    `;
    await db`update products set stock = 100 where id = 'p-knife'`;
    const sink = new MemorySink();
    let n = 0;
    const gen = (): IdGen => ({
      orderSeq: () => `S${String(n++).padStart(5, '0')}`.slice(0, 6),
      uuid: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
    });
    const ab = {
      ...INPUT,
      items: [
        { productId: 'p-knife', qty: 1 },
        { productId: 'p-bowl', qty: 1 },
      ],
    };
    // ⚠️ 两路用**不同的用户**（AJ-240）：建单现在先锁自己的 users 行，同一用户的建单是串行的——
    //    那样这条用例就再也制造不出"两笔建单同时抢商品行"的交错，死锁探针会变成假绿。
    //    真实的 AB / BA 交错本来就发生在不同买家之间。
    await db`insert into users (id, openid) values ('u-2', 'o-2')`;
    await db`
      insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country)
      values ('addr-2', 'u-2', 'John Roe', '+14155550124', '2 Infinite Loop', 'Cupertino', 'CA', '95014', 'US')
    `;
    const ba = {
      ...INPUT,
      userId: 'u-2',
      addressId: 'addr-2',
      items: [
        { productId: 'p-bowl', qty: 1 },
        { productId: 'p-knife', qty: 1 },
      ],
    };
    const results: PromiseSettledResult<unknown>[] = [];
    for (let round = 0; round < 20; round += 1) {
      results.push(
        ...(await Promise.allSettled([
          withTransaction(db, (tx) => createOrder(tx, deps(gen(), sink), ab)),
          withTransaction(db, (tx) => createOrder(tx, deps(gen(), sink), ba)),
        ])),
      );
    }
    const failures = results.filter((r) => r.status === 'rejected');
    expect(
      failures,
      JSON.stringify(failures.map((f) => String((f as PromiseRejectedResult).reason))),
    ).toEqual([]);
    const stock =
      await db`select id, stock from products where id in ('p-knife', 'p-bowl') order by id`;
    expect(stock.map((r) => [r.id, Number(r.stock)])).toEqual([
      ['p-bowl', 60],
      ['p-knife', 60],
    ]);
  });
});

/**
 * A3（2026-09-29 全量审查）：建单已按 product_id 升序扣减，但**回补**侧不是——
 * 取消回补的锁序跟着 `order_items` 的插入序，批量关单还是"每单内有序、跨单串接"。
 * 两条路径的序不同 = AB / BA 互等 = PG 40P01（非 AppError → 50000）。
 *
 * ⚠️ 这里的三条断言各有分工，**互补而不是重复**：
 *   ① `stockRestorePlan` 返回升序 —— **确定性**守护，直接验 SQL 的 `order by … collate "C"`；
 *   ② 死锁探针 —— 端到端，但依赖时序交错，所以先用挡片把交错**逼出来**（见下）；
 *   ③ `domain/stock-lock.unit.test.ts` 里的源码断言 —— 挡住"整段实现被换掉"。
 *   只有①而没有②③时，"计划排对了但没人用它"不会被发现（注入验证时实锤过一次）。
 *
 * @why 探针里必须用**挡片**先占住序上最小的那一行：不挡的话，建单侧要先做完报价（~10ms）
 *      才去取第一把锁，而回补侧几乎立刻就跑完了——两侧从未真正交错，
 *      "20 轮零死锁"就变成一句什么都没验的话（第一版就栽在这里：注入旧实现后仍全绿）。
 */
describe('A3：回补与建单的取锁序必须一致', () => {
  /** 序上较小 / 较大的两个商品（命名与字母序一致，避免再犯"以为反序其实同序"的错）。 */
  const P_FIRST = 'p-a';
  const P_LAST = 'p-z';
  const ASC = {
    ...INPUT,
    items: [
      { productId: P_FIRST, qty: 1 },
      { productId: P_LAST, qty: 1 },
    ],
  };

  /**
   * 造一张待回补的单，行项目**按传入顺序**插入（顺序本身就是被测的东西）。
   * @why 不能用 `insert … select` 或先排序再插：`order_items` 的物理插入序决定旧实现
   *      （一条 `update … from order_items`）的锁获取顺序，用例要能把它摆成升序的反面。
   */
  async function seedRestockable(orderId: string, productIds: readonly string[]): Promise<void> {
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                          fx_snapshot, address_snapshot, terms_version, expires_at)
      values (${orderId}, ${`W-${orderId}`}, 'u-1', 'created', 100, 100, 100,
              '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
    for (const [i, pid] of productIds.entries()) {
      await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, declared_value_usd)
               values (${`oi-${orderId}-${String(i)}`}, ${orderId}, ${pid}, ${pid}, 1, 100, 100)`;
      await db`update products set stock = stock - 1 where id = ${pid}`;
    }
  }

  beforeEach(async () => {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values (${P_LAST}, 'Last Item', 'kitchen', 1200, 300, 100, 'JP', 'active')
    `;
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values (${P_FIRST}, 'First Item', 'kitchen', 1200, 300, 100, 'JP', 'active')
    `;
  });

  it(`① 回补计划按 product_id 升序返回（插入序是 [${P_LAST}, ${P_FIRST}]）`, async () => {
    await seedRestockable('o-plan', [P_LAST, P_FIRST]);
    const plan = await stockRestorePlan(db, ['o-plan']);
    expect(plan.map((r) => r.productId)).toEqual([P_FIRST, P_LAST]);
  });

  const deadlocksOf = (results: PromiseSettledResult<unknown>[]): string[] =>
    results
      .filter((r) => r.status === 'rejected')
      .map((r) => String((r as PromiseRejectedResult).reason))
      .filter((msg) => msg.includes('40P01') || msg.includes('deadlock'));

  /**
   * 挡片：用**独立连接**占住 `P_FIRST` 一小段时间，逼出两侧真正的持锁交错。
   * @why 用独立连接而不是主连接：`withTransaction` 从池里取连接，挡片必须占住
   *      一条不参与被测事务的连接，否则挡片自己会被卷进同一事务。
   */
  async function withBlocker<T>(body: () => Promise<T>): Promise<T> {
    const blocker = testDb();
    let releaseHeld: () => void = () => {};
    const held = new Promise<void>((r) => {
      releaseHeld = r;
    });
    const hold = blocker.begin(async (tx) => {
      await tx`select id from products where id = ${P_FIRST} for update`;
      releaseHeld();
      await new Promise((r) => setTimeout(r, 200));
    });
    await held;
    try {
      return await body();
    } finally {
      await hold;
      await blocker.end();
    }
  }

  it('② 取消回补（插入序 [z,a]）对建单（a→z）：挡片逼出交错后仍零 40P01', async () => {
    const sink = new MemorySink();
    let n = 0;
    const gen = (): IdGen => ({
      orderSeq: () => `S${String(n++).padStart(5, '0')}`.slice(0, 6),
      uuid: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
    });
    const logger = createLogger({ env: 'test', destination: sink });
    const orderId = 'o-cancel-race';
    // 插入序**故意**是 [z, a]：与建单侧的升序正好相反
    await seedRestockable(orderId, [P_LAST, P_FIRST]);

    await withBlocker(async () => {
      // 建单侧**先**启动（它先做完报价、先去排 P_FIRST 的锁），回补侧后启动
      const t1 = withTransaction(db, (tx) => createOrder(tx, deps(gen(), sink), ASC));
      await new Promise((r) => setTimeout(r, 100));
      const t2 = withTransaction(db, (tx) =>
        cancelOrder(tx, { clock: CLOCK, logger }, { orderId, userId: 'u-1' }),
      );
      await new Promise((r) => setTimeout(r, 100));
      const all = await Promise.allSettled([t1, t2]);
      expect(deadlocksOf(all), JSON.stringify(deadlocksOf(all))).toEqual([]);
    });
  });

  it('③ 批量回补（订单 id 反序传入）对建单（a→z）：挡片逼出交错后仍零 40P01', async () => {
    const sink = new MemorySink();
    let n = 0;
    const gen = (): IdGen => ({
      orderSeq: () => `S${String(n++).padStart(5, '0')}`.slice(0, 6),
      uuid: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
    });
    const x1 = 'o-x1-race'; // 只含 z
    const x2 = 'o-x2-race'; // 只含 a
    await seedRestockable(x1, [P_LAST]);
    await seedRestockable(x2, [P_FIRST]);

    await withBlocker(async () => {
      const t1 = withTransaction(db, (tx) => createOrder(tx, deps(gen(), sink), ASC));
      await new Promise((r) => setTimeout(r, 100));
      // 订单 id **反序**传入（含 a 的那张在前）：批量回补必须自己按 product_id 排成全局升序，
      // 不能依赖调用方给的顺序——否则总锁序是 z,a 的串接，而串接不是全序（A3 的根因）
      const t2 = withTransaction(db, (tx) => restoreStockForOrders(tx, [x2, x1]));
      await new Promise((r) => setTimeout(r, 100));
      const all = await Promise.allSettled([t1, t2]);
      expect(deadlocksOf(all), JSON.stringify(deadlocksOf(all))).toEqual([]);
    });
  });
});

/**
 * D-39：采购信息**快照**落库（迁移 021）。
 *
 * @why 这三条用例是"落快照而不是 JOIN `products`"这条决策的**唯一防线**：
 *      商品的 `purchase_source` 会换（换供应商 / 换采购渠道），`title_ja` 也会改。
 *      JOIN 看起来更简单（不用多存三列），但结果是**历史订单的采购渠道被悄悄改写**，
 *      且没有任何一方报错——采购员照着清单去找的却是新渠道，货不对板要等收货才发现。
 *      换句话说：JOIN 与快照在"今天下的单"上行为完全一致，**只有历史单能区分它们**，
 *      所以用例必须"下单 → 改商品 → 回看订单行"，只验落库值等于商品当前值的话，
 *      换成 JOIN 也一样绿（这正是本 describe 存在的理由）。
 *
 * @see migrations/021_order_item_purchase_snapshot.sql（文件头写了落快照的 @why）；
 *      adapters/orders.ts `OrderItemInsertRow`（三列是**必填键**，逼调用方区分
 *      "忘了传"与"确实没有"）；技术文档 §2.7（待采购清单）
 */
describe('D-39：采购信息快照落 order_items', () => {
  /** 建一张单（用 p-knife，qty=1）。 */
  async function createOne(seq: string) {
    const sink = new MemorySink();
    return withTransaction(db, (tx) => createOrder(tx, deps(seqIdGen([seq]), sink), INPUT));
  }

  /** 读回该单唯一一条 order_items 的采购三列 + 标题快照。 */
  async function rowOf(orderId: string) {
    const rows = await db`
      select title_snapshot, title_ja, jan_code, purchase_source
        from order_items where order_id = ${orderId}
    `;
    expect(rows).toHaveLength(1);
    return rows[0] as Record<string, unknown>;
  }

  it('商品三列都有值 → 原样落进 order_items', async () => {
    await db`
      update products
         set title_ja = 'シェフナイフ', jan_code = '4900000000001', purchase_source = 'Amazon JP'
       where id = 'p-knife'
    `;
    const created = await createOne('SNAP01');
    const row = await rowOf(created.orderId);
    // title_snapshot 存的是**中文展示名**，与 title_ja 是两列两回事
    expect(row['title_snapshot']).toBe('Chef Knife');
    expect(row['title_ja']).toBe('シェフナイフ');
    expect(row['jan_code']).toBe('4900000000001');
    expect(row['purchase_source']).toBe('Amazon JP');
  });

  it('商品三列都是 NULL（还没录采购信息）→ 落 NULL，不落空串', async () => {
    // beforeEach 的商品没填这三列 → 三列都是 NULL
    const created = await createOne('SNAP02');
    const row = await rowOf(created.orderId);
    // ⚠️ 断言 `toBeNull()` 而不是 `toBeFalsy()`：'' 也是 falsy，
    //    那样"落空串"这个缺陷会悄悄通过，而空串在管理端展示层就是"有一条但看不见"
    expect(row['title_ja']).toBeNull();
    expect(row['jan_code']).toBeNull();
    expect(row['purchase_source']).toBeNull();
  });

  it('立身之本：下单后改商品的采购来源 / 日文名 → 订单行一字不动', async () => {
    await db`
      update products
         set title_ja = 'シェフナイフ', jan_code = '4900000000001', purchase_source = 'Amazon JP'
       where id = 'p-knife'
    `;
    const created = await createOne('SNAP03');
    const before = await rowOf(created.orderId);
    expect(before['purchase_source']).toBe('Amazon JP');

    // 换供应商、改日文名、补 JAN —— 商品侧的"当前值"整体变了
    await db`
      update products
         set title_ja = 'コックナイフ', jan_code = '4900000000002', purchase_source = '楽天市場'
       where id = 'p-knife'
    `;
    const after = await rowOf(created.orderId);
    expect(after).toEqual(before);
    expect(after['purchase_source']).toBe('Amazon JP');
    expect(after['title_ja']).toBe('シェフナイフ');
  });

  /**
   * 剩余清单 1-3（B4 / B5）：成本价、HS 码、英文报关品名同样落快照。
   * @why 成本价改了，历史单的毛利就被悄悄重算；HS 码 / 报关品名改了，
   *      已发出包裹的报关资料与面单对不上——两者都只有"下单 → 改商品 → 回看"能抓到。
   */
  it('成本价 / HS 码 / 英文报关品名：下单落快照，之后改商品不影响订单行', async () => {
    await db`
      update products set cost_jpy = 4200, hs_code = '8211.91', customs_desc_en = 'Kitchen knife, stainless steel'
       where id = 'p-knife'
    `;
    const created = await createOne('SNAP04');
    const snap = async () =>
      (
        await db`select cost_jpy, hs_code, customs_desc_en from order_items where order_id = ${created.orderId}`
      )[0] as Record<string, unknown>;
    // @measured: 本库 postgres.js 连接把 BIGINT 读成 number（首跑断言 '4200' 失败，Received 4200）
    expect(await snap()).toEqual({
      cost_jpy: 4200,
      hs_code: '8211.91',
      customs_desc_en: 'Kitchen knife, stainless steel',
    });
    await db`
      update products set cost_jpy = 5000, hs_code = '8211.92', customs_desc_en = 'Chef knife'
       where id = 'p-knife'
    `;
    expect((await snap())['cost_jpy']).toBe(4200);
    expect((await snap())['hs_code']).toBe('8211.91');
  });
});

/**
 * 建单要复核收货地址的国家仍然开放（M-04）。
 * @why 国家只在保存地址时校验过一次；运营下线某国后，旧地址照样能下单、能付款，
 *      而关税与展示币按"唯一开放的国家"取——收款口径与收货国家对不上，只能人工退款。
 */
describe('M-04：收货国家已下线 / 不存在 → 拒单', () => {
  it('🔴 地址国家的档案已下线 → 40002（field=country），不扣库存、不建单', async () => {
    await db`
      insert into country_profiles (code, active, display_currencies, address_template, phone_pattern, postal_pattern, duty_note)
      select 'CA', false, display_currencies, address_template, phone_pattern, postal_pattern, duty_note
        from country_profiles where code = 'US'
      on conflict (code) do update set active = false
    `;
    try {
      await db`update addresses set country = 'CA' where id = 'addr-1'`;
      const err = await withTransaction(db, (tx) =>
        createOrder(tx, deps(seqIdGen(['AAAAAA']), new MemorySink()), INPUT),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(40002);
      expect(
        Number((await db`select stock from products where id = 'p-knife'`)[0]?.['stock']),
      ).toBe(5);
      expect(await db`select 1 from orders`).toHaveLength(0);
    } finally {
      // country_profiles 是配置表，resetTestDb 不清它：自己造的必须自己删
      await db`delete from country_profiles where code = 'CA'`;
    }
  });

  it('🔴 地址国家根本没有档案 → 40002', async () => {
    await db`update addresses set country = 'ZZ' where id = 'addr-1'`;
    const err = await withTransaction(db, (tx) =>
      createOrder(tx, deps(seqIdGen(['AAAAAA']), new MemorySink()), INPUT),
    ).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(40002);
  });
});

/**
 * 关税无法估算时，订单存"空"而不是 0（W-05）。
 * @why 报价阶段 duty_jpy=null（前端据此不显示关税行），建单却存成 0，订单详情于是显示"预估关税 0 円"——
 *      同一张单，结算时说不知道关税，详情里却说关税是 0。
 */
describe('W-05：无法估算的关税存 null', () => {
  it('🔴 没有 (JP, US) 关税率行 → orders.duty_jpy 为 null', async () => {
    const saved =
      await db`select origin_country, dest_country, rate, note from duty_rates where origin_country = 'JP' and dest_country = 'US'`;
    await db`delete from duty_rates where origin_country = 'JP' and dest_country = 'US'`;
    try {
      const created = await withTransaction(db, (tx) =>
        createOrder(tx, deps(seqIdGen(['AAAAAA']), new MemorySink()), INPUT),
      );
      const [row] = await db`select duty_jpy from orders where id = ${created.orderId}`;
      expect(row?.['duty_jpy']).toBeNull();
    } finally {
      // duty_rates 是配置表，resetTestDb 不清它：删掉的必须原样放回
      for (const r of saved) {
        await db`insert into duty_rates (origin_country, dest_country, rate, note)
                 values (${r['origin_country']}, ${r['dest_country']}, ${r['rate']}, ${r['note']})`;
      }
    }
  });
});
