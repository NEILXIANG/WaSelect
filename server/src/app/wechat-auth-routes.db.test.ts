/**
 * 职责：`POST /auth/wechat/login` 的接线级真库用例（I1-U6b）——dev 装配全链路、
 *      未配置 50000、形状守卫、限流挂载、**签发 token 能过受保护接口**（身份闭环）。
 *
 * @why 身份闭环必须钉：登录接口返回 200 + 一个字符串，与"这个字符串能被
 *      requireRole 认成合法身份"之间隔着签名/aud/iss 三层——只测前者，
 *      "签错密钥/发错受众"这类缺陷全绿（登录成功但所有受保护接口 401）。
 *
 * @see app/wechat-auth-routes.ts；app/wechat-login.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { registerBusinessEventLog } from './business-events.js';

let db: Db;

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

async function buildServer(env: Record<string, string> = {}): Promise<{
  url: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: 'wechat-route-test-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    ...env,
  });
  const app = createHttpApp({
    logger,
    mount: (a) => {
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, sink, close: server.close };
}

function login(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/v1/auth/wechat/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /auth/wechat/login（dev 装配）', () => {
  it('200：AuthResp 形状（token + user.id/isAdmin）；token 能过受保护接口（身份闭环）', async () => {
    const srv = await buildServer({ WECHAT_DEV_LOGIN: 'dev-' });
    try {
      const res = await login(srv.url, { code: 'alice' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; user: { id: string; isAdmin: boolean } };
      expect(typeof body.token).toBe('string');
      expect(body.user.id).toMatch(/^u-/);
      expect(body.user.isAdmin).toBe(false);

      // 身份闭环：签发的 token 必须能过 requireRole('user') 的受保护接口
      const me = await fetch(`${srv.url}/api/v1/orders`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(me.status).toBe(200);

      // users 行：openid = dev 前缀 + code（dev 替身的既定形状）
      const rows = await db`select openid from users where id = ${body.user.id}`;
      expect(rows[0]?.['openid']).toBe('dev-alice');
    } finally {
      await srv.close();
    }
  });

  it('同 code 再登 → 同一 user.id（复登不建行）', async () => {
    const srv = await buildServer({ WECHAT_DEV_LOGIN: 'dev-' });
    try {
      const a = (await (await login(srv.url, { code: 'bob' })).json()) as {
        user: { id: string };
      };
      const b = (await (await login(srv.url, { code: 'bob' })).json()) as {
        user: { id: string };
      };
      expect(b.user.id).toBe(a.user.id);
      const rows = await db`select count(*)::int as n from users where openid = 'dev-bob'`;
      expect(Number(rows[0]?.['n'])).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('形状守卫：缺 code / 空 code / 非对象 → 40001', async () => {
    const srv = await buildServer({ WECHAT_DEV_LOGIN: 'dev-' });
    try {
      for (const body of [{}, { code: '' }, { code: 123 }]) {
        const res = await login(srv.url, body);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: number }).code).toBe(40001);
      }
    } finally {
      await srv.close();
    }
  });
});

describe('POST /auth/wechat/login（未配置 / 限流）', () => {
  it('既无真 AppID 也未开 dev 登录 → 50000 wechat_login_not_configured（路由照挂，响亮失败）', async () => {
    const srv = await buildServer();
    try {
      const res = await login(srv.url, { code: 'x' });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: number; message?: string };
      expect(body.code).toBe(50000);
      // 5xx 的 details 不外发（统一折叠"服务器内部错误"）；reason 必须进日志——
      // 它是线上区分"没配 AppID"与"微信挂了"的唯一依据
      expect(JSON.stringify(srv.sink.rows())).toContain('wechat_login_not_configured');
    } finally {
      await srv.close();
    }
  });

  it('限流挂载：前 30 次穿过（40001 形状拦），第 31 次 42901', async () => {
    const srv = await buildServer({ WECHAT_DEV_LOGIN: 'dev-' });
    try {
      for (let i = 0; i < 30; i += 1) {
        const res = await login(srv.url, {});
        expect(res.status).toBe(400);
      }
      const blocked = await login(srv.url, {});
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { code: number }).code).toBe(42901);
    } finally {
      await srv.close();
    }
  });
});
