/**
 * 职责：`GET /home` 的接线级真库用例（D-51）。
 *
 * @why 必须**接线级**而不是只测仓储：仓储单测证明不了"这条路由挂在 `/api/v1/home` 上"、
 *      证明不了它**免鉴权**、也证明不了 `categories` 真的被拼进响应体——
 *      这三件事各自漏掉都不报错：小程序首屏只是"没有 banner"，没人知道是路由没挂。
 *
 * @why 时间用**可推进**的假时钟（`mutableClock`）而不是固定时钟：
 *      固定时钟只能证明"注入的时刻被用上了"，证明不了"时间**来自**注入的时钟"——
 *      一个自己 `new Date()` 的实现，在固定时钟下也能给出能通过的时刻。
 *      推进假时钟 → 到期 banner 必须消失；若实现读的是真实时间，推进毫无影响，用例必红。
 *
 * @why 断言"DB 故障 → 500"而不是 `{banners: []}`：
 *      空数组与"取不到"在首页上是同一个样子（没有 banner 段）。把故障降级成空数组，
 *      等于让运营去查 banner 配置，而配置是对的——这条断言钉住"不做那个降级"。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { mutableClock } from '../../../test/helpers/fixed-clock.js';
import type { Clock } from '../ports/clock.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createHttpApp, listen } from '../http.js';
import { mountHomeRoutes } from './home-routes.js';
import { createBannersAdminRepo, type BannerWrite } from '../adapters/banners-admin.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'home-route-test-jwt-secret-'.repeat(3);

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

const NOW = '2026-10-05T00:00:00Z';

async function buildServer(opts: {
  imgBaseUrl?: string;
  clock: Clock;
  database?: Db;
  sink?: MemorySink;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: opts.sink ?? sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-callback-secret-for-home-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(opts.imgBaseUrl !== undefined ? { IMG_BASE_URL: opts.imgBaseUrl } : {}),
  });
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountHomeRoutes(a, {
        db: opts.database ?? db,
        clock: opts.clock,
        config,
        logger,
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function getHome(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/api/v1/home`);
  return { status: res.status, body: (await res.json()) as unknown };
}

type HomeBody = { banners: Array<Record<string, unknown>>; categories: string[] };

/** 一条此刻生效的配置（起止把 NOW 包在中间）。 */
const W: BannerWrite = {
  imageKey: 'banners/2026/autumn.png',
  linkType: 'product',
  linkId: 'p-1',
  sort: 3,
  active: true,
  startsAtMs: Date.parse('2026-10-01T00:00:00Z'),
  endsAtMs: Date.parse('2026-10-09T00:00:00Z'),
};

