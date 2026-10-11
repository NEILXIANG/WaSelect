/**
 * 职责：`/admin/orders*` 五条路由的接线级真库用例（I2 U-B2d）——守卫、准入闸门、
 *      落库、以及"闸门必须在调机构之前"这条顺序。
 *
 * @why 守卫与闸门都要**接线级**测（真 HTTP + 真 JWT + 真 identity 回源）：
 *      `requireRole` 与三个 guard 各自都有单测，但"这条路由有没有挂它们"
 *      只有接线级能证明——管理端接口漏守卫的代价是全库可读可写。
 *
 * @why 落库断言直接查 `orders` / `order_events` 表，不接受"响应说成功了"：
 *      响应是路由自己拼的，库才是事实（§2 第 21 条：自证断言不算证据）。
 *      退款那条尤其重要——它跨了两次事务，响应 202 并不代表钱真的退了。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REFUND_REASON_MAX_LENGTH,
  SEARCH_KEYWORD_MAX_LENGTH,
  SHIP_MAX_CHARS,
} from '@waselect/shared';
import { ADMIN_NOTE_MAX_LENGTH, refundGuard, shipGuard } from '../domain/admin-order-actions.js';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { waitUntil } from '../../../test/helpers/chain-server.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'admin-order-test-jwt-secret-'.repeat(3);

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
 *
 * @param opts.channels 覆盖 `PAYMENT_CHANNELS`。
 * @param opts.withoutMockSecret 不设 `MOCK_CALLBACK_SECRET`。
 *        ⚠️ 两个必须一起用才能造出"通道已下线"：开发环境下"未列出但有密钥"仍会注册 mock
 *        （`channels.ts` 的 @limitation 三），只改 channels 的话 mock 照样在册。
 */
