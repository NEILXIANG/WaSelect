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
import { SEARCH_KEYWORD_MAX_LENGTH, toMinor, toRateInt } from '@waselect/shared';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

/**
 * @param imgBaseUrl 传了才塞进 config。
 *      @why "没配"是本文件其余用例依赖的默认值，只有 AJ-361 那两条需要显式配一个，
 *           所以做成可选参数而不是给所有用例都配上——配了之后"整键省略"那一支就再也走不到了。
 */
async function buildServer(
  imgBaseUrl?: string,
  extraEnv: Record<string, string> = {},
): Promise<{
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
    JWT_SECRET: 'product-test-jwt-secret-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(imgBaseUrl === undefined ? {} : { IMG_BASE_URL: imgBaseUrl }),
    ...extraEnv,
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

/**
 * B25 / AJ-211：**一个离谱单价不得让整页 500**。
 *
 * @why 写入侧（validateProductInput 的上界）只能挡新建，挡不住存量脏数据——
 *      脏数据的来源很多：迁移、手工改库、上界收紧之前建的旧商品。
 *      所以读取侧必须**自己**能降级，不能假设"库里不会有"。
 * @why 断言必须同时钉"页面还在"与"出声了"：只断言 200 的话，
 *      把降级写成"静默跳过"（不打日志）也全绿，那就没人会去修那个脏价格。
 */
describe('B25 / AJ-211：脏价格只降级，不整页 500', () => {
  it('列表里有算不出展示价的商品 → 整页仍 200，该商品缺那个币种，并记 error', async () => {
    // 直接插库绕过写入侧校验：模拟"上界收紧之前就已存在的脏数据"。
    // 2×10^10 円 × USD 的 rateInt(6.7×10^5) ≈ 1.34×10^16 > 2^53 ⇒ toMinor 抛 RangeError
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, images, compliance_tags)
      values ('p-bad', 'Absurd', 'daily', ${20_000_000_000}, 500, 1, 'JP', 'active', '[]'::jsonb, '[]'::jsonb)
    `;
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products?size=50');
      expect(r.status).toBe(200);
      const body = r.json as { items: Array<{ id: string; display: Record<string, number> }> };
      const bad = body.items.find((p) => p.id === 'p-bad');
      expect(bad).toBeDefined();
      // 该商品的 USD 算不出 → 省略，而不是整页炸
      expect(bad?.display['USD']).toBeUndefined();
      // 其它商品照常算出来（降级只影响算不出的那一个）
      const knife = body.items.find((p) => p.id === 'p-1');
      expect(knife?.display['USD']).toBe(toMinor(8800, toRateInt('0.0067')));
      // 且必须出声：这是数据问题，不是请求问题
      const rows = srv.sink.find('display_price_failed');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.ctx).toMatchObject({ product_id: 'p-bad' });
    } finally {
      await srv.close();
    }
  });

  it('详情页同样降级（不是只修了列表）', async () => {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, images, compliance_tags)
      values ('p-bad', 'Absurd', 'daily', ${20_000_000_000}, 500, 1, 'JP', 'active', '[]'::jsonb, '[]'::jsonb)
    `;
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products/p-bad');
      expect(r.status).toBe(200);
      const body = r.json as { id: string; price_jpy: number; display: Record<string, number> };
      expect(body.price_jpy).toBe(20_000_000_000); // 日元原价照出（它本身没错）
      expect(body.display['USD']).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAT2-04：脏**汇率**只降级，不整页 500（与 AJ-211 的脏价格是同一个承诺的两半）
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 直接 `update fx_rates` 绕过写入侧：写入侧（`FX_RAW_RATE_BOUNDS`）有上界，
//      但**DB 只有 `rate > 0`、没有上界（023）**——与 `products.price_jpy` 同形，
//      而 B25 / AJ-211 当年正是据此决定"读侧必须自己能降级"。
// @why 列表与详情**各一条**：两条路径各自算汇率（列表一次算好给全部商品、
//      详情走 `displayOf`），只修一边是这类缺陷最常见的残留方式（AJ-211 就是两处一起修的）。
describe('CAT2-04：脏汇率只降级，不整页 500', () => {
  it('🔴 列表：某币种汇率超出可精确表示的范围 → 整页仍 200，该币种省略，并记 error', async () => {
    await db`update fx_rates set rate = 1234567 where quote = 'USD'`;
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products?size=50');
      expect(r.status).toBe(200);
      const body = r.json as {
        items: Array<{ id: string; display: Record<string, number> }>;
      };
      const knife = body.items.find((p) => p.id === 'p-1');
      expect(knife).toBeDefined();
      expect(knife?.display['USD']).toBeUndefined(); // 那个币种丢了，页面还在
      const rows = srv.sink.find('fx_rate_invalid');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.ctx).toMatchObject({ currency: 'USD' });
    } finally {
      await srv.close();
    }
  });

  it('🔴 详情：同样降级，且日志定位到具体商品（不是只修了列表）', async () => {
    await db`update fx_rates set rate = 1234567 where quote = 'USD'`;
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products/p-1');
      expect(r.status).toBe(200);
      const body = r.json as { price_jpy: number; display: Record<string, number> };
      expect(body.price_jpy).toBe(8800); // 日元原价照出（它本身没错）
      expect(body.display['USD']).toBeUndefined();
      const rows = srv.sink.find('fx_rate_invalid');
      expect((rows[0]?.ctx as Record<string, unknown>)['product_id']).toBe('p-1');
    } finally {
      await srv.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAT2-07：keyword 必须有长度上限
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 它是**唯一**一个不鉴权、不限流、原样进 `ILIKE '%kw%'` 的客户端可控输入：
//      无上限时一次请求就能让 PG 拿几 KB 的模式串去全表扫（`products` 无索引，CAT-19），
//      而连接池（`max: 10`）与支付回调共用——上限是这条路径上唯一的成本控制手段。
// @why 上限值从 shared 常量取、不写死 65：写死的话改常量不红，
//      而"契约写 64、代码拒 128"正是本仓反复出过的漂移（详见 AJ-360）。
describe('CAT2-07：keyword 超过上限 → 40001（且原值不进日志）', () => {
  it('🔴 超限一个字符 → 40001 + reason keyword_too_long，日志里不出现原值', async () => {
    const srv = await buildServer();
    try {
      const long = 'あ'.repeat(SEARCH_KEYWORD_MAX_LENGTH + 1);
      const r = await get(srv.url, `/api/v1/products?keyword=${encodeURIComponent(long)}`);
      expect(r.status).toBe(400);
      expect((r.json as Record<string, unknown>)['code']).toBe(40001);
      // reason 只在日志里（响应体只有 code/message）——钉它才能区分"超限"与别的 40001
      const rows = srv.sink.find('request_rejected');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect((rows[0]?.['details'] as Record<string, unknown> | undefined)?.['reason']).toBe(
        'keyword_too_long',
      );
      // 不回显：客户端可控的长串进 details 就等于把它复制一份进日志（CAT2-03 那条链）
      expect(srv.sink.lines.join('\n')).not.toContain('あ');
    } finally {
      await srv.close();
    }
  });

  it('恰好等于上限 → 200（边界必须放行：64 字的搜索词是真实存在的）', async () => {
    const srv = await buildServer();
    try {
      const exact = 'あ'.repeat(SEARCH_KEYWORD_MAX_LENGTH);
      const r = await get(srv.url, `/api/v1/products?keyword=${encodeURIComponent(exact)}`);
      expect(r.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});

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

// ═══════════════════════════════════════════════════════════════════════════
// CAT2-03：客户端可控的**无界串**不得撑出巨行日志
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 断言**日志行的长度**而不是响应码：这条路由对超长 id 本来就回 40401（PG 查不到而已），
//      响应侧看不出任何问题——真正的后果在日志：路径段会原样进 `http_path`
//      （访问日志）与 `AppError.details`（`{ product_id: String(req.params.id) }`），
//      于是**一条请求 = 一条 8KB 的日志行**，而这个端点不鉴权、无限流。
//      只看响应的话，把限长去掉照样全绿。
describe('CAT2-03：超长路径段不产生巨行日志', () => {
  it('🔴 8000 字符的 id → 仍 40401，但每一行日志都被限长且不带原值', async () => {
    const srv = await buildServer();
    try {
      const long = 'a'.repeat(8000);
      const r = await get(srv.url, `/api/v1/products/${long}`);
      expect(r.status).toBe(404);
      expect((r.json as { code: number }).code).toBe(40401);

      const lines = srv.sink.lines;
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length, line.slice(0, 60)).toBeLessThan(2000);
      }
      // 原值不得出现在任何一行里（截断了 + 留了标记）
      expect(lines.join('')).not.toContain('a'.repeat(600));
      expect(lines.join('')).toContain('…(+');
    } finally {
      await srv.close();
    }
  });

  it('正常长度的 id 照旧完整进 details（限长不得把排障要的线索也截掉）', async () => {
    const srv = await buildServer();
    try {
      await get(srv.url, '/api/v1/products/ghost');
      const rows = srv.sink.find('request_rejected');
      expect(rows).toHaveLength(1);
      const details = rows[0]?.['details'] as Record<string, unknown>;
      expect(details['product_id']).toBe('ghost');
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

  /**
   * 剩余清单 4-1：法务页绝对地址 + 商家信息（特商法表示）。
   * @why 原先回 `/legal/terms.zh.html` 这类相对路径，小程序复制到浏览器打不开（W-06 已在前端兜住"不显示"，这里补"有得显示"）。
   */
  it('🔴 /terms：配了 LEGAL_BASE_URL → 四类文档 × 三语言的绝对地址；seller 只带已配置的字段', async () => {
    const srv = await buildServer(undefined, {
      LEGAL_BASE_URL: 'https://pay.example.com/',
      SELLER_NAME: '株式会社ワセレクト',
      SELLER_EMAIL: 'support@example.com',
    });
    try {
      const r = (await get(srv.url, '/api/v1/terms')).json as {
        urls: Record<string, string>;
        documents: Record<string, Record<string, string>>;
        seller: Record<string, string>;
      };
      expect(r.urls).toEqual({
        zh: 'https://pay.example.com/legal/terms/#zh',
        ja: 'https://pay.example.com/legal/terms/#ja',
        en: 'https://pay.example.com/legal/terms/#en',
      });
      expect(Object.keys(r.documents).sort()).toEqual(['privacy', 'refund', 'terms', 'tokushoho']);
      expect(r.documents['tokushoho']?.['ja']).toBe('https://pay.example.com/legal/tokushoho/#ja');
      expect(r.seller).toEqual({ name: '株式会社ワセレクト', email: 'support@example.com' });
    } finally {
      await srv.close();
    }
  });

  it('/terms：没配 LEGAL_BASE_URL 也没配 CHECKOUT_BASE_URL → 不给 urls / documents（不给坏链接）；seller 为空对象', async () => {
    const srv = await buildServer();
    try {
      const r = (await get(srv.url, '/api/v1/terms')).json as Record<string, unknown>;
      expect(r).not.toHaveProperty('urls');
      expect(r).not.toHaveProperty('documents');
      expect(r['seller']).toEqual({});
    } finally {
      await srv.close();
    }
  });

  /** 剩余清单 4-2：客服联系方式（配置下发；没配的不给——假的联系方式比没有更贵）。 */
  it('🔴 /support：只回已配置的客服字段；全没配 → 空对象', async () => {
    const srv = await buildServer(undefined, {
      SUPPORT_EMAIL: 'support@example.com',
      SUPPORT_HOURS: '工作日 10:00–18:00（JST）',
    });
    try {
      const r = await get(srv.url, '/api/v1/support');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ email: 'support@example.com', hours: '工作日 10:00–18:00（JST）' });
    } finally {
      await srv.close();
    }
    const bare = await buildServer();
    try {
      expect((await get(bare.url, '/api/v1/support')).json).toEqual({});
    } finally {
      await bare.close();
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

// ═══════════════════════════════════════════════════════════════════════════
// AJ-361（CAT2-08 第一步）：商品图可以按 image_id 存（契约 0.6.28）
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 这两条钉的是"**中间态不坏**"：本步只给服务端加**认得** image_id 的能力，
//      管理端仍在存三档 URL。所以库里必然同时存在两种形态的条目——
//      少认一种的表现是"一半商品的图没了"且不报错，这正是本步要排除的。
// @why 直接插库而不是走 `POST /admin/products`：写入侧（第二步才切）与读侧要能**各自**
//      独立验证；用 admin 接口建单会把"写入格式"也牵进来，红灯时说不清是哪一侧坏了。
// @how ⚠️ images 用 **SQL 字面量**写，不要写 `${JSON.stringify([...])}::jsonb`：
//      postgres.js 见到 `::jsonb` 会把参数**按 jsonb 序列化**，于是传入的 JSON **文本**
//      被第二次编码 ⇒ 库里存的是"JSON 字符串包着 JSON"（`pg_typeof` 仍是 jsonb，
//      `jsonb_typeof` 变成 string），读回是 string 不是 array，`imagesOf` 直接返回 `[]`。
//      实测踩到：两条用例都拿到 `images: []`，而 SQL 与断言看上去都对。
//      （本文件前面的 insert 用字面量也是这个原因，不是巧合。）
describe('AJ-361：images 条目按 image_id 存 → 读侧拼出三档 URL', () => {
  it('🔴 配了 IMG_BASE_URL → 三档 URL 由 image_id 生成（不是把 id 原样吐给前端）', async () => {
    await db`
      update products
         set images = '[{"image_id":"img-7qk3m9vz2rx8"}]'::jsonb
       where id = 'p-1'
    `;
    // 故意带尾斜杠：顺带钉住拼接处只归一一次（出现 //img/… 就是漏了归一化）
    const srv = await buildServer('https://img.example.com/');
    try {
      const r = await get(srv.url, '/api/v1/products/p-1');
      expect(r.status).toBe(200);
      const body = r.json as { images: Array<{ thumb: string; card: string; detail: string }> };
      expect(body.images).toEqual([
        {
          thumb: 'https://img.example.com/img/img-7qk3m9vz2rx8/thumb.webp',
          card: 'https://img.example.com/img/img-7qk3m9vz2rx8/card.webp',
          detail: 'https://img.example.com/img/img-7qk3m9vz2rx8/detail.webp',
        },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('🔴 没配 IMG_BASE_URL → 按 id 存的条目整键省略、按 URL 存的照旧（页仍 200）', async () => {
    await db`
      update products
         set images = '[{"image_id":"img-7qk3m9vz2rx8"},{"thumb":"a.webp","card":"b.webp","detail":"c.webp"}]'::jsonb
       where id = 'p-1'
    `;
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/products/p-1');
      expect(r.status).toBe(200);
      const body = r.json as { images: Array<{ thumb: string }> };
      // 只剩旧形态那一条：按 id 存的渲染不出来 ⇒ 整键省略，不是吐一个拼不出域名的裸键
      expect(body.images).toEqual([{ thumb: 'a.webp', card: 'b.webp', detail: 'c.webp' }]);
    } finally {
      await srv.close();
    }
  });
});
