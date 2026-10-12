/**
 * 职责：后台商品分类接口（admin-category-routes.ts，AJ-491）的集成测试——真实 Postgres + 真实路由（含生产装配 mountAllRoutes）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
let sink: MemorySink;
const JWT_SECRET = 'admin-category-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

// product_categories 是保留种子的字典表（resetTestDb 不清）：本文件只增删 probe_ 开头的键，前后各清一次
const cleanProbes = async (): Promise<void> => {
  await db`delete from products where category like 'probe\\_%'`;
  await db`delete from product_categories where key like 'probe\\_%'`;
};

beforeEach(async () => {
  await resetTestDb(db);
  await cleanProbes();
  sink = new MemorySink();
});
afterEach(cleanProbes);

/** IMG_BASE_URL 不传即"未配置"（optionalUrl）；传了才拼 image。 */
async function buildServer(imgBaseUrl?: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-category-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(imgBaseUrl !== undefined ? { IMG_BASE_URL: imgBaseUrl } : {}),
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

async function seedUser(isAdmin: boolean, tag: string): Promise<string> {
  const id = `u-${tag}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${tag}`}, ${`${tag}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  return id;
}

/** ⚠️ `signToken` 是 async——必须 await，否则拼出 "Bearer [object Promise]"。 */
async function bearer(isAdmin = true): Promise<string> {
  const sub = await seedUser(isAdmin, isAdmin ? 'admin' : 'buyer');
  const t = await signToken(
    { sub, role: isAdmin ? 'admin' : 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  return `Bearer ${t}`;
}

async function call(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

const code = (r: { body: unknown }): number => Number((r.body as { code?: number })?.code);

const data = (r: { body: unknown }): unknown => (r.body as { data?: unknown })?.data;

/** 等到某一条审计行落库（审计在响应之后写），返回是否等到。 */
async function auditHas(action: string, target: string | null): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const rows =
      await db`select 1 from admin_audit where action = ${action} and target is not distinct from ${target}`;
    if (rows.length > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

async function auditRows(): Promise<Array<{ action: string; target: string | null }>> {
  for (let i = 0; i < 50; i++) {
    const rows =
      await db`select action, target from admin_audit where action like '% /admin/categories%' order by id`;
    if (rows.length > 0)
      return rows.map((r) => ({
        action: String(r.action),
        target: r.target === null ? null : String(r.target),
      }));
    await new Promise((res) => setTimeout(res, 20));
  }
  return [];
}

describe('后台商品分类接口', () => {
  it('🔴 列表：管理员看到预置四类（带在售 / 全部商品数）；买家 token → 403', async () => {
    const s = await buildServer();
    await db`insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
             values ('p-f1', '茶', 'food', 1000, 100, 'JP', 'active'), ('p-f2', '茶 2', 'food', 1000, 100, 'JP', 'draft')`;
    const r = await call(s.url, 'GET', '/api/v1/admin/categories', undefined, await bearer());
    expect(r.status).toBe(200);
    const items = (r.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.slice(0, 4).map((c) => c['key'])).toEqual(['beauty', 'daily', 'kitchen', 'food']);
    expect(items.find((c) => c['key'] === 'food')).toMatchObject({
      name: '食品',
      active: true,
      active_product_count: 1,
      product_count: 2,
    });
    const buyer = await call(
      s.url,
      'GET',
      '/api/v1/admin/categories',
      undefined,
      await bearer(false),
    );
    expect(buyer.status).toBe(403);
    await s.close();
  });

  it('🔴 新建 → 201 并记审计（目标 = 键）；形状不对 → 40001 带字段原因；键 / 名称重复 → 40001 duplicate', async () => {
    const s = await buildServer();
    const t = await bearer();
    const ok = await call(
      s.url,
      'POST',
      '/api/v1/admin/categories',
      { key: 'probe_tea', name: '日本茶', sort: 50 },
      t,
    );
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ key: 'probe_tea', name: '日本茶', sort: 50, active: true });
    expect(await auditRows()).toContainEqual({
      action: 'POST /admin/categories',
      target: 'probe_tea',
    });
    const bad = await call(
      s.url,
      'POST',
      '/api/v1/admin/categories',
      { key: 'Tea!', name: '茶' },
      t,
    );
    expect([bad.status, code(bad)]).toEqual([400, 40001]);
    expect(data(bad)).toEqual({ field: 'key', reason: 'key_invalid', count: 1 });
    const dupKey = await call(
      s.url,
      'POST',
      '/api/v1/admin/categories',
      { key: 'probe_tea', name: '别名' },
      t,
    );
    expect(data(dupKey)).toEqual({ field: 'key', reason: 'duplicate', count: 1 });
    const dupName = await call(
      s.url,
      'POST',
      '/api/v1/admin/categories',
      { key: 'probe_tea2', name: '日本茶' },
      t,
    );
    expect(data(dupName)).toEqual({ field: 'name', reason: 'duplicate', count: 1 });
    await s.close();
  });

  it('🔴 修改：改名 / 排序 / 停用 → 200 回新值；不存在 → 404 / 40404；想改键 → 40001', async () => {
    const s = await buildServer();
    const t = await bearer();
    await call(s.url, 'POST', '/api/v1/admin/categories', { key: 'probe_tea', name: '日本茶' }, t);
    const r = await call(
      s.url,
      'PUT',
      '/api/v1/admin/categories/probe_tea',
      { name: '茶叶', sort: 5, active: false },
      t,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ key: 'probe_tea', name: '茶叶', sort: 5, active: false });
    // AJ-497：路径参数叫 :key 不叫 :id，审计中间件原先只认 :id ⇒ 改分类的审计行 target 是 NULL（运营日志"对象"一栏写"—"）
    expect(await auditHas('PUT /admin/categories/:key', 'probe_tea')).toBe(true);
    const missing = await call(
      s.url,
      'PUT',
      '/api/v1/admin/categories/probe_nope',
      { name: '无' },
      t,
    );
    expect([missing.status, code(missing)]).toEqual([404, 40404]);
    const rekey = await call(
      s.url,
      'PUT',
      '/api/v1/admin/categories/probe_tea',
      { key: 'probe_x' },
      t,
    );
    expect([rekey.status, code(rekey)]).toEqual([400, 40001]);
    await s.close();
  });

  it('🔴 删除：空分类 → 204；还有商品（含草稿）→ 409 / 40919 且没删；不存在 → 404 / 40404', async () => {
    const s = await buildServer();
    const t = await bearer();
    await call(s.url, 'POST', '/api/v1/admin/categories', { key: 'probe_a', name: '甲类' }, t);
    await call(s.url, 'POST', '/api/v1/admin/categories', { key: 'probe_b', name: '乙类' }, t);
    await db`insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
             values ('p-b', '乙', 'probe_b', 1000, 100, 'JP', 'draft')`;
    expect(
      (await call(s.url, 'DELETE', '/api/v1/admin/categories/probe_a', undefined, t)).status,
    ).toBe(204);
    expect(await auditHas('DELETE /admin/categories/:key', 'probe_a')).toBe(true); // AJ-497
    const used = await call(s.url, 'DELETE', '/api/v1/admin/categories/probe_b', undefined, t);
    expect([used.status, code(used)]).toEqual([409, 40919]);
    expect((await db`select 1 from product_categories where key = 'probe_b'`).length).toBe(1);
    const missing = await call(s.url, 'DELETE', '/api/v1/admin/categories/probe_zz', undefined, t);
    expect([missing.status, code(missing)]).toEqual([404, 40404]);
    await s.close();
  });
});
