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
import { shippingRatesFingerprint } from '@waselect/shared';
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
import { waitUntil } from '../../../test/helpers/chain-server.js';

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

  // 规律排查 2026-10-12：超过 FX_MAX_AGE_HOURS（默认 72h）没更新的汇率，报价与下单当它缺失（整店 50003），
  //   运营页却照样标"（当前生效）"——看不出店已经下不了单
  it('🔴 当前行带过期时刻 stale_at 与 stale（与报价同口径：生效满 72 小时即过期）', async () => {
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
      values ('USD', 0.0067, 0.0065, 0.03, now() - interval '73 hours'),
             ('CNY', 0.049, 0.048, 0.03, now() - interval '1 hour')
    `;
    const { url, close } = await buildServer();
    try {
      const r = await call(url, 'GET', '/api/v1/admin/fx', undefined, await bearer());
      const rows = r.body as Array<Record<string, unknown>>;
      const usd = rows.find((x) => x['quote'] === 'USD');
      const cny = rows.find((x) => x['quote'] === 'CNY');
      expect(usd).toMatchObject({ is_current: true, stale: true });
      expect(cny).toMatchObject({ is_current: true, stale: false });
      const cnyAt = Date.parse(String(cny?.['effective_from']));
      expect(Date.parse(String(cny?.['stale_at'])) - cnyAt).toBe(72 * 3_600_000);
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

  /**
   * 突变 → 打 fx_rate_jump 的 warn（只记不拦，AJ-148 ④）。
   *
   * @why 2026-10-02（AJ-297）换了输入值：原来用 `0.65`（0.0065 多打两个 0，100 倍），
   *      但 per-quote 量纲区间上线后 0.65 会被**拦在校验层**（400），根本到不了 warn ——
   *      也就是说这条用例原来测的路径，现在归 `fx-input` 的量纲护栏管了。
   *      ⇒ 本用例改用**区间之内**的突变（0.0065 → 0.02，约 3.1 倍，≥ FX_JUMP_RATIO）：
   *      这正是"只记不拦"那层**剩下**的职责——量纲管得着的它不管，量纲管不着的它来记。
   * @why 顺带钉住"阈值取 3 而不是 10"：0.02/0.002 = 10 是区间内可能的最大倍数，
   *      只在两个端点之间成立；取 10 的话这条 warn 在真实维护里永远不触发。
   */
  it('突变超过阈值 → 打 fx_rate_jump 的 warn（只记不拦，AJ-148 ④ / AJ-297）', async () => {
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
          // ← 仍在 USD 区间 [0.002, 0.02] 内，但相对上一条（0.006695）跳了约 3.1 倍
          //   （0.65 这种"多打两个 0"现在由量纲护栏拦，走不到这里）
          raw_rate: 0.02,
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
      // 突变倍数进了日志：排障时不用自己拿两条记录去算
      expect((warns[0]?.['ctx'] as { ratio?: number }).ratio).toBeGreaterThan(3);
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

  it('🔴 ADM-4（AJ-458）：带 expected 指纹的整表替换——指纹对上 → 200；用过期指纹再存 → 40914 且表不动；不带指纹照旧放行', async () => {
    const { url, close } = await buildServer();
    try {
      await db`insert into shipping_rates (carrier, max_weight_g, price_jpy, active) values ('old', 1000, 3000, true)`;
      const current = shippingRatesFingerprint([
        { carrier: 'old', max_weight_g: 1000, price_jpy: 3000, active: true },
      ]);
      const ok = await call(
        url,
        'PUT',
        `/api/v1/admin/shipping-rates?expected=${current}`,
        RATES,
        await bearer(),
      );
      expect(ok.status).toBe(200);
      const stale = await call(
        url,
        'PUT',
        `/api/v1/admin/shipping-rates?expected=${current}`,
        [{ carrier: 'x', max_weight_g: 500, price_jpy: 1, active: true }],
        await bearer(),
      );
      expect(stale.status).toBe(409);
      expect((stale.body as { code: number }).code).toBe(40914);
      const rows = await db`select carrier from shipping_rates order by max_weight_g`;
      expect(rows.map((x) => String(x['carrier']))).toEqual(['placeholder', 'placeholder']);
      const noExpected = await call(
        url,
        'PUT',
        '/api/v1/admin/shipping-rates',
        RATES,
        await bearer(),
      );
      expect(noExpected.status).toBe(200);
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

  /**
   * 🔴 AJ-354（**接线级**）：并发保存运费时，审计行的 `before` 必须是先到者刚提交的那张表。
   *
   * @why 光有仓储层那条用例**不够**——它证明的是"仓储会返回正确的 before"，
   *      证明不了"路由真的把它交给了 `setAuditBefore`"。旧实现正是路由自己在锁外
   *      先读一次（`listShippingRates()`），那条路径在仓储层怎么改都不会红。
   *      （同 §2 第 35 条的教训：组件做对了、组件测试全绿，不等于规则已落地。）
   * @how 用 `db.begin` 持住先到者 A 的事务不提交（与 B22 同一套"确定状态"手法：
   *      不用 sleep 抢时序），再让 B 走**真实 HTTP** 进来 ⇒ B 必然堵在表锁上；
   *      释放 A 之后 B 才继续，此时它读到的表是确定的（= A 的输入）。
   *      ⚠️ 初始表用**直接 SQL** 铺而不是再发一次 PUT：否则库里会有两行
   *      同 action 的审计，断言"恰好一行"就不成立。
   */
  it('🔴 并发保存运费：审计的 before = 先到者刚提交的那张表（AJ-354）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('initial', 300, 900, true)
      `;
      let release: () => void = () => {};
      const released = new Promise<void>((r) => {
        release = r;
      });
      let opened: () => void = () => {};
      const openedP = new Promise<void>((r) => {
        opened = r;
      });

      // 先到者 A：锁表 → 清空 → 插入自己的档 → **持住不提交**
      const holdA = db.begin(async (tx) => {
        await tx`lock table shipping_rates in exclusive mode`;
        await tx`delete from shipping_rates`;
        await tx`
          insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
          values ('A', 500, 1000, true)
        `;
        opened();
        await released;
      });
      await openedP;

      const B_ROWS = [{ carrier: 'B', max_weight_g: 700, price_jpy: 2000, active: true }];
      let bDone = false;
      const putB = call(url, 'PUT', '/api/v1/admin/shipping-rates', B_ROWS, await bearer()).then(
        (r) => {
          bDone = true;
          return r;
        },
        (e: unknown) => {
          bDone = true;
          throw e;
        },
      );
      // 🔴 **必须先确认 B 真的堵在表锁上，再释放 A**——否则 B 可能整条跑在 A 提交之后，
      //    那时"锁外读 before"与"锁内读 before"给出**同一个答案**，用例假绿。
      //    ⚠️ 第一版就栽在这里：注入（改成锁外读）之后它照样绿，等于没测。
      //    判据是 **pg_stat_activity 里有别的后端正在等 `lock table shipping_rates`**，
      //    不是"等了多久"：等这把锁的只可能是 B（A 自己是 idle in transaction，不等锁）。
      //    两种实现下 B 都会堵在 lock 上（锁外读时那句 select 取 ACCESS SHARE，
      //    与 EXCLUSIVE 不冲突 ⇒ 读得到、然后才堵），所以"堵住"证明的是"B 已经开始了"。
      await waitUntil(
        async () => {
          const rows = await db`
            select count(*)::int as n from pg_stat_activity
             where state = 'active' and wait_event_type = 'Lock'
               and query like 'lock table shipping_rates%'
          `;
          return Number(rows[0]?.['n'] ?? 0) > 0;
        },
        'B 没有堵在运费表锁上（本用例的并发前提不成立）',
        3000,
      );
      expect(bDone).toBe(false); // 顺带确认 B 此时还没结束（前提的一致性检查）
      release();
      await holdA;
      const res = await putB;
      expect(res.status).toBe(200);

      // 审计是**响应之后**异步写的（中间件挂在 prefinish 上，不与业务同事务）
      const q = () => db`select before from admin_audit where action = 'PUT /admin/shipping-rates'`;
      await waitUntil(async () => (await q()).length === 1, '运费替换的审计行没写进来');
      const rows = await q();
      expect(rows).toHaveLength(1);
      // ① 不是最初那张表（旧实现在这里给出 initial）
      expect(rows[0]?.['before']).toEqual([
        { carrier: 'A', max_weight_g: 500, price_jpy: 1000, active: true },
      ]);
      // ② 库里最终是 B 那张（顺带确认这次替换真的发生了，审计不是凭空写的）
      expect(await db`select carrier, max_weight_g, price_jpy, active from shipping_rates`).toEqual(
        [{ carrier: 'B', max_weight_g: 700, price_jpy: 2000, active: true }],
      );
    } finally {
      await close();
    }
  });
});

