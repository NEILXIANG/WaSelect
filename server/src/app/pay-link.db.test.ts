/**
 * 职责：短链判定核心（pay-link.ts）的真库用例（I1-U6a-2）——判定链每一环的
 *      expired 归一、唯一 redirect 路径、日志脱敏（token/pay_url 不进日志）。
 *
 * @why 判定链的每一环都单独钉：失败原因对外不可见（都 302 到同一个失效页），
 *      如果只在路由层测「给了个错 token → 302」，那么「状态守卫被偷换成始终放行」
 *      这类注入在路由层与正确实现**表现完全相同**——必须把 reason 钉在核心层。
 *
 * @see app/pay-link.ts；adapters/orders.ts findPayLinkTarget
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { resolvePayLink } from './pay-link.js';

let db: Db;
const NOW = new Date('2026-09-26T12:00:00Z');
const TOKEN = 'a'.repeat(64); // issuePayLink 的形状：双 uuid 去横线（64 hex）
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const PAY_URL = 'https://checkout.stripe.com/c/pay/cs_test_link_1';

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
});

function clockAt(now: Date): Clock {
  return { now: () => now };
}

/** 造一张带短链素材的单（状态/过期/hash/支付行逐项可配，默认全合法）。 */
async function seedLinkOrder(
  id: string,
  over: {
    status?: string;
    expiresAt?: Date;
    withHash?: boolean;
    withInitiatedPay?: boolean;
  } = {},
): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot,
                        terms_version, expires_at, pay_token_hash)
    values (${id}, ${`W-${id}`}, 'u-1', ${over.status ?? 'pending_payment'},
            1000, 200, 0, 1200, 500,
            ${db.json({ USD: 0.0066 })},
            ${db.json({ recipient: 'Taro', phone: '+12025550123', line1: '1 Main St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' })},
            'TOS-1', ${over.expiresAt ?? new Date(NOW.getTime() + 600_000)},
            ${over.withHash === false ? null : TOKEN_HASH})
  `;
  if (over.withInitiatedPay !== false) {
    await db`
      insert into payments (id, order_id, provider, status, charge_currency, charge_amount, pay_url)
      values (${`pay-${id}`}, ${id}, 'stripe', 'initiated', 'USD', 800, ${PAY_URL})
    `;
  }
}

async function resolve(
  sink: MemorySink,
  input: { orderId: string; token: string },
  now: Date = NOW,
) {
  const logger = createLogger({ env: 'test', destination: sink });
  return resolvePayLink(db, { clock: clockAt(now), logger }, input);
}

describe('resolvePayLink：唯一 redirect 路径', () => {
  it('token 对 + pending_payment + 未过期 + 在途支付 → redirect 到 pay_url', async () => {
    const sink = new MemorySink();
    await seedLinkOrder('o-ok');
    const r = await resolve(sink, { orderId: 'o-ok', token: TOKEN });
    expect(r).toEqual({ type: 'redirect', url: PAY_URL });
  });
});

describe('resolvePayLink：失败全部归一为 expired（reason 只进内部日志）', () => {
  it('token 形状错（非 64 hex）→ token_malformed，且不查库也安全', async () => {
    const sink = new MemorySink();
    const r = await resolve(sink, { orderId: 'o-ghost', token: 'short' });
    expect(r).toEqual({ type: 'expired', reason: 'token_malformed' });
  });

  it('订单不存在 → order_not_found', async () => {
    const sink = new MemorySink();
    const r = await resolve(sink, { orderId: 'o-ghost', token: TOKEN });
    expect(r).toEqual({ type: 'expired', reason: 'order_not_found' });
  });

  it('token 64hex 但不符 → token_mismatch；hash 未落（从未发起 copylink）同码', async () => {
    const sink = new MemorySink();
    await seedLinkOrder('o-bad');
    const wrong = await resolve(sink, { orderId: 'o-bad', token: 'b'.repeat(64) });
    expect(wrong).toEqual({ type: 'expired', reason: 'token_mismatch' });

    await seedLinkOrder('o-nohash', { withHash: false });
    const noHash = await resolve(sink, { orderId: 'o-nohash', token: TOKEN });
    expect(noHash).toEqual({ type: 'expired', reason: 'token_mismatch' });
  });

  it('token 轮换后旧链接即死：覆盖写新 hash → 旧 token mismatch、新 token 放行', async () => {
    const sink = new MemorySink();
    await seedLinkOrder('o-rot');
    const newToken = 'c'.repeat(64);
    const newHash = createHash('sha256').update(newToken).digest('hex');
    await db`update orders set pay_token_hash = ${newHash} where id = 'o-rot'`;

    const old = await resolve(sink, { orderId: 'o-rot', token: TOKEN });
    expect(old).toEqual({ type: 'expired', reason: 'token_mismatch' });
    const fresh = await resolve(sink, { orderId: 'o-rot', token: newToken });
    expect(fresh).toEqual({ type: 'redirect', url: PAY_URL });
  });

  it('非 pending_payment（paid / cancelled / expired / created）→ status_* 各自归一', async () => {
    const sink = new MemorySink();
    for (const [id, status] of [
      ['o-paid', 'paid'],
      ['o-cxl', 'cancelled'],
      ['o-expd', 'expired'],
      ['o-crt', 'created'],
    ] as const) {
      // expired 终态单可能残留 initiated 行（关单 job 本体不作废，D-50 订阅者负责）；
      // 状态守卫必须先于 pay_url 命中——否则旧链接在关单后仍能跳
      await seedLinkOrder(id, { status });
      const r = await resolve(sink, { orderId: id, token: TOKEN });
      expect(r).toEqual({ type: 'expired', reason: `status_${status}` });
    }
  });

  it('到点未扫（pending_payment 但 now >= expires_at）→ window_closed（含等号边界）', async () => {
    const sink = new MemorySink();
    const expiresAt = new Date(NOW.getTime() + 60_000);
    await seedLinkOrder('o-late', { expiresAt });
    // 恰在 expires_at 这一毫秒 = 已不可付（与关单/mark-paid/pay-intent 同一比较方向）
    const r = await resolve(sink, { orderId: 'o-late', token: TOKEN }, expiresAt);
    expect(r).toEqual({ type: 'expired', reason: 'window_closed' });
  });

  it('无在途支付行（pay_url null）→ no_initiated_payment', async () => {
    const sink = new MemorySink();
    await seedLinkOrder('o-nopay', { withInitiatedPay: false });
    const r = await resolve(sink, { orderId: 'o-nopay', token: TOKEN });
    expect(r).toEqual({ type: 'expired', reason: 'no_initiated_payment' });
  });
});

describe('resolvePayLink：日志脱敏（ADR-29：链接即钥匙）', () => {
  it('redirect 与 expired 的日志都不含 token 明文与 pay_url', async () => {
    const sink = new MemorySink();
    await seedLinkOrder('o-log1');
    await resolve(sink, { orderId: 'o-log1', token: TOKEN });
    await resolve(sink, { orderId: 'o-ghost', token: TOKEN });

    const all = JSON.stringify(sink.rows());
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(PAY_URL);
    expect(all).not.toContain(TOKEN_HASH);
    // 但判定事实（order_id / result / reason）必须在——否则线上排查"链接为什么失效"无从下手
    expect(all).toContain('pay_link_resolved');
    expect(all).toContain('order_not_found');
  });
});
