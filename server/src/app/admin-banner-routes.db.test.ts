/**
 * 职责：`/admin/banners*` 四条路由的接线级真库用例（I2 U-D3）。
 *
 * @why 守卫与"改不存在的 id 必须 404"都要**接线级**测：`requireRole` 与
 *      `parseBannerInput` 各自都有单测，但"这条路由有没有挂它们"只有接线级能证明。
 *      尤其 404 那条——返回 200 的话运营会以为改成功了，而单测层看不出来。
 *
 * @why 断言一律查**库**：响应是路由自己拼的，库才是事实（§2 第 21 条）。
 *      `DELETE` 的 204 空体尤其不能信——"删了没有"只能查库。
 *
 * @why `image` 的拼接要测**两种配置态**（配了 / 没配 `IMG_BASE_URL`）：
 *      它是该配置项的**第一个消费方**，而"没配"时的降级形状（字段缺席 vs 空串）
 *      决定了前端显示成"没有图"还是"图裂了"——两种形状的排查方向完全不同。
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
import { waitUntil } from '../../../test/helpers/chain-server.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'admin-banner-test-jwt-secret-'.repeat(3);

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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-banner-route-test',
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

/** 这条 Banner 此刻的版本凭据（毫秒精度 ISO 串，与列表回显的 updated_at 同形）。 */
async function versionOf(id: string): Promise<string> {
  const [r] = await db`select updated_at from banners where id = ${id}`;
  return (r?.['updated_at'] as Date).toISOString();
}

const INPUT = {
  image_key: 'banners/2026/autumn-sale.png',
  link_type: 'product',
  link_id: 'p-1',
  sort: 2,
};

