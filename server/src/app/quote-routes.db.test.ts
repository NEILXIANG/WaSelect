/**
 * 职责：`POST /orders/quote` 的**接线级**真库用例（I1-U4，L1 层）。
 *
 * @why 本文件存在的理由是"接线"：域纯函数与仓储各有自己的测试，但
 *      「路由挂没挂上、鉴权挡不挡、装配顺序对不对、响应形状与契约对不对」
 *      只有真发请求才能证明（§2 第 35 条：能力存在 ≠ 能力被用上）。
 *      金额断言用 shared 的 toMinor/applyRate 独立复算，不从响应抄数。
 *
 * @see app/quote-routes.ts（被测）；app/mount.ts（挂载点）；routes.contract.test.ts（路由快照）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRate, toMinor, toRateInt, toRatioInt } from '@waselect/shared';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

const JWT_SECRET = 'quote-test-jwt-secret-'.repeat(3);

/** 每用例重建 app：限流计数器随之清零（store 在 mount 时建，进程级）。 */
async function buildServer(): Promise<{
  url: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: createMemoryStorage(),
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, sink, close: server.close };
}

async function postQuote(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${url}/api/v1/orders/quote`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

async function seedCatalog(): Promise<void> {
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Knife', 'kitchen', 8800, 620, 5, 'JP', 'active'),
           ('p-cup', 'Cup', 'kitchen', 3200, 480, 10, 'JP', 'active'),
           ('p-heavy', 'Stone', 'kitchen', 1000, 2000, 50, 'JP', 'active'),
           ('p-off', 'Old', 'kitchen', 1000, 100, 10, 'JP', 'offline')
  `;
  for (const s of makeShippingRates('placeholder')) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 hour'),
           ('CNY', 0.049, 0.048, 0.03, now() - interval '1 hour')
  `;
}

let token: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-q', 'o-q')`;
  await seedCatalog();
  token = await signToken({ sub: 'u-q', role: 'user' }, { secret: JWT_SECRET, issuer: 'waselect' });
});

