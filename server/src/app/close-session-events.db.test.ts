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
  it('订阅 order.expired 与 order.cancelled 两个事件（漏一个 = 一条关单路径没有连带）', () => {
    const { bus, handlers } = fakeBus();
    registerSessionExpiryOnClose(bus, { db, logger, registry: fakeRegistry(null) });
    expect([...handlers.keys()].sort()).toEqual([...SESSION_CLOSE_EVENTS].sort());
    expect(SESSION_CLOSE_EVENTS).toEqual(['order.expired', 'order.cancelled']);
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

  it('无在途支付行（取消路径已在事务内 void）→ 空转：不调 expire、不写日志、不炸', async () => {
    await seedOrderWithInitiatedPay('o-2', { payStatus: 'cancelled' });
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

    await handlers.get('order.cancelled')?.({ name: 'order.cancelled', at: '', orderId: 'o-2' });

    expect(called).toBe(0);
    expect(await payStatusOf('o-2')).toBe('cancelled');
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
