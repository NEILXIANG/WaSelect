/**
 * 职责：`/admin/products*` 四条路由的接线级真库用例（I2 U-A3）——守卫、校验、
 *      落库、404 分派。
 *
 * @why 守卫必须**接线级**测（真 HTTP + 真 JWT + 真 identity 回源）：
 *      `requireRole` 自身有单测，但"这条路由有没有挂守卫"只有接线级能证明。
 *      管理端接口泄露的代价是全库可写，属"漏一处就全盘皆输"的那类。
 *
 * @why 落库断言直接查 `products` 表，不接受"响应说建了"——
 *      响应是路由自己拼的，库才是事实（§2 第 21 条：自证断言不算证据）。
 */
import { LOW_STOCK_THRESHOLD } from '@waselect/shared';
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
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'admin-product-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

/**
 * 起一个只挂了正式路由清单的 server（与生产同一条装配路径）。
 * @param imgBaseUrl 传了才塞进 config（只有 AJ-361 那条用例需要显式配图床域名，
 *      其余用例走"未配置"的默认值——配了就再也走不到"整键省略"那一支）。
 */
async function buildServer(
  imgBaseUrl?: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  return buildServerWithSink(new MemorySink(), imgBaseUrl);
}

/** 同上，但把日志落点交回给调用方（断言"这条 warn 到底留没留"）。 */
async function buildServerWithSink(
  sink: MemorySink,
  imgBaseUrl?: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(imgBaseUrl === undefined ? {} : { IMG_BASE_URL: imgBaseUrl }),
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
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

/**
 * 插一个用户（默认管理员）；返回其 id。
 * id 由 tag 固定且 `on conflict` 幂等——同一个 tag 在一个用例里会被 seed 多次
 * （每次要 token 都调一次），不幂等就会撞主键。
 */
async function seedUser(isAdmin = true, tag = 'admin'): Promise<string> {
  const id = `u-${tag}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${tag}`}, ${`${tag}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  return id;
}

const adminToken = async (): Promise<string> =>
  signToken(
    { sub: await seedUser(true), role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
const userToken = async (): Promise<string> =>
  signToken(
    { sub: await seedUser(false, 'buyer'), role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );

/** 一条合法的商品输入（与 domain/product-input 的必填六项一致）。 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '货架测试商品',
    category: 'beauty',
    price_jpy: 3600,
    weight_g: 800,
    customs_desc_en: 'cosmetic set',
    hs_code: '3304.99',
    origin_country: 'JP',
    ...overrides,
  };
}

describe('GET /admin/products（管理端商品列表）', () => {
  it('无 token → 40101', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: number }).code).toBe(40101);
    await s.close();
  });

  it('小程序用户 token（aud=mp）→ 40301（不是 401：已认证但受众不符）', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await userToken()}` },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: number }).code).toBe(40301);
    await s.close();
  });

  it('token 合法但库里 is_admin=false → 40301（撤权即时生效，不等 12 小时过期）', async () => {
    const s = await buildServer();
    const sub = await seedUser(false, 'revoked');
    const t = await signToken({ sub, role: 'admin' }, { secret: JWT_SECRET, issuer: 'waselect' });
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.status).toBe(403);
    await s.close();
  });

  it('管理员 → 200，items 与 total 齐全（空库时 items 为 []）', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(Array.isArray(j.items)).toBe(true);
    expect(typeof j.total).toBe('number');
    await s.close();
  });

  it('四条路由**每一条**都对无 token 返回 40101（防"某条忘了挂守卫"）', async () => {
    // @why 单独一条断言覆盖全部四条：守卫是四条共用的一个实例（路由文件 @why），
    //      但"共用"靠人不改——只要有人给某条路由单独写一遍而漏了 guard，
    //      只有"那条 + 无 token"这一种组合能发现。所以每种组合都打一次。
    const s = await buildServer();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/v1/admin/products'],
      ['POST', '/api/v1/admin/products'],
      ['PUT', '/api/v1/admin/products/x'],
      ['PATCH', '/api/v1/admin/products/x/status'],
      ['PATCH', '/api/v1/admin/products/x/stock'], // AJ-403 新增的第五条
    ];
    for (const [method, path] of cases) {
      const r = await fetch(`${s.url}${path}`, {
        method,
        ...(method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }),
      });
      expect(r.status, `${method} ${path} 疑似缺守卫`).toBe(401);
    }
    await s.close();
  });
});

