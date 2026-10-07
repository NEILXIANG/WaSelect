/**
 * 职责：`adapters/orders.ts` 的真库用例（I1-U2，L1 层）——关单扫描的**边界、状态过滤、
 *      限量、行锁竞争**四个语义钉在真库上。
 *
 * @why 这批用例必须在真库：`FOR UPDATE SKIP LOCKED` 的"跳过"语义、`expires_at <= now` 的
 *      边界（含等号）、部分状态下的扫描过滤，没有一条能在假存储上验——而它们错任何一种，
 *      表现都是"某张真实的单被错误地关掉"或"该关的单永远不关"，不报错。
 *
 * @why 边界判定（含等号）单独成组：这是与 mark-paid 守卫**共享的语义**（可支付窗口
 *      `[created, expires_at)`），方向错一毫秒，"恰在到点瞬间付款"的单就会两边说法不一。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  decrementStock,
  insertOrderItems,
  lockExpiredPayableOrders,
  markOrderExpired,
} from './orders.js';
import {
  findInitiatedPayment,
  findLatestPaymentSummary,
  findOwnedOrder,
  findPayLinkTarget,
  listOrderItemsWithImage,
  listOrderTimeline,
  listOwnedOrders,
  lockOwnedOrderForCancel,
  lockOwnedOrderForPay,
  markOrderCancelled,
  markOrderPendingPayment,
  setPayTokenHash,
  voidInitiatedPayment,
} from './orders.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-exp', 'o-exp')`;
});

/** 造一张单：默认 created + 已到点。 */
async function seedOrder(
  id: string,
  over: { status?: string; expiresAt?: Date } = {},
): Promise<void> {
  const status = over.status ?? 'created';
  const expiresAt = over.expiresAt ?? new Date(NOW.getTime() - 1_000);
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, 'u-exp', ${status}, 1000, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', ${expiresAt})
  `;
}

describe('lockExpiredPayableOrders：状态过滤', () => {
  it('只取 created / pending_payment：paid / expired / cancelled 即使到点也不取', async () => {
    await seedOrder('o-created');
    await seedOrder('o-pending', { status: 'pending_payment' });
    await seedOrder('o-paid', { status: 'paid' });
    await seedOrder('o-expired', { status: 'expired' });
    await seedOrder('o-cancelled', { status: 'cancelled' });
    const ids = await lockExpiredPayableOrders(db, NOW, 100);
    expect(ids.sort()).toEqual(['o-created', 'o-pending']);
  });

  it('未到点的可支付单不取', async () => {
    await seedOrder('o-future', { expiresAt: new Date(NOW.getTime() + 60_000) });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual([]);
  });
});

describe('lockExpiredPayableOrders：边界（与 mark-paid 守卫共享语义）', () => {
  it('expires_at 恰好等于基准时刻 → 已到点（可支付窗口是 [created, expires_at)）', async () => {
    await seedOrder('o-edge', { expiresAt: NOW });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual(['o-edge']);
  });

  it('expires_at 晚基准 1ms → 未到点', async () => {
    await seedOrder('o-edge', { expiresAt: new Date(NOW.getTime() + 1) });
    expect(await lockExpiredPayableOrders(db, NOW, 100)).toEqual([]);
  });
});

describe('lockExpiredPayableOrders：限量与顺序', () => {
  it('超量时按 expires_at 升序取最老的，剩余的留给下一轮', async () => {
    await seedOrder('o-1', { expiresAt: new Date(NOW.getTime() - 3_000) });
    await seedOrder('o-2', { expiresAt: new Date(NOW.getTime() - 1_000) });
    await seedOrder('o-3', { expiresAt: new Date(NOW.getTime() - 2_000) });
    const ids = await lockExpiredPayableOrders(db, NOW, 2);
    expect(ids).toEqual(['o-1', 'o-3']);
  });
});

describe('lockExpiredPayableOrders：SKIP LOCKED', () => {
  it('行锁被别人持有的单**跳过而不是等锁**（关单不能被一笔落账拖住整批）', async () => {
    await seedOrder('o-locked');
    await seedOrder('o-free');
    const other = testDb();
    try {
      // ⚠️ 用**信号**等"锁已被持有"，不要 sleep 一个固定时长：
      //      `other.begin` 要先建连接再发 SQL，那段耗时在覆盖率跑（进程更慢、worker 更多）时
      //      会超过固定 sleep —— 实测 gate 的 cov 一轮因此挂过一次（拿到 ['o-locked','o-free']）。
      //      sleep 只是"大概率够"，信号才是"必然够"（§2 第 44 条）。
      let acquired: () => void = () => undefined;
      const locked = new Promise<void>((r) => {
        acquired = r;
      });
      // 外部事务持有 o-locked 的行锁（不提交）
      const holder = other.begin(async (tx) => {
        await tx`select id from orders where id = 'o-locked' for update`;
        acquired();
        await new Promise((r) => setTimeout(r, 300));
      });
      await locked;
      const ids = await lockExpiredPayableOrders(db, NOW, 100);
      expect(ids).toEqual(['o-free']);
      await holder;
    } finally {
      await closeDb(other);
    }
  });
});

describe('markOrderExpired', () => {
  it('关单 + 写审计事件（actor=system，时刻取传入基准而不是 DB now()）', async () => {
    await seedOrder('o-1');
    const ok = await markOrderExpired(db, 'o-1', NOW);
    expect(ok).toBe(true);
    const rows = await db`select status from orders where id = 'o-1'`;
    expect(rows[0]?.status).toBe('expired');
    const evs = await db`select status, actor, at from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(1);
    expect(evs[0]?.status).toBe('expired');
    expect(evs[0]?.actor).toBe('system');
    expect((evs[0]?.at as Date).toISOString()).toBe(NOW.toISOString());
  });

  it('状态已被迁走（如已 paid）→ 返回 false 且不写事件（不是错误，防幽灵关单）', async () => {
    await seedOrder('o-1', { status: 'paid' });
    const ok = await markOrderExpired(db, 'o-1', NOW);
    expect(ok).toBe(false);
    const evs = await db`select 1 from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(0);
  });

  it('重复关单：第二次返回 false、事件不翻倍（幂等）', async () => {
    await seedOrder('o-1');
    expect(await markOrderExpired(db, 'o-1', NOW)).toBe(true);
    expect(await markOrderExpired(db, 'o-1', NOW)).toBe(false);
    const evs = await db`select 1 from order_events where order_id = 'o-1'`;
    expect(evs).toHaveLength(1);
  });
});

describe('decrementStock（U5b：原子扣减的唯一正确形态）', () => {
  beforeEach(async () => {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values ('p-stock', 'Stock Item', 'kitchen', 1000, 100, 5, 'JP', 'active')
    `;
  });

  it('恰好扣到 0 放行；扣 6 → false 且库存不变（判定+扣减在同一语句里）', async () => {
    expect(await decrementStock(db, 'p-stock', 5)).toBe(true);
    let r = await db`select stock from products where id = 'p-stock'`;
    expect(Number(r[0]?.['stock'])).toBe(0);

    expect(await decrementStock(db, 'p-stock', 6)).toBe(false);
    r = await db`select stock from products where id = 'p-stock'`;
    expect(Number(r[0]?.['stock'])).toBe(0);

    expect(await decrementStock(db, 'p-stock', 1)).toBe(false); // 0 件也不能再扣
  });

  /**
   * 工程缺口第二轮复核（建单 TOCTOU）：建单先不加锁读商品快照，中间算报价（运费 / 汇率 / 关税），
   * 再扣库存。READ COMMITTED 下这段时间里运营把商品下架并提交，扣减照样成功 ⇒ 已下架（可能是合规停售）
   * 的商品落成订单、进待采购清单。条件更新里带上 status，判定与扣减仍在同一语句。
   */
  it('🔴 商品已下架 → false 且库存不变（扣减与上架判定在同一语句里）', async () => {
    await db`update products set status = 'offline' where id = 'p-stock'`;
    expect(await decrementStock(db, 'p-stock', 1)).toBe(false);
    const r = await db`select stock from products where id = 'p-stock'`;
    expect(Number(r[0]?.['stock'])).toBe(5);
  });
});

