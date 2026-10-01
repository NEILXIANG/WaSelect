/**
 * 职责：**取消前"问机构一句"**（第三轮审查 MP3-04，P1）——`assertNoPaidSession` 的行为测试。
 *
 * @why 这一层是全链路里**唯一**能挡住"买家已付款、通知未达时被取消"的地方：
 *      那一刻本地数据（订单 `pending_payment` + 支付行 `initiated`）**完全合法**，
 *      任何只看本地状态的测试都会绿。所以这条用例的输入必须来自**机构**：
 *      用带 `sessionStatus` 的 stub 通道，让机构自己说"已付"，再断言取消被拒。
 *
 * @why 真库（db 层）而不是内存假库：`assertNoPaidSession` 的第一步是读订单与在途支付行，
 *      "读不读得出来"（`findOwnedOrder` 的归属判定、`findInitiatedPayment` 的
 *      `status='initiated'` 过滤）本身就是这条防线的一部分——
 *      假库会把"支付行其实读不到"这种失败变成永远绿。
 *
 * @limitation 机构是 stub，不是真 Stripe：真 Stripe 的 `payment_status` 取值以
 *              `stripe-checkout.ts` 的 `@measured` 为准，那一段由适配器单测钉住，本文件不重复。
 *
 * @see app/cancel-order.ts（assertNoPaidSession）；ports/payment.ts（sessionStatus / supportsSessionQuery）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createLogger, type Logger } from '../logger.js';
import type {
  ChannelView,
  PaymentProvider,
  PaymentRegistry,
  ProviderFactory,
  SessionStatus,
} from '../ports/payment.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { assertNoPaidSession } from './cancel-order.js';

let db: Db;
const sink = new MemorySink();
let logger: Logger;

const NOW = new Date('2026-01-02T12:00:00.000Z');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink.clear();
  logger = createLogger({ env: 'test', destination: sink });
  await db`insert into users (id, openid) values ('u-cps', 'o-cps')`;
});

/**
 * 种一张 `pending_payment` 订单 + 一条在途支付行（这就是"通知未达"那一刻的本地形态）。
 * @param over.status 覆盖订单状态；@param over.noPay 不给支付行（模拟"还没发起支付"）
 */
async function seedPaying(
  over: { id?: string; status?: string; noPay?: boolean } = {},
): Promise<string> {
  const id = over.id ?? 'o-cps';
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, 'u-cps', ${over.status ?? 'pending_payment'},
            1000, 200, 0, 1200, 500, ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })},
            'TOS-1', ${new Date(NOW.getTime() + 30 * 60_000)})
  `;
  if (over.noPay !== true) {
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
      values (${`pay-${id}`}, ${id}, 'stub', ${`cs_${id}`}, 'initiated', 'USD', 800,
              'https://example.invalid/pay')
    `;
  }
  return id;
}

/** 只会"报会话状态"的 stub 通道。 */
function stubProvider(opts: {
  status?: SessionStatus;
  supportsSessionQuery?: boolean;
  throws?: boolean;
}): PaymentProvider {
  const caps = {
    currencies: ['USD'],
    countries: ['*'],
    entryMode: 'copylink' as const,
    supportsRefund: false,
    supportsPartialRefund: false,
    supportsDispute: false,
    refundableWhenDisabled: false,
    // 默认**声明**支持（被测路径就是它）；显式 false 那条用例才关掉。
    // @why 不声明时被测函数会直接放行（能力未声明 = 不查），那是另一条正确分支，
    //      若这里默认不声明，本文件所有"机构说已付"的用例都会假绿。
    supportsSessionQuery: opts.supportsSessionQuery ?? true,
  };
  return {
    channel: 'stub',
    capabilities: caps,
    create: () => Promise.reject(new Error('unused')),
    parseWebhook: () => Promise.reject(new Error('unused')),
    sessionStatus:
      opts.throws === true
        ? () => Promise.reject(new Error('stripe 502'))
        : () => Promise.resolve(opts.status ?? 'unpaid'),
  } as unknown as PaymentProvider;
}