async function buildServer(
  opts: { channels?: string; withoutMockSecret?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void>; sink: MemorySink }> {
  // ⚠️ sink 一并返回（AJ-315）：`AppError.details` 结构上不进响应体，
  //    "到底是入口拦的、还是 PG 报 22001 被兜底折的"只能靠日志里的 reason 区分——
  //    两者对外都是 40001，看响应码分不出来。
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: opts.channels ?? 'mock',
    ...(opts.withoutMockSecret === true
      ? {}
      : { MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-route-test' }),
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
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close, sink };
}

/** 插一个用户（默认管理员）；id 由 tag 固定且 on conflict 幂等。 */
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

/** 插一张订单 + 一条支付行（provider 用 mock：注册表里它可退款）。 */
async function seedOrder(o: {
  id: string;
  status?: string;
  hasDispute?: boolean;
  paymentStatus?: string;
  providerRef?: string | null;
}): Promise<void> {
  await db`
    insert into users (id, openid) values (${`u-${o.id}`}, ${`o-${o.id}`})
      on conflict (id) do nothing
  `;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${o.id}`}, '商品', 'daily', 1000, 500, 'JP')
      on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        has_dispute, expires_at)
    values (${o.id}, ${`NO-${o.id}`}, ${`u-${o.id}`}, ${o.status ?? 'paid'}, 1000, 500, 150, 1650,
            500, ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ id: 'a-1', recipient: 'Jane Doe', line1: '1 Infinite Loop', country: 'US' } as never)},
            'TOS-TEST-1', ${o.hasDispute ?? false}, now() + interval '30 minutes')
  `;
  await db`
    insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                             weight_g, declared_value_usd)
    values (${`oi-${o.id}`}, ${o.id}, ${`p-${o.id}`}, '商品', 1, 1000, 500, 7)
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency,
                          charge_amount)
    values (${`pay-${o.id}`}, ${o.id}, 'mock', ${o.providerRef ?? `mock_${o.id}`},
            ${o.paymentStatus ?? 'succeeded'}, 'JPY', 1650)
  `;
}

const ADDR = {
  recipient: 'SAN ZHANG',
  phone: '+14155552671',
  line1: '2 Main St',
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
  country: 'US',
};

/** 带管理员 token 的请求封装。 */
async function adminFetch(
  s: { url: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

describe('GET /admin/orders/{id}：行项目带商品图（三端联动 UI 模拟 2026-10-08）', () => {
  it('🔴 详情的行项目带商品首图（运营对照实物发货）；商品无图 → 不带 image', async () => {
    await seedOrder({ id: 'o-img' });
    await seedOrder({ id: 'o-noimg' });
    const img = {
      thumb: 'https://img.test/t.webp',
      card: 'https://img.test/c.webp',
      detail: 'https://img.test/d.webp',
    };
    await db`update products set images = ${db.json([img] as never)} where id = 'p-o-img'`;
    const s = await buildServer();
    try {
      const a = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-img');
      expect((a.json['items'] as Array<Record<string, unknown>>)[0]?.['image']).toEqual(img);
      const b = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-noimg');
      expect((b.json['items'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('image');
    } finally {
      await s.close();
    }
  });
});

describe('GET /admin/orders（管理端订单列表）', () => {
  it('无 token → 40101', async () => {
    const s = await buildServer();
    const r = await fetch(`${s.url}/api/v1/admin/orders`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: number }).code).toBe(40101);
    await s.close();
  });

  it('小程序用户 token → 40301；管理员 → 200', async () => {
    const s = await buildServer();
    const bad = await fetch(`${s.url}/api/v1/admin/orders`, {
      headers: { authorization: `Bearer ${await userToken()}` },
    });
    expect(bad.status).toBe(403);
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json.items)).toBe(true);
    expect(typeof ok.json.total).toBe('number');
    await s.close();
  });

  // @why 前端的形状断言**硬失败**在缺 `order_id` 上（api.ts @limitation 一），
  //      键名叫错的表现是整页空白 + "网络错误"，真因却只是键名——必须钉住。
  it('响应行的主键叫 order_id（不是 id）：前端按 order_id 硬校验', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders');
    const items = ok.json.items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(typeof items[0]?.order_id).toBe('string');
    expect(items[0]?.order_no).toBe('NO-o-1');
    expect(items[0]?.has_dispute).toBe(false);
    await s.close();
  });

  /**
   * D-39 / 0.6.26：列表行带 `items`（含采购快照）——「待采购清单」就是这一页本身。
   *
   * @why 三条断言分工不同，缺任一都会留下"看起来做完了"的假象：
   *      ① 有采购信息 → 列表带得到（这是"清单能用"的最低要求）；
   *      ② 多单多行的**归属**正确（批量取之后按 order_id 归堆，归错就是
   *         "这一单显示了别人的采购来源"——采购员照它去买，买到错的东西，
   *         而且**没有任何报错**，是这一段最危险的失效形态）；
   *      ③ 没有采购信息 → 三列整键省略（与详情同口径，前端显示"未记录"）。
   */
  it('列表行带 items 与采购快照；多单多行归属正确；无采购信息时整键省略', async () => {
    const s = await buildServer();
    // 两单各两条行项目，插入序故意交错（o-1 的 b 行插在 o-2 的 a 行之后）
    await seedOrder({ id: 'o-1' });
    await seedOrder({ id: 'o-2' });
    await db`
      insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                               weight_g, declared_value_usd, title_ja, jan_code, purchase_source,
                               cost_jpy, hs_code, customs_desc_en)
      values ('oi-1b', 'o-1', 'p-o-1', '包丁', 1, 1000, 500, 7, 'シェフナイフ', '4900000000011', 'Amazon JP',
              620, '8211.91', 'Kitchen knife'),
             ('oi-2a', 'o-2', 'p-o-2', '茶碗', 2, 800, 300, 11, '茶碗', '4900000000022', '楽天市場',
              null, null, null),
             ('oi-1c', 'o-1', 'p-o-1', 'まな板', 1, 500, 800, 4, 'まな板', '4900000000033', '錦市場 直送',
              null, null, null)
    `;
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders');
    expect(ok.status).toBe(200);
    const rows = ok.json.items as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    const byId = new Map(rows.map((r) => [String(r['order_id']), r]));
    const lineOf = (orderId: string, title: string): Record<string, unknown> => {
      const lines = byId.get(orderId)?.['items'] as Array<Record<string, unknown>>;
      const hit = lines.find((l) => l['title'] === title);
      if (hit === undefined)
        throw new Error(`${orderId} 里没有 ${title}：${JSON.stringify(lines)}`);
      return hit;
    };

    // ① o-1 有三行（含种子那条），o-2 有两行
    expect(byId.get('o-1')?.['items'] as unknown[]).toHaveLength(3);
    expect(byId.get('o-2')?.['items'] as unknown[]).toHaveLength(2);

    // ② 归属：每行带着**自己那一单**的采购来源
    expect(lineOf('o-1', '包丁')['purchase_source']).toBe('Amazon JP');
    expect(lineOf('o-1', 'まな板')['purchase_source']).toBe('錦市場 直送');
    expect(lineOf('o-2', '茶碗')['purchase_source']).toBe('楽天市場');
    expect(lineOf('o-1', '包丁')['jan_code']).toBe('4900000000011');
    expect(lineOf('o-1', '包丁')['title_ja']).toBe('シェフナイフ');

    // ③ 种子那条没填采购信息 → 三列整键省略（不是 null / 空串）
    const plain = lineOf('o-1', '商品');
    expect(plain).not.toHaveProperty('title_ja');
    expect(plain).not.toHaveProperty('jan_code');
    expect(plain).not.toHaveProperty('purchase_source');

    // ④ 迁移 027 快照：有值下发、NULL 整键省略（剩余清单 1-3）
    expect(lineOf('o-1', '包丁')['cost_jpy']).toBe(620);
    expect(lineOf('o-1', '包丁')['hs_code']).toBe('8211.91');
    expect(lineOf('o-1', '包丁')['customs_desc_en']).toBe('Kitchen knife');
    expect(lineOf('o-2', '茶碗')).not.toHaveProperty('cost_jpy');
    expect(lineOf('o-2', '茶碗')).not.toHaveProperty('hs_code');
    await s.close();
  });

  /**
   * AJ-407（契约 0.6.48）：行项目带申报价与重量——打印「面单信息」直接读详情，不另开读接口。
   * @why 申报价是**美分整数**（与契约"金额一律整数最小单位"同口径），不是美元小数：
   *      报关清单 CSV 才转两位小数（exports.ts），JSON 里给小数会让前端再乘回去时漂 1 分。
   */
  it('🔴 详情行项目带 declared_value_usd（美分整数）与 weight_g（AJ-407）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
    expect(r.status).toBe(200);
    const [line] = r.json['items'] as Array<Record<string, unknown>>;
    expect(line?.['declared_value_usd']).toBe(7);
    expect(line?.['weight_g']).toBe(500);
    await s.close();
  });

  it('status 非法 → 40001；page/size 越界 → 40001', async () => {
    const s = await buildServer();
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?status=nope')).status).toBe(400);
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?page=0')).status).toBe(400);
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?size=101')).status).toBe(400);
    await s.close();
  });

  // AJ-360：管理端的 keyword 与公开 `/products` 是**同一个**客户端可控输入的两个面，
  // 上限取同一个常量——只钉公开侧的话，这里就是"契约没写、实现没挡"的同形状漏洞。
  it('🔴 keyword 超过 SEARCH_KEYWORD_MAX_LENGTH → 40001（CAT2-07）', async () => {
    const s = await buildServer();
    const long = 'ん'.repeat(SEARCH_KEYWORD_MAX_LENGTH + 1);
    const r = await adminFetch(
      s,
      'GET',
      `/api/v1/admin/orders?keyword=${encodeURIComponent(long)}`,
    );
    expect(r.status).toBe(400);
    expect(r.json['code']).toBe(40001);
    await s.close();
  });

  it('keyword 恰好等于上限 → 200（边界必须放行：整串粘贴运单号是真实动作）', async () => {
    const s = await buildServer();
    const exact = 'ん'.repeat(SEARCH_KEYWORD_MAX_LENGTH);
    const r = await adminFetch(
      s,
      'GET',
      `/api/v1/admin/orders?keyword=${encodeURIComponent(exact)}`,
    );
    expect(r.status).toBe(200);
    await s.close();
  });

  it('keyword 走真实 HTTP 也能命中单号（列取错 = 客服搜不到单）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    await seedOrder({ id: 'o-2' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders?keyword=NO-o-1');
    expect(ok.json.items as unknown[]).toHaveLength(1);
    await s.close();
  });

  it('列表行带收件人（0.6.9/KD-14）：按收件人搜中的行，收件人一栏能回显；其余地址字段不在列表', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-r1' });
    await db`update orders set address_snapshot = address_snapshot || '{"recipient":"Hanako Sato"}'::jsonb where id = 'o-r1'`;
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders?keyword=hanako');
    const items = r.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.['recipient']).toBe('Hanako Sato');
    expect(items[0]).not.toHaveProperty('address');
    expect(JSON.stringify(items[0])).not.toMatch(/phone|line1|postal_code/);
    await s.close();
  });

  it('六条路由**每一条**都对无 token 返回 40101（防"某条忘了挂守卫"）', async () => {
    const s = await buildServer();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/v1/admin/orders'],
      ['GET', '/api/v1/admin/orders/x'],
      ['POST', '/api/v1/admin/orders/x/ship'],
      ['POST', '/api/v1/admin/orders/x/refund'],
      ['POST', '/api/v1/admin/orders/x/dispute/release'],
      ['POST', '/api/v1/admin/orders/x/address'],
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

describe('GET /admin/orders?include_test（剩余清单 3-4）', () => {
  it('🔴 默认不含测试单；include_test=true 含；非 true/false → 40001', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-real' });
    await seedOrder({ id: 'o-test' });
    await db`update orders set is_test = true where id = 'o-test'`;
    const ids = (r: { json: Record<string, unknown> }) =>
      (r.json['items'] as Array<{ order_id: string }>).map((i) => i.order_id).sort();
    expect(ids(await adminFetch(s, 'GET', '/api/v1/admin/orders'))).toEqual(['o-real']);
    expect(ids(await adminFetch(s, 'GET', '/api/v1/admin/orders?include_test=true'))).toEqual([
      'o-real',
      'o-test',
    ]);
    expect(ids(await adminFetch(s, 'GET', '/api/v1/admin/orders?include_test=false'))).toEqual([
      'o-real',
    ]);
    expect((await adminFetch(s, 'GET', '/api/v1/admin/orders?include_test=1')).json['code']).toBe(
      40001,
    );
    await s.close();
  });
});

/**
 * AJ-400（契约 0.6.44）：状态页签要"一个页签 = 几个状态"（售后·退款 = refunding + refunded），
 * 日期筛选按 JST 日历日、两端都含。边界样本直接钉在 JST 日界两侧（UTC 15:00 = JST 次日 00:00）。
 */
describe('GET /admin/orders：多状态与下单日期筛选（AJ-400）', () => {
  const ids = (r: { json: Record<string, unknown> }): string[] =>
    (r.json['items'] as Array<{ order_id: string }>).map((i) => i.order_id).sort();

  it('🔴 status 逗号分隔 = 任一命中；total 与 items 同口径', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-paid', status: 'paid' });
    await seedOrder({ id: 'o-rfing', status: 'refunding' });
    await seedOrder({ id: 'o-rfed', status: 'refunded' });
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders?status=refunding,refunded');
    expect(ids(r)).toEqual(['o-rfed', 'o-rfing']);
    expect(r.json['total']).toBe(2);
    // 单状态的老写法照旧（工作台待办链接 `#/orders?status=paid` 依赖它）
    expect(ids(await adminFetch(s, 'GET', '/api/v1/admin/orders?status=paid'))).toEqual(['o-paid']);
    await s.close();
  });

  it('🔴 status 含空段或非法段 → 40001 status_invalid（不悄悄丢掉那一段）', async () => {
    const s = await buildServer();
    for (const bad of ['paid,', 'paid,nope', ',paid', '']) {
      const r = await adminFetch(s, 'GET', `/api/v1/admin/orders?status=${bad}`);
      expect(r.json['code'], bad).toBe(40001);
    }
    expect(s.sink.lines.join('\n')).toContain('status_invalid');
    await s.close();
  });

  it('🔴 created_from / created_to 按 JST 日界、两端都含（日界两侧各一单）', async () => {
    const s = await buildServer();
    const at: ReadonlyArray<readonly [string, string]> = [
      ['o-1006-late', '2026-10-06T14:59:59.999Z'], // JST 10-06 23:59:59.999
      ['o-1007-early', '2026-10-06T15:00:00.000Z'], // JST 10-07 00:00
      ['o-1007-late', '2026-10-07T14:59:59.999Z'], // JST 10-07 23:59:59.999
      ['o-1008-early', '2026-10-07T15:00:00.000Z'], // JST 10-08 00:00
    ];
    for (const [id, ts] of at) {
      await seedOrder({ id });
      await db`update orders set created_at = ${new Date(ts)} where id = ${id}`;
    }
    const q = (qs: string) => adminFetch(s, 'GET', `/api/v1/admin/orders?${qs}`);
    const day = await q('created_from=2026-10-07&created_to=2026-10-07');
    expect(ids(day)).toEqual(['o-1007-early', 'o-1007-late']);
    expect(day.json['total']).toBe(2);
    expect(ids(await q('created_from=2026-10-07'))).toEqual([
      'o-1007-early',
      'o-1007-late',
      'o-1008-early',
    ]);
    expect(ids(await q('created_to=2026-10-07'))).toEqual([
      'o-1006-late',
      'o-1007-early',
      'o-1007-late',
    ]);
    // 与状态 / 关键词叠加（AND，不是 OR）
    expect(
      ids(await q('created_from=2026-10-07&created_to=2026-10-07&keyword=NO-o-1007-l')),
    ).toEqual(['o-1007-late']);
    expect(ids(await q('created_from=2026-10-07&status=shipped'))).toEqual([]);
    await s.close();
  });

  it('🔴 日期非法 / 不存在的日 / 起点晚于终点 → 40001，reason 指明哪一端', async () => {
    const s = await buildServer();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['created_from=2026-02-30', 'created_from_invalid'],
      ['created_from=2026-10-07T00:00:00Z', 'created_from_invalid'],
      ['created_from=', 'created_from_invalid'],
      ['created_to=yesterday', 'created_to_invalid'],
      ['created_from=2026-10-08&created_to=2026-10-07', 'created_range_invalid'],
      // 重复参数（Express 解析成数组）不是合法日期
      ['created_from=2026-10-01&created_from=2026-10-02', 'created_from_invalid'],
    ];
    for (const [qs, reason] of cases) {
      const r = await adminFetch(s, 'GET', `/api/v1/admin/orders?${qs}`);
      expect(r.json['code'], qs).toBe(40001);
      expect(s.sink.lines.join('\n'), qs).toContain(reason);
    }
    await s.close();
  });
});

