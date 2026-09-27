/**
 * 职责：`GET /pay/link/{id}` 的接线级真库用例（I1-U6a-2）——302 搬运（托管页/失效页）、
 *      无鉴权可达、无 CORS 头、限流挂载、token 不进任何日志。
 *
 * @why 判定组合已在 pay-link.db.test.ts 钉死；这里只钉**接线**：
 *      路由把 path/query 正确送进核心、把核心结果正确写成 302 Location，
 *      以及三条 HTTP 层承诺（契约 summary：security:[] / 不放行 CORS / 按 IP 限流）。
 *
 * @see app/pay-link-routes.ts；app/pay-link.ts
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { registerBusinessEventLog } from './business-events.js';

let db: Db;
let sink: MemorySink;
const TOKEN = 'd'.repeat(64);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const PAY_URL = 'https://checkout.stripe.com/c/pay/cs_test_route_1';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: 'pay-link-route-test-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    // 与生产同形：失效页必须落到 checkout 静态站的绝对地址（浏览器此时已在 API 域名上）
    CHECKOUT_BASE_URL: 'https://checkout.example.test/',
  });
  const app = createHttpApp({
    logger,
    mount: (a) => {
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, { config, logger, db, events });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, close: server.close };
}

/** 造一张「链接活着」的单（pending_payment + hash + initiated pay_url）。 */
async function seedLiveLink(id: string): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot,
                        terms_version, expires_at, pay_token_hash)
    values (${id}, ${`W-${id}`}, 'u-1', 'pending_payment', 1000, 200, 0, 1200, 500,
            ${db.json({ USD: 0.0066 })},
            ${db.json({ recipient: 'Taro', phone: '+12025550123', line1: '1 Main St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' })},
            'TOS-1', now() + interval '10 minutes', ${TOKEN_HASH})
  `;
  await db`
    insert into payments (id, order_id, provider, status, charge_currency, charge_amount, pay_url)
    values (${`pay-${id}`}, ${id}, 'stripe', 'initiated', 'USD', 800, ${PAY_URL})
  `;
}

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
});

describe('GET /pay/link/{id}（302 搬运）', () => {
  it('活链接 → 302 到机构托管页；无 Authorization 也可达（security:[]）', async () => {
    const srv = await buildServer();
    try {
      await seedLiveLink('o-live');
      const res = await fetch(`${srv.url}/api/v1/pay/link/o-live?t=${TOKEN}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(PAY_URL);
    } finally {
      await srv.close();
    }
  });

  it('token 错 / 缺 t / 单不存在 → 302 到相对失效页 /pay/expired（不教探测者原因）', async () => {
    const srv = await buildServer();
    try {
      await seedLiveLink('o-live');
      for (const url of [
        `${srv.url}/api/v1/pay/link/o-live?t=${'e'.repeat(64)}`,
        `${srv.url}/api/v1/pay/link/o-live`,
        `${srv.url}/api/v1/pay/link/o-ghost?t=${TOKEN}`,
      ]) {
        const res = await fetch(url, { redirect: 'manual' });
        expect(res.status).toBe(302);
        // 绝对地址 + 尾斜杠被归一（`//pay/expired` 会把静态站当成协议相对地址）
        expect(res.headers.get('location')).toBe('https://checkout.example.test/pay/expired');
      }
    } finally {
      await srv.close();
    }
  });

  it('不放行 CORS：带 Origin 也不回 access-control-allow-origin（契约承诺）', async () => {
    const srv = await buildServer();
    try {
      await seedLiveLink('o-live');
      const res = await fetch(`${srv.url}/api/v1/pay/link/o-live?t=${TOKEN}`, {
        redirect: 'manual',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('token 不进任何日志流（访问日志只有 req.path；业务日志只有 order_id/result）', async () => {
    const srv = await buildServer();
    try {
      await seedLiveLink('o-live');
      await fetch(`${srv.url}/api/v1/pay/link/o-live?t=${TOKEN}`, { redirect: 'manual' });
      await fetch(`${srv.url}/api/v1/pay/link/o-ghost?t=${TOKEN}`, { redirect: 'manual' });
      const all = JSON.stringify(sink.rows());
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(PAY_URL);
      // 访问日志事实在（path 不含 query 是 http.ts 的既定字段口径）
      expect(all).toContain('/api/v1/pay/link/o-live');
    } finally {
      await srv.close();
    }
  });

  it('限流挂载：前 30 次穿过（302），第 31 次 42901', async () => {
    const srv = await buildServer();
    try {
      // 不存在的单 → 每次都是 302 expired，正好用来纯测限流（不消耗业务侧任何资源）
      let lastStatus = 0;
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${srv.url}/api/v1/pay/link/o-x?t=${TOKEN}`, {
          redirect: 'manual',
        });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(302);
      const blocked = await fetch(`${srv.url}/api/v1/pay/link/o-x?t=${TOKEN}`, {
        redirect: 'manual',
      });
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { code: number };
      expect(body.code).toBe(42901);
    } finally {
      await srv.close();
    }
  });
});