describe('GET /home', () => {
  it('免鉴权：不带任何 token → 200（首屏首帧就要用，登录态不该挡住"看见这家店卖什么"）', async () => {
    const { url, close } = await buildServer({ clock: mutableClock(NOW).clock });
    try {
      const res = await fetch(`${url}/api/v1/home`, {
        headers: { authorization: 'Bearer garbage-token' },
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('空表：banners = []，categories 仍是完整清单（没有 banner ≠ 没有分类）', async () => {
    const { url, close } = await buildServer({ clock: mutableClock(NOW).clock });
    try {
      const { status, body } = await getHome(url);
      expect(status).toBe(200);
      expect((body as HomeBody).banners).toEqual([]);
      expect((body as HomeBody).categories).toEqual(['beauty', 'daily', 'kitchen', 'food']);
    } finally {
      await close();
    }
  });

  it('只返回**此刻生效**的：停用 / 未开始 / 已过期 三条都不出现', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-on', sort: 1 });
    await write.insertBanner({ ...W, id: 'b-off', sort: 2, active: false });
    await write.insertBanner({
      ...W,
      id: 'b-later',
      sort: 3,
      startsAtMs: Date.parse('2026-10-06T00:00:00Z'),
    });
    await write.insertBanner({
      ...W,
      id: 'b-over',
      sort: 4,
      endsAtMs: Date.parse('2026-10-04T00:00:00Z'),
    });

    const { url, close } = await buildServer({ clock: mutableClock(NOW).clock });
    try {
      const { body } = await getHome(url);
      expect((body as HomeBody).banners.map((b) => b['id'])).toEqual(['b-on']);
    } finally {
      await close();
    }
  });

  it('按 sort 升序返回（运营在后台排的顺序，不能被查询顺序改写）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-3', sort: 30 });
    await write.insertBanner({ ...W, id: 'b-1', sort: 10 });
    await write.insertBanner({ ...W, id: 'b-2', sort: 20 });

    const { url, close } = await buildServer({ clock: mutableClock(NOW).clock });
    try {
      const { body } = await getHome(url);
      expect((body as HomeBody).banners.map((b) => b['id'])).toEqual(['b-1', 'b-2', 'b-3']);
    } finally {
      await close();
    }
  });

  it('推进假时钟跨过 ends_at → banner 消失（证明时间**来自注入的 clock**，不是真实时间）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-1', endsAtMs: Date.parse('2026-10-05T00:00:00Z') });
    const { clock, advance } = mutableClock(NOW);

    const { url, close } = await buildServer({ clock });
    try {
      // 恰好等于 ends_at（闭区间）→ 还在
      expect((await getHome(url)).body as HomeBody).toMatchObject({ banners: [{ id: 'b-1' }] });
      // 推进 1ms → 过期，必须消失
      advance(1);
      expect(((await getHome(url)).body as HomeBody).banners).toEqual([]);
    } finally {
      await close();
    }
  });

  it('IMG_BASE_URL 未配置 → 不带 image 字段（不是空串：空串会被当成"有一张图、图裂了"）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-1' });

    const { url, close } = await buildServer({ clock: mutableClock(NOW).clock });
    try {
      const { body } = await getHome(url);
      const [b] = (body as HomeBody).banners;
      expect(b).toBeDefined();
      expect(Object.keys(b ?? {})).not.toContain('image');
      expect(b?.['image_key']).toBe('banners/2026/autumn.png');
    } finally {
      await close();
    }
  });

  it('IMG_BASE_URL 已配置 → image 是完整 URL；尾部斜杠只处理一次（不出现 //）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-1' });

    const { url, close } = await buildServer({
      clock: mutableClock(NOW).clock,
      imgBaseUrl: 'https://img.example.com/',
    });
    try {
      const { body } = await getHome(url);
      expect((body as HomeBody).banners[0]?.['image']).toBe(
        'https://img.example.com/banners/2026/autumn.png',
      );
    } finally {
      await close();
    }
  });

  it('🔴 IMG_BASE_URL 未配置 → 挂载时打一条 warn（否则"配了 banner 却永远不显示"是全静默的）', async () => {
    // @why 这条链路上没有任何一方报错：服务端 200、小程序不给提示、
    //      运营在后台看得见自己配的那条 banner——只有启动日志能说话。
    const local = new MemorySink();
    const { close } = await buildServer({ clock: mutableClock(NOW).clock, sink: local });
    try {
      expect(local.find('home_image_base_unset')).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('IMG_BASE_URL 已配置 → 不打那条 warn（配好了还告警，告警就没人看了）', async () => {
    const local = new MemorySink();
    const { close } = await buildServer({
      clock: mutableClock(NOW).clock,
      imgBaseUrl: 'https://img.example.com',
      sink: local,
    });
    try {
      expect(local.find('home_image_base_unset')).toEqual([]);
    } finally {
      await close();
    }
  });

  it('DB 故障 → 5xx，**不降级**成 {banners: []}（空数组会把故障伪装成"今天没配 banner"）', async () => {
    const logger = createLogger({ env: 'test', destination: sink });
    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '1',
      HOST: '127.0.0.1',
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET,
      PAYMENT_CHANNELS: 'mock',
      MOCK_CALLBACK_SECRET: 'mock-callback-secret-for-home-route-test',
      TERMS_VERSION: 'TOS-TEST-1',
    });
    // ⚠️ 抛的是**仓储调用那一刻**的错（模板字面量先求 `db.unsafe(...)`），
    //    所以这里 unsafe 抛就足够，不必让整个 tagged template 可调用。
    const throwingDb = {
      unsafe: () => {
        throw new Error('db down');
      },
    } as unknown as Db;
    const app = createHttpApp({
      logger,
      mount: (a) =>
        mountHomeRoutes(a, { db: throwingDb, clock: mutableClock(NOW).clock, config, logger }),
    });
    const server = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/home`);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);
    } finally {
      await server.close();
    }
  });
});