describe('GET /admin/orders/{id}（详情）', () => {
  it('存在 → 200 且带 items / payments / events 与地址', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const ok = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
    expect(ok.status).toBe(200);
    expect(ok.json.order_id).toBe('o-1');
    expect(ok.json.items as unknown[]).toHaveLength(1);
    const pays = ok.json.payments as Record<string, unknown>[];
    expect(pays[0]?.provider).toBe('mock');
    // 契约 Order.payment = {channel, charge_currency, charge_amount, …}：曾原样透传 payments 末条（键叫 provider），
    // admin-web 读 payment.channel 永远为空（一致性审计 C5，AJ-176）
    const payment = ok.json.payment as Record<string, unknown>;
    expect(payment.channel).toBe('mock');
    expect(payment.charge_currency).toBe(pays[0]?.charge_currency);
    expect(payment.charge_amount).toBe(pays[0]?.charge_amount);
    expect(payment).not.toHaveProperty('provider');
    expect(ok.json.events as unknown[]).toHaveLength(0);
    expect((ok.json.address as { recipient?: string }).recipient).toBe('Jane Doe');
    await s.close();
  });

  it('不存在 → 40400', async () => {
    const s = await buildServer();
    const r = await adminFetch(s, 'GET', '/api/v1/admin/orders/no-such');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe(40400);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/ship（发货）', () => {
  it('paid → 200 且库里真的 shipped（carrier / tracking_no / shipped_at 都落了）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(200);
    const rows =
      await db`select status, carrier, tracking_no, shipped_at from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('shipped');
    expect(String(rows[0]?.carrier)).toBe('JPPOST');
    expect(String(rows[0]?.tracking_no)).toBe('TRACK-1');
    expect(rows[0]?.shipped_at).not.toBeNull();
    await s.close();
  });

  it('已发货 → 40902（不是静默成功）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'shipped' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await s.close();
  });

  // @why AJ-145 的核心守护：**拒付中不发货**。这条同时钉住"用 40909 而不是 40902"——
  //      给 40902 会让客服以为状态不对而去改状态。
  it('has_dispute=true → 40909 且状态没动（拒付中不发货，AJ-145）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40909);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    await s.close();
  });

  it('缺 carrier / tracking_no → 40001', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    expect((await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {})).status).toBe(400);
    await s.close();
  });

  /**
   * 🔴 AJ-315（第二轮审查 B24）：超长必须在**入口**被拒（40001 + 指名哪一列），
   *    而不是让 PG 报 22001 —— 后者会被兜底层折成泛化的 40001，
   *    运营看到"参数缺失或格式错误"，提示指向错误的字段。
   * 上限由 shared 常量算出：写死 32 / 64 就等于两处都能改、改一处另一处不红。
   */
  it(`carrier 超过 ${String(SHIP_MAX_CHARS.carrier)} 字 → 40001「太长」，且订单仍是 paid`, async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier + 1),
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    // reason 只进日志（AppError 的 details 结构上不进响应体）
    const reason = s.sink.lines.join('\n');
    expect(reason).toContain('carrier_too_long');
    // 🔴 反证：若是 PG 报 22001 被兜底折的，reason 会是 sql_data_exception:22001
    expect(reason).not.toContain('sql_data_exception');
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    await s.close();
  });

  it(`tracking_no 超过 ${String(SHIP_MAX_CHARS.tracking_no)} 字 → 40001「太长」，且订单仍是 paid`, async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/ship', {
      carrier: 'JPPOST',
      tracking_no: 'T'.repeat(SHIP_MAX_CHARS.tracking_no + 1),
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    const reason = s.sink.lines.join('\n');
    expect(reason).toContain('tracking_no_too_long');
    expect(reason).not.toContain('sql_data_exception');
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    await s.close();
  });

  it('订单不存在 → 40400', async () => {
    const s = await buildServer();
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/no-such/ship', {
      carrier: 'JPPOST',
      tracking_no: 'TRACK-1',
    });
    expect(r.status).toBe(404);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/refund（全额退款）', () => {
  it('paid + mock 通道 → 202 且库里最终 refunded（钱真的退了，不只看响应）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
    expect(r.status).toBe(202);
    const rows = await db`select status, refunded_at from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('refunded');
    expect(rows[0]?.refunded_at).not.toBeNull();
    const p = await db`select status from payments where id = 'pay-o-1'`;
    expect(String(p[0]?.status)).toBe('refunded');
    await s.close();
  });

  // @why 这条守的是"闸门在调机构**之前**"：若顺序反了，拒付单的钱会被真的退出去，
  //      而响应还是 409——那时错误码对了，钱却已经没了。所以必须同时断言库里没变。
  it('has_dispute=true → 40907 且状态与支付行都没动（钱没被退出去）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40907);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    expect((await db`select status from payments where id = 'pay-o-1'`)[0]?.status).toBe(
      'succeeded',
    );
    await s.close();
  });

  // KD-4（AJ-175）：上一次机构调用失败后订单停在 refunding——此前重试被 40902 拒，这张单从此退不了
  it('停在 refunding 的单（上次机构调用失败）→ 重试 202 → refunded；只有一条 refunding 事件；重试沿用首次理由', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    // 造"上一次失败"的现场：迁到 refunding 并记下首次理由，但钱没退成
    await db`update orders set status = 'refunding' where id = 'o-1'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-1', 'refunding', '首次理由：缺货', 'admin', now() - interval '5 minutes')`;
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', {
      reason: '再试一次',
    });
    expect(r.status).toBe(202);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('refunded');
    expect((await db`select status from payments where id = 'pay-o-1'`)[0]?.status).toBe(
      'refunded',
    );
    const ev =
      await db`select status, note from order_events where order_id = 'o-1' and status = 'refunding'`;
    expect(ev.map((e) => e['note'])).toEqual(['首次理由：缺货']); // 重试不写第二条
    // 已退完的单不能再退（重试放行只对 refunding，不对 refunded）
    const again = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe(40902);
    await s.close();
  });

  // B7 / AJ-191：**超长理由必须在入口就被拒，且订单不进 refunding**。
  // @why 这条守的不是"参数校验"，是"这张单还有没有出口"：理由一旦落进 append-only 的
  //      order_events，KD-4 又要求重试沿用首次理由（同键同参），机构就会一直拒——
  //      订单永久停在 refunding。所以必须断言库里**没有** refunding 事件，而不只是看响应码。
  // @why 上限由 shared 常量算出（不是再写一遍 500）：写死会让"改了上限、测试照旧绿"。
  it(`理由超过 ${String(REFUND_REASON_MAX_LENGTH)} 字 → 40001，订单仍是 paid 且没有 refunding 事件（B7）`, async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', {
      reason: '理'.repeat(REFUND_REASON_MAX_LENGTH + 1),
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    const ev = await db`select status from order_events where order_id = 'o-1'`;
    expect(ev.map((e) => String(e['status']))).not.toContain('refunding');
    // 恰好在上限处应当照常退款（边界不是"卡住"，是"过了才卡"）
    const ok = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', {
      reason: '理'.repeat(REFUND_REASON_MAX_LENGTH),
    });
    expect(ok.status).toBe(202);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('refunded');
    await s.close();
  });

  // B8 / AJ-192：**通道解析必须在事务内、落 refunding 之前**。
  // @why 这两条守的是"通道没了的时候，订单还能不能保持原样"。原实现把
  //      `registry.getForRefund` 放在第一段事务**提交之后**：订单先迁到 refunding，
  //      然后才发现拿不到 provider → 40001。此后每次重试都走重试分支（refunding 放行），
  //      每次都拿同一个 40001 ⇒ 永久 refunding，而它一分钱都没动过。
  // @why 用 `PAYMENT_CHANNELS: 'wechat'` + 不设 MOCK_CALLBACK_SECRET 造现场：
  //      wechat 在 R1 前没有实现（`channels.ts` 静默跳过），所以注册表里**一个通道都没有**，
  //      正是"审核结束后 mock 被移出"的真实形态。
  it('通道已下线（注册表里没有该通道）→ 400，订单仍是 paid 且**没有** refunding 事件（B8）', async () => {
    const s = await buildServer({ channels: 'wechat', withoutMockSecret: true });
    await seedOrder({ id: 'o-1' }); // payments.provider = 'mock'
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('paid');
    expect((await db`select status from payments where id = 'pay-o-1'`)[0]?.status).toBe(
      'succeeded',
    );
    const ev = await db`select status from order_events where order_id = 'o-1'`;
    expect(ev.map((e) => String(e['status']))).not.toContain('refunding');
    await s.close();
  });

  // ⚠️ 诚实标注：**这条不是 B8 的红灯证据**。注入"解析搬回事务外"时它照样绿——
  //    因为重试分支根本不写状态（refunding → refunding 不是迁移），解析在哪一步
  //    对结果没有影响。它守的是另一件事：通道缺失时，重试分支不会把订单**推到别处**
  //    （仍 400、状态仍是 refunding）、也不会写第二条 refunding 事件——
  //    即"已经卡住的单，不会因为再点几次变得更糟"。
  it('停在 refunding 的单在通道下线后重试 → 400，且不写第二条事件（B8 连带）', async () => {
    const s = await buildServer({ channels: 'wechat', withoutMockSecret: true });
    await seedOrder({ id: 'o-1' });
    await db`update orders set status = 'refunding' where id = 'o-1'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-1', 'refunding', '首次理由：缺货', 'admin', now() - interval '5 minutes')`;
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '再试' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40001);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.status).toBe('refunding');
    const ev =
      await db`select status from order_events where order_id = 'o-1' and status = 'refunding'`;
    expect(ev.length).toBe(1); // 没有第二条 refunding 事件
    await s.close();
  });

  it('未付款（created）→ 40902；缺 reason → 40001', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'created', paymentStatus: 'initiated' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await seedOrder({ id: 'o-2' });
    expect((await adminFetch(s, 'POST', '/api/v1/admin/orders/o-2/refund', {})).status).toBe(400);
    await s.close();
  });
});

