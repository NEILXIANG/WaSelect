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
    const ba = {
      ...INPUT,
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