// ── I1-U5c：查询 / 取消 ─────────────────────────────────────────────────────

/** 造一张带全字段的单（查询/取消用；归属与状态可配）。 */
async function seedFullOrder(
  id: string,
  over: { user?: string; status?: string; createdAt?: Date; fx?: Record<string, number> } = {},
): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, contact_email,
                        terms_version, expires_at, created_at)
    values (${id}, ${`W-${id}`}, ${over.user ?? 'u-exp'}, ${over.status ?? 'created'},
            1000, 200, 150, 1200, 500,
            ${db.json(over.fx ?? { USD: 0.0066 })},
            ${db.json({ recipient: 'Taro', phone: '+12025550123', line1: '1 Main St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' })},
            't@example.com', 'TOS-1', ${NOW}, ${over.createdAt ?? NOW})
  `;
}

describe('listOwnedOrders（U5c：归属过滤进 WHERE，不拉回内存再滤）', () => {
  beforeEach(async () => {
    await db`insert into users (id, openid) values ('u-other', 'o-other')`;
  });

  it('只列本人的单，按 created_at 倒序（最新的在前）', async () => {
    await seedFullOrder('o-old', { createdAt: new Date(NOW.getTime() - 3_000) });
    await seedFullOrder('o-new', { createdAt: new Date(NOW.getTime() - 1_000) });
    await seedFullOrder('o-other', { user: 'u-other', createdAt: new Date(NOW.getTime() - 2_000) });
    const rows = await listOwnedOrders(db, 'u-exp');
    expect(rows.map((r) => r.id)).toEqual(['o-new', 'o-old']);
  });

  it('status 过滤只留匹配态；非法值在路由层已 40001（仓储不重复校验）', async () => {
    await seedFullOrder('o-created');
    await seedFullOrder('o-paid', { status: 'paid' });
    const rows = await listOwnedOrders(db, 'u-exp', 'paid');
    expect(rows.map((r) => r.id)).toEqual(['o-paid']);
  });

  it('fx_snapshot 读出为普通对象（db.json 单重编码写入 → 驱动解析直出；jsonbValue 兜旧行）', async () => {
    await seedFullOrder('o-fx');
    const rows = await listOwnedOrders(db, 'u-exp');
    const fx = rows[0]?.fx_snapshot;
    expect(typeof fx).toBe('object');
    expect((fx as Record<string, number>)['USD']).toBeCloseTo(0.0066);
  });
});

describe('findOwnedOrder / lockOwnedOrderForCancel（归属判定：非本人与不存在同 null）', () => {
  beforeEach(async () => {
    await db`insert into users (id, openid) values ('u-other', 'o-other')`;
    await seedFullOrder('o-mine');
    await seedFullOrder('o-theirs', { user: 'u-other' });
  });

  it('本人 → 全字段行（address_snapshot 也是普通对象）；他人与不存在 → null', async () => {
    const mine = await findOwnedOrder(db, 'o-mine', 'u-exp');
    expect(mine?.id).toBe('o-mine');
    expect(mine?.contact_email).toBe('t@example.com');
    expect((mine?.address_snapshot as Record<string, unknown>)['recipient']).toBe('Taro');
    expect(await findOwnedOrder(db, 'o-theirs', 'u-exp')).toBeNull();
    expect(await findOwnedOrder(db, 'o-ghost', 'u-exp')).toBeNull();
  });

  it('lock 版返回 {id,status} 并持行锁（取消路径的第一步）', async () => {
    const locked = await lockOwnedOrderForCancel(db, 'o-mine', 'u-exp');
    expect(locked).toEqual({ id: 'o-mine', status: 'created' });
    expect(await lockOwnedOrderForCancel(db, 'o-theirs', 'u-exp')).toBeNull();
  });
});

describe('listOrderItemsWithImage / listOrderTimeline / findLatestPaymentSummary', () => {
  beforeEach(async () => {
    await seedFullOrder('o-det');
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, images)
      values ('p-det', 'Detail Item', 'kitchen', 1000, 100, 5, 'JP', 'offline',
              ${db.json(['https://img.example.com/a.jpg'])})
    `;
    await db`
      insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
      values ('oi-1', 'o-det', 'p-det', 'Detail Item', 2, 1000, 100, 1320)
    `;
  });

  /**
   * 工程缺口第二轮复核：行 id 是 `oi-<uuid v4>`，原先三处读取都按 id 排序 = **随机顺序**——
   * 买家按 A、B、C 下单，详情 / 管理端 / 待采购 / 报关 CSV 里的行序每张单各不相同。
   * 迁移 029 加 `line_no`（下单顺序），读取按它排。
   */
  it('🔴 行按下单顺序返回，而不是按（随机的）行 id 排', async () => {
    await db`delete from order_items where order_id = 'o-det'`;
    const row = (id: string, title: string) => ({
      id,
      order_id: 'o-det',
      product_id: 'p-det',
      title_snapshot: title,
      qty: 1,
      unit_price_jpy: 1000,
      weight_g: 100,
      declared_value_usd: 7,
      title_ja: null,
      jan_code: null,
      purchase_source: null,
      cost_jpy: null,
      hs_code: null,
      customs_desc_en: null,
    });
    await insertOrderItems(db, [row('oi-zzz', 'A'), row('oi-mmm', 'B'), row('oi-aaa', 'C')]);
    const items = await listOrderItemsWithImage(db, 'o-det');
    expect(items.map((i) => i.title_snapshot)).toEqual(['A', 'B', 'C']);
  });

  it('items 带出 products.images——商品已下架（offline）也照出：历史订单看的是下单时的事实', async () => {
    const items = await listOrderItemsWithImage(db, 'o-det');
    expect(items).toHaveLength(1);
    expect(items[0]?.title_snapshot).toBe('Detail Item');
    expect(items[0]?.qty).toBe(2);
    expect(items[0]?.images).toEqual(['https://img.example.com/a.jpg']);
  });

  it('timeline 按 at 升序（取消链路的展示顺序）', async () => {
    await db`insert into order_events (order_id, status, actor, at) values
      ('o-det', 'created', 'user:u-exp', ${new Date(NOW.getTime() - 2_000)}),
      ('o-det', 'cancelled', 'user:u-exp', ${new Date(NOW.getTime() - 1_000)})`;
    const tl = await listOrderTimeline(db, 'o-det');
    expect(tl.map((t) => t.status)).toEqual(['created', 'cancelled']);
  });

  it('买家时间线只含订单状态值：改址 / 拒付 / 退款失败这类管理事件不外泄（一致性审计 C2，AJ-176）', async () => {
    await db`insert into order_events (order_id, status, note, actor, at) values
      ('o-det', 'created', null, 'user:u-exp', ${new Date(NOW.getTime() - 5_000)}),
      ('o-det', 'paid', null, 'provider:mock', ${new Date(NOW.getTime() - 4_000)}),
      ('o-det', 'address_changed', '管理员改址', 'admin:u-admin', ${new Date(NOW.getTime() - 3_000)}),
      ('o-det', 'dispute_opened', 'dp_1', 'provider:stripe', ${new Date(NOW.getTime() - 2_000)}),
      ('o-det', 'refund_failed', 'provider_error', 'admin:u-admin', ${new Date(NOW.getTime() - 1_000)})`;
    const tl = await listOrderTimeline(db, 'o-det');
    expect(tl.map((t) => t.status)).toEqual(['created', 'paid']);
  });

  it('payment 取 created_at 最新一条（换通道重发后旧的不该盖新的）；无支付行 → null', async () => {
    expect(await findLatestPaymentSummary(db, 'o-det')).toBeNull();
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount, created_at)
      values ('pay-old', 'o-det', 'mock', 'cancelled', 'JPY', 1200, ${new Date(NOW.getTime() - 2_000)}),
             ('pay-new', 'o-det', 'stripe', 'initiated', 'USD', 800, ${new Date(NOW.getTime() - 1_000)})`;
    const p = await findLatestPaymentSummary(db, 'o-det');
    expect(p?.provider).toBe('stripe');
    expect(p?.charge_amount).toBe(800);
  });

  /**
   * 工程缺口第二轮复核：`payments.created_at` 默认 `now()` = **事务开始**时刻。并发换通道时，
   * 先开事务、后拿到锁的那一方插入的新行 created_at 反而**更早**；它作废的旧行时间更晚 ⇒
   * 只按 created_at 取，买家详情显示的是已作废那笔（币种金额都不对），付款成功后仍是。
   */
  it('🔴 已作废行的 created_at 更晚（并发换通道）→ 仍取未作废的那一行', async () => {
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount, created_at)
      values ('pay-live', 'o-det', 'stripe', 'succeeded', 'USD', 800, ${new Date(NOW.getTime() - 2_000)}),
             ('pay-void', 'o-det', 'mock', 'cancelled', 'JPY', 1200, ${new Date(NOW.getTime() - 1_000)})`;
    const p = await findLatestPaymentSummary(db, 'o-det');
    expect(p?.provider).toBe('stripe');
    expect(p?.status).toBe('succeeded');
  });
});