/**
 * B1b / AJ-194：人工解除拒付限制的**逃生口**。
 *
 * @why 这组用例守的不是"多一条接口"，是"订单还有没有活路"：`has_dispute` 为 true 时
 *      发货 40909、退款 40907 全被锁住，而能让它变回 false 的只有机构那条
 *      `charge.dispute.closed`——那条链断在任何一环，订单就永久锁死。
 */
describe('POST /admin/orders/{id}/dispute/release（人工解除拒付限制，B1b）', () => {
  it('锁着的单 + 理由 → 解锁，且**发货与退款闸门真的开了**（换读取方验证）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    // 解锁前：两个闸门都是关的
    expect(shipGuard('paid', true).ok).toBe(false);
    expect(refundGuard('paid', true).ok).toBe(false);

    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {
      reason: '机构回调丢失，已与买家核实款项正常',
    });
    expect(r.status).toBe(200);
    expect((await db`select has_dispute from orders where id = 'o-1'`)[0]?.has_dispute).toBe(false);

    // 换两个读取方：闸门与详情接口
    expect(shipGuard('paid', false).ok).toBe(true);
    expect(refundGuard('paid', false).ok).toBe(true);
    const detail = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
    expect(detail.json['has_dispute']).toBe(false);
    await s.close();
  });

  // @why 事件与审计是"谁在什么时候解开的"的唯一留痕：没有它们，这个口就跟手工改库没区别。
  it('写下 dispute_released 事件（actor 是 admin:<sub>）与 admin_audit（含改前值）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {
      reason: '已与买家和解',
    });
    expect(r.status).toBe(200);

    const ev =
      await db`select status, note, actor from order_events where order_id = 'o-1' and status = 'dispute_released'`;
    expect(ev).toHaveLength(1);
    expect(String(ev[0]?.note)).toBe('已与买家和解');
    expect(String(ev[0]?.actor)).toMatch(/^admin:/); // 人工动作，不是机构事件

    // ⚠️ 审计是**响应之后**异步写的（中间件挂在 `prefinish`，不与业务同事务）：
    //    必须"等它出现"，不能"响应回来了就直接查"——直接查在机器忙时会先于 insert 到期，
    //    于是同一条用例在 `test:db` 里绿、在 `cov`（全量并发）里红（AJ-274 实测）。
    const auditQ = () =>
      db`select action, target, before, after from admin_audit where target = 'o-1'`;
    await waitUntil(
      async () => (await auditQ()).some((a) => String(a['action']).includes('dispute/release')),
      'admin_audit 里没有这条解锁记录',
    );
    const audit = await auditQ();
    const row = audit.find((a) => String(a['action']).includes('dispute/release'));
    expect(row, 'admin_audit 里没有这条解锁记录').toBeDefined();
    // 不可逆操作要记改前值（admin-audit 中间件只在显式提供时才写 before）
    expect(String(JSON.stringify(row?.['before']))).toContain('has_dispute');
    await s.close();
  });

  // @why **不碰 payments.dispute_***：解除的是"限制"不是"事实"。
  //      允许抹掉拒付记录 = 这个口从逃生口变成橡皮擦。
  it('🔴 不碰 payments.dispute_*（拒付记录照旧在风控列表里看得见）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    await db`update payments set dispute_id = 'dp_1', dispute_status = 'lost' where id = 'pay-o-1'`;
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {
      reason: '败诉单已线下退款给买家',
    });
    expect(r.status).toBe(200);
    const p = await db`select dispute_id, dispute_status from payments where id = 'pay-o-1'`;
    expect(String(p[0]?.dispute_id)).toBe('dp_1');
    expect(String(p[0]?.dispute_status)).toBe('lost');
    await s.close();
  });

  /**
   * @why "解除一个本来就没锁的限制"如果返回成功，运营点错单号时会**以为**自己解开了某张单，
   *      而实际上什么都没发生。这是这个口最危险的用法，必须响亮失败。
   */
  it('🔴 本来就没锁 → 40902 dispute_not_locking（不是幂等 200）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' }); // has_dispute 默认 false
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {
      reason: '试试',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    expect((await db`select has_dispute from orders where id = 'o-1'`)[0]?.has_dispute).toBe(false);
    await s.close();
  });

  it('缺理由 → 40001；超长理由 → 40001；订单不存在 → 40400', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', hasDispute: true });
    expect(
      (await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {})).status,
    ).toBe(400);
    expect(
      (
        await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/dispute/release', {
          reason: '理'.repeat(ADMIN_NOTE_MAX_LENGTH + 1),
        })
      ).status,
    ).toBe(400);
    // 超长的没落下事件（理由根本没进库）
    expect(
      await db`select 1 from order_events where order_id = 'o-1' and status = 'dispute_released'`,
    ).toHaveLength(0);

    const missing = await adminFetch(s, 'POST', '/api/v1/admin/orders/nope/dispute/release', {
      reason: 'x',
    });
    expect(missing.status).toBe(404);
    await s.close();
  });
});

