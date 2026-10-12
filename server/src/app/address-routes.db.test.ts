/**
 * 职责：地址 CRUD 的接线级真库用例（I1-U5a）——鉴权、40001/40002 分层、
 *      归属 40400、默认唯一在 HTTP 层的端到端行为。
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

let db: Db;
const JWT_SECRET = 'address-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  sink: MemorySink;
}> {
  // ⚠️ sink 一并返回（AJ-355）：地址写操作的日志**字段**（改了哪一条）只进日志不进响应，
  //    断言响应体永远证明不了它——与 admin-order-routes 的 `AppError.details` 同形。
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
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
  return { url: `http://127.0.0.1:${server.port}`, close: server.close, sink };
}

let token = '';
let otherToken = '';

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1'), ('u-2', 'o-2')`;
  token = await signToken({ sub: 'u-1', role: 'user' }, { secret: JWT_SECRET, issuer: 'waselect' });
  otherToken = await signToken(
    { sub: 'u-2', role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
});

const VALID = {
  recipient: 'Jane Doe',
  phone: '+14155550123',
  line1: '1 Infinite Loop',
  city: 'Cupertino',
  state: 'CA',
  postal_code: '95014',
};

async function call(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  tok: string = token,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('POST /addresses', () => {
  it('201 创建并可读回；缺字段 → 40001；格式错 → 40002', async () => {
    const srv = await buildServer();
    try {
      const created = await call(srv.url, 'POST', '/api/v1/addresses', VALID);
      expect(created.status).toBe(201);
      expect(created.json['recipient']).toBe('Jane Doe');
      expect(created.json['country']).toBe('US'); // 省略时默认 US

      const missing = await call(srv.url, 'POST', '/api/v1/addresses', { recipient: 'A B' });
      expect(missing.json['code']).toBe(40001);

      // 中文收件人 → 40002（须英文/拼音）；坏电话 / 坏邮编 / 非 active 国家同码
      for (const bad of [
        { ...VALID, recipient: '张三' },
        { ...VALID, phone: '13800138000' },
        { ...VALID, postal_code: '123' },
        { ...VALID, state: 'California' },
        { ...VALID, country: 'CA' },
        { ...VALID, state: 'NV' }, // AJ-496：每个字段都合法，但 95014 不是内华达的邮编
      ]) {
        const r = await call(srv.url, 'POST', '/api/v1/addresses', bad);
        expect(r.json['code'], JSON.stringify(bad)).toBe(40002);
      }
    } finally {
      await srv.close();
    }
  });

  it('无 token → 40101', async () => {
    const srv = await buildServer();
    try {
      const res = await fetch(`${srv.url}/api/v1/addresses`, { method: 'GET' });
      expect(((await res.json()) as { code: number }).code).toBe(40101);
    } finally {
      await srv.close();
    }
  });
});

describe('GET /addresses 与默认唯一（HTTP 层端到端）', () => {
  it('列表只含本人；连续两条默认 → 最终只有最新一条默认', async () => {
    const srv = await buildServer();
    try {
      await call(srv.url, 'POST', '/api/v1/addresses', { ...VALID, is_default: true });
      await call(srv.url, 'POST', '/api/v1/addresses', {
        ...VALID,
        line1: '2 Other St',
        is_default: true,
      });
      const list = await call(srv.url, 'GET', '/api/v1/addresses');
      const items = list.json as unknown as Array<{ is_default: boolean; line1: string }>;
      expect(items).toHaveLength(2);
      expect(items.filter((a) => a.is_default)).toHaveLength(1);
      expect(items[0]?.line1).toBe('2 Other St'); // 默认在最前

      const others = await call(srv.url, 'GET', '/api/v1/addresses', undefined, otherToken);
      expect(others.json).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

describe('PUT/DELETE /addresses/{id}', () => {
  it('PUT 全量更新 200；DELETE 204；他人地址一律 40400', async () => {
    const srv = await buildServer();
    try {
      const created = await call(srv.url, 'POST', '/api/v1/addresses', VALID);
      const id = String(created.json['id']);

      const updated = await call(srv.url, 'PUT', `/api/v1/addresses/${id}`, {
        ...VALID,
        recipient: 'New Name',
      });
      expect(updated.status).toBe(200);
      expect(updated.json['recipient']).toBe('New Name');

      // 他人：改与删都 40400，且原值未动
      expect(
        (await call(srv.url, 'PUT', `/api/v1/addresses/${id}`, VALID, otherToken)).json['code'],
      ).toBe(40400);
      expect(
        (await call(srv.url, 'DELETE', `/api/v1/addresses/${id}`, undefined, otherToken)).json[
          'code'
        ],
      ).toBe(40400);
      expect((await call(srv.url, 'PUT', '/api/v1/addresses/ghost', VALID)).json['code']).toBe(
        40400,
      );

      const del = await call(srv.url, 'DELETE', `/api/v1/addresses/${id}`);
      expect(del.status).toBe(204);
      expect((await call(srv.url, 'GET', '/api/v1/addresses')).json).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 写操作的日志必须答得出"**对哪个对象**"（AJ-355 / 约束七）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // @why 断言**日志字段**而不是响应：这三个事件此前只写 `result: 'ok'`（PUT 连日志都没有），
  //      而响应体里根本没有"改了哪一条"之外的信息——只看响应的话，把 `ctx` 删掉照样全绿。
  // @why 三个事件各一条用例：合成一条的话，注入"去掉 PUT 那条日志"会被另外两条兜住
  //      （本文件文件头的纪律：一条规则一个用例）。

  it('🔴 POST 的 address_created 带 address_id 与 is_default（答得出建的是哪条、是不是默认）', async () => {
    const srv = await buildServer();
    try {
      const created = await call(srv.url, 'POST', '/api/v1/addresses', {
        ...VALID,
        is_default: true,
      });
      const id = String(created.json['id']);
      const rows = srv.sink.find('address_created');
      expect(rows).toHaveLength(1);
      const ctx = (rows[0]?.['ctx'] ?? {}) as Record<string, unknown>;
      expect(String(ctx['address_id'])).toBe(id);
      expect(ctx['is_default']).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('🔴 PUT 会打 address_updated 且带 address_id（此前更新成功完全不打日志）', async () => {
    const srv = await buildServer();
    try {
      const created = await call(srv.url, 'POST', '/api/v1/addresses', VALID);
      const id = String(created.json['id']);
      await call(srv.url, 'PUT', `/api/v1/addresses/${id}`, { ...VALID, recipient: 'New Name' });
      const rows = srv.sink.find('address_updated');
      expect(rows).toHaveLength(1);
      const ctx = (rows[0]?.['ctx'] ?? {}) as Record<string, unknown>;
      expect(String(ctx['address_id'])).toBe(id);
      // 没设默认 ⇒ is_default 是 false（"改门牌号"与"设成默认"在日志里必须能分开）
      expect(ctx['is_default']).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('🔴 DELETE 的 address_deleted 带 address_id（答得出删的是哪条）', async () => {
    const srv = await buildServer();
    try {
      const created = await call(srv.url, 'POST', '/api/v1/addresses', VALID);
      const id = String(created.json['id']);
      await call(srv.url, 'DELETE', `/api/v1/addresses/${id}`);
      const rows = srv.sink.find('address_deleted');
      expect(rows).toHaveLength(1);
      const ctx = (rows[0]?.['ctx'] ?? {}) as Record<string, unknown>;
      expect(String(ctx['address_id'])).toBe(id);
    } finally {
      await srv.close();
    }
  });
});
