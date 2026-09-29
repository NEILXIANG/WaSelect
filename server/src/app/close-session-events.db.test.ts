/**
 * 职责：D-50 关单连带订阅者（close-session-events.ts）的真库用例（I1-U6a-2）——
 *      事件 → 库内 void + 机构 expireSession 的全组合，含全部 best-effort 降级路径。
 *
 * @why 订阅者是"失败静默"代码（总线兜异常、请求照常成功），每个降级分支都必须
 *      显式钉：不实现 expireSession / 调用抛错 / 通道未注册，**库内 void 都必须已完成**。
 *
 * @see app/close-session-events.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger, type Logger } from '../logger.js';
import type { EventBus, EventHandler } from '../ports/events.js';
import type {
  ChannelQuery,
  ChannelView,
  PaymentProvider,
  PaymentRegistry,
  ProviderFactory,
} from '../ports/payment.js';
import { registerSessionExpiryOnClose, SESSION_CLOSE_EVENTS } from './close-session-events.js';

let db: Db;
let sink: MemorySink;
let logger: Logger;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
  sink = new MemorySink();
  logger = createLogger({ env: 'test', destination: sink });
});

/** 收集式假总线：订阅即记录，测试直接调 handler（publish 语义在事件总线自己的测试里钉）。 */
function fakeBus(): { bus: EventBus; handlers: Map<string, EventHandler> } {
  const handlers = new Map<string, EventHandler>();
  const bus: EventBus = {
    subscribe: (name, h) => {
      handlers.set(name, h);
      return () => handlers.delete(name);
    },
    publish: () => {
      throw new Error('本测试直接调 handler，不走 publish');
    },
    publishAll: () => {
      throw new Error('本测试直接调 handler，不走 publishAll');
    },
  };
  return { bus, handlers };
}

function fakeRegistry(provider: PaymentProvider | null): PaymentRegistry {
  const unused = (what: string) => (): never => {
    throw new Error(`订阅者不该调 ${what}`);
  };
  return {
    register: (_c: string, _f: ProviderFactory) => unused('register')(),
    get: unused('get'),
    getForRefund: unused('getForRefund'),
    getForCallback: (channel) => {
      if (provider === null) throw new Error(`channel_not_registered: ${channel}`);
      return provider;
    },
    listAvailable: (_q: ChannelQuery): ChannelView[] => unused('listAvailable')(),
  };
}

/** 最小 PaymentProvider（create/parseWebhook 不可达；expireSession 可配）。 */
function fakeProvider(over: { expireSession?: (ref: string) => Promise<void> }): PaymentProvider {
  return {
    channel: 'stripe',
    capabilities: {
      currencies: ['JPY', 'USD'],
      countries: ['*'],
      entryMode: 'copylink',
      supportsRefund: true,
      supportsPartialRefund: false,
      supportsDispute: true,
      refundableWhenDisabled: true,
    },
    create: () => Promise.reject(new Error('unused')),
    parseWebhook: () => Promise.reject(new Error('unused')),
    ...(over.expireSession === undefined ? {} : { expireSession: over.expireSession }),
  };
}