describe('POST /orders/quote（接线）', () => {
  it('无 token → 40101（鉴权先于业务）', async () => {
    const srv = await buildServer();
    try {
      const r = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 1 }] });
      expect(r.json['code']).toBe(40101);
    } finally {
      await srv.close();
    }
  });

  it('完整报价：金额/重量/关税/展示价与契约形状逐项对上（独立复算）', async () => {
    const srv = await buildServer();
    try {
      const r = await postQuote(
        srv.url,
        {
          items: [
            { product_id: 'p-knife', qty: 1 },
            { product_id: 'p-cup', qty: 2 },
          ],
        },
        token,
      );
      expect(r.status).toBe(200);
      const items = 8800 + 3200 * 2; // 15200
      const weight = 620 + 480 * 2 + 250; // 1830 → 向上取 2000 档（4950）
      const total = items + 4950;
      expect(r.json['items_jpy']).toBe(items);
      expect(r.json['shipping_jpy']).toBe(4950);
      expect(r.json['total_jpy']).toBe(total);
      expect(r.json['weight_g']).toBe(weight);
      expect(r.json['duty_estimate']).toBe(true);
      expect(r.json['duty_jpy']).toBe(applyRate(items, toRatioInt('0.15000')));
      expect(r.json['display']).toEqual({
        USD: toMinor(total, toRateInt('0.0067')),
        CNY: toMinor(total, toRateInt('0.049')),
      });
      expect(r.json['split_hint']).toBe(false);
      expect(r.json['free_shipping_remaining_jpy']).toBeUndefined(); // 未配置包邮 → 字段不出现
      // 流 A：报价留一条 info（高频只读，不进审计流）
      const log = srv.sink.find('quote_computed')[0];
      expect(log?.['result']).toBe('ok');
      expect((log?.['ctx'] as { total_jpy?: number } | undefined)?.total_jpy).toBe(total);
    } finally {
      await srv.close();
    }
  });

  /**
   * 剩余清单 4-7（M10）：失效商品要能被定位——响应 `data.product_id` 指出是哪一件。
   * @why 购物车里五件商品、报价回"商品不存在或已下架"，用户只能逐件删掉试；带上 id 前端就能标红那一行。
   * @why 只带 product_id（买家自己购物车里的 id，不是新信息）；库存数量等内部细节仍只进日志。
   */
  it('🔴 40401 / 40901 的响应带 data.product_id（指出是哪一件），不带库存数等内部细节', async () => {
    const srv = await buildServer();
    try {
      const ghost = await postQuote(
        srv.url,
        {
          items: [
            { product_id: 'p-knife', qty: 1 },
            { product_id: 'ghost', qty: 1 },
          ],
        },
        token,
      );
      expect(ghost.json).toMatchObject({ code: 40401, data: { product_id: 'ghost' } });
      const stock = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 6 }] }, token);
      expect(stock.json['data']).toEqual({ product_id: 'p-knife' });
    } finally {
      await srv.close();
    }
  });

  it('商品不存在 / 已下架 → 40401；库存不足 → 40901；形状坏 → 40001', async () => {
    const srv = await buildServer();
    try {
      const ghost = await postQuote(srv.url, { items: [{ product_id: 'ghost', qty: 1 }] }, token);
      expect(ghost.json['code']).toBe(40401);
      const off = await postQuote(srv.url, { items: [{ product_id: 'p-off', qty: 1 }] }, token);
      expect(off.json['code']).toBe(40401);
      const stock = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 6 }] }, token);
      expect(stock.json['code']).toBe(40901);
      const empty = await postQuote(srv.url, { items: [] }, token);
      expect(empty.json['code']).toBe(40001);
      const dup = await postQuote(
        srv.url,
        {
          items: [
            { product_id: 'p-knife', qty: 1 },
            { product_id: 'p-knife', qty: 1 },
          ],
        },
        token,
      );
      expect(dup.json['code']).toBe(40001);
    } finally {
      await srv.close();
    }
  });

  /**
   * AJ-239（第二轮审查 ORD2-02）：**超重**与**运费表没配**是两件事，不能共用 50004。
   * ⚠️ 这条原先钉的是"超重 → 50004"。
   * @why 50004 是 HTTP 500「运费不可计算」，action 写的是"管理员补齐参数"——对"运费表没配"是对的；
   *      但购物车只是**太重**（超过最大一档）时，买家看到的是系统错误、没有拆单指引，
   *      而且每改一次数量就是一条 5xx + error 日志，会把真正的配置事故淹掉。
   */
  it('🔴 超重（有运费表，但包裹 > 最大档）→ 40912 拆单提示（warn 级，不是 5xx）', async () => {
    const srv = await buildServer();
    try {
      // 6 × 2000g + 250g 包材 = 12250g > 10000g 最大档
      const heavy = await postQuote(srv.url, { items: [{ product_id: 'p-heavy', qty: 6 }] }, token);
      expect(heavy.status).toBe(409);
      expect(heavy.json['code']).toBe(40912);
      expect(String(heavy.json['message'])).toContain('拆单');
      // 不是服务端故障：不得留下 error 级日志（否则会淹掉真正的配置事故）
      expect(srv.sink.rows().filter((r) => r.level === 'error')).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('🔴 运费表一档都没有（配置缺失）→ 仍是 50004（那才是要管理员处理的事故）', async () => {
    const srv = await buildServer();
    try {
      await db`update shipping_rates set active = false`;
      const none = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 1 }] }, token);
      expect(none.json['code']).toBe(50004);
    } finally {
      await srv.close();
    }
  });

  it('任一展示币汇率缺失 → 50003', async () => {
    const srv = await buildServer();
    try {
      await db`delete from fx_rates where quote = 'CNY'`;
      const noFx = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 1 }] }, token);
      expect(noFx.json['code']).toBe(50003);
    } finally {
      await srv.close();
    }
  });

  /**
   * 汇率过期保护（剩余清单 1-2 / B3）：最近一次录入早于 FX_MAX_AGE_HOURS（默认 72 小时）→ 当作缺失。
   * @why 原来只取"已生效的最新一行"，管理员一个月没更新照样报价、照样按它收美元，汇损自担且无人知道。
   */
  it('🔴 汇率最近一次录入在 4 天前 → 50003（停止报价），并打 error 日志', async () => {
    const srv = await buildServer();
    try {
      await db`update fx_rates set effective_from = now() - interval '4 days'`;
      const r = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 1 }] }, token);
      expect(r.json['code']).toBe(50003);
      expect(srv.sink.find('fx_rate_stale').length).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it('2 天前录入的汇率仍可用', async () => {
    const srv = await buildServer();
    try {
      await db`update fx_rates set effective_from = now() - interval '2 days'`;
      const r = await postQuote(srv.url, { items: [{ product_id: 'p-knife', qty: 1 }] }, token);
      expect(r.status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('限流挂在真路由上：前 30 次 40101（无 token 被鉴权拦），第 31 次 42901', async () => {
    const srv = await buildServer();
    try {
      const body = { items: [{ product_id: 'p-knife', qty: 1 }] };
      for (let i = 0; i < 30; i += 1) {
        const r = await postQuote(srv.url, body);
        expect(r.json['code']).toBe(40101);
      }
      const r = await postQuote(srv.url, body);
      expect(r.status).toBe(429);
      expect(r.json['code']).toBe(42901);
      expect(r.headers.get('retry-after')).not.toBeNull();
    } finally {
      await srv.close();
    }
  });
});
