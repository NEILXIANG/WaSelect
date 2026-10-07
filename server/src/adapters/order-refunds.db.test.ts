/**
 * 职责：`order_refunds`（迁移 030，AJ-383 部分退款）的**库层不变量**。
 *
 * @why 部分退款的"不超退"最终靠应用层的锁内求和（见 adapters/order-refunds.ts），
 *      但金额为正、状态在域内、同一订单同一机构单号不重复登记——这些是"写坏一行就是钱的事故"的形态，
 *      库层再钉一道，应用层改坏了也落不进库。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  insertPartialRefund,
  listPartialRefunds,
  settlePartialRefund,
  sumPartialRefunds,
} from './order-refunds.js';

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
  await db`insert into users (id, openid) values ('u-r', 'o-r')`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values ('o-r', 'W-R', 'u-r', 'paid', 10000, 2000, 1500, 12000, 900,
            ${db.json({ USD: 0.0066 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() + interval '30 minutes')
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values ('pay-r', 'o-r', 'stripe', 'cs_test_r', 'succeeded', 'USD', 8160)
  `;
});

async function insertRefund(over: Record<string, unknown> = {}): Promise<void> {
  const r = {
    id: 'rf-1',
    amount_minor: 1000,
    status: 'initiated',
    provider_ref: null as string | null,
    ...over,
  };
  await db`
    insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, provider_ref, actor)
    values (${r.id as string}, 'o-r', 'pay-r', 'USD', ${r.amount_minor as number}, '缺一件：抹茶粉',
            ${r.status as string}, ${r.provider_ref}, 'admin:u-admin')
  `;
}

describe('order_refunds 库层不变量（迁移 030）', () => {
  it('正常一行能写入，created_at 有默认值', async () => {
    await insertRefund();
    const [row] =
      await db`select status, amount_minor, created_at from order_refunds where id = 'rf-1'`;
    expect(row?.['status']).toBe('initiated');
    expect(Number(row?.['amount_minor'])).toBe(1000);
    expect(row?.['created_at']).toBeInstanceOf(Date);
  });

  it.each([0, -1])('🔴 amount_minor = %d → 23514（金额必须为正）', async (amount) => {
    await expect(insertRefund({ amount_minor: amount })).rejects.toMatchObject({ code: '23514' });
  });

  it('🔴 状态不在域内 → 23514', async () => {
    await expect(insertRefund({ status: 'done' })).rejects.toMatchObject({ code: '23514' });
  });

  it('🔴 同一机构退款单号登记两次 → 23505（同一笔钱不能记成两笔退款）', async () => {
    await insertRefund({ id: 'rf-1', status: 'succeeded', provider_ref: 're_1' });
    await expect(
      insertRefund({ id: 'rf-2', status: 'succeeded', provider_ref: 're_1' }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

const AT = new Date('2026-10-06T12:00:00Z');
const row = (id: string, amountMinor: number) => ({
  id,
  orderId: 'o-r',
  paymentId: 'pay-r',
  currency: 'USD',
  amountMinor,
  reason: '缺一件：抹茶粉',
  actor: 'admin:u-admin',
});

describe('order-refunds 仓储（AJ-383）', () => {
  it('sumPartialRefunds：failed 不占额度；initiated / pending / unknown / succeeded 都占；在途只看前三种', async () => {
    expect(await sumPartialRefunds(db, 'o-r')).toEqual({
      reservedMinor: 0,
      succeededMinor: 0,
      inFlight: false,
    });
    await insertPartialRefund(db, row('rf-a', 1000));
    expect(await sumPartialRefunds(db, 'o-r')).toEqual({
      reservedMinor: 1000,
      succeededMinor: 0,
      inFlight: true,
    });
    await settlePartialRefund(db, 'rf-a', 'succeeded', 're_a', AT);
    await insertPartialRefund(db, row('rf-b', 500));
    await settlePartialRefund(db, 'rf-b', 'failed', 're_b', AT);
    await insertPartialRefund(db, row('rf-c', 300));
    await settlePartialRefund(db, 'rf-c', 'unknown', null, AT);
    expect(await sumPartialRefunds(db, 'o-r')).toEqual({
      reservedMinor: 1300,
      succeededMinor: 1000,
      inFlight: true,
    });
  });

  it('🔴 settlePartialRefund 只能从非终态出发：succeeded / failed 之后再改 → false 且不变', async () => {
    await insertPartialRefund(db, row('rf-a', 1000));
    expect(await settlePartialRefund(db, 'rf-a', 'succeeded', 're_a', AT)).toBe(true);
    expect(await settlePartialRefund(db, 'rf-a', 'failed', 're_a', AT)).toBe(false);
    const [r] = await db`select status, settled_at from order_refunds where id = 'rf-a'`;
    expect(r?.['status']).toBe('succeeded');
    expect(r?.['settled_at']).toEqual(AT);
  });

  it('pending / unknown 不写 settled_at（还没落定）；provider_ref 为 null 时不覆盖已有单号', async () => {
    await insertPartialRefund(db, row('rf-a', 1000));
    await settlePartialRefund(db, 'rf-a', 'pending', 're_a', AT);
    await settlePartialRefund(db, 'rf-a', 'unknown', null, AT);
    const [r] =
      await db`select status, provider_ref, settled_at from order_refunds where id = 'rf-a'`;
    expect(r).toMatchObject({ status: 'unknown', provider_ref: 're_a', settled_at: null });
  });

  it('listPartialRefunds 按发起顺序返回，金额是数字', async () => {
    await insertPartialRefund(db, row('rf-z', 100));
    await db`update order_refunds set created_at = created_at - interval '1 minute' where id = 'rf-z'`;
    await insertPartialRefund(db, row('rf-a', 200));
    const list = await listPartialRefunds(db, 'o-r');
    expect(list.map((r) => [r.id, r.amount_minor])).toEqual([
      ['rf-z', 100],
      ['rf-a', 200],
    ]);
  });
});