async function seedOrderWithInitiatedPay(
  orderId: string,
  over: { provider?: string; providerRef?: string | null; payStatus?: string } = {},
): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot,
                        terms_version, expires_at)
    values (${orderId}, ${`W-${orderId}`}, 'u-1', 'expired', 1000, 200, 0, 1200, 500,
            ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })},
            'TOS-1', now() - interval '1 minute')
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
    values (${`pay-${orderId}`}, ${orderId}, ${over.provider ?? 'stripe'},
            ${over.providerRef === undefined ? 'cs_test_1' : over.providerRef},
            ${over.payStatus ?? 'initiated'}, 'USD', 800,
            'https://checkout.stripe.com/c/pay/cs_test_1')
  `;
}

async function payStatusOf(orderId: string): Promise<string> {
  const rows = await db`select status from payments where order_id = ${orderId}`;
  return String(rows[0]?.['status']);
}

describe('registerSessionExpiryOnClose：注册事实', () => {
  it('订阅 order.expired / order.cancelled / order.paid 三个事件（漏一个 = 一条收尾路径没有连带）', () => {
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, { db, logger, registry: fakeRegistry(null) });
    expect([...handlers.keys()].sort()).toEqual([...SESSION_CLOSE_EVENTS].sort());
    expect(SESSION_CLOSE_EVENTS).toEqual(['order.expired', 'order.cancelled', 'order.paid']);
  });
});

describe('付款成功连带：换通道留下的旧会话一并作废（AJ-175 补测）', () => {
  it('A(stripe) → B(mock) 换通道后用 B 付款 → 只作废 A 的旧会话；刚成功的那一笔绝不碰', async () => {
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                          total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('o-sw', 'W-o-sw', 'u-1', 'paid', 1000, 200, 0, 1200, 500,
              ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })}, 'TOS-1', now() + interval '20 minutes')`;
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, created_at)
      values ('pay-sw-a', 'o-sw', 'stripe', 'cs_old', 'cancelled', 'USD', 800, now() - interval '5 minutes'),
             ('pay-sw-b', 'o-sw', 'mock', 'mock-ref-b', 'succeeded', 'JPY', 1200, now())`;
    const expired: string[] = [];
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: async (ref) => {
            expired.push(ref);
          },
        }),
      ),
    });
    await handlers.get('order.paid')?.({
      name: 'order.paid',
      at: new Date().toISOString(),
      orderId: 'o-sw',
    });
    expect(expired).toEqual(['cs_old']);
    const pays = await db`select id, status from payments where order_id = 'o-sw' order by id`;
    expect(pays.map((p) => [p['id'], p['status']])).toEqual([
      ['pay-sw-a', 'cancelled'],
      ['pay-sw-b', 'succeeded'],
    ]);
  });
});

describe('关单连带：库内 void + 机构 expire', () => {
  it('order.expired + 在途支付 → 行变 cancelled + expireSession 被调（机构单号原样透传）', async () => {
    await seedOrderWithInitiatedPay('o-1');
    const expired: string[] = [];
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: (ref) => {
            expired.push(ref);
            return Promise.resolve();
          },
        }),
      ),
    });

    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-1' });

    expect(await payStatusOf('o-1')).toBe('cancelled');
    expect(expired).toEqual(['cs_test_1']);
    expect(
      sink
        .rows()
        .some((r) => r.event === 'pay_session_expire' && JSON.stringify(r).includes('"ok"')),
    ).toBe(true);
  });

  it('取消路径（支付行已在事务内 void 成 cancelled）→ 机构会话**仍被作废**一次，行保持 cancelled（KD-1 回归）', async () => {
    await seedOrderWithInitiatedPay('o-2', { payStatus: 'cancelled' });
    const expired: string[] = [];
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: (ref) => {
            expired.push(ref);
            return Promise.resolve();
          },
        }),
      ),
    });

    await handlers.get('order.cancelled')?.({ name: 'order.cancelled', at: '', orderId: 'o-2' });

    expect(expired).toEqual(['cs_test_1']);
    expect(await payStatusOf('o-2')).toBe('cancelled');
  });

  it('换通道留下的旧会话（cancelled）+ 当前在途会话（initiated）→ 关单时两个会话都被作废；succeeded 行不碰', async () => {
    await seedOrderWithInitiatedPay('o-2b', { payStatus: 'cancelled', providerRef: 'cs_old' });
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
      values ('pay-o-2b-new', 'o-2b', 'stripe', 'cs_new', 'initiated', 'USD', 800),
             ('pay-o-2b-paid', 'o-2b', 'stripe', 'cs_paid', 'succeeded', 'USD', 800)
    `;
    const expired: string[] = [];
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: (ref) => {
            expired.push(ref);
            return Promise.resolve();
          },
        }),
      ),
    });

    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-2b' });

    expect(expired.sort()).toEqual(['cs_new', 'cs_old']);
    const rows = await db`select id, status from payments where order_id = 'o-2b' order by id`;
    expect(rows.map((r) => [r['id'], r['status']])).toEqual([
      ['pay-o-2b', 'cancelled'],
      ['pay-o-2b-new', 'cancelled'],
      ['pay-o-2b-paid', 'succeeded'],
    ]);
  });

  it('该单没有任何支付行 → 空转：不调 expire、不写日志、不炸', async () => {
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                          total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('o-2c', 'W-o-2c', 'u-1', 'cancelled', 1000, 200, 0, 1200, 500,
              ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })}, 'TOS-1', now())
    `;
    let called = 0;
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: () => {
            called += 1;
            return Promise.resolve();
          },
        }),
      ),
    });
    await handlers.get('order.cancelled')?.({ name: 'order.cancelled', at: '', orderId: 'o-2c' });
    expect(called).toBe(0);
    expect(sink.find('pay_session_expire')).toEqual([]);
  });

  it('通道无 expireSession（in_app 形态）→ 行仍 void，不炸', async () => {
    await seedOrderWithInitiatedPay('o-3', { provider: 'wechat' });
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(fakeProvider({})), // 无 expireSession
    });

    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-3' });

    expect(await payStatusOf('o-3')).toBe('cancelled');
  });

  it('expireSession 抛错 → 行仍 void + warn failed，不 rethrow（自然过期兜底）', async () => {
    await seedOrderWithInitiatedPay('o-4');
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: () => Promise.reject(new Error('HTTP 400 already expired')),
        }),
      ),
    });

    // 订阅者自己兜住（best-effort）——如果它 rethrow，这里就会抛出来
    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-4' });

    expect(await payStatusOf('o-4')).toBe('cancelled');
    const warns = sink.find('pay_session_expire');
    expect(warns.some((r) => JSON.stringify(r).includes('failed'))).toBe(true);
    expect(warns.some((r) => JSON.stringify(r).includes('already expired'))).toBe(true);
  });

  it('通道整个未注册（getForCallback 抛）→ 行仍 void + warn skipped', async () => {
    await seedOrderWithInitiatedPay('o-5', { provider: 'ghostpay' });
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, { db, logger, registry: fakeRegistry(null) });

    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-5' });

    expect(await payStatusOf('o-5')).toBe('cancelled');
    const rows = sink.find('pay_session_expire');
    expect(rows.some((r) => JSON.stringify(r).includes('channel_not_registered'))).toBe(true);
  });

  it('provider_ref 为 null（防御：无机构单号）→ 行 void、expire 跳过不炸', async () => {
    await seedOrderWithInitiatedPay('o-6', { providerRef: null });
    let called = 0;
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, {
      db,
      logger,
      registry: fakeRegistry(
        fakeProvider({
          expireSession: () => {
            called += 1;
            return Promise.resolve();
          },
        }),
      ),
    });

    await handlers.get('order.expired')?.({ name: 'order.expired', at: '', orderId: 'o-6' });

    expect(await payStatusOf('o-6')).toBe('cancelled');
    expect(called).toBe(0);
  });
});