function stubRegistry(provider: PaymentProvider): PaymentRegistry {
  return {
    register: (_channel: string, _factory: ProviderFactory) => undefined,
    get: () => provider,
    getForRefund: () => provider,
    getForCallback: () => provider,
    listAvailable: (): ChannelView[] => [],
  };
}

/** 取 AppError 的 (code, reason)；非 AppError 直接抛（用例不该走到）。 */
async function failureOf(p: Promise<unknown>): Promise<{ code: number; reason: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: number; details?: { reason?: string } };
    if (typeof err.code !== 'number') throw e;
    return { code: err.code, reason: String(err.details?.reason) };
  }
  throw new Error('期望被拒绝，但它放行了');
}

describe('assertNoPaidSession（取消前问机构，MP3-04）', () => {
  it('🔴 机构说"已付" → 拒绝取消（40902 payment_already_paid），订单仍在 pending_payment', async () => {
    const id = await seedPaying({ id: 'o-paid' });
    const f = await failureOf(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ status: 'paid' })) },
        { orderId: id, userId: 'u-cps' },
      ),
    );
    expect(f.code).toBe(40902);
    expect(f.reason).toBe('payment_already_paid');
    // 挡住的凭证：订单没被动过（关单 + 回补库存都没发生）
    const row = await db`select status from orders where id = ${id}`;
    expect(String(row[0]?.['status'])).toBe('pending_payment');
    expect(sink.find('cancel_blocked_paid_session')).toHaveLength(1);
  });

  it('🔴 机构说"不确定"（processing）→ 也拒绝取消（40902 payment_in_flight）', async () => {
    const id = await seedPaying({ id: 'o-flight' });
    const f = await failureOf(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ status: 'processing' })) },
        { orderId: id, userId: 'u-cps' },
      ),
    );
    expect(f.code).toBe(40902);
    expect(f.reason).toBe('payment_in_flight');
  });

  it('🔴 机构查不到（网络/5xx）→ fail-closed 拒绝取消（50300），而不是"查不到就当没付"', async () => {
    const id = await seedPaying({ id: 'o-down' });
    const f = await failureOf(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ throws: true })) },
        { orderId: id, userId: 'u-cps' },
      ),
    );
    expect(f.code).toBe(50300);
    expect(f.reason).toBe('session_query_failed');
  });

  it('机构说"未付" → 放行（日常取消不能被这条防线挡住）', async () => {
    const id = await seedPaying({ id: 'o-unpaid' });
    await expect(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ status: 'unpaid' })) },
        { orderId: id, userId: 'u-cps' },
      ),
    ).resolves.toBeUndefined();
  });

  it('通道不支持会话查询（in_app 类）→ 放行，且不假装查过（不产生任何日志）', async () => {
    const id = await seedPaying({ id: 'o-nocap' });
    await expect(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ supportsSessionQuery: false })) },
        { orderId: id, userId: 'u-cps' },
      ),
    ).resolves.toBeUndefined();
    expect(sink.lines).toHaveLength(0);
  });

  it('还没发起支付（created 且无在途支付行）→ 放行：没有可问的对象', async () => {
    const id = await seedPaying({ id: 'o-created', status: 'created', noPay: true });
    await expect(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ status: 'paid' })) },
        { orderId: id, userId: 'u-cps' },
      ),
    ).resolves.toBeUndefined();
  });

  it('非本人订单 → 40400（与取消主路径同口径：不存在与非本人不可区分）', async () => {
    const id = await seedPaying({ id: 'o-other' });
    const f = await failureOf(
      assertNoPaidSession(
        { db, logger, registry: stubRegistry(stubProvider({ status: 'paid' })) },
        { orderId: id, userId: 'u-someone-else' },
      ),
    );
    expect(f.code).toBe(40400);
  });
});
