/**
 * 职责：D-50 关单连带的**注册与触发链**端到端（U-J2）——
 *      「expire job 发 `order.expired` → 真事件总线 → 订阅者 → 库内 void + 机构 expireSession」
 *      这整条链此前**没有任何测试**覆盖。
 *
 * @why `close-session-events.db.test.ts` 测的是**处理函数本身**（假总线 + `publish` 直接抛错、
 *      手工调 handler）。它能证明"给这个 handler 一个事件，它会做正确的事"，
 *      证明不了两件更要紧的事：
 *      ① **注册**：`mount.ts` 真的把它挂到总线上了吗？没挂的话 handler 写得再对也是死代码——
 *         而"总线里一个订阅者都没有"**不是错误**，没有任何报错。
 *      ② **触发**：job 发出的 `order.expired` 真的到达它了吗？
 *         事件名写错一个字母（订阅 `order.expire`）、或订阅了但发布方改名——
 *         两边都不报错，结果是**机构会话永远不会被作废、库里支付行一直悬着**，
 *         而关单 job 的心跳、审计事件、状态迁移**全部正常绿**。
 *      这两类的共同点是**静默**：谁都不说，只有在"用户拿着已关单的短链还能付钱"时才暴露。
 *
 * @why 证据一律从**外部**取（§2 第 21 条）——
 *      机构调用是否发生，由 **stub provider 自己记账**（订阅者不知道有这本账）；
 *      库内是否作废，直接查 `payments.status`。
 *      不从 handler / 订阅者内部取任何状态。
 *
 * @limitation 一：**注册事实**与**机构调用**分两条用例验，靠传递性闭合——
 *      ① 注册：`mountAllRoutes` 之后往同一个总线发事件 → 库内 void 发生（mount 用的是真注册表）；
 *      ② 机构调用：真总线 + 带 `expireSession` 的 stub 通道 → 断言 provider 被调。
 *      为什么不合一条：`mount` 的注册表由 `PAYMENT_CHANNELS` 配置驱动，
 *      而带 `expireSession` 的只有 stripe 通道——在测试里让 stripe 通道真去打外网
 *      会撞上出站闸门（AJ-56），于是这一步用手工注册表。
 *      两条的**连接点都是同一个真 `EventBus`**，所以"mount 注册 → 事件到达 → 调机构"
 *      这条链是被完整覆盖的，只是不在一次断言里。
 * @limitation 二：本文件**不起 HTTP**。链条的两端是「调度器 job」与「支付通道注册表」，
 *              中间没有路由——起服务只会增加噪音。
 * @limitation 三：订阅者对每个事件的**处理逻辑**（best-effort 降级全组合）仍由
 *              `close-session-events.db.test.ts` 覆盖，本文件**不重复**——
 *              它只补"事件到底有没有走到那里"。
 *
 * @see app/close-session-events.ts（订阅者）；app/mount.ts（注册点）；
 *      app/expire-orders.ts（事件源）；adapters/event-bus.ts（总线语义）；
 *      docs/自主决策记录.md AJ-171
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createLogger, type Logger } from '../logger.js';
import { loadConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type {
  ChannelQuery,
  ChannelView,
  PaymentProvider,
  PaymentRegistry,
  ProviderFactory,
} from '../ports/payment.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { createHttpApp } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { registerSessionExpiryOnClose } from './close-session-events.js';
import { runSchedulerOnce } from './scheduler.js';
import { createSchedulerDeps } from './scheduler-start.js';
import { createExpireOrdersJob, EXPIRE_ORDERS_JOB } from './expire-orders.js';
import { cancelOrder } from './cancel-order.js';
import { withUnitOfWork } from './unit-of-work.js';

let db: Db;
const sink = new MemorySink();
let logger: Logger;

const NOW = new Date('2026-01-02T12:00:00.000Z');
/** 固定时钟：判定基准必须钉死，"到点/未到点"才可断言。 */
const clock: Clock = { now: () => NOW };

const JWT_SECRET = 'close-session-wiring-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await db`delete from job_runs where name = ${EXPIRE_ORDERS_JOB}`;
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink.clear();
  logger = createLogger({ env: 'test', destination: sink });
  await db`insert into users (id, openid) values ('u-csw', 'o-csw')`;
});

