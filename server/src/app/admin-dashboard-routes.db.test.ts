/**
 * 职责：`GET /api/v1/admin/dashboard/sales` 的真库用例（AJ-393，管理后台对标分析第一批③）。
 *
 * @why 走真库而不是替身 Db：这里的被测物**就是** SQL 的口径——
 *      "哪些行落在窗口里""两个来源相加会不会双计"全在 SQL 里。
 *      用一个返回预设行的替身去验聚合，验的只是"我把返回值抄对了吗"。
 *
 * ── 窗口（NOW = 2026-10-08T03:00:00Z，即 JST 2026-10-08 12:00）─────────────────
 *   今日  from 2026-10-07T15:00:00Z  to 2026-10-08T15:00:00Z
 *   近 7 天 from 2026-10-01T15:00:00Z  to 2026-10-08T15:00:00Z
 *
 * @see ./admin-dashboard-routes.ts；adapters/dashboard.ts（口径与边界表的唯一出处）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { mutableClock } from '../../../test/helpers/fixed-clock.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-dashboard-test-jwt-secret-'.repeat(3);

/** 服务端"此刻"（JST 2026-10-08 12:00）。 */
const NOW = '2026-10-08T03:00:00.000Z';
const TODAY_FROM = '2026-10-07T15:00:00.000Z';
const TODAY_TO = '2026-10-08T15:00:00.000Z';
const LAST7_FROM = '2026-10-01T15:00:00.000Z';
/** 今日窗口内（JST 10-08 01:00）。 */
const T_IN_TODAY = '2026-10-07T16:00:00.000Z';
/** 今日窗口外、7 日窗口内（JST 10-07 23:59:59）。 */
const T_YESTERDAY = '2026-10-07T14:59:59.000Z';
/** 两个窗口之外（JST 09-30 09:00）。 */
const T_OUTSIDE = '2026-09-30T00:00:00.000Z';

const USER = 'u-1';
const ADMIN = 'u-admin';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink = new MemorySink();
  await db`
    insert into users (id, openid, email, is_admin)
    values (${USER}, ${`o-${USER}`}, ${`${USER}@example.com`}, false)
    on conflict (id) do nothing
  `;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${ADMIN}, ${`o-${ADMIN}`}, ${`${ADMIN}@example.com`}, true)
    on conflict (id) do update set is_admin = true
  `;
});

async function buildServer(at: string = NOW): Promise<{
  url: string;
  close: () => Promise<void>;
  setNow: (next: string) => void;
}> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-dashboard-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const fake = mutableClock(at);
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: createMemoryStorage(),
        clock: fake.clock,
      }),
  });
  const server = await listen(app);
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    close: server.close,
    setNow: fake.set,
  };
}

async function bearer(isAdmin = true): Promise<string> {
  const id = isAdmin ? ADMIN : USER;
  const t = await signToken(
    { sub: id, role: isAdmin ? 'admin' : 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  return `Bearer ${t}`;
}

async function get(
  url: string,
  path: string,
  token?: string,
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${url}${path}`, {
    headers: token === undefined ? {} : { authorization: token },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// ── 造数（直接插库；形状与 migrations 对齐，缺列会立刻红，不会静默少钱）──────────────

async function seedOrder(o: {
  id: string;
  totalJpy: number;
  status: string;
  createdAt: string;
  paidAt?: string | null;
  refundedAt?: string | null;
  isTest?: boolean;
}): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        expires_at, is_test, created_at, paid_at, refunded_at)
    values (${o.id}, ${`W-${o.id}`}, ${USER}, ${o.status},
            ${o.totalJpy}, 0, 0, ${o.totalJpy}, 500,
            '{}'::jsonb, '{}'::jsonb, 'TOS-TEST-1', ${o.createdAt},
            ${o.isTest ?? false}, ${o.createdAt}, ${o.paidAt ?? null}, ${o.refundedAt ?? null})
  `;
}

async function seedPayment(p: {
  id: string;
  orderId: string;
  status: string;
  currency: string;
  amount: number;
  paidAmount?: number | null;
  paidCurrency?: string | null;
  disputeAmount?: number | null;
  disputeOpenedAt?: string | null;
}): Promise<void> {
  await db`
    insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                          paid_amount, paid_currency, dispute_amount, dispute_opened_at, created_at)
    values (${p.id}, ${p.orderId}, 'mock', ${p.status}, ${p.currency}, ${p.amount},
            ${p.paidAmount ?? null}, ${p.paidCurrency ?? null},
            ${p.disputeAmount ?? null}, ${p.disputeOpenedAt ?? null}, ${NOW})
  `;
}

async function seedPartialRefund(r: {
  id: string;
  orderId: string;
  paymentId: string;
  currency: string;
  amount: number;
  status: string;
  createdAt: string;
  settledAt?: string | null;
}): Promise<void> {
  await db`
    insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason,
                               status, actor, created_at, settled_at)
    values (${r.id}, ${r.orderId}, ${r.paymentId}, ${r.currency}, ${r.amount}, '缺件',
            ${r.status}, 'admin:u-admin', ${r.createdAt}, ${r.settledAt ?? null})
  `;
}

async function seedFxRate(quote: string, rate: number, effectiveFrom: string): Promise<void> {
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from, created_by)
    values (${quote}, ${rate}, ${rate}, 0, ${effectiveFrom}, 'test')
  `;
}

