/**
 * 职责：`createPayIntent` 核心的真库用例（I1-U6a）——守卫 / 发起 / 复用 / 换通道 /
 *      copylink 短链（D-49）/ 扣款币种解析。
 *
 * @why 注册表用**假 Provider 工厂**（pa/pb/pc/usd-only）而不是 mock/stripe 真适配器：
 *      核心要钉的是"核心自身的编排"（守卫顺序、行作废、token 轮换、金额解析），
 *      与"某个机构适配器的行为"无关——后者各有自己的测试。假 Provider 也让
 *      "换通道"（pa→pb）不依赖第二个真实通道存在（stripe 无密钥时注册不了）。
 *
 * @why copylink 的 token 断言钉**两端**：响应里的明文 token（pay_url 查询串）与
 *      库里的 sha256——只断一头，"hash 存错但链接碰巧能发"或反过来都测不出。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { toMinor, toRateInt } from '@waselect/shared';
import { closeDb, withTransaction, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig, type AppConfig } from '../config.js';
import { createPaymentRegistry } from '../adapters/payment/registry.js';
import type {
  ChannelConfig,
  PaymentProvider,
  PaymentRegistry,
  PaymentRequest,
  PaymentSession,
} from '../ports/payment.js';
import type { IdGen } from '../ports/ids.js';
import { AppError } from '../errors.js';
import { createPayIntent, type PayIntentDeps } from './pay-intent.js';

let db: Db;
const CLOCK = fixedClock('2026-01-02T12:00:00.000Z');
const EXPIRES = new Date('2026-01-02T12:30:00.000Z'); // 30 分钟后（可支付窗口内）
const TOTAL = 20_150;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1'), ('u-2', 'o-2')`;
});

/** 造一张可支付单（db.json 单重编码；fx 快照含 USD）。 */
async function seedPayable(
  id: string,
  over: { user?: string; status?: string; expiresAt?: Date; fx?: Record<string, number> } = {},
): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`260102-${id.padEnd(6, 'X').slice(0, 6)}`}, ${over.user ?? 'u-1'},
            ${over.status ?? 'created'}, 15_200, 4950, 0, ${TOTAL}, 1830,
            ${db.json(over.fx ?? { USD: 0.0067, CNY: 0.049 })},
            ${db.json({ recipient: 'Jane', country: 'US' })},
            'TOS-1', ${over.expiresAt ?? EXPIRES})
  `;
}

// ── 假 Provider 工厂（见文件头 @why）─────────────────────────────────────────

function fakeProvider(
  channel: string,
  opts: { currencies: readonly string[]; copylink?: boolean } = { currencies: ['JPY'] },
): PaymentProvider {
  return {
    channel,
    capabilities: {
      currencies: opts.currencies,
      countries: ['*'],
      entryMode: opts.copylink === true ? 'copylink' : 'in_app',
      supportsRefund: false,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: true,
    },
    async create(req: PaymentRequest): Promise<PaymentSession> {
      // providerRef 由幂等键派生：同键重发 = 同一会话（mock/Stripe 幂等键的同款行为）
      return {
        providerRef: `${channel}-${req.idempotencyKey}`,
        entry:
          opts.copylink === true
            ? { mode: 'copylink', url: `https://pay.example.com/s/${req.idempotencyKey}` }
            : { mode: 'in_app', params: { via: channel, orderId: req.orderId } },
      };
    },
    parseWebhook: () => Promise.reject(new Error('unused in pay-intent tests')),
  };
}

function fakeRegistry(channels: Record<string, PaymentProvider>): PaymentRegistry {
  const configs: ChannelConfig[] = Object.keys(channels).map((channel) => ({
    channel,
    enabled: true,
    priority: 10,
    countries: ['*'],
    currencies: ['*'],
    label: channel,
  }));
  const registry = createPaymentRegistry({ configs });
  for (const [ch, p] of Object.entries(channels)) registry.register(ch, () => p);
  return registry;
}

// uuid 必须逐次唯一：payments.id 主键由它派生，常量会在"建行两次"的场景撞 23505
// （换通道测试实抓过一次——那次的报错指向 recordPaymentIntent，根因却在测试的 IdGen）
let uuidSeq = 0;
const ID_GEN: IdGen = {
  uuid: () => `abcdef01-2345-6789-abcd-${String(uuidSeq++).padStart(12, '0')}`,
  orderSeq: () => 'AAAAAA',
};