describe('守卫', () => {
  it('四条路由：无 token → 40101；买家 token → 40301', async () => {
    const { url, close } = await buildServer();
    try {
      const cases: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
        ['GET', '/api/v1/admin/banners'],
        ['POST', '/api/v1/admin/banners'],
        ['PUT', '/api/v1/admin/banners/b-1'],
        ['DELETE', '/api/v1/admin/banners/b-1'],
      ];
      for (const [method, path] of cases) {
        const body = method === 'POST' || method === 'PUT' ? INPUT : undefined;
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

describe('GET /admin/banners', () => {
  it('空表 → []；有数据 → 含停用档且带 image_key 与 image', async () => {
    const { url, close } = await buildServer('https://img.example.com/');
    try {
      const token = await bearer();
      expect((await call(url, 'GET', '/api/v1/admin/banners', undefined, token)).body).toEqual([]);

      await db`
        insert into banners (id, image_key, link_type, link_id, sort, active)
        values ('b-2', 'b/x.png', 'none', null, 5, false),
               ('b-1', 'b/y.png', 'product', 'p-1', 1, true)
      `;
      const r = await call(url, 'GET', '/api/v1/admin/banners', undefined, token);
      expect(r.status).toBe(200);
      const rows = r.body as Array<Record<string, unknown>>;
      expect(rows.map((x) => x['id'])).toEqual(['b-1', 'b-2']); // sort 升序
      expect(rows[0]?.['image_key']).toBe('b/y.png');
      // 尾部斜杠只吃一次：不能拼出 //
      expect(rows[0]?.['image']).toBe('https://img.example.com/b/y.png');
      expect(rows[1]?.['active']).toBe(false); // 停用档也要看得见
      expect(rows[1]?.['link_id']).toBeUndefined(); // null → 字段缺席而不是 null
    } finally {
      await close();
    }
  });

  it('IMG_BASE_URL 未配置 → **不带 image 字段**（空串会被当成"图裂了"）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, sort)
        values ('b-1', 'b/y.png', 'none', 1)
      `;
      const r = await call(url, 'GET', '/api/v1/admin/banners', undefined, await bearer());
      const row = (r.body as Array<Record<string, unknown>>)[0];
      expect(row?.['image_key']).toBe('b/y.png');
      expect(row?.['image']).toBeUndefined();
      expect('image' in (row ?? {})).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('POST /admin/banners', () => {
  it('201 且**带 id**（前端拿它打后续 PUT）；库里落的是 key 不是 URL', async () => {
    const { url, close } = await buildServer('https://img.example.com');
    try {
      const r = await call(url, 'POST', '/api/v1/admin/banners', INPUT, await bearer());
      expect(r.status).toBe(201);
      const created = r.body as Record<string, unknown>;
      expect(typeof created['id']).toBe('string');
      expect(String(created['id']).length).toBeGreaterThan(0);

      const rows = await db`select id, image_key, link_type, link_id, sort, active from banners`;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['image_key'])).toBe('banners/2026/autumn-sale.png');
      expect(String(rows[0]?.['link_type'])).toBe('product');
      expect(String(rows[0]?.['link_id'])).toBe('p-1');
      expect(Number(rows[0]?.['sort'])).toBe(2);
      expect(rows[0]?.['active']).toBe(true);
    } finally {
      await close();
    }
  });

  it('非法输入 → 40001 且**没落库**（含"选了跳转却没填 id"与"时间填反"）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      for (const body of [
        {},
        { image_key: '  ' },
        { ...INPUT, link_type: 'url' },
        { image_key: 'x', link_type: 'product' }, // 缺 link_id
        { ...INPUT, sort: -1 },
        {
          ...INPUT,
          starts_at: '2026-10-02T00:00:00Z',
          ends_at: '2026-10-01T00:00:00Z', // 填反：banner 永不展示
        },
        { ...INPUT, starts_at: 'yesterday' },
      ]) {
        const r = await call(url, 'POST', '/api/v1/admin/banners', body, token);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(code(r)).toBe(40001);
      }
      expect((await db`select count(*)::int as n from banners`)[0]?.['n']).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('PUT /admin/banners/{id}', () => {
  it('200 空体且库里真的改了（整行覆盖：link_id 改回 none 时为 null）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, link_id, sort, active)
        values ('b-1', 'old.png', 'product', 'p-1', 1, true)
      `;
      const r = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/b-1',
        {
          image_key: 'new.png',
          link_type: 'none',
          sort: 8,
          active: false,
          expected_updated_at: await versionOf('b-1'),
        },
        await bearer(),
      );
      expect(r.status).toBe(200);
      expect(r.body).toBeNull();
      const rows =
        await db`select image_key, link_type, link_id, sort, active from banners where id = ${'b-1'}`;
      expect(String(rows[0]?.['image_key'])).toBe('new.png');
      expect(String(rows[0]?.['link_type'])).toBe('none');
      expect(rows[0]?.['link_id']).toBeNull();
      expect(Number(rows[0]?.['sort'])).toBe(8);
      expect(rows[0]?.['active']).toBe(false);
    } finally {
      await close();
    }
  });

  it('🈲 id 不存在 → 40402（返回 200 会让运营以为改成功了）', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/nope',
        { image_key: 'x.png', expected_updated_at: '2026-10-01T00:00:00.000Z' },
        await bearer(),
      );
      expect(r.status).toBe(404);
      expect(code(r)).toBe(40402);
      expect((await db`select count(*)::int as n from banners`)[0]?.['n']).toBe(0);
    } finally {
      await close();
    }
  });

  it('非法输入 → 40001 且**原来的没被改**（先校验后写）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, sort)
        values ('b-1', 'old.png', 'none', 1)
      `;
      const r = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/b-1',
        { image_key: '' },
        await bearer(),
      );
      expect(r.status).toBe(400);
      expect(code(r)).toBe(40001);
      const rows = await db`select image_key from banners where id = ${'b-1'}`;
      expect(String(rows[0]?.['image_key'])).toBe('old.png');
    } finally {
      await close();
    }
  });
});

/**
 * Banner 编辑的乐观锁（S-09）：两个人同时编辑，后保存的不能静默覆盖前一个人的改动。
 * @why PUT 是整行覆盖：运营 A 打开编辑准备调排序，B 把它紧急下线；A 保存时 active 被写回 true，
 *      这条 Banner 又出现在首页，且没有任何提示。商品 PUT 早就有这把锁（ADM3-02），Banner 没有。
 */
describe('PUT /admin/banners/{id}：乐观锁（S-09）', () => {
  it('🔴 两人拿同一个版本先后保存 → 第二个 409 / 40914，库里保留第一个人写的', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, sort, active)
        values ('b-1', 'old.png', 'none', 1, true)
      `;
      const v = await versionOf('b-1');
      const first = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/b-1',
        { image_key: 'old.png', link_type: 'none', sort: 1, active: false, expected_updated_at: v },
        await bearer(),
      );
      expect(first.status).toBe(200);
      const second = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/b-1',
        { image_key: 'old.png', link_type: 'none', sort: 9, active: true, expected_updated_at: v },
        await bearer(),
      );
      expect(second.status).toBe(409);
      expect(code(second)).toBe(40914);
      const [row] = await db`select active, sort from banners where id = 'b-1'`;
      expect(row?.['active']).toBe(false);
      expect(Number(row?.['sort'])).toBe(1);
    } finally {
      await close();
    }
  });

  it('不带 expected_updated_at → 40001（没有凭据就不能判断是不是覆盖了别人）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`insert into banners (id, image_key, link_type, sort) values ('b-1', 'old.png', 'none', 1)`;
      const r = await call(
        url,
        'PUT',
        '/api/v1/admin/banners/b-1',
        { image_key: 'x.png', link_type: 'none', sort: 1 },
        await bearer(),
      );
      expect(code(r)).toBe(40001);
    } finally {
      await close();
    }
  });

  it('列表回显 updated_at（编辑页拿它当凭据）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`insert into banners (id, image_key, link_type, sort) values ('b-1', 'old.png', 'none', 1)`;
      const r = await call(url, 'GET', '/api/v1/admin/banners', undefined, await bearer());
      expect((r.body as Array<{ updated_at?: string }>)[0]?.updated_at).toBe(
        await versionOf('b-1'),
      );
    } finally {
      await close();
    }
  });
});

