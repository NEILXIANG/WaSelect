/**
 * 职责：**管理端改商品 → 买家侧所有读取方与下单链路都跟着变**；以及
 *      **上传 → 商品图 → 买家看到的图**这条链（测试审查 U-J9）。
 *
 * @why 既有的"管理端写 → 买家读"只覆盖了运费、汇率（quote-create-chain）和发货/退款/拒付
 *      （admin-buyer-consistency）。商品这一侧——**下架**与**改价**——从未经真实管理端路由流到买家侧：
 *      `quote-create-chain` 的"报价后改商品价"用的是直接 SQL，绕过了管理端的校验与写路径；
 *      下架之后列表 / 详情 / 报价 / 建单四个入口是否**一致地**拒绝，没有任何用例同时看过。
 *      四个入口各自有自己的查询，只要有一个漏了 `status = 'active'` 过滤，
 *      下架商品就会从那个入口被买走——而其它三个入口的用例照样绿。
 * @why 上传链：上传返回的三档 URL 要原样出现在买家商品详情里。两端各自有测试
 *      （上传测存储里有三档、商品测 images 映射），但"上传的输出能不能直接当商品的输入、
 *      买家看到的是不是同一组 URL"没人串过。
 *
 * @limitation 下架对**已存在订单**的影响只验了"详情仍可读、品名是快照"；
 *              下架后已下单未付款的单能否继续付款，按现行口径（支付金额与商品取订单快照）是可以的，
 *              本文件用一条断言钉住这个现状，是否应当拦截属业务口径，不在测试审查范围内。
 *
 * @see app/admin-product-routes.ts；app/product-routes.ts；app/admin-upload-routes.ts；
 *      docs/自主决策记录.md AJ-174
 */
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  orderBody,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

let db: Db;
let srv: ChainServer;
let buyer = '';
let admin = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db, { IMG_BASE_URL: 'https://img.example.test' });
}, 30_000);

afterAll(async () => {
  await srv.close();
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  buyer = await tokenFor('u-1');
  admin = await tokenFor('u-admin', 'admin');
});

const listIds = async (): Promise<string[]> => {
  const r = await call(srv, 'GET', '/api/v1/products?size=50');
  expect(r.status).toBe(200);
  return (r.json['items'] as { id: string }[]).map((p) => p.id).sort();
};

describe('管理端下架 / 上架 → 买家四个入口一致', () => {
  it('下架：列表不含、详情/报价/建单一律 40401；已有订单仍可读且品名是快照；重新上架后全部恢复', async () => {
    // 先下一张含茶杯的单（下架前）
    const before = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-before',
      body: orderBody(),
    });
    expect(before.status).toBe(201);
    const orderId = String(before.json['order_id']);
    expect(await listIds()).toEqual(['p-cup', 'p-knife']);

    const off = await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
      token: admin,
      body: { status: 'offline' },
    });
    expect(off.status).toBe(200);

    expect(await listIds()).toEqual(['p-knife']);
    const detail = await call(srv, 'GET', '/api/v1/products/p-cup');
    const quote = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: buyer,
      body: { items: [{ product_id: 'p-cup', qty: 1 }] },
    });
    const create = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-after',
      body: orderBody(),
    });
    expect([detail.json['code'], quote.json['code'], create.json['code']]).toEqual([
      40401, 40401, 40401,
    ]);
    // 已有订单：详情仍可读，茶杯那一行品名来自快照
    const g = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: buyer });
    expect(g.status).toBe(200);
    expect(
      (g.json['items'] as { product_id: string; title: string }[]).find(
        (i) => i.product_id === 'p-cup',
      )?.title,
    ).toBe('Tea Cup');
    // 现行口径（@limitation）：已下单未付款的单仍可发起支付
    const pay = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: buyer,
      key: 'pay-before',
      body: { channel: 'mock' },
    });
    expect(pay.status).toBe(200);

    // 重新上架 → 四个入口恢复
    expect(
      (
        await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
          token: admin,
          body: { status: 'active' },
        })
      ).status,
    ).toBe(200);
    expect(await listIds()).toEqual(['p-cup', 'p-knife']);
    expect((await call(srv, 'GET', '/api/v1/products/p-cup')).status).toBe(200);
    const again = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-again',
      body: orderBody(),
    });
    expect(again.status).toBe(201);
  });
});