describe('GET /admin/products 搜索与低库存（三端联动 UI 模拟 2026-10-08）', () => {
  it('🔴 keyword 按商品名 / 日文名 / JAN 码（不区分大小写）筛；low_stock=true 只出库存 ≤ LOW_STOCK_THRESHOLD 的', async () => {
    const s = await buildServer();
    try {
      const tk = await adminToken();
      const mk = async (title: string, extra: Record<string, unknown>) =>
        fetch(`${s.url}/api/v1/admin/products`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' },
          body: JSON.stringify(body({ title, ...extra })),
        });
      await mk('Shiroi Koibito 12', { title_ja: '白い恋人', jan_code: '4902777012345', stock: 30 });
      await mk('南部铁器 铁壶', { stock: 3 });
      await mk('无印良品 中性笔', { stock: LOW_STOCK_THRESHOLD });
      const get = async (qs: string) =>
        (await (
          await fetch(`${s.url}/api/v1/admin/products?${qs}`, {
            headers: { authorization: `Bearer ${tk}` },
          })
        ).json()) as { items: { title: string }[]; total: number };
      expect((await get('keyword=koibito')).items.map((i) => i.title)).toEqual([
        'Shiroi Koibito 12',
      ]);
      expect((await get('keyword=%E7%99%BD%E3%81%84')).total).toBe(1); // 日文名「白い」
      expect((await get('keyword=4902777')).total).toBe(1); // JAN
      expect((await get('keyword=100%25')).total).toBe(0); // % 不是通配符
      const low = await get('low_stock=true');
      expect(low.items.map((i) => i.title).sort()).toEqual(['南部铁器 铁壶', '无印良品 中性笔']);
      expect((await get('low_stock=true&keyword=铁壶')).total).toBe(1);
      const bad = await fetch(`${s.url}/api/v1/admin/products?low_stock=yes`, {
        headers: { authorization: `Bearer ${tk}` },
      });
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});

describe('POST /admin/products（建商品）', () => {
  it('合法 → 201 且**库里真的有一行**（不只看响应）', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ title: '落库验证商品' })),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, unknown>;
    expect(typeof j.id).toBe('string');
    const newId = String(j.id);
    const rows = await db`select title, origin_country, status from products where id = ${newId}`;
    expect(rows[0]?.title).toBe('落库验证商品');
    expect(rows[0]?.origin_country).toBe('JP');
    await s.close();
  });

  it('含"上架即拒"标签（electrical）→ 40001 且库里没多出行', async () => {
    const s = await buildServer();
    const before = (await db`select count(*)::int as n from products`)[0]?.n ?? 0;
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ compliance_tags: ['electrical'] })),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: number }).code).toBe(40001);
    expect((await db`select count(*)::int as n from products`)[0]?.n ?? 0).toBe(Number(before));
    await s.close();
  });

  it('缺必填（price_jpy）→ 40001', async () => {
    const s = await buildServer();
    const b = body();
    delete b.price_jpy;
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(b),
    });
    expect(r.status).toBe(400);
    await s.close();
  });

  it('报关品名含禁词（SPF）→ 40001', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ customs_desc_en: 'sunscreen SPF50' })),
    });
    expect(r.status).toBe(400);
    await s.close();
  });
});

