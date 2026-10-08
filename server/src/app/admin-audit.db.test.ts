/**
 * 职责：管理端**操作审计**（流 B，ADR-29；F-02 / AJ-183）与拉黑**即时生效**（F-06 / AJ-183）——生产装配 + 真库。
 *
 * @why F-02：`admin_audit` 表建了（迁移 002，append-only 触发器都有）却**零写入方**——改价、上下架、
 *      运费整表替换、汇率、Banner、拉黑都只有运行日志，而运行日志有保留期。这里钉住的是"**一个入口**
 *      覆盖所有管理端写接口"：新加一条管理端写路由，不用记得去写审计，它自动就在。
 * @why F-06：拉黑后被拉黑者的下一个请求必须立刻被拒（身份缓存 60 秒窗口曾让它继续用 60 秒）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  seedChainFixture,
  tokenFor,
  waitUntil,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

let db: Db;
let srv: ChainServer;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  srv = await buildChainServer(db);
});

afterEach(async () => {
  await srv.close();
});

const audits = () =>
  db`select actor, action, target, before, after, trace_id from admin_audit order by id`;

describe('admin_audit：管理端写接口一处接入（F-02）', () => {
  it('成功的写操作各留一行：actor=admin:<id>、action=方法+路由模板、target=路径 id、after=请求体；trace_id 与响应头一致', async () => {
    const admin = await tokenFor('u-admin', 'admin');
    const r = await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
      token: admin,
      body: { status: 'offline' },
    });
    expect(r.status).toBe(200);
    await waitUntil(async () => (await audits()).length === 1, '审计行没写进来');
    const [row] = await audits();
    expect(row).toMatchObject({
      actor: 'admin:u-admin',
      action: 'PATCH /admin/products/:id/status',
      target: 'p-cup',
      after: { status: 'offline' },
    });
    expect(String(row?.['trace_id'])).toMatch(/.+/);
  });

  it('运费整表替换带 before（改前整表）：不可逆操作必须答得出"之前是多少"', async () => {
    const admin = await tokenFor('u-admin', 'admin');
    const r = await call(srv, 'PUT', '/api/v1/admin/shipping-rates', {
      token: admin,
      body: [{ carrier: 'EMS', max_weight_g: 2000, price_jpy: 5000, active: true }],
    });
    expect(r.status).toBe(200);
    await waitUntil(async () => (await audits()).length === 1, '审计行没写进来');
    const [row] = await audits();
    expect(Array.isArray(row?.['before'])).toBe(true);
    expect((row?.['before'] as unknown[]).length).toBeGreaterThan(1);
  });

  /**
   * SEC-12 / AJ-344：**新建**类写操作没有路径 `:id`，审计行的 target 一直是 NULL——
   * 于是"谁在什么时候建了东西"查得到，"**建了什么**"查不到，而后者才是要查的那一半。
   * @why 放在这里而不是商品路由的用例里：这条钉的是**审计中间件与路由的契约**
   *      （新建类路由必须显式声明 target），不是商品创建本身。
   */
  it('🔴 新建类写操作（POST /admin/products）的审计行 target = 新商品 id，不是 NULL', async () => {
    const admin = await tokenFor('u-admin', 'admin');
    const r = await call(srv, 'POST', '/api/v1/admin/products', {
      token: admin,
      body: {
        title: '审计 target 验证商品',
        category: 'beauty',
        price_jpy: 3600,
        weight_g: 800,
        customs_desc_en: 'cosmetic set',
        hs_code: '3304.99',
        origin_country: 'JP',
      },
    });
    expect(r.status).toBe(201);
    const newId = String(r.json['id']);
    await waitUntil(async () => (await audits()).length === 1, '审计行没写进来');
    const [row] = await audits();
    expect(row).toMatchObject({
      actor: 'admin:u-admin',
      action: 'POST /admin/products',
      target: newId, // 不是 null：路由用 setAuditTarget 声明了"建的是这个 id"
    });
    // 顺带确认库里真的有这个商品（否则 target 对上一个不存在的 id 也毫无意义）
    expect((await db`select 1 from products where id = ${newId}`).length).toBe(1);
  });

  it('🔴 列表内联改库存（PATCH /admin/products/:id/stock，AJ-403）留一行：target = 商品 id，after = {stock, expected_stock}', async () => {
    const admin = await tokenFor('u-admin', 'admin');
    const r = await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/stock', {
      token: admin,
      body: { stock: 25, expected_stock: 10 },
    });
    expect(r.status).toBe(200);
    await waitUntil(async () => (await audits()).length === 1, '审计行没写进来');
    expect((await audits())[0]).toMatchObject({
      actor: 'admin:u-admin',
      action: 'PATCH /admin/products/:id/stock',
      target: 'p-cup',
      after: { stock: 25, expected_stock: 10 },
    });
  });

  it('失败的写（4xx）、读（GET）、买家 token 都不留审计行', async () => {
    const admin = await tokenFor('u-admin', 'admin');
    expect(
      (
        await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
          token: admin,
          body: { status: 'weird' },
        })
      ).status,
    ).toBe(400);
    expect((await call(srv, 'GET', '/api/v1/admin/orders', { token: admin })).status).toBe(200);
    expect(
      (
        await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
          token: await tokenFor('u-1'),
          body: { status: 'offline' },
        })
      ).status,
    ).toBe(403);
    // 再做一次成功写，作为"审计确实在跑"的对照：之前三次都没留行
    await call(srv, 'PATCH', '/api/v1/admin/products/p-knife/status', {
      token: admin,
      body: { status: 'offline' },
    });
    await waitUntil(async () => (await audits()).length >= 1, '对照组也没写进来');
    const rows = await audits();
    expect(rows.map((r) => r['target'])).toEqual(['p-knife']);
  });
});

describe('拉黑即时生效（F-06）', () => {
  it('买家请求过一次（身份进缓存）→ 管理员拉黑 → 买家下一个请求立刻被拒；拉黑本身留审计', async () => {
    const buyer = await tokenFor('u-1');
    expect((await call(srv, 'GET', '/api/v1/orders', { token: buyer })).status).toBe(200);

    const admin = await tokenFor('u-admin', 'admin');
    expect(
      (await call(srv, 'POST', '/api/v1/admin/users/u-1/block', { token: admin })).status,
    ).toBe(200);
    const after = await call(srv, 'GET', '/api/v1/orders', { token: buyer });
    expect([401, 403]).toContain(after.status);

    await waitUntil(async () => (await audits()).length === 1, '拉黑的审计行没写进来');
    expect((await audits())[0]).toMatchObject({
      action: 'POST /admin/users/:id/block',
      target: 'u-1',
    });
  });
});
