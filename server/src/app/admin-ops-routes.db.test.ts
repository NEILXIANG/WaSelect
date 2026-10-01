/**
 * 职责：`/admin/fx` 与 `/admin/shipping-rates` 四条路由的接线级真库用例（I2 U-C3）。
 *
 * @why 守卫与"改前值进日志"都要**接线级**测：`requireRole` 与各校验函数都有单测，
 *      但"这条路由有没有挂它们"只有接线级能证明——管理端接口漏守卫的代价是全库可写。
 *
 * @why 断言一律查**库**而不是信响应：响应是路由自己拼的，库才是事实（§2 第 21 条）。
 *      汇率那条尤其重要：响应是 201 空体，"到底存进去没有、存的 rate 是多少"只能查库。
 *
 * @why 两条写路由的失败用例都要顺便断言"**库里没变**"：
 *      400 只说明"被拦住了"，不能说明"没有先删后插到一半"。
 *      整表替换的失败路径如果留下半张表，后果是全站 50004 无法报价。
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
import { createCatalogRepo } from '../adapters/catalog.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-ops-test-jwt-secret-'.repeat(3);

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

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-ops-route-test',
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

async function seedUser(isAdmin: boolean, tag: string): Promise<string> {
  const id = `u-${tag}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${tag}`}, ${`${tag}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  return id;
}

/** 管理员（默认）或买家的 Bearer 头。⚠️ `signToken` 是 async——必须 await，否则拼出 "Bearer [object Promise]"。 */
const bearer = async (isAdmin = true): Promise<string> => {
  const sub = await seedUser(isAdmin, isAdmin ? 'admin' : 'buyer');
  const t = await signToken(
    { sub, role: isAdmin ? 'admin' : 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  return `Bearer ${t}`;
};

/** 发请求并返回 {status, body}；body 为空体时是 null。 */
async function call(
  url: string,
  method: 'GET' | 'POST' | 'PUT',
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
const RATES = [
  { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2100, active: true },
  { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4950, active: true },
];

describe('守卫', () => {
  it('四条路由：无 token → 40101；买家 token → 40301', async () => {
    const { url, close } = await buildServer();
    try {
      const cases: Array<['GET' | 'POST' | 'PUT', string]> = [
        ['GET', '/api/v1/admin/fx'],
        ['POST', '/api/v1/admin/fx'],
        ['GET', '/api/v1/admin/shipping-rates'],
        ['PUT', '/api/v1/admin/shipping-rates'],
      ];
      for (const [method, path] of cases) {
        const body =
          method === 'GET' ? undefined : method === 'POST' ? { quote: 'USD', raw_rate: 1 } : RATES;
        const anon = await call(url, method, path, body);
        expect(anon.status, `${method} ${path} 无 token`).toBe(401);
        expect(code(anon)).toBe(40101);
        const buyer = await call(url, method, path, body, await bearer(false));
        expect(buyer.status, `${method} ${path} 买家 token`).toBe(403);
        expect(code(buyer)).toBe(40301);
      }
    } finally {
      await close();
    }
  });
});

describe('GET /admin/fx', () => {
  it('管理员 → 200；空表返回空数组（不是 null、不是 {items}）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/fx', undefined, await bearer());
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    } finally {
      await close();
    }
  });

  it('含历史与未来生效行，且每个币种最新一行在最上面（AJ-150 ①）', async () => {
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
      values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 day'),
             ('USD', 0.0070, 0.0068, 0.03, now() + interval '1 day'),
             ('CNY', 0.049, 0.048, 0.03, now())
    `;
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/fx', undefined, await bearer());
      expect(r.status).toBe(200);
      const rows = r.body as Array<Record<string, unknown>>;
      // 未来生效的那条必须在场（过滤掉它 = 运营以为没保存成功）
      expect(rows).toHaveLength(3);
      expect(rows.map((x) => x['quote'])).toEqual(['CNY', 'USD', 'USD']);
      expect(Number(rows[1]?.['rate'])).toBe(0.007); // 同币种内倒序：未来行在前
      expect(Number(rows[1]?.['raw_rate'])).toBe(0.0068);
      expect(typeof rows[0]?.['effective_from']).toBe('string');
      expect(Number(rows[0]?.['buffer'])).toBe(0.03);
      // 🔴 ADM3-05：每行都带 is_current，且由**服务端时钟**判定（未来行 false / 已生效行 true）
      expect(rows.map((x) => x['is_current'])).toEqual([true, false, true]);
      expect(Number(rows[2]?.['raw_rate'])).toBe(0.0065); // USD 已生效的那行才是当前
    } finally {
      await close();
    }
  });

  it('🔴 is_current 按 quote + 时刻复合判定：另一币种同一毫秒的历史行不得被标成当前（ADM3-05）', async () => {
    // 批量补录时两个币种可能落在同一毫秒；只按毫秒记"当前"会把 CNY 的历史行也标成当前生效
    const t1 = new Date(Date.now() - 3_600_000); // 1 小时前
    const t2 = new Date(Date.now() - 1_800_000); // 30 分钟前（更晚）
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
      values ('USD', 0.0067, 0.0065, 0.03, ${t1}),
             ('CNY', 0.048, 0.047, 0.03, ${t1}),
             ('CNY', 0.049, 0.048, 0.03, ${t2})
    `;
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/fx', undefined, await bearer());
      const rows = r.body as Array<Record<string, unknown>>;
      const cur = rows.filter((x) => x['is_current'] === true);
      expect(cur).toHaveLength(2); // 每个币种**恰好**一行
      expect(cur.map((x) => x['quote']).sort()).toEqual(['CNY', 'USD']);
      // CNY 的当前行必须是更晚那条（t2），不是与 USD 撞毫秒的那条（t1）
      expect(Number(cur.find((x) => x['quote'] === 'CNY')?.['raw_rate'])).toBe(0.048);
    } finally {
      await close();
    }
  });

  it('全部都是未来生效行时没有任何 is_current（前端据此判定"没有基准"，不会拿旧值当基准）', async () => {
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
      values ('USD', 0.0070, 0.0068, 0.03, now() + interval '1 day')
    `;
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/fx', undefined, await bearer());
      const rows = r.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1); // 行还在（不能因为"未生效"就从列表里消失）
      expect(rows[0]?.['is_current']).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('POST /admin/fx', () => {
  it('成功：201 空体，库里 rate = raw × (1 + buffer)，不传 effective_from 取当前时间', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/fx',
        { quote: 'USD', raw_rate: 0.0065 },
        await bearer(),
      );
      expect(r.status).toBe(201);
      expect(r.body).toBeNull();

      // 查库：响应是空体，库才是事实
      const rows =
        await db`select quote, rate, raw_rate, buffer, effective_from, created_by from fx_rates`;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['quote']).trim()).toBe('USD');
      expect(Number(rows[0]?.['rate'])).toBe(0.006695); // 0.0065 × 1.03
      expect(Number(rows[0]?.['raw_rate'])).toBe(0.0065);
      expect(Number(rows[0]?.['buffer'])).toBe(0.03);
      expect(String(rows[0]?.['created_by'])).toContain('admin:');
      // 不传时间 → 立即生效（不晚于当下）
      expect((rows[0]?.['effective_from'] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      await close();
    }
  });

  it('传了 effective_from → 用它（不是当前时间）', async () => {
    const { url, close } = await buildServer();
    try {
      const at = '2026-09-28T09:00:00+09:00';
      const r = await call(
        url,
        'POST',
        '/api/v1/admin/fx',
        { quote: 'CNY', raw_rate: 0.048, effective_from: at },
        await bearer(),
      );
      expect(r.status).toBe(201);
      const rows = await db`select effective_from from fx_rates`;
      expect((rows[0]?.['effective_from'] as Date).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    } finally {
      await close();
    }
  });

  it('非法输入：quote 不在枚举 / raw_rate ≤ 0 / 超量纲 / 日期非法 → 40001 且**没落库**', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      for (const body of [
        { quote: 'JPY', raw_rate: 1 },
        { quote: 'USD', raw_rate: 0 },
        { quote: 'USD', raw_rate: -1 },
        { quote: 'USD', raw_rate: 5000 },
        { quote: 'USD' },
        { quote: 'USD', raw_rate: 0.0065, effective_from: 'yesterday' },
      ]) {
        const r = await call(url, 'POST', '/api/v1/admin/fx', body, token);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(code(r)).toBe(40001);
      }
      expect((await db`select count(*)::int as n from fx_rates`)[0]?.['n']).toBe(0);
    } finally {
      await close();
    }
  });

  it('同币种同一生效时间重复 → 40910（不是 50000：那是"服务端故障"，方向反掉）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      const body = { quote: 'USD', raw_rate: 0.0065, effective_from: '2026-09-28T00:00:00Z' };
      expect((await call(url, 'POST', '/api/v1/admin/fx', body, token)).status).toBe(201);
      const dup = await call(url, 'POST', '/api/v1/admin/fx', body, token);
      expect(dup.status).toBe(409);
      expect(code(dup)).toBe(40910);
      expect((await db`select count(*)::int as n from fx_rates`)[0]?.['n']).toBe(1);
    } finally {
      await close();
    }
  });

  it('突变 10 倍以上 → 打 fx_rate_jump 的 warn（只记不拦，AJ-148 ④）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      // 两条都用 2020 年的生效时间：一定早于"现在"，顺序与真实挂钟无关（测试不依赖今天几号）
      const first = await call(
        url,
        'POST',
        '/api/v1/admin/fx',
        {
          quote: 'USD',
          raw_rate: 0.0065,
          effective_from: '2020-01-01T00:00:00Z',
        },
        token,
      );
      expect(first.status).toBe(201);
      const second = await call(
        url,
        'POST',
        '/api/v1/admin/fx',
        {
          quote: 'USD',
          raw_rate: 0.65, // ← 多打两个 0：0.006695 → 0.6695，约 100 倍
          effective_from: '2020-01-02T00:00:00Z',
        },
        token,
      );
      expect(second.status).toBe(201);

      const warns = sink.find('fx_rate_jump');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.['level']).toBe('warn');
      // 改前值必须进日志（维护不可逆，没有 prev 就答不出"上一次是多少"）
      const sets = sink.find('admin_fx_set');
      expect(sets).toHaveLength(2);
      expect((sets[0]?.['ctx'] as { prev_rate?: number | null }).prev_rate).toBeNull();
      expect((sets[1]?.['ctx'] as { prev_rate?: number }).prev_rate).toBeCloseTo(0.006695, 8);
      // 只记不拦：第二次仍是 201，没有被拒绝
      expect((await db`select count(*)::int as n from fx_rates`)[0]?.['n']).toBe(2);
    } finally {
      await close();
    }
  });
});

describe('GET /admin/shipping-rates', () => {
  it('空表 → []；有数据 → 含停用档且按上限升序', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      expect(
        (await call(url, 'GET', '/api/v1/admin/shipping-rates', undefined, token)).body,
      ).toEqual([]);
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('placeholder', 2000, 4950, true), ('placeholder', 500, 2100, false)
      `;
      const r = await call(url, 'GET', '/api/v1/admin/shipping-rates', undefined, token);
      expect(r.status).toBe(200);
      const rows = r.body as Array<Record<string, unknown>>;
      expect(rows.map((x) => x['max_weight_g'])).toEqual([500, 2000]);
      expect(rows[0]?.['active']).toBe(false); // 停用档也要看得见
      expect(rows[0]?.['carrier']).toBe('placeholder');
      expect(rows[0]?.['price_jpy']).toBe(2100);
    } finally {
      await close();
    }
  });
});

