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

  it('🔴 建商品：9750g（+250 包材 = 10000，恰好最高档）放行；9751g → 409/40918 且库里没多出行', async () => {
    await seedRates([2000, 10000]);
    const s = await buildServer();
    try {
      expect((await post(s, 9750)).status).toBe(201);
      const before = (await db`select count(*)::int as n from products`)[0]?.n;
      const r = await post(s, 9751);
      expect(r.status).toBe(409);
      expect(((await r.json()) as { code: number }).code).toBe(40918);
      expect((await db`select count(*)::int as n from products`)[0]?.n).toBe(before);
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
