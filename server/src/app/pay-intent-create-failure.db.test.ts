/**
 * 职责：B3 / AJ-199 的**端到端**用例——"机构确认拒绝建会话"这条链在真实路由上跑通。
 *
 * @why 必须有一个**走路由**的用例，不能只有 `pay-intent.db.test.ts` 里的核心用例：
 *      核心只负责"算键"，而"把失败记下来"这一半在**路由的 catch**里（事务外，否则会被回滚）。
 *      只测核心的话，"路由忘了记"这个缺陷**一处都不会红**——而它恰恰是 B3 的全部内容
 *      （§2 第 21 条：自证断言不算证据；这里要的是"两个独立部分真的接上了"）。
 *
 * @why 假 Provider 而不是真 stripe：这条链要钉的是"失败 → 记数 → 换键 → 成功"的编排，
 *      与某个机构的报文格式无关（stripe 的报文形状由它自己的单测钉）。
 *      真 `mountPayIntentRoutes` + 真 `createIdempotencyExecutor` + 真 HTTP：接线要是假的，
 *      "路由到底有没有调那个记数"就变成了自己证明自己。
 *
 * @limitation 不验"结果未知不换键"的 HTTP 形态（那条在核心用例里钉）；
 *              这里只钉"确认拒绝必须换键 + 必须落一条事件"。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express, RequestHandler } from 'express';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { stubIdGen } from '../../../test/helpers/stub-id-gen.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createHttpApp, listen } from '../http.js';
import { mountPayIntentRoutes } from './pay-intent-routes.js';
import { createIdempotencyExecutor } from '../adapters/idempotency.js';
import { createIdentityCheck } from '../adapters/identity.js';
import { createPaymentRegistry } from '../adapters/payment/registry.js';
import { signToken } from './auth.js';
import { ProviderRejectedError } from '../ports/payment.js';
import type { ChannelConfig, PaymentProvider, PaymentSession } from '../ports/payment.js';
import { PAY_CREATE_FAILED_EVENT } from './payment-intent.js';

let db: Db;
const JWT_SECRET = 'pay-intent-create-failure-'.repeat(3);
const CLOCK = fixedClock('2026-01-02T12:00:00.000Z');

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
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values ('o-1', '260102-B3AAA1', 'u-1', 'created', 15_200, 4950, 0, 20_150, 1830,
            '{"USD":0.0067}', '{"recipient":"Jane","country":"US"}', 'TOS-1',
            ${new Date('2026-01-02T12:30:00.000Z')})
  `;
});

/**
 * 会失败的 Provider：`failTimes` 次之后开始成功，并把每次收到的幂等键记下来。
 * @why 键必须**看得见**：只断言"第二次 200"是不够的——键要是没换，真 Stripe 会回放缓存的 5xx，
 *      而假 Provider 不会，于是用例假绿（B3 当年正是这样全绿的）。
 */
function flakyProvider(channel: string, seen: string[], failTimes: number): PaymentProvider {
  let n = 0;
  return {
    channel,
    capabilities: {
      currencies: ['JPY'],
      countries: ['*'],
      entryMode: 'in_app',
      supportsRefund: false,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: true,
    },
    async create(req): Promise<PaymentSession> {
      seen.push(req.idempotencyKey);
      n += 1;
      if (n <= failTimes) throw new ProviderRejectedError(500, 'stripe is down');
      return {
        providerRef: `${channel}-${req.idempotencyKey}`,
        entry: { mode: 'in_app', params: { via: channel } },
      };
    },
    parseWebhook: () => Promise.reject(new Error('unused')),
  };
}

async function buildServer(
  seen: string[],
  failTimes: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-1',
  });
  const registry = createPaymentRegistry({
    configs: [
      {
        channel: 'mock',
        enabled: true,
        priority: 10,
        countries: ['*'],
        currencies: ['*'],
        label: 'pa',
      } satisfies ChannelConfig,
    ],
  });
  registry.register('mock', () => flakyProvider('mock', seen, failTimes));

  const noopLimiter: RequestHandler = (_req, _res, next) => next();
  const app = createHttpApp({
    logger,
    mount: (a: Express) => {
      mountPayIntentRoutes(a, {
        db,
        logger,
        clock: CLOCK,
        idGen: stubIdGen('B3AAAA', 'uuid-b3-0001'),
        config,
        auth: { secret: JWT_SECRET, issuer: 'waselect' },
        // 真身份检查：生产装配必传（deps 里已改成必填），这里也不能省——
        // 省掉的话本用例跑的是一条生产上不存在的接线。
        identity: createIdentityCheck(db),
        idempotency: createIdempotencyExecutor(db),
        registry,
        payLimiter: noopLimiter,
      });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, close: server.close };
}

async function pay(url: string, token: string, key: string): Promise<{ status: number }> {
  const res = await fetch(`${url}/api/v1/orders/o-1/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
    },
    body: JSON.stringify({ channel: 'mock' }),
  });
  return { status: res.status };
}

describe('B3 / AJ-199：机构确认拒绝建会话后，这张单还能付', () => {
  it('首次 5xx（50001）→ 记一条 pay_create_failed → 再次发起到手的是**新键**（不再被缓存的失败挡住）', async () => {
    const seen: string[] = [];
    const s = await buildServer(seen, 1);
    const token = await signToken(
      { sub: 'u-1', role: 'user' },
      { secret: JWT_SECRET, issuer: 'waselect' },
    );
    try {
      // ⚠️ 两把**不同的**客户端幂等键：模拟用户"点了一次失败、再点一次"（A5：换参要换键）
      expect((await pay(s.url, token, 'idem-1')).status).toBe(500);

      const ev = await db<{ n: number }[]>`
        select count(*)::int as n from order_events
         where order_id = 'o-1' and status = ${PAY_CREATE_FAILED_EVENT}`;
      expect(ev[0]?.n).toBe(1);

      expect((await pay(s.url, token, 'idem-2')).status).toBe(200);
      expect(seen).toEqual(['pay-o-1-mock', 'pay-o-1-mock-f1']);
    } finally {
      await s.close();
    }
  });

  it('记数落的是 `provider_failed:<通道>`，与退款那条口径一致（管理端能看出被拒了几次）', async () => {
    const seen: string[] = [];
    const s = await buildServer(seen, 99);
    const token = await signToken(
      { sub: 'u-1', role: 'user' },
      { secret: JWT_SECRET, issuer: 'waselect' },
    );
    try {
      expect((await pay(s.url, token, 'idem-a')).status).toBe(500);
      expect((await pay(s.url, token, 'idem-b')).status).toBe(500);
      const notes = await db<{ note: string | null }[]>`
        select note from order_events
         where order_id = 'o-1' and status = ${PAY_CREATE_FAILED_EVENT} order by id asc`;
      expect(notes.map((r) => r.note)).toEqual(['provider_failed:mock', 'provider_failed:mock']);
      expect(seen).toEqual(['pay-o-1-mock', 'pay-o-1-mock-f1']);
    } finally {
      await s.close();
    }
  });
});