describe('PUT /admin/shipping-rates', () => {
  it('整表替换：200 空体，库里只剩新表（旧的没了）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('old', 1000, 3000, true)
      `;
      const r = await call(url, 'PUT', '/api/v1/admin/shipping-rates', RATES, await bearer());
      expect(r.status).toBe(200);
      expect(r.body).toBeNull();
      const rows =
        await db`select carrier, max_weight_g, price_jpy, active from shipping_rates order by max_weight_g`;
      expect(rows.map((x) => String(x['carrier']))).toEqual(['placeholder', 'placeholder']);
      expect(rows.map((x) => Number(x['max_weight_g']))).toEqual([500, 2000]);
      // 改前值进日志：整表替换不可逆
      const ev = sink.find('admin_shipping_rates_replaced');
      expect(ev).toHaveLength(1);
      const ctx = ev[0]?.['ctx'] as {
        before_count?: number;
        after_count?: number;
        before?: unknown[];
      };
      expect(ctx.before_count).toBe(1);
      expect(ctx.after_count).toBe(2);
      expect(ctx.before).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('🔴 两家承运商同时启用 → 40001 且**库里一张没动**（否则全站 50004 无法报价）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('placeholder', 2000, 4950, true)
      `;
      const r = await call(
        url,
        'PUT',
        '/api/v1/admin/shipping-rates',
        [...RATES, { carrier: 'yamato', max_weight_g: 2000, price_jpy: 5000, active: true }],
        await bearer(),
      );
      expect(r.status).toBe(400);
      expect(code(r)).toBe(40001);
      const rows = await db`select carrier, max_weight_g from shipping_rates`;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['carrier'])).toBe('placeholder');
    } finally {
      await close();
    }
  });

  it('空表 / 重复档 / 非整数重量 / 全停用 → 40001 且库里没变', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('placeholder', 2000, 4950, true)
      `;
      const token = await bearer();
      for (const body of [
        [],
        {},
        [
          { carrier: 'placeholder', max_weight_g: 500, price_jpy: 1 },
          { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2 },
        ],
        [{ carrier: 'placeholder', max_weight_g: 1.5, price_jpy: 1 }],
        [{ carrier: 'placeholder', max_weight_g: 0, price_jpy: 1 }],
        [{ carrier: 'placeholder', max_weight_g: 500, price_jpy: -1 }],
        [{ carrier: 'placeholder', max_weight_g: 500, price_jpy: 100, active: false }],
        [{ carrier: '', max_weight_g: 500, price_jpy: 100 }],
      ]) {
        const r = await call(url, 'PUT', '/api/v1/admin/shipping-rates', body, token);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(code(r)).toBe(40001);
      }
      const rows = await db`select max_weight_g from shipping_rates`;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.['max_weight_g'])).toBe(2000);
    } finally {
      await close();
    }
  });

  it('替换后 D-46 取档仍正确（交叉验证 catalog 的唯一取档实现）', async () => {
    const { url, close } = await buildServer();
    try {
      await call(url, 'PUT', '/api/v1/admin/shipping-rates', RATES, await bearer());
      const catalog = createCatalogRepo(db);
      expect(await catalog.resolveSingleActiveCarrier()).toBe('placeholder');
      // 红线向量：1850g → 2000 档（4950）。返回 2100 = 向下取档 = D-46 事故
      expect(await catalog.findShippingPriceJpy('placeholder', 1850)).toBe(4950);
      expect(await catalog.findShippingPriceJpy('placeholder', 500)).toBe(2100);
    } finally {
      await close();
    }
  });
});