describe('DELETE /admin/banners/{id}', () => {
  it('204 空体且库里真没了', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, sort) values ('b-1', 'x.png', 'none', 1)
      `;
      const r = await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, await bearer());
      expect(r.status).toBe(204);
      expect(r.body).toBeNull();
      expect((await db`select count(*)::int as n from banners`)[0]?.['n']).toBe(0);
    } finally {
      await close();
    }
  });

  it('🔴 审计要留**改前值**：答得出被删的是哪张图、链到哪（OPS3-08）', async () => {
    const { url, close } = await buildServer();
    try {
      await db`
        insert into banners (id, image_key, link_type, link_id, sort)
        values ('b-1', 'hero.png', 'product', 'p-cup', 3)
      `;
      const r = await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, await bearer());
      expect(r.status).toBe(204);
      // 审计是**响应之后**异步写的（中间件挂在 prefinish 上，不与业务同事务）
      const q = () =>
        db`select target, before from admin_audit where action = 'DELETE /admin/banners/:id'`;
      await waitUntil(async () => (await q()).length === 1, '删除的审计行没写进来');
      const rows = await q();
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['target'])).toBe('b-1');
      const before = rows[0]?.['before'] as Record<string, unknown> | null;
      expect(String(before?.['image_key'])).toBe('hero.png');
      expect(String(before?.['link_type'])).toBe('product');
      expect(String(before?.['link_id'])).toBe('p-cup');
    } finally {
      await close();
    }
  });

  it('幂等：不存在的 id 也 204（重复删除不报错）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      expect(
        (await call(url, 'DELETE', '/api/v1/admin/banners/nope', undefined, token)).status,
      ).toBe(204);
      await db`
        insert into banners (id, image_key, link_type, sort) values ('b-1', 'x.png', 'none', 1)
      `;
      expect(
        (await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, token)).status,
      ).toBe(204);
      // 第二次删同一条：仍然 204（幂等，不是 404）
      expect(
        (await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, token)).status,
      ).toBe(204);
    } finally {
      await close();
    }
  });

  it('🔴 双击删除只留**一行**审计：0 行命中的那次不写（有审计行 ⇔ 改动真的发生了）', async () => {
    const { url, close } = await buildServer();
    try {
      const token = await bearer();
      await db`
        insert into banners (id, image_key, link_type, sort) values ('b-1', 'x.png', 'none', 1)
      `;
      await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, token);
      const q = () => db`select target from admin_audit where action = 'DELETE /admin/banners/:id'`;
      await waitUntil(async () => (await q()).length === 1, '第一次删除的审计行没写进来');
      await call(url, 'DELETE', '/api/v1/admin/banners/b-1', undefined, token); // 第二次：什么都没删
      await call(url, 'DELETE', '/api/v1/admin/banners/nope', undefined, token); // 从来就没这条
      // ⚠️ "没有第二行"不能靠 waitUntil 证明（等不到就是"永远等不到"）：
      //    给这两次 no-op 一个比审计写入更长的窗口，再断言仍是一行。
      await new Promise((r) => setTimeout(r, 300));
      const rows = await q();
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['target'])).toBe('b-1');
    } finally {
      await close();
    }
  });
});