// ── 断言辅助 ────────────────────────────────────────────────────────────────

type Window = {
  from: string;
  to: string;
  orders: number;
  paid_orders: number;
  sales_jpy: number;
  avg_jpy: number | null;
  received: { currency: string; amount: number }[];
  refunded: { currency: string; amount: number }[];
  disputed: { currency: string; amount: number }[];
};

function win(body: Record<string, unknown>, key: 'today' | 'last7'): Window {
  const w = body[key] as Window;
  return w;
}

/** 某个币种那一行的金额（没有该币种 → null，让"少了整行"能被断言到）。 */
function moneyOf(
  rows: readonly { currency: string; amount: number }[],
  currency: string,
): number | null {
  return rows.find((r) => r.currency === currency)?.amount ?? null;
}

describe('GET /api/v1/admin/dashboard/sales（AJ-393）', () => {
  it('空库：全 0 与空数组；客单价是 null 而不是 0（0 円分不清是没单还是算错）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      expect(r.status).toBe(200);
      const t = win(r.body, 'today');
      expect(t.orders).toBe(0);
      expect(t.paid_orders).toBe(0);
      expect(t.sales_jpy).toBe(0);
      expect(t.avg_jpy).toBeNull();
      expect(t.received).toEqual([]);
      expect(t.refunded).toEqual([]);
      expect(t.disputed).toEqual([]);
    } finally {
      await close();
    }
  });

  it('🔴 窗口与"当前生效汇率"都取注入时钟：推进假时钟后整段窗口跟着走', async () => {
    await seedOrder({
      id: 'o-1',
      totalJpy: 1000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-1',
      orderId: 'o-1',
      status: 'succeeded',
      currency: 'JPY',
      amount: 1000,
    });
    await seedFxRate('USD', 0.0067, '2026-10-07T00:00:00Z');
    const { url, close, setNow } = await buildServer();
    try {
      const before = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      expect(win(before.body, 'today').sales_jpy).toBe(1000);
      // 推进到 JST 10-09：那张 10-08 的单应当整段移出今日窗口
      setNow('2026-10-09T03:00:00.000Z');
      const after = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(after.body, 'today');
      expect(t.from).toBe('2026-10-08T15:00:00.000Z');
      expect(t.to).toBe('2026-10-09T15:00:00.000Z');
      expect(t.sales_jpy).toBe(0);
      // 仍在近 7 天窗口内
      expect(win(after.body, 'last7').sales_jpy).toBe(1000);
    } finally {
      await close();
    }
  });

  it('🔴 按 JST 日界切分：JST 当日 00:00 前一秒的付款不算今日，但仍算近 7 天', async () => {
    await seedOrder({
      id: 'o-today',
      totalJpy: 1000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedOrder({
      id: 'o-yday',
      totalJpy: 7000,
      status: 'paid',
      createdAt: T_YESTERDAY,
      paidAt: T_YESTERDAY,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(t.from).toBe(TODAY_FROM);
      expect(t.to).toBe(TODAY_TO);
      expect(t.sales_jpy).toBe(1000);
      expect(t.paid_orders).toBe(1);
      const w7 = win(r.body, 'last7');
      expect(w7.from).toBe(LAST7_FROM);
      // 今日 ⊆ 近 7 天：销售额必须能覆盖今日
      expect(w7.sales_jpy).toBe(8000);
      expect(w7.paid_orders).toBe(2);
    } finally {
      await close();
    }
  });

  it('🔴 订单数按下单时间、销售额按收款时间：昨天下的单今天付的钱，只进今天的"卖了多少钱"', async () => {
    await seedOrder({
      id: 'o-cross',
      totalJpy: 4200,
      status: 'paid',
      createdAt: T_YESTERDAY, // 昨天下的单
      paidAt: T_IN_TODAY, // 今天付的钱
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      // 今日：不计"来了几张单"，但计"收了多少钱"
      expect(win(r.body, 'today').orders).toBe(0);
      expect(win(r.body, 'today').sales_jpy).toBe(4200);
      expect(win(r.body, 'today').paid_orders).toBe(1);
      // 近 7 天：两个口径都算它
      expect(win(r.body, 'last7').orders).toBe(1);
      expect(win(r.body, 'last7').sales_jpy).toBe(4200);
    } finally {
      await close();
    }
  });

  it('🔴 测试单一律排除（is_test 的单不进任何窗口）', async () => {
    await seedOrder({
      id: 'o-test',
      totalJpy: 999_000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
      isTest: true,
    });
    await seedPayment({
      id: 'p-t',
      orderId: 'o-test',
      status: 'succeeded',
      currency: 'JPY',
      amount: 999_000,
    });
    await seedOrder({
      id: 'o-real',
      totalJpy: 3000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(t.orders).toBe(1);
      expect(t.sales_jpy).toBe(3000);
      // 测试单的退款 / 拒付同样不进
      expect(t.refunded).toEqual([]);
    } finally {
      await close();
    }
  });

  it('销售额按円计价，实收按扣款币种分行、不折算（USD 分与円不能直接相加）', async () => {
    await seedOrder({
      id: 'o-jpy',
      totalJpy: 10_000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-jpy',
      orderId: 'o-jpy',
      status: 'succeeded',
      currency: 'JPY',
      amount: 10_000,
      paidAmount: 10_000,
      paidCurrency: 'JPY',
    });
    await seedOrder({
      id: 'o-usd',
      totalJpy: 6800,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-usd',
      orderId: 'o-usd',
      status: 'succeeded',
      currency: 'USD',
      amount: 4590,
      paidAmount: 4612, // 机构实际扣到的（与登记数差几分）
      paidCurrency: 'USD',
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(t.sales_jpy).toBe(16_800); // 円计价合计
      expect(t.paid_orders).toBe(2);
      expect(t.avg_jpy).toBe(8400); // 四舍五入
      // 实收取实际扣款（paid_amount 优先）
      expect(moneyOf(t.received, 'JPY')).toBe(10_000);
      expect(moneyOf(t.received, 'USD')).toBe(4612);
      // 只有两行，且没有把 USD 折进円里
      expect(t.received).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('🔴 已退 = 全额退款单 + 部分退款 succeeded：两个来源相加，只取一个会漏一半', async () => {
    // ① 全额退款：只改状态机，不写 order_refunds
    await seedOrder({
      id: 'o-full',
      totalJpy: 5000,
      status: 'refunded',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
      refundedAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-full',
      orderId: 'o-full',
      status: 'refunded',
      currency: 'JPY',
      amount: 5000,
    });
    // ② 部分退款（订单仍是 paid）
    await seedOrder({
      id: 'o-part',
      totalJpy: 8000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-part',
      orderId: 'o-part',
      status: 'succeeded',
      currency: 'USD',
      amount: 5400,
    });
    await seedPartialRefund({
      id: 'rf-1',
      orderId: 'o-part',
      paymentId: 'p-part',
      currency: 'USD',
      amount: 1200,
      status: 'succeeded',
      createdAt: T_IN_TODAY,
      settledAt: T_IN_TODAY,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(moneyOf(t.refunded, 'JPY')).toBe(5000); // 全额那笔
      expect(moneyOf(t.refunded, 'USD')).toBe(1200); // 部分那笔
      expect(t.refunded).toHaveLength(2); // 两个币种各一行
    } finally {
      await close();
    }
  });

  /**
   * 先部分退 X、再整单退：整单那笔**实际出账**是 `charge − X`（`fullRefundAmount`），各按各的时间落窗。
   * @why 修订前（AJ-393 初版）把整单记成 `charge`、并把该单的部分退款整行排除：
   *      全时段合计碰巧对，但"今天退了多少"多算 X、X 所在那天少算 X（WorkBuddy 批次复审发现）。
   */
  it('🔴 先部分退再全额退：今日只算整单那笔实际退的余额，部分退款留在它自己那天', async () => {
    await seedOrder({
      id: 'o-both',
      totalJpy: 9000,
      status: 'refunded',
      createdAt: T_OUTSIDE,
      paidAt: T_OUTSIDE,
      refundedAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-both',
      orderId: 'o-both',
      status: 'refunded',
      currency: 'JPY',
      amount: 9000,
    });
    // 昨天先退过 2000（仍在近 7 天）
    await seedPartialRefund({
      id: 'rf-pre',
      orderId: 'o-both',
      paymentId: 'p-both',
      currency: 'JPY',
      amount: 2000,
      status: 'succeeded',
      createdAt: T_YESTERDAY,
      settledAt: T_YESTERDAY,
    });
    // 更早（7 天外）还退过 500：不进任何窗口，但同样要从整单余额里扣掉
    await seedPartialRefund({
      id: 'rf-old',
      orderId: 'o-both',
      paymentId: 'p-both',
      currency: 'JPY',
      amount: 500,
      status: 'succeeded',
      createdAt: T_OUTSIDE,
      settledAt: T_OUTSIDE,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      // 今日：整单那笔实际退 9000 − 2000 − 500 = 6500
      expect(moneyOf(win(r.body, 'today').refunded, 'JPY')).toBe(6500);
      // 近 7 天：6500 + 昨天的 2000 = 8500（7 天外的 500 不进窗口；不能是 9000 或 11000）
      expect(moneyOf(win(r.body, 'last7').refunded, 'JPY')).toBe(8500);
    } finally {
      await close();
    }
  });

  it('🔴 部分退款只算 succeeded：failed 不计、未落定不计；订单 refunding 也不算已退', async () => {
    await seedOrder({
      id: 'o-1',
      totalJpy: 8000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-1',
      orderId: 'o-1',
      status: 'succeeded',
      currency: 'JPY',
      amount: 8000,
    });
    await seedPartialRefund({
      id: 'rf-failed',
      orderId: 'o-1',
      paymentId: 'p-1',
      currency: 'JPY',
      amount: 3000,
      status: 'failed',
      createdAt: T_IN_TODAY,
      settledAt: T_IN_TODAY,
    });
    await seedPartialRefund({
      id: 'rf-pending',
      orderId: 'o-1',
      paymentId: 'p-1',
      currency: 'JPY',
      amount: 4000,
      status: 'pending',
      createdAt: T_IN_TODAY,
    });
    // 退款中的单：状态机还没落 refunded，不算已退
    await seedOrder({
      id: 'o-2',
      totalJpy: 4000,
      status: 'refunding',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedPayment({
      id: 'p-2',
      orderId: 'o-2',
      status: 'refunded',
      currency: 'JPY',
      amount: 4000,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      expect(win(r.body, 'today').refunded).toEqual([]);
    } finally {
      await close();
    }
  });

  it('🔴 拒付按**开案**时间落窗（上个月的单今天被拒付，要出现在今天的卡片上）', async () => {
    await seedOrder({
      id: 'o-old',
      totalJpy: 12_000,
      status: 'paid',
      createdAt: T_OUTSIDE,
      paidAt: T_OUTSIDE,
    });
    await seedPayment({
      id: 'p-old',
      orderId: 'o-old',
      status: 'succeeded',
      currency: 'USD',
      amount: 8100,
      disputeAmount: 8100,
      disputeOpenedAt: T_IN_TODAY,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(moneyOf(t.disputed, 'USD')).toBe(8100);
      // 订单本身是上个月下的，不该进今天的订单数
      expect(t.orders).toBe(0);
      expect(t.sales_jpy).toBe(0);
    } finally {
      await close();
    }
  });

  it('fx：有当日生效 USD 汇率才出现；没有时整键省略（不编 0）', async () => {
    const { url, close } = await buildServer();
    try {
      const none = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      expect(none.body).not.toHaveProperty('fx');

      // 未来才生效的汇率不算"已生效"
      await seedFxRate('USD', 0.0099, '2026-10-09T00:00:00Z');
      const future = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      expect(future.body).not.toHaveProperty('fx');

      await seedFxRate('USD', 0.0067, '2026-10-07T00:00:00Z');
      const ok = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const fx = ok.body['fx'] as { usd_rate: number; usd_effective_from: string };
      expect(fx.usd_rate).toBeCloseTo(0.0067, 8);
      expect(fx.usd_effective_from).toBe('2026-10-07T00:00:00.000Z');
    } finally {
      await close();
    }
  });

  it('客单价四舍五入；1 单时等于该单金额', async () => {
    await seedOrder({
      id: 'o-1',
      totalJpy: 1000,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedOrder({
      id: 'o-2',
      totalJpy: 1001,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    await seedOrder({
      id: 'o-3',
      totalJpy: 1001,
      status: 'paid',
      createdAt: T_IN_TODAY,
      paidAt: T_IN_TODAY,
    });
    const { url, close } = await buildServer();
    try {
      const r = await get(url, '/api/v1/admin/dashboard/sales', await bearer());
      const t = win(r.body, 'today');
      expect(t.sales_jpy).toBe(3002);
      expect(t.avg_jpy).toBe(1001); // 3002 / 3 = 1000.67 → 1001
    } finally {
      await close();
    }
  });

  it('鉴权：无 token → 401；非管理员 → 403', async () => {
    const { url, close } = await buildServer();
    try {
      const anon = await get(url, '/api/v1/admin/dashboard/sales');
      expect(anon.status).toBe(401);
      const buyer = await get(url, '/api/v1/admin/dashboard/sales', await bearer(false));
      expect(buyer.status).toBe(403);
    } finally {
      await close();
    }
  });
});

// ── 第 25 项（2026-10-10，AJ-438，契约 0.6.62）：转化漏斗 GET /admin/dashboard/funnel ─────────────
// 口径：按"人"去重（有 user_id 用 user_id；没有的借同一设备 session 在窗口内登录过的 user_id；都没有算匿名设备），
// 每一步只数"上一步也到过"的人；"有购买意向"= 加购 或 进结算（立即购买不经过购物车）；"付款成功"看 pay_start 那张单
// 是否 paid_at 非空且不是测试单。
async function seedEvent(e: {
  user: string | null;
  session: string;
  event: string;
  props?: Record<string, unknown>;
  at: string;
}): Promise<void> {
  await db`
    insert into user_events (user_id, session_id, event, props, created_at)
    values (${e.user}, ${e.session}, ${e.event}, ${db.json((e.props ?? {}) as never)}, ${e.at})
  `;
}

async function seedFunnelUsers(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db`insert into users (id, openid, email, is_admin) values (${id}, ${`o-${id}`}, null, false)
             on conflict (id) do nothing`;
  }
}

describe('AJ-438：GET /admin/dashboard/funnel 转化漏斗', () => {
  it('🔴 七类真实路径 → 六步人数（按人去重、逐步嵌套、立即购买算意向、测试单与窗口外不算）', async () => {
    await seedFunnelUsers(['u-a', 'u-b', 'u-d', 'u-e', 'u-g']);
    const t = T_IN_TODAY;
    // A：完整路径，已付款
    await seedOrder({ id: 'o-a', totalJpy: 5000, status: 'paid', createdAt: t, paidAt: t });
    for (const [ev, props] of [
      ['page_view', { page: 'home' }],
      ['page_view', { page: 'detail' }],
      ['add_to_cart', { product_id: 'p-1' }],
      ['checkout_enter', {}],
      ['pay_start', { order_id: 'o-a', channel: 'mock' }],
    ] as const)
      await seedEvent({ user: 'u-a', session: 's-a', event: ev, props, at: t });
    // B：登录前从分享链接直达详情（匿名），登录后立即购买 → 发起支付但没付
    await seedOrder({ id: 'o-b', totalJpy: 3000, status: 'pending_payment', createdAt: t });
    await seedEvent({
      user: null,
      session: 's-b',
      event: 'page_view',
      props: { page: 'detail' },
      at: t,
    });
    await seedEvent({ user: 'u-b', session: 's-b', event: 'checkout_enter', at: t });
    await seedEvent({
      user: 'u-b',
      session: 's-b',
      event: 'pay_start',
      props: { order_id: 'o-b' },
      at: t,
    });
    // C：匿名只看首页
    await seedEvent({
      user: null,
      session: 's-c',
      event: 'page_view',
      props: { page: 'home' },
      at: t,
    });
    // D：首页 → 加购，没看过详情（嵌套：第 3 步不算）
    await seedEvent({
      user: 'u-d',
      session: 's-d',
      event: 'page_view',
      props: { page: 'home' },
      at: t,
    });
    await seedEvent({
      user: 'u-d',
      session: 's-d',
      event: 'add_to_cart',
      props: { product_id: 'p-1' },
      at: t,
    });
    // E：看详情、发起支付且已付，但进结算在窗口外（嵌套：止于第 2 步）
    await seedOrder({ id: 'o-e', totalJpy: 4000, status: 'paid', createdAt: t, paidAt: t });
    await seedEvent({ user: 'u-e', session: 's-e', event: 'checkout_enter', at: T_OUTSIDE });
    await seedEvent({
      user: 'u-e',
      session: 's-e',
      event: 'page_view',
      props: { page: 'detail' },
      at: t,
    });
    await seedEvent({
      user: 'u-e',
      session: 's-e',
      event: 'pay_start',
      props: { order_id: 'o-e' },
      at: t,
    });
    // G：完整路径，但付的是测试单（付款成功不算）
    await seedOrder({
      id: 'o-g',
      totalJpy: 100,
      status: 'paid',
      createdAt: t,
      paidAt: t,
      isTest: true,
    });
    for (const [ev, props] of [
      ['page_view', { page: 'detail' }],
      ['add_to_cart', { product_id: 'p-2' }],
      ['checkout_enter', {}],
      ['pay_start', { order_id: 'o-g' }],
    ] as const)
      await seedEvent({ user: 'u-g', session: 's-g', event: ev, props, at: t });
    // 窗口外：整条路径都在 7 天之前
    await seedEvent({
      user: null,
      session: 's-old',
      event: 'page_view',
      props: { page: 'home' },
      at: T_OUTSIDE,
    });

    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/admin/dashboard/funnel', await bearer());
      expect(r.status).toBe(200);
      expect(r.body['days']).toBe(7);
      expect(r.body['from']).toBe(LAST7_FROM);
      expect(r.body['to']).toBe(TODAY_TO);
      expect(r.body['steps']).toEqual([
        { key: 'visit', visitors: 6 },
        { key: 'view_item', visitors: 4 },
        { key: 'intent', visitors: 3 },
        { key: 'checkout', visitors: 3 },
        { key: 'pay_start', visitors: 3 },
        { key: 'paid', visitors: 1 },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('🔴 days=1 只看今天；days 只收 1 / 7 / 30（其它 → 40001）；非管理员 → 403', async () => {
    await seedEvent({
      user: null,
      session: 's-y',
      event: 'page_view',
      props: { page: 'home' },
      at: T_YESTERDAY,
    });
    await seedEvent({
      user: null,
      session: 's-t',
      event: 'page_view',
      props: { page: 'home' },
      at: T_IN_TODAY,
    });
    const srv = await buildServer();
    try {
      const today = await get(srv.url, '/api/v1/admin/dashboard/funnel?days=1', await bearer());
      expect(today.body['from']).toBe(TODAY_FROM);
      expect((today.body['steps'] as Array<{ visitors: number }>)[0]?.visitors).toBe(1);
      const week = await get(srv.url, '/api/v1/admin/dashboard/funnel?days=7', await bearer());
      expect((week.body['steps'] as Array<{ visitors: number }>)[0]?.visitors).toBe(2);
      for (const bad of ['2', '0', 'abc', '7.5', '365']) {
        const r = await get(srv.url, `/api/v1/admin/dashboard/funnel?days=${bad}`, await bearer());
        expect([bad, r.status, r.body['code']]).toEqual([bad, 400, 40001]);
      }
      const user = await get(srv.url, '/api/v1/admin/dashboard/funnel', await bearer(false));
      expect(user.status).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