describe('POST /admin/orders/{id}/address（发货前改址）', () => {
  it('paid + 合法地址 → 200，快照改了、事件记了、**状态没动**', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', ADDR);
    expect(r.status).toBe(200);
    const rows = await db`select status, address_snapshot from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('paid');
    const snap = rows[0]?.address_snapshot as { recipient?: string; country?: string };
    expect(snap.recipient).toBe('SAN ZHANG');
    expect(snap.country).toBe('US');
    const evs = await db`select status, actor, note from order_events where order_id = 'o-1'`;
    expect(String(evs[0]?.status)).toBe('address_changed');
    expect(String(evs[0]?.actor)).toMatch(/^admin:/);
    // B12 / AJ-208：路由层同样要留旧地址——仓储层的用例证明不了"这条路由真的把旧值带出来了"。
    // AJ-293 之后旧值**不再写在 note 里**（note 只留"人话 + 归档号"），改去归档表取。
    // @why 断言必须**真的把 recipient 读出来比对**，不能降级成"查到 1 行就算过"——
    //      只断言 count 的话，写入方向写反（把新值当旧值归档）也全绿，而取证拿到的是错的。
    // @why 反过来，note 里**不许**再出现旧地址：原来这里 JSON.parse(note).from.recipient，
    //      那条路径正是 AJ-293 要拆掉的暴露面（订单详情会把 note 原样渲染给运营看）。
    expect(String(evs[0]?.['note'])).not.toContain('Jane Doe');
    const hist = await db`select snapshot from order_address_history where order_id = 'o-1'`;
    expect(hist).toHaveLength(1);
    expect((hist[0]?.['snapshot'] as { recipient?: string }).recipient).toBe('Jane Doe');
    await s.close();
  });

  it('已发货 → 40902（改址不动已发出的货）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1', status: 'shipped' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', ADDR);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(40902);
    await s.close();
  });

  it('非 ASCII 收件人 → 40002（与买家地址簿同一份校验，不是第二份）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', {
      ...ADDR,
      recipient: '张三',
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40002);
    await s.close();
  });

  it('国家不可下单（ZZ）→ 40002（表驱动，不写死 US）', async () => {
    const s = await buildServer();
    await seedOrder({ id: 'o-1' });
    const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', {
      ...ADDR,
      country: 'ZZ',
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(40002);
    await s.close();
  });
});

/** 评估 4.5（2026-10-09）：列表排序 `sort`（白名单；`-键` 降序），默认仍是下单时间倒序。 */
describe('GET /admin/orders?sort', () => {
  async function seedThree(): Promise<void> {
    for (const [id, total, mins] of [
      ['o-a', 9800, 30],
      ['o-b', 1650, 20],
      ['o-c', 24_300, 10],
    ] as const) {
      await seedOrder({ id });
      await db`update orders set total_jpy = ${total}, created_at = now() - ${`${mins} minutes`}::interval
               where id = ${id}`;
    }
  }
  const ids = (j: Record<string, unknown>): unknown[] =>
    (j.items as Array<{ order_id: string }>).map((i) => i.order_id);

  it('🔴 sort=-total_jpy → 金额从大到小；sort=total_jpy → 从小到大；不传 → 下单时间倒序', async () => {
    const s = await buildServer();
    await seedThree();
    expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders?sort=-total_jpy')).json)).toEqual([
      'o-c',
      'o-a',
      'o-b',
    ]);
    expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders?sort=total_jpy')).json)).toEqual([
      'o-b',
      'o-a',
      'o-c',
    ]);
    expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders')).json)).toEqual([
      'o-c',
      'o-b',
      'o-a',
    ]);
    expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders?sort=created_at')).json)).toEqual([
      'o-a',
      'o-b',
      'o-c',
    ]);
    await s.close();
  });

  it('🔴 白名单外的键 → 400 / 40001（不静默按默认排）', async () => {
    const s = await buildServer();
    for (const bad of ['stock', 'id;drop', '--total_jpy']) {
      const r = await adminFetch(s, 'GET', `/api/v1/admin/orders?sort=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe(40001);
    }
    await s.close();
  });

  describe('严格检查第二轮 · 第二批（服务端）', () => {
    it('🔴 ADM-6（AJ-453）：sort=paid_at → 最早付款的在前（待发货页签按它排，最久未发货的先处理）', async () => {
      const s = await buildServer();
      for (const [id, paidAt] of [
        ['o-late', '2026-10-09T03:00:00Z'],
        ['o-early', '2026-10-07T03:00:00Z'],
        ['o-mid', '2026-10-08T03:00:00Z'],
      ] as const) {
        await seedOrder({ id });
        await db`update orders set paid_at = ${paidAt} where id = ${id}`;
      }
      const ids = (j: Record<string, unknown>): string[] =>
        (j['items'] as Array<{ order_id: string }>).map((i) => i.order_id);
      expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders?sort=paid_at')).json)).toEqual([
        'o-early',
        'o-mid',
        'o-late',
      ]);
      expect(ids((await adminFetch(s, 'GET', '/api/v1/admin/orders?sort=-paid_at')).json)).toEqual([
        'o-late',
        'o-mid',
        'o-early',
      ]);
      await s.close();
    });

    it('🔴 OPS-3（AJ-454）：attention=partial_refund 列出有部分退款（在途或已成功但未退满）的单；已整单退款的不出现', async () => {
      const s = await buildServer();
      await seedOrder({ id: 'o-pr' });
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
             values ('rf-pr', 'o-pr', 'pay-o-pr', 'JPY', 300, '破损', 'succeeded', 'admin:u-a', now())`;
      await seedOrder({ id: 'o-inflight' });
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
             values ('rf-if', 'o-inflight', 'pay-o-inflight', 'JPY', 300, '破损', 'pending', 'admin:u-a', now())`;
      await seedOrder({ id: 'o-failed-only' });
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
             values ('rf-f', 'o-failed-only', 'pay-o-failed-only', 'JPY', 300, '破损', 'failed', 'admin:u-a', now())`;
      await seedOrder({ id: 'o-refunded', status: 'refunded' });
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
             values ('rf-r', 'o-refunded', 'pay-o-refunded', 'JPY', 1650, '破损', 'succeeded', 'admin:u-a', now())`;
      await seedOrder({ id: 'o-plain' });
      const r = await adminFetch(s, 'GET', '/api/v1/admin/orders?attention=partial_refund');
      expect(r.status).toBe(200);
      expect(
        (r.json['items'] as Array<{ order_id: string }>).map((i) => i.order_id).sort(),
      ).toEqual(['o-inflight', 'o-pr']);
      await s.close();
    });

    it('🔴 A-4（AJ-455）：改址后详情带 address_history（改前完整地址、谁、何时）；审计 after 只记归档号、不含地址字段', async () => {
      const s = await buildServer();
      await seedOrder({ id: 'o-1' });
      const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/address', ADDR);
      expect(r.status).toBe(200);
      const d = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
      const hist = d.json['address_history'] as Array<Record<string, unknown>>;
      expect(hist).toHaveLength(1);
      expect(hist[0]?.['snapshot']).toMatchObject({
        recipient: 'Jane Doe',
        line1: '1 Infinite Loop',
      });
      expect(hist[0]?.['actor']).toMatch(/^admin:/);
      expect(typeof hist[0]?.['at']).toBe('string');
      let audit: readonly Record<string, unknown>[] = [];
      for (let i = 0; i < 50 && audit.length === 0; i++) {
        audit =
          await db`select after from admin_audit where target = 'o-1' and action = 'POST /admin/orders/:id/address'`;
        if (audit.length === 0) await new Promise((r) => setTimeout(r, 20));
      }
      const after = JSON.stringify(audit[0]?.['after']);
      expect(after).toContain('archive_id');
      for (const k of ['recipient', 'line1', 'city', 'state', 'phone', 'SAN ZHANG', 'Cupertino']) {
        expect(after, `审计 after 不该含 ${k}`).not.toContain(k);
      }
      await s.close();
    });

    it('🔴 G1（AJ-456）：有部分退款在途时整单退款 → 40902 且 data.reason=partial_refund_in_flight（管理端据此给下一步）', async () => {
      const s = await buildServer();
      await seedOrder({ id: 'o-1' });
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
             values ('rf-1', 'o-1', 'pay-o-1', 'JPY', 300, '破损', 'pending', 'admin:u-a', now())`;
      const r = await adminFetch(s, 'POST', '/api/v1/admin/orders/o-1/refund', { reason: '缺货' });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe(40902);
      expect((r.json as { data?: { reason?: string } }).data?.reason).toBe(
        'partial_refund_in_flight',
      );
      await s.close();
    });
  });

  describe('ADM-1（AJ-466）：详情事件带操作者邮箱', () => {
    it('actor=admin:<id> 的事件回填 actor_email；系统 / 机构事件不带', async () => {
      const s = await buildServer();
      await seedOrder({ id: 'o-1' });
      await db`insert into users (id, openid, email, is_admin) values ('u-ops', 'o-ops', 'ops@example.com', true) on conflict (id) do nothing`;
      await db`insert into order_events (order_id, status, actor, at) values
             ('o-1', 'shipped', 'admin:u-ops', now()), ('o-1', 'paid', 'provider:mock', now() - interval '1 minute')`;
      const r = await adminFetch(s, 'GET', '/api/v1/admin/orders/o-1');
      const events = r.json['events'] as Array<Record<string, unknown>>;
      expect(events.find((e) => e['status'] === 'shipped')?.['actor_email']).toBe(
        'ops@example.com',
      );
      expect(events.find((e) => e['status'] === 'paid')).not.toHaveProperty('actor_email');
      await s.close();
    });
  });
});
