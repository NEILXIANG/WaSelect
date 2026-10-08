/**
 * 订单内部备注（第一批⑤，AJ-396）：迁移 034 的库约束 + `GET/POST /admin/orders/:id/notes` 两条路由。
 * 真实路由 + 真实 Postgres（约束三：数据库不 mock）。
 *
 * @why 库约束与路由放在同一个文件：备注的三道防线（应用层 `orderNoteGuard` → 库 CHECK → append-only 触发器）
 *      是**一件事的三层**，拆开写会出现"每层各自绿、合起来有缝"（约束九·链路覆盖矩阵那一类）。
 * @why 库约束用例**绕过路由直接 insert**：应用层校验在前，走路由永远到不了 CHECK——
 *      只经路由测，CHECK 被删了也是绿的（约束八：注回缺陷必须会红）。
 * @limitation 不测并发追加的先后：备注按 `(created_at, id)` 排序，同一微秒的两条靠 BIGSERIAL 决胜，
 *             这是库的行为，不是本模块的逻辑。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';
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
const JWT_SECRET = 'admin-order-note-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let token: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'ops@example.com', true)`;
  token = await signToken(
    { sub: 'u-admin', role: 'admin' },
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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-note-test',
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

async function seedOrder(id: string): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, ${`u-${id}`}, 'paid', 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() + interval '30 minutes')
  `;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('迁移 034：order_notes 的库约束（绕过路由直插）', () => {
  it('🔴 append-only：UPDATE / DELETE 都被拒（42501，与 order_events 同一个触发器函数）', async () => {
    await seedOrder('o-n0');
    await db`insert into order_notes (order_id, author, body) values ('o-n0', 'admin:u-admin', '原文')`;
    await expect(db`update order_notes set body = '改过' where order_id = 'o-n0'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    await expect(db`delete from order_notes where order_id = 'o-n0'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    const [n] = await db`select body from order_notes where order_id = 'o-n0'`;
    expect(n?.['body']).toBe('原文');
  });

  it('🔴 body CHECK：空串 / 只有空白（含全角空格）/ 超 1000 码位都被拒；恰好 1000 放行', async () => {
    await seedOrder('o-n1');
    for (const bad of ['', '   ', '\u3000\n', 'あ'.repeat(ORDER_NOTE_MAX_LENGTH + 1)]) {
      await expect(
        db`insert into order_notes (order_id, author, body) values ('o-n1', 'admin:u-admin', ${bad})`,
      ).rejects.toThrow(/order_notes_body_check/);
    }
    await db`insert into order_notes (order_id, author, body)
             values ('o-n1', 'admin:u-admin', ${'あ'.repeat(ORDER_NOTE_MAX_LENGTH)})`;
  });

  it('🔴 author 必须是 admin:<id> 形状；order_id 必须是存在的订单（外键）', async () => {
    await seedOrder('o-n2');
    await expect(
      db`insert into order_notes (order_id, author, body) values ('o-n2', 'user:u-1', 'x')`,
    ).rejects.toThrow(/order_notes_author_check/);
    await expect(
      db`insert into order_notes (order_id, author, body) values ('o-none', 'admin:u-admin', 'x')`,
    ).rejects.toThrow(/order_notes_order_id_fkey/);
  });
});

describe('POST /admin/orders/:id/notes', () => {
  it('🔴 追加一条：201、正文去首尾空白、作者 = admin:<sub>、回显作者邮箱、写审计', async () => {
    await seedOrder('o-p1');
    const r = await call('POST', '/api/v1/admin/orders/o-p1/notes', {
      body: '  买家微信说周五后再发\n地址先不改  ',
    });
    expect(r.status).toBe(201);
    expect(r.json['note']).toMatchObject({
      author: 'admin:u-admin',
      author_email: 'ops@example.com',
      body: '买家微信说周五后再发\n地址先不改',
    });
    const note = r.json['note'] as Record<string, unknown>;
    expect(typeof note['id']).toBe('string');
    expect(Number.isNaN(Date.parse(String(note['created_at'])))).toBe(false);
    const rows = await db`select author, body from order_notes where order_id = 'o-p1'`;
    expect(rows).toHaveLength(1);
    // 审计中间件写在响应之后（admin-audit.ts @limitation），等它落库
    let audit: readonly Record<string, unknown>[] = [];
    for (let i = 0; i < 50 && audit.length === 0; i++) {
      audit = await db`select action, target from admin_audit where target = 'o-p1'`;
      if (audit.length === 0) await new Promise((res) => setTimeout(res, 20));
    }
    expect(audit).toEqual([{ action: 'POST /admin/orders/:id/notes', target: 'o-p1' }]);
  });

  it('🔴 空白（含全角空格）/ 非字符串 → 40001 order_note_required；超长 → 40001 order_note_too_long；都不落库', async () => {
    await seedOrder('o-p2');
    for (const body of ['', ' \n ', '\u3000', 42, null]) {
      const r = await call('POST', '/api/v1/admin/orders/o-p2/notes', { body });
      expect(r.status).toBe(400);
      expect(r.json['code']).toBe(40001);
    }
    const long = await call('POST', '/api/v1/admin/orders/o-p2/notes', {
      body: 'x'.repeat(ORDER_NOTE_MAX_LENGTH + 1),
    });
    expect(long.json['code']).toBe(40001);
    expect(srv.sink.lines.join('\n')).toContain('order_note_too_long');
    const ok = await call('POST', '/api/v1/admin/orders/o-p2/notes', {
      body: 'x'.repeat(ORDER_NOTE_MAX_LENGTH),
    });
    expect(ok.status).toBe(201);
    const rows = await db`select count(*)::int as n from order_notes where order_id = 'o-p2'`;
    expect(rows[0]?.['n']).toBe(1);
  });

  it('🔴 订单不存在 → 404 / 40400（不落库，不撞外键 500）', async () => {
    const r = await call('POST', '/api/v1/admin/orders/o-none/notes', { body: '记一笔' });
    expect(r.status).toBe(404);
    expect(r.json['code']).toBe(40400);
  });
});

describe('GET /admin/orders/:id/notes', () => {
  it('按时间先后返回；作者没有邮箱 / 用户行已不存在时省略 author_email 而不是报错', async () => {
    await seedOrder('o-g1');
    await db`insert into users (id, openid) values ('u-old', 'o-old')`;
    await db`insert into order_notes (order_id, author, body, created_at) values
               ('o-g1', 'admin:u-admin', '第二条', '2026-10-08T02:00:00Z'),
               ('o-g1', 'admin:u-old', '第一条', '2026-10-08T01:00:00Z'),
               ('o-g1', 'admin:u-gone', '第三条', '2026-10-08T03:00:00Z')`;
    const r = await call('GET', '/api/v1/admin/orders/o-g1/notes');
    expect(r.status).toBe(200);
    const items = r.json['items'] as Record<string, unknown>[];
    expect(items.map((i) => i['body'])).toEqual(['第一条', '第二条', '第三条']);
    expect(items[0]).not.toHaveProperty('author_email');
    expect(items[1]?.['author_email']).toBe('ops@example.com');
    expect(items[2]).not.toHaveProperty('author_email');
    expect(items[0]?.['created_at']).toBe('2026-10-08T01:00:00.000Z');
  });

  it('没有备注 → 空数组；订单不存在 → 40400', async () => {
    await seedOrder('o-g2');
    expect((await call('GET', '/api/v1/admin/orders/o-g2/notes')).json).toEqual({ items: [] });
    const r = await call('GET', '/api/v1/admin/orders/o-none/notes');
    expect(r.json['code']).toBe(40400);
  });
});
