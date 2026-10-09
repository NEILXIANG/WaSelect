/**
 * 管理端前端报错上报（AJ-421）：`POST /admin/client-errors` → error 级运行日志（经统一脱敏，进而进 Sentry 分流）。
 * 真实路由 + 真实 Postgres（审计表要真查）。
 *
 * @why 断言日志行而不是只断言 204：这条接口唯一的产物就是那一行日志；204 而日志没写 = 报错被吞。
 * @why 断言"没有审计行"：上报不是管理员操作，进了 admin_audit 会让运营日志页满屏"前端报错"。
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
const JWT_SECRET = 'admin-client-error-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let admin: string;
let buyer: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'ops@example.com', true)`;
  await db`insert into users (id, openid) values ('u-buyer', 'o-buyer')`;
  admin = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  buyer = await signToken(
    { sub: 'u-buyer', role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-client-error-test',
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
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

async function report(
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}/api/v1/admin/client-errors`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const errorLines = (): Array<Record<string, unknown>> =>
  srv.sink
    .rows()
    .filter((r) => (r as Record<string, unknown>)['event'] === 'admin_client_error') as Array<
    Record<string, unknown>
  >;

describe('POST /admin/client-errors', () => {
  it('🔴 管理员上报 → 204 + 一条 error 级 admin_client_error；消息里的邮箱已脱敏；不写审计', async () => {
    const r = await report(admin, {
      kind: 'render',
      message: 'Cannot render customer jane.doe@example.com',
      stack: 'TypeError: x\n    at CustomerCard (CustomerCard.tsx:12:3)',
      page: 'customers',
    });
    expect(r.status).toBe(204);
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line['level']).toBe('error');
    expect(JSON.stringify(line)).toContain('customers');
    expect(JSON.stringify(line)).toContain('CustomerCard.tsx:12:3');
    expect(JSON.stringify(line)).not.toContain('jane.doe@example.com');
    const audits = await db`select 1 from admin_audit where action like '%client-errors%'`;
    expect(audits).toHaveLength(0);
  });

  it('🔴 入参不合法 → 400 / 40001，且不记 admin_client_error', async () => {
    const r = await report(admin, { kind: 'warn', message: 'x' });
    expect([r.status, r.json['code']]).toEqual([400, 40001]);
    expect(errorLines()).toHaveLength(0);
  });

  it('🔴 买家令牌 / 无令牌 → 拒绝，不记日志（这不是公开入口）', async () => {
    expect((await report(buyer, { kind: 'error', message: 'x' })).status).toBe(403);
    expect((await report(null, { kind: 'error', message: 'x' })).status).toBe(401);
    expect(errorLines()).toHaveLength(0);
  });
});