async function seedOrderWithInitiatedPay(
  orderId: string,
  over: { provider?: string; providerRef?: string | null; expiresInMs?: number } = {},
): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot,
                        terms_version, expires_at)
    values (${orderId}, ${`W-${orderId}`}, 'u-csw', 'created', 1000, 200, 0, 1200, 500,
            ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })},
            'TOS-1', ${new Date(NOW.getTime() + (over.expiresInMs ?? -1_000))})
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
    values (${`pay-${orderId}`}, ${orderId}, ${over.provider ?? 'mock'},
            ${over.providerRef === undefined ? 'cs_test_1' : over.providerRef},
            'initiated', 'USD', 800, 'https://example.invalid/pay')
  `;
}

async function payStatusOf(orderId: string): Promise<string> {
  const rows = await db`select status from payments where order_id = ${orderId}`;
  return String(rows[0]?.['status']);
}

/** 装配后往总线发一个关单事件（走真总线，不 mock 发布动作）。 */
function publishClose(bus: ReturnType<typeof createEventBus>, name: string, orderId: string): void {
  bus.publish({ name, at: NOW.toISOString(), orderId });
}

/**
 * 等订阅者跑完。
 * @why 总线的语义是"发后不等"（`event-bus.ts` @tradeoff）：`publish` 返回时 async 订阅者
 *      **还没跑完**，直接断言会假绿（先写断言再等 = 恒真）。
 *      用 `vi.waitFor` 而不是固定 sleep：DB 往返耗时会随机器负载漂移，
 *      固定 sleep 在慢机器上就是新的 flaky 源。
 */
async function waitForPayStatus(orderId: string, expected: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await payStatusOf(orderId)).toBe(expected);
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe('注册事实：mount 之后订阅者真的挂在总线上', () => {
  it('发 order.expired → 库内在途支付行被作废（没注册则什么都不发生）', async () => {
    await seedOrderWithInitiatedPay('o-reg-expired');
    const bus = createEventBus(logger);
    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '1',
      HOST: '127.0.0.1',
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET,
      PAYMENT_CHANNELS: 'mock',
      TERMS_VERSION: 'TOS-1',
    });
    createHttpApp({
      logger,
      // mount 在 createHttpApp 内**同步**执行（http.ts:310）——本用例不起端口，只为触发装配
      mount: (a) =>
        mountAllRoutes(a, { config, logger, db, events: bus, storage: createMemoryStorage() }),
    });

    publishClose(bus, 'order.expired', 'o-reg-expired');
    await waitForPayStatus('o-reg-expired', 'cancelled');
  });

  it('发 order.cancelled → 同样被作废（两个事件名缺一个 = 一条关单路径没有连带）', async () => {
    await seedOrderWithInitiatedPay('o-reg-cancelled');
    const bus = createEventBus(logger);
    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '1',
      HOST: '127.0.0.1',
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET,
      PAYMENT_CHANNELS: 'mock',
      TERMS_VERSION: 'TOS-1',
    });
    createHttpApp({
      logger,
      mount: (a) =>
        mountAllRoutes(a, { config, logger, db, events: bus, storage: createMemoryStorage() }),
    });

    publishClose(bus, 'order.cancelled', 'o-reg-cancelled');
    await waitForPayStatus('o-reg-cancelled', 'cancelled');
  });

  it('反向对照：不挂载（无订阅者）发同样的事件 → 支付行**保持 initiated**（防上两条恒真）', async () => {
    await seedOrderWithInitiatedPay('o-reg-none');
    const bus = createEventBus(logger);

    publishClose(bus, 'order.expired', 'o-reg-none');
    // 固定等待（不是 waitFor）：本用例要证的正是"等了也没变"
    await new Promise((r) => setTimeout(r, 300));
    expect(await payStatusOf('o-reg-none')).toBe('initiated');
  });
});

describe('触发链：expire job → 真总线 → 订阅者 → 机构 expireSession', () => {
  it('关单 job 一轮跑完：订单 expired、支付行作废、stub 通道收到 expireSession(provider_ref)', async () => {
    const calls: string[] = [];
    const provider: PaymentProvider = {
      channel: 'stub',
      capabilities: {
        currencies: ['JPY', 'USD'],
        countries: ['*'],
        entryMode: 'copylink',
        supportsRefund: true,
        supportsPartialRefund: false,
        supportsDispute: false,
        refundableWhenDisabled: true,
      },
      create: () => Promise.reject(new Error('unused')),
      parseWebhook: () => Promise.reject(new Error('unused')),
      // 记账发生在**通道侧**：订阅者不知道有这本账，所以这不是自证
      expireSession: async (ref: string) => {
        calls.push(ref);
      },
    };
    const registry: PaymentRegistry = {
      register: (_c: string, _f: ProviderFactory) => undefined,
      get: () => {
        throw new Error('unused');
      },
      getForRefund: () => {
        throw new Error('unused');
      },
      getForCallback: () => provider,
      listAvailable: (_q: ChannelQuery): ChannelView[] => [],
    };

    await seedOrderWithInitiatedPay('o-chain', { provider: 'stub', providerRef: 'cs_test_1' });
    const bus = createEventBus(logger);
    registerSessionExpiryOnClose(bus, { db, logger, registry });

    const r = await runSchedulerOnce(
      createSchedulerDeps(db, bus, clock, logger, { name: EXPIRE_ORDERS_JOB }),
      [createExpireOrdersJob()],
    );
    // 判别联合必须先收窄：`SchedulerTickSkipped` 没有 ok/jobs 字段
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(r.ok).toBe(true);

    const order = await db`select status from orders where id = 'o-chain'`;
    expect(String(order[0]?.['status'])).toBe('expired');
    await waitForPayStatus('o-chain', 'cancelled');
    await vi.waitFor(() => expect(calls).toEqual(['cs_test_1']), { timeout: 5_000, interval: 20 });
  });

  it('反向对照：跑同一个 job 但**不注册**订阅者 → 支付行不动、机构没被调（防上一条恒真）', async () => {
    const calls: string[] = [];
    const provider: PaymentProvider = {
      channel: 'stub',
      capabilities: {
        currencies: ['JPY', 'USD'],
        countries: ['*'],
        entryMode: 'copylink',
        supportsRefund: true,
        supportsPartialRefund: false,
        supportsDispute: false,
        refundableWhenDisabled: true,
      },
      create: () => Promise.reject(new Error('unused')),
      parseWebhook: () => Promise.reject(new Error('unused')),
      expireSession: async (ref: string) => {
        calls.push(ref);
      },
    };
    const registry: PaymentRegistry = {
      register: () => undefined,
      get: () => {
        throw new Error('unused');
      },
      getForRefund: () => {
        throw new Error('unused');
      },
      getForCallback: () => provider,
      listAvailable: (): ChannelView[] => [],
    };

    await seedOrderWithInitiatedPay('o-chain-none', { provider: 'stub' });
    const bus = createEventBus(logger);
    // 故意不注册 registerSessionExpiryOnClose——只把它装进"没人订阅"的注册表里
    void registry;

    await runSchedulerOnce(
      createSchedulerDeps(db, bus, clock, logger, { name: EXPIRE_ORDERS_JOB }),
      [createExpireOrdersJob()],
    );

    const order = await db`select status from orders where id = 'o-chain-none'`;
    expect(String(order[0]?.['status'])).toBe('expired'); // job 本身照常工作
    await new Promise((r) => setTimeout(r, 300));
    expect(await payStatusOf('o-chain-none')).toBe('initiated'); // 但连带没发生
    expect(calls).toEqual([]);
  });
});

describe('触发链：用户取消（真取消事务 + 提交后分发）→ 订阅者 → 机构 expireSession（KD-1 回归）', () => {
  it('取消事务内已把支付行 void，提交后订阅者仍把机构会话作废（此前永远找不到行、从不作废）', async () => {
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                          total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
      values ('o-cxl', 'W-o-cxl', 'u-csw', 'pending_payment', 1000, 200, 0, 1200, 500,
              ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })}, 'TOS-1',
              ${new Date(NOW.getTime() + 30 * 60_000)})
    `;
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
      values ('pay-o-cxl', 'o-cxl', 'stub', 'cs_test_cxl', 'initiated', 'USD', 800, 'https://example.invalid/pay')
    `;
    const calls: string[] = [];
    const provider = {
      channel: 'stub',
      capabilities: {
        currencies: ['USD'],
        countries: ['*'],
        entryMode: 'copylink',
        supportsRefund: false,
        supportsPartialRefund: false,
        supportsDispute: false,
        refundableWhenDisabled: false,
      },
      create: () => Promise.reject(new Error('unused')),
      parseWebhook: () => Promise.reject(new Error('unused')),
      expireSession: (ref: string) => {
        calls.push(ref);
        return Promise.resolve();
      },
    } as unknown as PaymentProvider;
    const registry: PaymentRegistry = {
      register: () => undefined,
      get: () => provider,
      getForRefund: () => provider,
      getForCallback: () => provider,
      listAvailable: (): ChannelView[] => [],
    };
    const bus = createEventBus(logger);
    registerSessionExpiryOnClose(bus, { db, logger, registry });

    // 与 order-routes.ts 取消路由同构：同一事务取消 + 提交后分发 order.cancelled
    await withUnitOfWork(db, bus, async (tx, emit) => {
      await cancelOrder(tx, { clock, logger }, { orderId: 'o-cxl', userId: 'u-csw' });
      emit({ name: 'order.cancelled', at: NOW.toISOString(), orderId: 'o-cxl' });
    });

    expect(await payStatusOf('o-cxl')).toBe('cancelled'); // 事务内已作废
    await vi.waitFor(() => expect(calls).toEqual(['cs_test_cxl']), {
      timeout: 5_000,
      interval: 20,
    });
  });
});