describe('管理端编辑商品 × 并发库存变化（AJ-175 拍板：库存省略即不改；PUT 不管上下架）', () => {
  const PRODUCT_BODY = {
    category: 'kitchen',
    price_jpy: 8800,
    weight_g: 620,
    customs_desc_en: 'kitchen knife, stainless steel',
    hs_code: '8211.91',
    origin_country: 'JP',
  };

  it('打开编辑页（读到库存 5）→ 期间买家下单扣到 4 → 只改标题保存 → 库存仍是 4；取消后回到 5（不是 6）', async () => {
    const list = await call(srv, 'GET', '/api/v1/admin/products?size=50', { token: admin });
    const seen = (list.json['items'] as Record<string, unknown>[]).find(
      (p) => p['id'] === 'p-knife',
    );
    expect(seen?.['stock']).toBe(5); // 管理员打开编辑页时看到的值
    // 乐观锁凭据（ADM3-02 / 契约 0.6.18）：编辑页打开那一刻的 `updated_at`
    const cred = String(seen?.['updated_at']);

    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-lost-update',
      body: {
        items: [{ product_id: 'p-knife', qty: 1 }],
        address_id: 'addr-1',
        terms_version: 'TOS-TEST-1',
      },
    });
    expect(c.status).toBe(201);

    // admin-web 在库存没改时不发 stock（view.ts toProductInput）
    // ⚠️ 同时钉住 DB3-02：下单**不**推进 `updated_at`，所以这里仍能拿打开页面时的凭据保存成功。
    //    若有人把 `updated_at = now()` 加回 decrementStock，这一条立刻变红（AJ-258 注回实测）。
    const put = await call(srv, 'PUT', '/api/v1/admin/products/p-knife', {
      token: admin,
      body: { ...PRODUCT_BODY, title: 'Chef Knife 改名', expected_updated_at: cred },
    });
    expect(put.status).toBe(200);
    expect(put.json['stock']).toBe(4);

    const cancel = await call(srv, 'POST', `/api/v1/orders/${String(c.json['order_id'])}/cancel`, {
      token: buyer,
    });
    expect(cancel.status).toBe(200);
    const stock = await db`select stock from products where id = 'p-knife'`;
    expect(Number(stock[0]?.['stock'])).toBe(5);

    // 管理员**明确**改库存（盘点）仍是绝对值设置
    // ⚠️ 上一次保存推进了 `updated_at`，凭据必须取新的（PUT 响应回整行，不必再拉一次列表）
    const set = await call(srv, 'PUT', '/api/v1/admin/products/p-knife', {
      token: admin,
      body: {
        ...PRODUCT_BODY,
        title: 'Chef Knife 改名',
        stock: 20,
        expected_updated_at: String(put.json['updated_at']),
      },
    });
    expect(set.json['stock']).toBe(20);
  });

  it('编辑一个已下架的商品 → 保存后**仍是下架**（此前 PUT 写死 active，会被悄悄重新上架）', async () => {
    expect(
      (
        await call(srv, 'PATCH', '/api/v1/admin/products/p-cup/status', {
          token: admin,
          body: { status: 'offline' },
        })
      ).status,
    ).toBe(200);
    // ⚠️ 下架（PATCH /status）**会**推进 `updated_at`（它是商品信息的一部分），凭据要在下架之后取
    const afterOffline = await call(srv, 'GET', '/api/v1/admin/products?size=50', { token: admin });
    const cup = (afterOffline.json['items'] as Record<string, unknown>[]).find(
      (p) => p['id'] === 'p-cup',
    );
    const put = await call(srv, 'PUT', '/api/v1/admin/products/p-cup', {
      token: admin,
      body: {
        ...PRODUCT_BODY,
        title: 'Tea Cup 新文案',
        price_jpy: 3200,
        weight_g: 480,
        expected_updated_at: String(cup?.['updated_at']),
      },
    });
    expect(put.status).toBe(200);
    expect(put.json['status']).toBe('offline');
    expect((await call(srv, 'GET', '/api/v1/products/p-cup')).json['code']).toBe(40401);
    expect(await listIds()).toEqual(['p-knife']);
  });
});

describe('上传 → 商品图 → 买家看到的图', () => {
  it('上传返回的三档 URL 原样写进商品，买家详情 images[0] 与列表卡片图逐档相等', async () => {
    const jpeg = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 60, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const fd = new FormData();
    fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'knife.jpg');
    const up = await fetch(`${srv.url}/api/v1/admin/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
      body: fd,
    });
    expect(up.status).toBe(201);
    const set = (await up.json()) as { thumb: string; card: string; detail: string };
    for (const k of ['thumb', 'card', 'detail'] as const) {
      expect(set[k].startsWith('https://img.example.test/')).toBe(true);
    }

    const before = await call(srv, 'GET', '/api/v1/admin/products?size=50', { token: admin });
    const knife = (before.json['items'] as Record<string, unknown>[]).find(
      (p) => p['id'] === 'p-knife',
    );
    const put = await call(srv, 'PUT', '/api/v1/admin/products/p-knife', {
      token: admin,
      body: {
        expected_updated_at: String(knife?.['updated_at']),
        title: 'Chef Knife',
        category: 'kitchen',
        price_jpy: 8800,
        weight_g: 620,
        stock: 5,
        customs_desc_en: 'kitchen knife, stainless steel',
        hs_code: '8211.91',
        origin_country: 'JP',
        images: [{ thumb: set.thumb, card: set.card, detail: set.detail }],
      },
    });
    expect(put.status).toBe(200);

    const d = await call(srv, 'GET', '/api/v1/products/p-knife');
    expect((d.json['images'] as unknown[])[0]).toEqual({
      thumb: set.thumb,
      card: set.card,
      detail: set.detail,
    });
    const list = await call(srv, 'GET', '/api/v1/products?size=50');
    const card = (list.json['items'] as Record<string, unknown>[]).find(
      (p) => p['id'] === 'p-knife',
    );
    expect(card?.['image']).toEqual({ thumb: set.thumb, card: set.card, detail: set.detail });

    // 下单后订单详情的商品行也带同一张图（订单读路径复用同一映射）
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: buyer,
      key: 'k-img',
      body: orderBody(),
    });
    const g = await call(srv, 'GET', `/api/v1/orders/${String(c.json['order_id'])}`, {
      token: buyer,
    });
    const line = (g.json['items'] as Record<string, unknown>[]).find(
      (i) => i['product_id'] === 'p-knife',
    );
    expect(line?.['image']).toEqual({ thumb: set.thumb, card: set.card, detail: set.detail });
  });
});