function deps(registry: PaymentRegistry, sink: MemorySink): PayIntentDeps {
  const config: AppConfig = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://localhost:1/db', // 不连接（核心只用注入的 tx）
    JWT_SECRET: 'pay-intent-test-jwt-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    CHECKOUT_BASE_URL: 'https://checkout.example.com',
    TERMS_VERSION: 'TOS-1',
  });
  return {
    config,
    clock: CLOCK,
    idGen: ID_GEN,
    logger: createLogger({ env: 'test', destination: sink }),
    registry,
  };
}

function codeOf(e: unknown): number {
  return (e as AppError).code;
}

describe('守卫（归属/状态/到期）', () => {
  it('边界（AJ-175 补测）：now 恰好等于 expires_at → 40904；前 1ms → 可发起（窗口 [created, expires_at)，与落账 / 短链 / 关单作业同向）', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa') });
    await seedPayable('o-eq', { expiresAt: CLOCK.now() });
    await seedPayable('o-1ms', { expiresAt: new Date(CLOCK.now().getTime() + 1) });
    await withTransaction(db, async (tx) => {
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-eq',
        userId: 'u-1',
        channel: 'pa',
      }).then(
        () =>
          expect.unreachable('恰好到点应 40904（写成 > 会在这一毫秒放行一个关单作业马上要关的单）'),
        (e) => expect(codeOf(e)).toBe(40904),
      );
    });
    await withTransaction(db, async (tx) => {
      const r = await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-1ms',
        userId: 'u-1',
        channel: 'pa',
      });
      expect(r.channel).toBe('pa');
    });
  });

  it('非本人与不存在 → 40400；expired → 40904；到点未扫（created 但已过 expires_at）→ 40904；paid → 40902', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa') });
    await seedPayable('o-1');
    await seedPayable('o-exp', { status: 'expired' });
    await seedPayable('o-late', { expiresAt: new Date('2026-01-02T11:59:00.000Z') });
    await seedPayable('o-paid', { status: 'paid' });

    await withTransaction(db, async (tx) => {
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-1',
        userId: 'u-2',
        channel: 'pa',
      }).then(
        () => expect.unreachable('非本人应 40400'),
        (e) => expect(codeOf(e)).toBe(40400),
      );
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-ghost',
        userId: 'u-1',
        channel: 'pa',
      }).then(
        () => expect.unreachable('不存在应 40400'),
        (e) => expect(codeOf(e)).toBe(40400),
      );
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-exp',
        userId: 'u-1',
        channel: 'pa',
      }).then(
        () => expect.unreachable('expired 应 40904'),
        (e) => expect(codeOf(e)).toBe(40904),
      );
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-late',
        userId: 'u-1',
        channel: 'pa',
      }).then(
        () => expect.unreachable('到点应 40904'),
        (e) => expect(codeOf(e)).toBe(40904),
      );
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-paid',
        userId: 'u-1',
        channel: 'pa',
      }).then(
        () => expect.unreachable('paid 应 40902'),
        (e) => expect(codeOf(e)).toBe(40902),
      );
      // 全部拒绝路径不得留下任何 payments 行——**必须在回滚之前、用同一个 tx 数**：
      // 回滚之后再数恒为 0（测试审查 U-J11：原写法是同义反复，拒绝路径写了行也会绿）
      const inTx = await tx`select count(*)::int as n from payments`;
      expect(Number(inTx[0]?.['n'])).toBe(0);
      throw new Error('rollback-probe');
    }).catch((e: Error) => expect(e.message).toBe('rollback-probe'));
  });
});