describe('markOrderCancelled + voidInitiatedPayment（守卫 = 释放库存的排他凭证）', () => {
  beforeEach(async () => {
    await db`insert into users (id, openid) values ('u-other', 'o-other')`;
  });

  it('created / pending_payment → true + cancelled_at + order_events 行', async () => {
    await seedFullOrder('o-c1');
    await seedFullOrder('o-c2', { status: 'pending_payment' });
    expect(await markOrderCancelled(db, 'o-c1', 'u-exp', NOW, 'user:u-exp')).toBe(true);
    expect(await markOrderCancelled(db, 'o-c2', 'u-exp', NOW, 'user:u-exp')).toBe(true);
    const r = await db`select status, cancelled_at from orders where id = 'o-c1'`;
    expect(r[0]?.['status']).toBe('cancelled');
    expect(r[0]?.['cancelled_at']).not.toBeNull();
    const ev = await db`select status, actor from order_events where order_id = 'o-c1'`;
    expect(ev[0]?.['status']).toBe('cancelled');
  });

  it('paid / 他人 / 不存在 → false（0 行命中不是错误，调用方判 40400/40902）', async () => {
    await seedFullOrder('o-paid', { status: 'paid' });
    await seedFullOrder('o-theirs', { user: 'u-other' });
    expect(await markOrderCancelled(db, 'o-paid', 'u-exp', NOW, 'user:u-exp')).toBe(false);
    expect(await markOrderCancelled(db, 'o-theirs', 'u-exp', NOW, 'user:u-exp')).toBe(false);
    expect(await markOrderCancelled(db, 'o-ghost', 'u-exp', NOW, 'user:u-exp')).toBe(false);
  });

  it('voidInitiatedPayment：initiated → cancelled（返回 1）；succeeded 不动（返回 0）', async () => {
    await seedFullOrder('o-v1');
    await seedFullOrder('o-v2');
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
      values ('pay-i', 'o-v1', 'mock', 'initiated', 'JPY', 1200),
             ('pay-s', 'o-v2', 'mock', 'succeeded', 'JPY', 1200)`;
    expect(await voidInitiatedPayment(db, 'o-v1')).toBe(1);
    expect(await voidInitiatedPayment(db, 'o-v2')).toBe(0);
    const r1 = await db`select status from payments where id = 'pay-i'`;
    const r2 = await db`select status from payments where id = 'pay-s'`;
    expect(r1[0]?.['status']).toBe('cancelled');
    expect(r2[0]?.['status']).toBe('succeeded');
  });
});

// ── I1-U6a：支付意图 / 短链 ──────────────────────────────────────────────────

describe('lockOwnedOrderForPay（发起支付的第一步：持锁读全所需字段）', () => {
  beforeEach(async () => {
    await db`insert into users (id, openid) values ('u-other', 'o-other')`;
    await seedFullOrder('o-pay');
    await seedFullOrder('o-pay-theirs', { user: 'u-other' });
  });

  it('本人 → order_no/status/total/expires_at/快照/目的国（从 address_snapshot jsonb 提取）；他人与不存在 → null', async () => {
    const row = await lockOwnedOrderForPay(db, 'o-pay', 'u-exp');
    expect(row?.order_no).toBe('W-o-pay');
    expect(row?.status).toBe('created');
    expect(row?.total_jpy).toBe(1200);
    expect(row?.dest_country).toBe('US');
    expect((row?.fx_snapshot as Record<string, number>)['USD']).toBeCloseTo(0.0066);
    expect(await lockOwnedOrderForPay(db, 'o-pay-theirs', 'u-exp')).toBeNull();
    expect(await lockOwnedOrderForPay(db, 'o-ghost', 'u-exp')).toBeNull();
  });
});

describe('findInitiatedPayment（在途支付意图至多一条：部分唯一索引保证）', () => {
  beforeEach(async () => {
    await seedFullOrder('o-ip');
  });

  it('initiated 行返回全字段；cancelled/succeeded 不取；无行 → null', async () => {
    expect(await findInitiatedPayment(db, 'o-ip')).toBeNull();
    await db`insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
      values ('pay-i1', 'o-ip', 'stripe', 'cs_123', 'initiated', 'USD', 800, 'https://checkout.stripe.com/c/pay/cs_123')`;
    const row = await findInitiatedPayment(db, 'o-ip');
    expect(row).toMatchObject({
      id: 'pay-i1',
      provider: 'stripe',
      provider_ref: 'cs_123',
      charge_currency: 'USD',
      charge_amount: 800,
      pay_url: 'https://checkout.stripe.com/c/pay/cs_123',
    });
    await db`update payments set status = 'cancelled' where id = 'pay-i1'`;
    expect(await findInitiatedPayment(db, 'o-ip')).toBeNull();
  });
});

describe('markOrderPendingPayment（首次发起才迁移+记事件；重复发起不重复记）', () => {
  it('created → true + order_events；pending_payment / paid → false 且无事件', async () => {
    await seedFullOrder('o-pp');
    expect(await markOrderPendingPayment(db, 'o-pp', NOW, 'user:u-exp')).toBe(true);
    const r = await db`select status from orders where id = 'o-pp'`;
    expect(r[0]?.['status']).toBe('pending_payment');
    const ev = await db`select status, actor from order_events where order_id = 'o-pp'`;
    expect(ev.map((e) => e['status'])).toEqual(['pending_payment']);
    // actor 口径 `user:<id>`（一致性审计 C3，AJ-176；与建单 / 取消两处同形）
    expect(ev[0]?.['actor']).toBe('user:u-exp');

    // 第二次（换通道重新发起 / 同通道复用）：不迁移、不重复记事件
    expect(await markOrderPendingPayment(db, 'o-pp', NOW, 'user:u-exp')).toBe(false);
    const ev2 = await db`select status from order_events where order_id = 'o-pp'`;
    expect(ev2).toHaveLength(1);

    await seedFullOrder('o-pp-paid', { status: 'paid' });
    expect(await markOrderPendingPayment(db, 'o-pp-paid', NOW, 'user:u-exp')).toBe(false);
  });
});

describe('setPayTokenHash + findPayLinkTarget（D-49 短链的两端）', () => {
  it('hash 落库；findPayLinkTarget 联出 status/hash/initiated 的 pay_url（无支付行 → pay_url null）', async () => {
    await seedFullOrder('o-link', { status: 'pending_payment' });
    await setPayTokenHash(db, 'o-link', 'a'.repeat(64));
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount, pay_url)
      values ('pay-l1', 'o-link', 'stripe', 'initiated', 'USD', 800, 'https://checkout.stripe.com/c/pay/cs_x')`;

    const hit = await findPayLinkTarget(db, 'o-link');
    expect(hit).toMatchObject({
      status: 'pending_payment',
      pay_token_hash: 'a'.repeat(64),
      pay_url: 'https://checkout.stripe.com/c/pay/cs_x',
    });
    // expires_at 必须带出（短链落地的「到点未扫」判定全靠它——漏了这个字段，
    // 过期但未被关单 job 扫到的订单链接会继续跳转到机构页）
    expect(hit?.expires_at).toBeInstanceOf(Date);

    await seedFullOrder('o-link-nopay');
    const noPay = await findPayLinkTarget(db, 'o-link-nopay');
    expect(noPay?.pay_url).toBeNull();
    expect(await findPayLinkTarget(db, 'o-ghost')).toBeNull();
  });
});

