/**
 * 职责：CSV 导出接口（剩余清单 3-3）——订单 / 待采购 / 待发货报关三类。
 * @why 导出的是**含收件地址的 PII**：这里断言三件事——内容对、排除测试单、导出这一动作进审计（GET 不经审计中间件）。
 * @see ./admin-export-routes.ts
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
import { EXPORT_IDS_MAX } from '@waselect/shared';
import type { Clock } from '../ports/clock.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { waitUntil } from '../../../test/helpers/chain-server.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-export-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink = new MemorySink();
});

async function buildServer(clock?: Clock): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-export-route-test',
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
        ...(clock !== undefined ? { clock } : {}),
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function bearer(isAdmin = true): Promise<string> {
  const id = `u-${isAdmin ? 'admin' : 'buyer'}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${id}`}, ${`${id}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  // ⚠️ signToken 是 async——必须 await，否则拼出 "Bearer [object Promise]"
  const t = await signToken(
    { sub: id, role: isAdmin ? 'admin' : 'user' },
    {
      secret: JWT_SECRET,
      issuer: 'waselect',
    },
  );
  return `Bearer ${t}`;
}

async function call(
  url: string,
  method: 'GET' | 'POST',
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

const ADDR = {
  recipient: 'Jane Doe',
  phone: '+14155550123',
  line1: '1 Infinite Loop',
  line2: null,
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
  country: 'US',
};

async function seedOrder(id: string, status: string, isTest = false): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                               fx_snapshot, address_snapshot, terms_version, expires_at, is_test, created_at, paid_at)
           values (${id}, ${`WS${id}`}, ${`u-${id}`}, ${status}, 12800, 4950, null, 17750, 900, '{}'::jsonb,
                   ${db.json(ADDR)}, 'T', now(), ${isTest}, '2026-10-05T00:00:00Z', '2026-10-05T00:10:00Z')`;
  await db`insert into products (id, title, category, price_jpy, weight_g, stock, customs_desc_en, origin_country)
           values (${`p-${id}`}, 'Deba Knife', 'kitchen', 12800, 540, 3, 'Kitchen knife', 'JP') on conflict do nothing`;
  await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g,
                                    declared_value_usd, title_ja, jan_code, purchase_source, cost_jpy, hs_code, customs_desc_en)
           values (${`oi-${id}`}, ${id}, ${`p-${id}`}, 'Deba Knife 出刃包丁', 1, 12800, 540, 8576,
                   '出刃包丁 165mm', '4900000000011', '=HYPERLINK("x")', 6200, '8211.91', 'Kitchen knife, stainless')`;
}

const lines = (csv: string): string[] =>
  csv
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter((l) => l !== '');

describe('GET /api/v1/admin/exports/{kind}（3-3）', () => {
  // 统一结论 5.4：文件内容按日本时间，文件名原先按 UTC 日期——日本时间 0–9 点导出的文件名会是前一天
  it('🔴 文件名用日本时间的日期：UTC 10-09 20:00（日本 10-10 05:00）→ orders-20261010.csv', async () => {
    const { url, close } = await buildServer(fixedClock('2026-10-09T20:00:00.000Z'));
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer());
      expect(r.status).toBe(200);
      expect((r.body as { filename: string }).filename).toBe('orders-20261010.csv');
    } finally {
      await close();
    }
  });

  it('🔴 customs：只出 paid 的单（不含测试单），一行一个行项目，带收件地址、HS 码、申报价（美元两位小数）', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'shipped');
    await seedOrder('o-t', 'paid', true);
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/customs', undefined, await bearer());
      expect(r.status).toBe(200);
      const body = r.body as { filename: string; csv: string };
      expect(body.filename).toMatch(/^customs-\d{8}\.csv$/);
      const ls = lines(body.csv);
      expect(ls).toHaveLength(2); // 表头 + o-1 一行
      expect(ls[0]).toContain('hs_code');
      expect(ls[1]).toContain('WSo-1');
      expect(ls[1]).toContain('Jane Doe');
      // P1-8：号码列以 ="…" 输出，Excel 里保持文本（邮编前导零、电话 +、HS 码 .00 都不丢）
      expect(ls[1]).toContain('"=""95014"""');
      expect(ls[1]).toContain('"=""+14155550123"""');
      expect(ls[1]).toContain('8211.91');
      expect(ls[1]).toContain('85.76');
      expect(ls[1]).toContain('Kitchen knife, stainless');
    } finally {
      await close();
    }
  });

  it('purchase：paid 单的采购快照，公式注入被转义；不含收件地址', async () => {
    await seedOrder('o-1', 'paid');
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/purchase', undefined, await bearer());
      const csv = (r.body as { csv: string }).csv;
      expect(csv).toContain('出刃包丁 165mm');
      expect(csv).toContain('4900000000011');
      expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
      expect(csv).not.toContain('Jane Doe');
      // AJ-493 后续 / AJ-494：采购单是内部用表——中文表头；36 位商品 id 挪到最后一列（核对用）
      expect(lines(csv)[0]).toBe(
        '订单号,付款时间（日本时间）,商品名,日文原名,JAN 码,采购来源,数量,售价（日元）,成本（日元）,备注,商品编号（系统）',
      );
      // 数据行与表头对齐：第 3 列是商品名，最后一列是商品 id（只看表头的话，数据列错位不会红）
      const cells = (lines(csv)[1] ?? '').split(',');
      expect(cells[2]).toBe('Deba Knife 出刃包丁');
      expect(cells.at(-1)).toBe('p-o-1');
    } finally {
      await close();
    }
  });

  // 规律排查 2026-10-12：两张表只看 status = 'paid'——拒付锁定的单服务端不许发货（40909），采购员照表买了发不出去、
  //   报关表里也列着它；拉黑买家的已付单可以发（AJ 批量发货黄字提醒、不拦），采购表上同样要看得到
  it('🔴 拒付锁定的单不进报关表、采购表标"先别采购"；拉黑买家的单采购表标出来', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-d', 'paid');
    await seedOrder('o-b', 'paid');
    await db`update orders set has_dispute = true where id = 'o-d'`;
    await db`update users set blocked_at = now() where id = 'u-o-b'`;
    const { url, close } = await buildServer();
    try {
      const customs = (
        (await call(url, 'GET', '/api/v1/admin/exports/customs', undefined, await bearer()))
          .body as {
          csv: string;
        }
      ).csv;
      expect(customs).not.toContain('WSo-d');
      expect(customs).toContain('WSo-1');
      const purchase = (
        (await call(url, 'GET', '/api/v1/admin/exports/purchase', undefined, await bearer()))
          .body as {
          csv: string;
        }
      ).csv;
      const note = (no: string): string | undefined =>
        lines(purchase)
          .find((l) => l.startsWith(no + ','))
          ?.split(',')
          .at(-2);
      expect(note('WSo-1')).toBe('');
      expect(note('WSo-d')).toBe('拒付锁定：暂不发货，先别采购');
      expect(note('WSo-b')).toBe('买家已拉黑：发货前先核实');
    } finally {
      await close();
    }
  });

  it('orders：全部非测试单（可按 status 过滤），一单一行', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'shipped');
    await seedOrder('o-t', 'paid', true);
    const { url, close } = await buildServer();
    try {
      const all = await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer());
      expect(lines((all.body as { csv: string }).csv)).toHaveLength(3);
      // P2-46：时间列是日本时间（页面全部 JST，导出原先是 UTC Z，跨日统计会错一天）
      // AJ-494：订单总表是内部用表——中文表头、状态写中文（原为 created_at_jst / paid 这类英文字段与代号）
      expect(lines((all.body as { csv: string }).csv)[0]).toBe(
        '订单号,状态,下单时间（日本时间）,付款时间（日本时间）,发货时间（日本时间）,商品金额（日元）,运费（日元）,预估关税（日元）,订单合计（日元）,收件人,州,国家,承运商,运单号,实付币种,实付金额',
      );
      expect((all.body as { csv: string }).csv).toContain(',待发货,');
      expect((all.body as { csv: string }).csv).not.toMatch(/,paid,/);
      expect((all.body as { csv: string }).csv).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect((all.body as { csv: string }).csv).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      const shipped = await call(
        url,
        'GET',
        '/api/v1/admin/exports/orders?status=shipped',
        undefined,
        await bearer(),
      );
      expect(lines((shipped.body as { csv: string }).csv)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('🔴 每次导出都写一条审计（谁、导了哪类、多少行）；未知 kind → 40001；非管理员 → 403', async () => {
    await seedOrder('o-1', 'paid');
    const { url, close } = await buildServer();
    try {
      await call(url, 'GET', '/api/v1/admin/exports/customs', undefined, await bearer());
      // 审计行在响应之后写（admin-audit.ts：prefinish 之后），先等它落库再读——不等在全量负载下偶发读空（2026-10-12 复盘）
      await waitUntil(
        async () => (await db`select 1 from admin_audit`).length >= 1,
        '导出的审计行没写进来',
      );
      const [a] = await db`select actor, action, target, after from admin_audit`;
      expect(a).toMatchObject({
        actor: 'admin:u-admin',
        action: 'GET /admin/exports/:kind', // P2-23：与中间件同形态（去 /api/v1 前缀）,
        target: 'customs',
      });
      expect(a?.['after']).toEqual({ rows: 1 });
      expect(
        code(await call(url, 'GET', '/api/v1/admin/exports/everything', undefined, await bearer())),
      ).toBe(40001);
      expect(
        (await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer(false)))
          .status,
      ).toBe(403);
    } finally {
      await close();
    }
  });

  // ── AJ-407（契约 0.6.48）：导出所选 `order_ids` ──────────────────────────────
  // @why 三类共用同一个过滤：只测 customs 的话，purchase / orders 漏接这个参数时导出的是**全部**订单，
  //      而运营以为导的是勾的那几单——多出来的单会被当成"要采购 / 要报关"处理。
  it('🔴 order_ids：三类都只出所选；未知 id 忽略；测试单即便被选中也不出', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'paid');
    await seedOrder('o-t', 'paid', true);
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      for (const kind of ['customs', 'purchase', 'orders']) {
        const r = await call(
          url,
          'GET',
          `/api/v1/admin/exports/${kind}?order_ids=o-2,o-t,o-nope`,
          undefined,
          token,
        );
        expect(r.status).toBe(200);
        const ls = lines((r.body as { csv: string }).csv);
        expect(ls, kind).toHaveLength(2); // 表头 + o-2
        expect(ls[1], kind).toContain('WSo-2');
      }
    } finally {
      await close();
    }
  });

  it('🔴 order_ids 与 status 是 AND（orders）；purchase / customs 仍只出 paid（所选里的已发货单不出）', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'shipped');
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      const both = await call(
        url,
        'GET',
        '/api/v1/admin/exports/orders?order_ids=o-1,o-2&status=shipped',
        undefined,
        token,
      );
      const ls = lines((both.body as { csv: string }).csv);
      expect(ls).toHaveLength(2);
      expect(ls[1]).toContain('WSo-2');
      const customs = await call(
        url,
        'GET',
        '/api/v1/admin/exports/customs?order_ids=o-1,o-2',
        undefined,
        token,
      );
      const cl = lines((customs.body as { csv: string }).csv);
      expect(cl).toHaveLength(2);
      expect(cl[1]).toContain('WSo-1');
    } finally {
      await close();
    }
  });

  it('🔴 order_ids 非法 → 40001（空串 / 空段 / 重复参数 / 超长 id / 超过上限），一行都不导、不写审计；恰好上限放行', async () => {
    await seedOrder('o-1', 'paid');
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      const many = (n: number): string =>
        Array.from({ length: n }, (_, i) => `x-${String(i)}`).join(',');
      const bad = [
        'order_ids=',
        'order_ids=o-1,',
        'order_ids=o-1,,o-2',
        'order_ids=o-1&order_ids=o-2',
        `order_ids=${'x'.repeat(65)}`,
        `order_ids=${many(EXPORT_IDS_MAX + 1)}`,
      ];
      for (const qs of bad) {
        const r = await call(url, 'GET', `/api/v1/admin/exports/orders?${qs}`, undefined, token);
        expect(r.status, qs.slice(0, 40)).toBe(400);
        expect(code(r), qs.slice(0, 40)).toBe(40001);
      }
      expect(await db`select 1 from admin_audit`).toHaveLength(0);
      const edge = await call(
        url,
        'GET',
        `/api/v1/admin/exports/orders?order_ids=${many(EXPORT_IDS_MAX - 1)},o-1`,
        undefined,
        token,
      );
      expect(edge.status).toBe(200);
      expect(lines((edge.body as { csv: string }).csv)).toHaveLength(2);
      // 同一 id 写两次按一次算（去重），不报错
      const dup = await call(
        url,
        'GET',
        '/api/v1/admin/exports/orders?order_ids=o-1,o-1',
        undefined,
        token,
      );
      expect(lines((dup.body as { csv: string }).csv)).toHaveLength(2);
      // 上限按**去重后**计：恰好上限个不同 id 再重复一个，不算超限
      const atMax = await call(
        url,
        'GET',
        `/api/v1/admin/exports/orders?order_ids=${many(EXPORT_IDS_MAX)},x-0`,
        undefined,
        token,
      );
      expect(atMax.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('🔴 导出所选的审计 after 带所选单数（selected）；不带 order_ids 时形状不变', async () => {
    await seedOrder('o-1', 'paid');
    await seedOrder('o-2', 'paid');
    const { url, close } = await buildServer();
    try {
      await call(
        url,
        'GET',
        '/api/v1/admin/exports/customs?order_ids=o-1,o-2,o-nope',
        undefined,
        await bearer(),
      );
      await waitUntil(
        async () => (await db`select 1 from admin_audit`).length >= 1,
        '导出的审计行没写进来',
      );
      const [a] = await db`select after from admin_audit`;
      expect(a?.['after']).toEqual({ rows: 2, selected: 3 });
    } finally {
      await close();
    }
  });

  it('🔴 ADM-3（AJ-451）：订单总表带买家实付币种与金额（paid_currency / paid_amount，按币种小数位展示）', async () => {
    await seedOrder('o-usd', 'paid');
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
             values ('pay-usd', 'o-usd', 'stripe', 'succeeded', 'USD', 8600)`;
    await seedOrder('o-nopay', 'paid');
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/exports/orders', undefined, await bearer());
      const rows = lines((r.body as { csv: string }).csv);
      expect(rows[0]).toContain(
        '实付币种,实付金额' /* AJ-494：中文表头（原 paid_currency,paid_amount） */,
      );
      const usd = rows.find((l) => l.startsWith('WSo-usd'));
      expect(usd?.endsWith(',USD,86.00')).toBe(true); // 行末两列
      const none = rows.find((l) => l.startsWith('WSo-nopay'));
      expect(none?.endsWith(',,')).toBe(true); // 没有成功支付行：两列为空，不编 0
    } finally {
      await close();
    }
  });
});