describe('发起（JPY 通道）', () => {
  it('payments 行 initiated + 订单 pending_payment + 事件；payload 来自 entry.params', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa') });
    await seedPayable('o-1');
    const r = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pa' }),
    );
    expect(r.channel).toBe('pa');
    expect(r.charge).toEqual({ currency: 'JPY', amount: TOTAL });
    expect(r.payload).toEqual({ via: 'pa', orderId: 'o-1' });
    expect(r.expiresAt.toISOString()).toBe(EXPIRES.toISOString());

    const pays =
      await db`select provider, provider_ref, status, charge_currency, charge_amount, pay_url from payments where order_id = 'o-1'`;
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({
      provider: 'pa',
      provider_ref: 'pa-pay-o-1-pa',
      status: 'initiated',
      charge_currency: 'JPY',
      charge_amount: TOTAL,
      pay_url: null,
    });
    const order = await db`select status from orders where id = 'o-1'`;
    expect(order[0]?.['status']).toBe('pending_payment');
    const ev = await db`select status from order_events where order_id = 'o-1'`;
    expect(ev.map((e) => e['status'])).toEqual(['pending_payment']);
  });

  it('同通道复用：同一幂等键 → 同一 provider_ref，payments 仍 1 行（不新建、不重复记事件）', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa') });
    await seedPayable('o-1');
    const first = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pa' }),
    );
    const again = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pa' }),
    );
    expect(again.providerRef).toBe(first.providerRef);
    const pays = await db`select count(*)::int as n from payments where order_id = 'o-1'`;
    expect(Number(pays[0]?.['n'])).toBe(1);
    const ev = await db`select count(*)::int as n from order_events where order_id = 'o-1'`;
    expect(Number(ev[0]?.['n'])).toBe(1);
  });

  it('换通道：旧 initiated 行作废（cancelled），新通道建行；payload 来自新通道', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa'), pb: fakeProvider('pb') });
    await seedPayable('o-1');
    await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pa' }),
    );
    const r = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pb' }),
    );
    expect(r.payload).toEqual({ via: 'pb', orderId: 'o-1' });
    const rows =
      await db`select provider, status from payments where order_id = 'o-1' order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: 'pa', status: 'cancelled' });
    expect(rows[1]).toMatchObject({ provider: 'pb', status: 'initiated' });
  });

  it('换通道回切 A→B→A：机构复放旧 provider_ref 也不撞唯一键（幂等键带轮次），第三次仍成功（全量审计 P1）', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({ pa: fakeProvider('pa'), pb: fakeProvider('pb') });
    await seedPayable('o-1');
    const go = (channel: string) =>
      withTransaction(db, (tx) =>
        createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel }),
      );
    const first = await go('pa');
    await go('pb');
    const third = await go('pa');
    // 新一轮意图是**新的**机构会话（fakeProvider 的 ref 由幂等键派生，键带轮次即不同）
    expect(third.providerRef).not.toBe(first.providerRef);
    const rows =
      await db`select provider, status from payments where order_id = 'o-1' order by created_at`;
    expect(rows.map((r) => `${r.provider}:${r.status}`)).toEqual([
      'pa:cancelled',
      'pb:cancelled',
      'pa:initiated',
    ]);
  });
});

describe('copylink（D-49 短链）', () => {
  it('复用 copylink 意图**不回调机构**：provider.create 只被调一次，pay_url / provider_ref 取自库（Stripe 同键异参会 400）', async () => {
    const sink = new MemorySink();
    const base = fakeProvider('pc', { currencies: ['USD'], copylink: true });
    let creates = 0;
    const counting: PaymentProvider = {
      ...base,
      create: (req) => {
        creates += 1;
        return base.create(req);
      },
    };
    const registry = fakeRegistry({ pc: counting });
    await seedPayable('o-1');
    const first = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pc' }),
    );
    const second = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pc' }),
    );
    expect(creates).toBe(1);
    expect(second.providerRef).toBe(first.providerRef);
  });

  it('pay_url 落库；token 明文进 pay_url、sha256 落 orders.pay_token_hash（两端对得上）', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({
      pc: fakeProvider('pc', { currencies: ['USD'], copylink: true }),
    });
    await seedPayable('o-1');
    const r = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'pc' }),
    );
    const payUrl = String(r.payload['pay_url']);
    expect(payUrl.startsWith('https://checkout.example.com/o/o-1?t=')).toBe(true);
    const token = payUrl.split('?t=')[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const order = await db`select pay_token_hash from orders where id = 'o-1'`;
    const hash = createHash('sha256').update(token).digest('hex');
    expect(order[0]?.['pay_token_hash']).toBe(hash);
    expect(String(r.payload['expires_at'])).toBe(EXPIRES.toISOString());
    const pays = await db`select pay_url from payments where order_id = 'o-1'`;
    expect(pays[0]?.['pay_url']).toBe('https://pay.example.com/s/pay-o-1-pc');
  });

  it('复用轮换 token：hash 变了（旧链接即死），payments 仍 1 行同 provider_ref', async () => {
    const sink = new MemorySink();
    // 每次调用给不同 uuid（轮换的证据）
    let n = 0;
    const idGen: IdGen = {
      uuid: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
      orderSeq: () => 'AAAAAA',
    };
    const registry = fakeRegistry({
      pc: fakeProvider('pc', { currencies: ['USD'], copylink: true }),
    });
    await seedPayable('o-1');
    const d = { ...deps(registry, sink), idGen };
    const first = await withTransaction(db, (tx) =>
      createPayIntent(tx, d, { orderId: 'o-1', userId: 'u-1', channel: 'pc' }),
    );
    // 用例名说的是"hash 变了"就必须读库里的 hash——只断言 payload URL 变化时，
    // 摘掉 setPayTokenHash（hash 不落库）这个用例照样绿（缺陷注入实抓一次）。
    const h1 = await db`select pay_token_hash as h from orders where id = 'o-1'`;
    const second = await withTransaction(db, (tx) =>
      createPayIntent(tx, d, { orderId: 'o-1', userId: 'u-1', channel: 'pc' }),
    );
    const h2 = await db`select pay_token_hash as h from orders where id = 'o-1'`;
    expect(h1[0]?.['h']).toMatch(/^[0-9a-f]{64}$/);
    expect(h2[0]?.['h']).toMatch(/^[0-9a-f]{64}$/);
    expect(h2[0]?.['h']).not.toBe(h1[0]?.['h']);
    expect(second.providerRef).toBe(first.providerRef);
    expect(second.payload['pay_url']).not.toBe(first.payload['pay_url']);
    const pays = await db`select count(*)::int as n from payments where order_id = 'o-1'`;
    expect(Number(pays[0]?.['n'])).toBe(1);
  });
});

describe('扣款币种解析（JPY 锚优先）', () => {
  it('通道配置只对外宣告 USD（列表按 USD 才列出）而能力含 JPY+USD → 按 **USD** 扣，与用户看到的一致（全量审计 P1）', async () => {
    const sink = new MemorySink();
    const provider = fakeProvider('st', { currencies: ['JPY', 'USD'], copylink: true });
    const registry = createPaymentRegistry({
      configs: [
        {
          channel: 'st',
          enabled: true,
          priority: 10,
          countries: ['*'],
          currencies: ['USD'],
          label: 'st',
        },
      ],
    });
    registry.register('st', () => provider);
    await seedPayable('o-1');
    const r = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'st' }),
    );
    expect(r.charge.currency).toBe('USD');
  });

  it('USD-only 通道：按订单 fx_snapshot 换算（断言值独立复算）', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({
      us: fakeProvider('us', { currencies: ['USD'], copylink: true }),
    });
    await seedPayable('o-1');
    const r = await withTransaction(db, (tx) =>
      createPayIntent(tx, deps(registry, sink), { orderId: 'o-1', userId: 'u-1', channel: 'us' }),
    );
    expect(r.charge).toEqual({ currency: 'USD', amount: toMinor(TOTAL, toRateInt('0.0067')) });
  });

  it('USD-only 但快照缺 USD → 50003（收钱路径不降级）；能力既无 JPY 也无 USD → 40001', async () => {
    const sink = new MemorySink();
    const registry = fakeRegistry({
      us: fakeProvider('us', { currencies: ['USD'], copylink: true }),
      xx: fakeProvider('xx', { currencies: ['EUR'] }),
    });
    await seedPayable('o-nofx', { fx: { CNY: 0.049 } });
    await withTransaction(db, async (tx) => {
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-nofx',
        userId: 'u-1',
        channel: 'us',
      }).then(
        () => expect.unreachable('缺 USD 应 50003'),
        (e) => expect(codeOf(e)).toBe(50003),
      );
      await createPayIntent(tx, deps(registry, sink), {
        orderId: 'o-nofx',
        userId: 'u-1',
        channel: 'xx',
      }).then(
        () => expect.unreachable('EUR-only 应 40001'),
        (e) => expect(codeOf(e)).toBe(40001),
      );
      throw new Error('rollback-probe');
    }).catch((e: Error) => expect(e.message).toBe('rollback-probe'));
  });
});
