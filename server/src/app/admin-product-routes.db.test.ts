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

/** 起一个只挂了正式路由清单的 server（与生产同一条装配路径）。 */
async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: new MemorySink() });
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

  it('PUT 已存在 → 200 且库里标题变了', async () => {
    const s = await buildServer();
    const id = String(await createOne(s));
    const r = await fetch(`${s.url}/api/v1/admin/products/${id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ title: '改后标题' })),
    });
    expect(r.status).toBe(200);
    expect((await db`select title from products where id = ${id}`)[0]?.title).toBe('改后标题');
    await s.close();
  });

  it('PUT 不存在的 id → 40401（不是静默建一条新的）', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/products/no-such-id`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body()),
    });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: number }).code).toBe(40401);
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
