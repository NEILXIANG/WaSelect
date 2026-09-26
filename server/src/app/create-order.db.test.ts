/**
 * 职责：建单核心的**可注入路径**真库用例（I1-U5b）——D32 单号冲突重试与关单释放库存。
 *
 * @why D32 只能在核心层测：撞号序列要靠**可控的 IdGen**（第一次撞、第二次成），
 *      而 mountAllRoutes 装配的是 systemIdGen——核心函数可注入正是为了这个用例存在
 *      （"单号冲突重试"除了靠运气撞上一次之外永远测不到，skeleton.ts 的既定教训）。
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
import { markOrderExpired, restoreStockForOrder } from '../adapters/orders.js';
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