/**
 * 有在途支付的单晚一点再关（M-01）：给"窗口内付款、通知晚到"的回调留出落账时间。
 * @why 关单作业到点就关、回补库存；窗口最后几秒付的款，通知晚几秒到就会撞上"已关单 → 迟到付款"，
 *      钱扣了、单关了、库存可能被别人买走，只能人工退款。
 */
describe('lockExpiredPayableOrders：在途支付的宽限（M-01）', () => {
  const GRACE = 300_000;
  async function seedInitiated(orderId: string): Promise<void> {
    await db`insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
             values (${`pay-${orderId}`}, ${orderId}, 'stripe', ${`cs_test_${orderId}`}, 'initiated', 'USD', 700)`;
  }

  it('🔴 到点 1 秒、有 initiated 支付行 → 本轮不关', async () => {
    await seedOrder('o-pay', { status: 'pending_payment' });
    await seedInitiated('o-pay');
    expect(await lockExpiredPayableOrders(db, NOW, 100, GRACE)).toEqual([]);
  });

  it('过了宽限期 → 关', async () => {
    await seedOrder('o-pay2', {
      status: 'pending_payment',
      expiresAt: new Date(NOW.getTime() - GRACE - 1_000),
    });
    await seedInitiated('o-pay2');
    expect(await lockExpiredPayableOrders(db, NOW, 100, GRACE)).toEqual(['o-pay2']);
  });

  it('没有在途支付的单不受影响：到点即关', async () => {
    await seedOrder('o-nopay');
    expect(await lockExpiredPayableOrders(db, NOW, 100, GRACE)).toEqual(['o-nopay']);
  });
});
