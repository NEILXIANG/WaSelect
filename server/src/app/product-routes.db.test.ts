/**
 * 职责：`GET /products`、`GET /products/{id}`、`GET /terms`、`GET /fx` 的接线级真库用例（I1-U5a）。
 *
 * @why 本文件只验"接线与形状"：分页/过滤/转义已在 catalog.db.test.ts 钉死，
 *      这里回答的是"路由挂上了吗、公开端点真的不鉴权吗、响应与契约形状对吗、
 *      下架商品真的 40401 吗、fx 缺失时浏览真的降级而不是炸吗"。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { toMinor, toRateInt } from '@waselect/shared';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: 'product-test-jwt-secret-'.repeat(3),
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
  return { url: `http://127.0.0.1:${server.port}`, close: server.close };
}

beforeEach(async () => {
  await resetTestDb(db);
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, images, compliance_tags)
    values ('p-1', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active', '["k1.jpg"]'::jsonb, '[]'::jsonb),
           ('p-2', 'Face Cream', 'beauty', 3200, 480, 10, 'JP', 'active', '[]'::jsonb, '["cosmetic"]'::jsonb),
           ('p-3', 'Old Cup', 'daily', 1000, 300, 0, 'JP', 'offline', '[]'::jsonb, '[]'::jsonb)
  `;
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 hour')
  `;
});

async function get(url: string, path: string): Promise<{ status: number; json: never }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, json: (await res.json()) as never };
}

describe('GET /products（公开，不鉴权）', () => {
  it('列表只出上架商品；display 能算就算（CNY 无汇率 → 降级省略，不炸）', async () => {
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products');
      expect(r.status).toBe(200);
      const body = r.json as {
        items: Array<{ id: string; display: Record<string, number>; image?: unknown }>;
        total: number;
      };
      expect(body.total).toBe(2);
      const knife = body.items.find((p) => p.id === 'p-1');
      expect(knife?.display['USD']).toBe(toMinor(8800, toRateInt('0.0067')));
      expect(knife?.display['CNY']).toBeUndefined(); // 降级：缺币省略而不是 500
      expect(knife?.image).toEqual({ thumb: 'k1.jpg', card: 'k1.jpg', detail: 'k1.jpg' });
    } finally {
      await srv.close();
    }
  });

  it('分页/分类参数非法 → 40001；合法过滤生效', async () => {
    const srv = await buildServer();
    try {
      expect((await get(srv.url, '/api/v1/products?page=0')).json['code' as never]).toBe(40001);
      expect((await get(srv.url, '/api/v1/products?size=51')).json['code' as never]).toBe(40001);
      expect((await get(srv.url, '/api/v1/products?category=weapon')).json['code' as never]).toBe(
        40001,
      );
      const ok = (await get(srv.url, '/api/v1/products?category=beauty')).json as {
        items: unknown[];
      };
      expect(ok.items).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });
});

describe('GET /products/{id}', () => {
  it('详情 200（含 description/compliance_tags 等公开列）', async () => {
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products/p-2');
      expect(r.status).toBe(200);
      const p = r.json as { id: string; compliance_tags: string[]; origin_country: string };
      expect(p.compliance_tags).toEqual(['cosmetic']);
      expect(p.origin_country).toBe('JP');
      // FTC 发货时限承诺（D-39⑦ / AJ-180）：来自配置 SHIP_WITHIN_BUSINESS_DAYS（缺省 7），小程序详情页照此出文案
      expect((r.json as Record<string, unknown>)['ship_within_business_days']).toBe(7);
    } finally {
      await srv.close();
    }
  });

  it('下架与不存在同码 40401（不泄露"存在但被下架"）', async () => {
    const srv = await buildServer();
    try {
      expect((await get(srv.url, '/api/v1/products/p-3')).json['code' as never]).toBe(40401);
      expect((await get(srv.url, '/api/v1/products/ghost')).json['code' as never]).toBe(40401);
    } finally {
      await srv.close();
    }
  });
});

describe('GET /terms 与 GET /fx（公开配置端点）', () => {
  it('/terms 返回环境变量的 TERMS_VERSION（40011 的比对源）', async () => {
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/terms');
      expect(r.status).toBe(200);
      expect((r.json as { version: string }).version).toBe('TOS-TEST-1');
    } finally {
      await srv.close();
    }
  });

  it('/fx 返回 base=JPY 与各币当日含缓冲汇率；全缺时 rates 为空对象而不是炸', async () => {
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/fx');
      const fx = r.json as { base: string; rates: Record<string, number>; asOf?: string };
      expect(fx.base).toBe('JPY');
      expect(fx.rates['USD']).toBeCloseTo(0.0067, 10);
      expect(fx.rates['CNY']).toBeUndefined();
      expect(typeof fx.asOf).toBe('string');

      await db`delete from fx_rates`;
      const empty = (await get(srv.url, '/api/v1/fx')).json as { rates: Record<string, number> };
      expect(empty.rates).toEqual({});
    } finally {
      await srv.close();
    }
  });
});