/**
 * P2-30 的另一半：换运费表不能把**在售商品**挤出最高档（否则那件商品从此报不了价）。
 * 默认 PACKAGING_WEIGHT_G = 250。
 */
describe('PUT /admin/shipping-rates 不得装不下在售商品（P2-30 / 40918）', () => {
  async function seedProduct(id: string, weightG: number, status: string): Promise<void> {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, status,
                            customs_desc_en, origin_country, hs_code)
      values (${id}, ${'重货 ' + id}, 'kitchen', 9800, ${weightG}, 3, ${status},
              'kitchen knife set', 'JP', '8211.91')
    `;
  }

  it('🔴 新表最高 2000、在售商品 1800g（+250 = 2050）→ 409/40918，data 指出是哪件，旧表原样保留', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('old', 5000, 9200, true)
      `;
      await seedProduct('p-heavy', 1800, 'active');
      const r = await call(url, 'PUT', '/api/v1/admin/shipping-rates', RATES, await bearer());
      expect(r.status).toBe(409);
      expect(code(r)).toBe(40918);
      expect((r.body as { data?: { product_id?: string } }).data?.product_id).toBe('p-heavy');
      const rows = await db`select carrier, max_weight_g from shipping_rates`;
      expect(rows.map((x) => [x['carrier'], x['max_weight_g']])).toEqual([['old', 5000]]);
    } finally {
      await close();
    }
  });

  it('同样重的商品已下架 → 放行（下架品不报价）；1750g 在售（+250 = 2000 恰好最高档）→ 放行', async () => {
    const { url, close } = await buildServer();
    try {
      await seedProduct('p-off', 9000, 'offline');
      await seedProduct('p-edge', 1750, 'active');
      const r = await call(url, 'PUT', '/api/v1/admin/shipping-rates', RATES, await bearer());
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});