describe('PUT /admin/products/{id} 与 PATCH status', () => {
  /** 先建一个商品并返回其 id。 */
  async function createOne(s: { url: string }): Promise<string> {
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body()),
    });
    return String(((await r.json()) as Record<string, unknown>).id);
  }

  /** 库里那一行的 `updated_at`（乐观锁凭据的**真源**：响应里的也一样，但库才是事实）。 */
  async function updatedAtOf(id: string): Promise<Date> {
    const rows = await db`select updated_at from products where id = ${id}`;
    return rows[0]?.['updated_at'] as Date;
  }

  /** 打一次 PUT（凭据默认取库里的当前值）。 */
  async function put(
    s: { url: string },
    id: string,
    overrides: Record<string, unknown> = {},
    expectedUpdatedAt?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        body({
          ...overrides,
          ...(expectedUpdatedAt === undefined ? {} : { expected_updated_at: expectedUpdatedAt }),
        }),
      ),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  it('PUT 已存在 + 凭据匹配 → 200 且库里标题变了', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    const r = await put(s, id, { title: '改后标题' }, (await updatedAtOf(id)).toISOString());
    expect(r.status).toBe(200);
    expect((await db`select title from products where id = ${id}`)[0]?.title).toBe('改后标题');
    await s.close();
  });

  it('PUT 不存在的 id → 40401（不是静默建一条新的）', async () => {
    const s = await buildServer();
    const r = await put(s, 'no-such-id', {}, new Date().toISOString());
    expect(r.status).toBe(404);
    expect(r.json.code).toBe(40401);
    await s.close();
  });

  // ── 以下四条是 ADM3-02（乐观锁）的红线 ──────────────────────────────────────
  it('PUT **缺** expected_updated_at → 40001（不退化成"无锁覆盖"）', async () => {
    // @why 这条是整个 ADM3-02 的前提：如果缺凭据时只是"照旧保存"，
    //      老前端会一直能用、一直静默覆盖别人的改价——**比不能用危险得多**。
    const s = await buildServer();
    const id = await createOne(s);
    const r = await put(s, id, { title: '无凭据保存' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    expect((await db`select title from products where id = ${id}`)[0]?.title).toBe('货架测试商品');
    await s.close();
  });

  it('PUT expected_updated_at 不是合法时间 → 40001（不是当成"永远匹配"）', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    for (const bad of ['', 'not-a-date', '2026-13-99T00:00:00.000Z']) {
      const r = await put(s, id, { title: '脏凭据' }, bad);
      expect(r.status, `凭据 ${JSON.stringify(bad)} 应被拒`).toBe(400);
      expect(r.json.code).toBe(40001);
    }
    await s.close();
  });

  it('PUT 凭据过期 → 40914（**不是** 40401），且库里整行没被写', async () => {
    // @why 必须断言"不是 40401"：把"被别人改过"说成"商品不存在"，
    //      运营会去找一个根本不存在的商品，而不是去刷新——错误码指错方向比不报错更贵。
    const s = await buildServer();
    const id = await createOne(s);
    const staleAt = new Date((await updatedAtOf(id)).getTime() - 60_000).toISOString();
    const r = await put(s, id, { title: '覆盖者', price_jpy: 999 }, staleAt);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40914);

    const row = (await db`select title, price_jpy, updated_at from products where id = ${id}`)[0];
    expect(row?.title).toBe('货架测试商品');
    expect(row?.price_jpy).toBe(3600);
    expect((row?.['updated_at'] as Date).toISOString()).not.toBe(staleAt);
    await s.close();
  });

  it('PUT 冲突留 warn 日志 admin_product_update_stale（将来评估"要不要字段级合并"的数据来源）', async () => {
    const sink = new MemorySink();
    const s = await buildServerWithSink(sink);
    const id = await createOne(s);
    const staleAt = new Date((await updatedAtOf(id)).getTime() - 60_000).toISOString();
    expect((await put(s, id, { title: '覆盖者' }, staleAt)).status).toBe(409);
    const line = sink.lines.find((l) => l.includes('admin_product_update_stale'));
    expect(line).toBeDefined();
    expect(line).toContain(id); // 报障时能反查是哪一件商品
    await s.close();
  });

  // ── P2-8（第三轮缺口，AJ-386）：库存是并发写的列，updated_at 凭据护不住它 ───────────
  // @why 下单扣减 / 关单回补只动 stock、不碰 updated_at（orders.ts decrementStock 的 @why），
  //      所以运营打开表单时库存 10、期间卖出 2 件（库里 8）、运营改成 15 保存——凭据照样匹配，
  //      15 覆盖了 8，多卖出 2 件根本不存在的货。
  it('🔴 PUT 带 stock 却缺 expected_stock → 40001，库存不变', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    const before = (await db`select stock from products where id = ${id}`)[0]?.stock as number;
    const r = await put(s, id, { stock: 15 }, (await updatedAtOf(id)).toISOString());
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    expect((await db`select stock from products where id = ${id}`)[0]?.stock).toBe(before);
    await s.close();
  });

  it('🔴 PUT stock 期间被下单扣减（expected_stock 对不上）→ 40914，整行不写', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    await db`update products set stock = 10 where id = ${id}`;
    const at = (await updatedAtOf(id)).toISOString();
    await db`update products set stock = stock - 2 where id = ${id}`; // 买家下单，不碰 updated_at
    const r = await put(s, id, { stock: 15, expected_stock: 10, title: '改库存' }, at);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40914);
    const row = (await db`select stock, title from products where id = ${id}`)[0];
    expect(row?.stock).toBe(8);
    expect(row?.title).toBe('货架测试商品');
    await s.close();
  });

  it('PUT stock + expected_stock 匹配 → 200 且库存写入', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    await db`update products set stock = 10 where id = ${id}`;
    const r = await put(
      s,
      id,
      { stock: 15, expected_stock: 10 },
      (await updatedAtOf(id)).toISOString(),
    );
    expect(r.status).toBe(200);
    expect((await db`select stock from products where id = ${id}`)[0]?.stock).toBe(15);
    await s.close();
  });

  it('PATCH status=offline → 200 且库里 status 变了', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}/status`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'offline' }),
    });
    expect(r.status).toBe(200);
    expect((await db`select status from products where id = ${id}`)[0]?.status).toBe('offline');
    await s.close();
  });

  it('PATCH status 非法值 → 40001', async () => {
    const s = await buildServer();
    const id = await createOne(s);
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}/status`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'deleted' }),
    });
    expect(r.status).toBe(400);
    await s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AJ-361（CAT2-08 第一步）：管理端也可以按 image_id 存商品图
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 这条钉的是**两端都认新形态**：写入侧落库的是 id（不是三档 URL），
//      管理端列表读回时缩略图能由 id 拼出。只认一半的表现是"运营上传完图、
//      商品列表里却没有图"——而上传与列表是两个人、两个时刻，谁都不会立刻发现。
// @why 落库断言查 `products` 表而不是只看响应：响应是路由自己拼的，库才是事实
//      （§2 第 21 条：自证断言不算证据）。
describe('AJ-361：管理端按 image_id 存商品图', () => {
  it('🔴 提交 {image_id} → 落库是 id 本身；列表读回三档 URL', async () => {
    const s = await buildServer('https://img.example.com');
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ images: [{ image_id: 'img-7qk3m9vz2rx8' }] })),
    });
    expect(r.status).toBe(201);
    const id = String(((await r.json()) as { id: string }).id);

    // ① 落库：存的是 id，不是三档 URL（换 CDN 不用改历史数据的前提就在这里）
    const rows = await db`select images from products where id = ${id}`;
    expect(rows[0]?.images).toEqual([{ image_id: 'img-7qk3m9vz2rx8' }]);

    // ② 读回：管理端列表的缩略图由 id 拼出三档（键形来自 imageObjectKey）
    const list = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    const items = (
      (await list.json()) as {
        items: Array<{ id: string; images: Array<Record<string, string>> }>;
      }
    ).items;
    // ③ **回显 image_id**（0.6.29 / AJ-362）：编辑页拿不到 id ⇒ 保存时只能发回三档 URL
    //    ⇒ 一次"只改标题的编辑"就把这个商品静默退回旧形态。这一项是第二步的成立前提。
    expect(items.find((x) => x.id === id)?.images).toEqual([
      {
        thumb: 'https://img.example.com/img/img-7qk3m9vz2rx8/thumb.webp',
        card: 'https://img.example.com/img/img-7qk3m9vz2rx8/card.webp',
        detail: 'https://img.example.com/img/img-7qk3m9vz2rx8/detail.webp',
        image_id: 'img-7qk3m9vz2rx8',
      },
    ]);
    await s.close();
  });

  it('🔴 没配 IMG_BASE_URL 时，管理端列表仍回显 image_id（S-04：否则一次编辑保存就把商品图清空）', async () => {
    const withBase = await buildServer('https://img.example.com');
    const r = await fetch(`${withBase.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ images: [{ image_id: 'img-7qk3m9vz2rx8' }] })),
    });
    const id = String(((await r.json()) as { id: string }).id);
    await withBase.close();

    const noBase = await buildServer(undefined);
    const list = await fetch(`${noBase.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    const items = (
      (await list.json()) as { items: Array<{ id: string; images: Array<Record<string, string>> }> }
    ).items;
    expect(items.find((x) => x.id === id)?.images).toEqual([{ image_id: 'img-7qk3m9vz2rx8' }]);
    await noBase.close();
  });

  it('🔴 库里报关品名为 NULL → 响应**整键省略**，不得出现字面量 "null"', async () => {
    // @why 钉在**响应**上而不是只钉仓储：运营与前端看到的是 JSON。
    //      字面量 "null" 会被 `isBlank` 判为"填了"，服务端校验放行 ⇒ 报关英文品名
    //      真的变成 "null" 发往海关，而改它的人以为自己没动这一项（CAT-20）。
    const s = await buildServer();
    await db`
      insert into products (id, title, category, price_jpy, weight_g, customs_desc_en, origin_country)
      values ('p-null-desc', '缺报关品名', 'beauty', 3600, 800, null, 'JP')
    `;
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: Array<Record<string, unknown>> }).items;
    const item = items.find((x) => x['id'] === 'p-null-desc');
    expect(item).toBeDefined();
    // ⚠️ 断言"键不在"而不是"值不是 null"：给 null 与给 "null" 都是**下发了一个值**，
    //    前端 `str()` 对两者都回落成空串/字符串，只有"键不在"才是"没有"的唯一表示
    //    （与文件头 why / maker 的口径一致）。
    expect('customs_desc_en' in (item ?? {})).toBe(false);
    expect(JSON.stringify(items)).not.toContain('"null"');
    await s.close();
  });

  it('按三档 URL 存的存量条目 → 不带 image_id（不凭空造一个，也不改写它的形状）', async () => {
    const s = await buildServer('https://img.example.com');
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        body({
          images: [{ thumb: 'a.webp', card: 'b.webp', detail: 'c.webp' }],
        }),
      ),
    });
    expect(r.status).toBe(201);
    const id = String(((await r.json()) as { id: string }).id);
    const list = await fetch(`${s.url}/api/v1/admin/products`, {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    const items = (
      (await list.json()) as {
        items: Array<{ id: string; images: Array<Record<string, string>> }>;
      }
    ).items;
    expect(items.find((x) => x.id === id)?.images).toEqual([
      { thumb: 'a.webp', card: 'b.webp', detail: 'c.webp' },
    ]);
    await s.close();
  });
});

/**
 * P2-30（第三轮缺口）：在售商品"单件 + 包材"必须落在**当前生效运费表**的最高档内。
 * @why 商品重量上界 `PRODUCT_MAX_WEIGHT_G` 跟的是运费表**能装多重**（30kg 结构上限），不是**实际配了多重**：
 *      表只配到 10kg 时 10–29kg 的商品照样能上架，买家加购后报价才撞 40912——问题暴露在最晚、最不该的那一步。
 * @see domain/shipping-fit.ts；默认 PACKAGING_WEIGHT_G = 250（config.ts）
 */
describe('上架重量 vs 运费表最高档（P2-30 / 40918）', () => {
  async function seedRates(maxes: readonly number[]): Promise<void> {
    for (const [i, m] of maxes.entries()) {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('Japan Post EMS', ${m}, ${1400 + i * 1000}, true)
      `;
    }
  }

  async function post(s: { url: string }, weight: number): Promise<Response> {
    return fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ weight_g: weight })),
    });
  }

  /** PATCH /status（P2-30 的判定点之一；AJ-403 起草稿上架也走这里）。 */
  async function patchStatus(
    s: { url: string },
    id: string,
    status: string,
  ): Promise<{ status: number; code: unknown }> {
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}/status`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    return { status: r.status, code: ((await r.json()) as { code?: unknown }).code };
  }

  // AJ-403：新建 = 草稿，草稿不对买家可见 ⇒ 建的那一刻不判重量；判定挪到"草稿 → 在售"那一步。
  // 边界值与原用例相同（9750 恰好最高档放行、9751 超一克拒）。
  it('🔴 建草稿不判重量（9751g 也 201）；草稿上架：9750g 放行、9751g → 409/40918 且仍为草稿', async () => {
    await seedRates([2000, 10000]);
    const s = await buildServer();
    try {
      const okId = String(((await (await post(s, 9750)).json()) as { id: string }).id);
      const heavy = await post(s, 9751);
      expect(heavy.status).toBe(201);
      const heavyId = String(((await heavy.json()) as { id: string }).id);
      expect(await patchStatus(s, okId, 'active')).toEqual({ status: 200, code: undefined });
      expect(await patchStatus(s, heavyId, 'active')).toEqual({ status: 409, code: 40918 });
      expect((await db`select status from products where id = ${heavyId}`)[0]?.status).toBe(
        'draft',
      );
    } finally {
      await s.close();
    }
  });

  it('没有任何生效运费档 → 不判（此时报价本就 50004，不该连商品都建不了）', async () => {
    const s = await buildServer();
    try {
      expect((await post(s, 20000)).status).toBe(201);
    } finally {
      await s.close();
    }
  });

  it('🔴 改在售商品把重量改超 → 40918；下架中的商品改超放行，但重新上架 → 40918', async () => {
    await seedRates([10000]);
    const s = await buildServer();
    try {
      const id = String(((await (await post(s, 800)).json()) as { id: string }).id);
      const putWeight = async (w: number): Promise<{ status: number; code: unknown }> => {
        const at = (
          (await db`select updated_at from products where id = ${id}`)[0]?.['updated_at'] as Date
        ).toISOString();
        const r = await fetch(`${s.url}/api/v1/admin/products/${id}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await adminToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body({ weight_g: w, expected_updated_at: at })),
        });
        return { status: r.status, code: ((await r.json()) as { code?: unknown }).code };
      };
      const setStatus = async (status: string): Promise<{ status: number; code: unknown }> => {
        const r = await fetch(`${s.url}/api/v1/admin/products/${id}/status`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${await adminToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status }),
        });
        return { status: r.status, code: ((await r.json()) as { code?: unknown }).code };
      };

      // AJ-403：新建是草稿，先上架才是本用例要测的"在售商品"
      expect((await setStatus('active')).status).toBe(200);
      expect(await putWeight(12000)).toEqual({ status: 409, code: 40918 });
      expect((await db`select weight_g from products where id = ${id}`)[0]?.weight_g).toBe(800);

      expect((await setStatus('offline')).status).toBe(200);
      expect((await putWeight(12000)).status).toBe(200); // 下架中：允许先把真实重量录进来
      expect(await setStatus('active')).toEqual({ status: 409, code: 40918 });
      expect((await db`select status from products where id = ${id}`)[0]?.status).toBe('offline');
    } finally {
      await s.close();
    }
  });
});

/**
 * AJ-403（管理端第二批 C）：商品**草稿**状态。
 * @why 新建即在售的后果是"半成品被买家看到"：图还没传、文案没写好，买家已经能加购。
 *      草稿是第三个状态，买家侧四个入口一律按"不在售"处理（与 offline 同口径，见 admin-catalog-buyer-chain）。
 * @why 草稿只能是**起点**：PATCH 不接受 `draft`——上过架的商品"不卖了"叫下架，
 *      退回草稿会让"它曾经卖过"这件事在状态上消失。
 */
describe('草稿状态（AJ-403）', () => {
  async function create(
    s: { url: string },
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${s.url}/api/v1/admin/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body(extra)),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  async function patchStatus(s: { url: string }, id: string, status: unknown): Promise<number> {
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}/status`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    return r.status;
  }

  const dbStatus = async (id: string): Promise<unknown> =>
    (await db`select status from products where id = ${id}`)[0]?.status;

  it('🔴 新建 → 201，响应与库里都是 draft', async () => {
    const s = await buildServer();
    try {
      const r = await create(s);
      expect(r.status).toBe(201);
      expect(r.json['status']).toBe('draft');
      expect(await dbStatus(String(r.json['id']))).toBe('draft');
    } finally {
      await s.close();
    }
  });

  it('🔴 请求体自带 status=active 也只建草稿（上架只走 PATCH /status，判定只有一处）', async () => {
    const s = await buildServer();
    try {
      const r = await create(s, { status: 'active' });
      expect(r.status).toBe(201);
      expect(await dbStatus(String(r.json['id']))).toBe('draft');
    } finally {
      await s.close();
    }
  });

  it('🔴 PATCH 状态迁移表：draft→active / active→offline / offline→active 放行；任何 → draft 一律 40001 且库里不变', async () => {
    const s = await buildServer();
    try {
      const id = String((await create(s)).json['id']);
      expect(await patchStatus(s, id, 'draft')).toBe(400); // 草稿 → 草稿：也不收这个值
      expect(await dbStatus(id)).toBe('draft');
      expect(await patchStatus(s, id, 'active')).toBe(200);
      expect(await dbStatus(id)).toBe('active');
      expect(await patchStatus(s, id, 'draft')).toBe(400);
      expect(await dbStatus(id)).toBe('active');
      expect(await patchStatus(s, id, 'offline')).toBe(200);
      expect(await patchStatus(s, id, 'draft')).toBe(400);
      expect(await dbStatus(id)).toBe('offline');
      expect(await patchStatus(s, id, 'active')).toBe(200);
      // 草稿直接"不要了" → offline 也放行（不强制先上架一次）
      const id2 = String((await create(s)).json['id']);
      expect(await patchStatus(s, id2, 'offline')).toBe(200);
      expect(await dbStatus(id2)).toBe('offline');
    } finally {
      await s.close();
    }
  });

  it('🔴 GET ?status=draft 只出草稿；?status=active 不含草稿；不传 = 全部', async () => {
    const s = await buildServer();
    try {
      const d = String((await create(s, { title: '草稿甲' })).json['id']);
      const a = String((await create(s, { title: '在售乙' })).json['id']);
      expect(await patchStatus(s, a, 'active')).toBe(200);
      const get = async (qs: string): Promise<string[]> => {
        const r = await fetch(`${s.url}/api/v1/admin/products${qs}`, {
          headers: { authorization: `Bearer ${await adminToken()}` },
        });
        expect(r.status).toBe(200);
        return ((await r.json()) as { items: { id: string }[] }).items.map((i) => i.id).sort();
      };
      expect(await get('?status=draft')).toEqual([d]);
      expect(await get('?status=active')).toEqual([a]);
      expect(await get('')).toEqual([a, d].sort());
    } finally {
      await s.close();
    }
  });

  it('草稿改重量不判运费表（同下架中：先录真实重量，上架时再判）', async () => {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values ('Japan Post EMS', 10000, 9000, true)
    `;
    const s = await buildServer();
    try {
      const id = String((await create(s)).json['id']);
      const at = (
        (await db`select updated_at from products where id = ${id}`)[0]?.['updated_at'] as Date
      ).toISOString();
      const r = await fetch(`${s.url}/api/v1/admin/products/${id}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${await adminToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body({ weight_g: 12000, expected_updated_at: at })),
      });
      expect(r.status).toBe(200);
      expect(await dbStatus(id)).toBe('draft'); // PUT 不碰状态
    } finally {
      await s.close();
    }
  });
});

/**
 * AJ-403：图片顺序 = 数组顺序，第一张是主图。前端"上移 / 设为主图"只是重排数组再 PUT，
 * 这条钉的是**服务端不重排、不去重地原样落库并原样读回**——否则前端排得再好，保存一次就打回原形。
 */
describe('商品图顺序（AJ-403）', () => {
  it('🔴 PUT 把图片换个顺序 → 库里与列表读回都是新顺序', async () => {
    const s = await buildServer('https://img.example.com');
    try {
      const imgs = ['img-aaaaaaaaaaaa', 'img-bbbbbbbbbbbb', 'img-cccccccccccc'];
      const created = await fetch(`${s.url}/api/v1/admin/products`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await adminToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body({ images: imgs.map((image_id) => ({ image_id })) })),
      });
      const id = String(((await created.json()) as { id: string }).id);
      const at = (
        (await db`select updated_at from products where id = ${id}`)[0]?.['updated_at'] as Date
      ).toISOString();
      const reordered = [imgs[2], imgs[0], imgs[1]] as string[]; // 第三张设为主图
      const r = await fetch(`${s.url}/api/v1/admin/products/${id}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${await adminToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          body({
            images: reordered.map((image_id) => ({ image_id })),
            expected_updated_at: at,
          }),
        ),
      });
      expect(r.status).toBe(200);
      expect((await db`select images from products where id = ${id}`)[0]?.images).toEqual(
        reordered.map((image_id) => ({ image_id })),
      );
      const list = await fetch(`${s.url}/api/v1/admin/products`, {
        headers: { authorization: `Bearer ${await adminToken()}` },
      });
      const items = (
        (await list.json()) as { items: { id: string; images: { image_id: string }[] }[] }
      ).items;
      expect(items.find((x) => x.id === id)?.images.map((i) => i.image_id)).toEqual(reordered);
    } finally {
      await s.close();
    }
  });
});

/**
 * AJ-403：列表内联改库存 `PATCH /admin/products/{id}/stock`。
 * @why 窄接口而不是复用整行 PUT：PUT 要带齐全部字段 + `expected_updated_at`，列表行若拿它改库存，
 *      任何一次"别人改了标题"都会让改库存 40914；而库存真正需要护住的只有"期间被下单扣减"这一件事。
 * @why 不推进 `updated_at`：它的语义是"商品**信息**最后被改的时刻"（catalog-admin.ts 文件头），
 *      库存是余额不是信息；推进它会让正在编辑同一商品的人保存时无辜 40914，列表也会把这一行顶到第一位。
 */
describe('PATCH /admin/products/{id}/stock（AJ-403）', () => {
  async function seedProduct(stock: number): Promise<{ id: string; updatedAt: Date }> {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, customs_desc_en, origin_country, status)
      values ('p-stock', '库存测试 白い恋人 12枚', 'food', 1200, 300, ${stock}, 'cookies', 'JP', 'active')
    `;
    const at = (await db`select updated_at from products where id = 'p-stock'`)[0]?.['updated_at'];
    return { id: 'p-stock', updatedAt: at as Date };
  }

  async function patchStock(
    s: { url: string },
    id: string,
    payload: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}/stock`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  const stockOf = async (id: string): Promise<unknown> =>
    (await db`select stock from products where id = ${id}`)[0]?.stock;

  it('🔴 expected_stock 对上 → 200 {id, stock}，库里写入；updated_at **不变**', async () => {
    const s = await buildServer();
    try {
      const p = await seedProduct(3);
      const r = await patchStock(s, p.id, { stock: 30, expected_stock: 3 });
      expect(r).toEqual({ status: 200, json: { id: p.id, stock: 30 } });
      expect(await stockOf(p.id)).toBe(30);
      const after = (await db`select updated_at from products where id = ${p.id}`)[0]?.[
        'updated_at'
      ] as Date;
      expect(after.toISOString()).toBe(p.updatedAt.toISOString());
    } finally {
      await s.close();
    }
  });

  it('🔴 期间被下单扣减（expected_stock 对不上）→ 409/40914，库存不被覆盖，留 warn', async () => {
    const sink = new MemorySink();
    const s = await buildServerWithSink(sink);
    try {
      const p = await seedProduct(3);
      await db`update products set stock = stock - 1 where id = ${p.id}`; // 模拟下单扣减
      const r = await patchStock(s, p.id, { stock: 30, expected_stock: 3 });
      expect(r.status).toBe(409);
      expect(r.json['code']).toBe(40914);
      expect(await stockOf(p.id)).toBe(2);
      expect(sink.lines.some((l) => l.includes('admin_product_stock_stale'))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('🔴 输入边界：缺 expected_stock / 负数 / 小数 / 字符串 / 缺 stock → 40001，库存不变；stock=0 合法', async () => {
    const s = await buildServer();
    try {
      const p = await seedProduct(3);
      const bad: unknown[] = [
        { stock: 30 },
        { stock: -1, expected_stock: 3 },
        { stock: 1.5, expected_stock: 3 },
        { stock: '30', expected_stock: 3 },
        { expected_stock: 3 },
        { stock: 30, expected_stock: -1 },
        { stock: 30, expected_stock: '3' },
        { stock: 2147483648, expected_stock: 3 }, // INT 列上界 + 1（库层兜底也会 40001；精确 reason 由单测钉）
      ];
      for (const b of bad) {
        const r = await patchStock(s, p.id, b);
        expect(r.status, JSON.stringify(b)).toBe(400);
        expect(r.json['code'], JSON.stringify(b)).toBe(40001);
      }
      expect(await stockOf(p.id)).toBe(3);
      expect((await patchStock(s, p.id, { stock: 0, expected_stock: 3 })).status).toBe(200);
      expect(await stockOf(p.id)).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('不存在的 id → 40401（不是 40914：对不上的不是库存，是商品本身）', async () => {
    const s = await buildServer();
    try {
      const r = await patchStock(s, 'p-nope', { stock: 1, expected_stock: 0 });
      expect(r.status).toBe(404);
      expect(r.json['code']).toBe(40401);
    } finally {
      await s.close();
    }
  });
});
