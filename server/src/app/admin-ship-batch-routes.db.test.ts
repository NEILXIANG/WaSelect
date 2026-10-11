/**
 * 职责：`POST /admin/orders/ship-batch`（AJ-401，契约 0.6.45）的接线级真库用例。
 *
 * @why 批量发货的风险不在"能不能发"，而在**拼起来的缝**：
 *      ① 一行坏数据把整批回滚（运营以为全没发，再提交一次 → 好的那些 40902）；
 *      ② 一行半途失败留下"状态已 shipped、时间线没有 shipped 事件"的半成品；
 *      ③ 两个管理员同时批量发同一批单 → 同一单发两次（两封发货邮件、两条事件）。
 *      三条都只有真库 + 真 HTTP 才能证明（单测里的事务是假的）。
 * @why 闸门（拒付 40909 / 测试单 / 状态 / 长度）不在这里重新穷举：批量复用单单那一份
 *      （ship-order.ts），这里只证明"每一种闸门结果都按行如实回来、且不影响别行"。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SHIP_BATCH_MAX, SHIP_MAX_CHARS } from '@waselect/shared';
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
const JWT_SECRET = 'ship-batch-test-jwt-secret-'.repeat(3);
const PATH = '/api/v1/admin/orders/ship-batch';

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let published: string[];

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'admin@example.com', true)`;
  await db`insert into users (id, openid, email, is_admin) values ('u-buyer', 'o-buyer', 'buyer@example.com', false)`;
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-ship-batch-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const events = createEventBus(logger);
  published = [];
  events.subscribe('order.shipped', (e) => {
    published.push(e.orderId ?? '');
  });
  const app = createHttpApp({
    logger,
    mount: (a) => mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() }),
  });
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

/** 一张订单（真实形状：日文商品名、美国地址快照）；默认 paid、无拒付、非测试单。 */
async function seed(
  id: string,
  o: { status?: string; hasDispute?: boolean; isTest?: boolean } = {},
): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict (id) do nothing`;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${id}`}, '南部鉄器 急須 0.65L', 'daily', 8800, 1200, 'JP') on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        has_dispute, is_test, expires_at)
    values (${id}, ${`NO-${id}`}, ${`u-${id}`}, ${o.status ?? 'paid'}, 8800, 4950, 0, 13750,
            1200, ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ id: null, recipient: 'Emily Chen', line1: '1600 Amphitheatre Pkwy', city: 'Mountain View', state: 'CA', postal_code: '94043', country: 'US' } as never)},
            'TOS-TEST-1', ${o.hasDispute ?? false}, ${o.isTest ?? false}, now() + interval '30 minutes')
  `;
}

async function post(
  body: unknown,
  role: 'admin' | 'user' | 'none' = 'admin',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role !== 'none') {
    const sub = role === 'admin' ? 'u-admin' : 'u-buyer';
    headers['authorization'] =
      `Bearer ${await signToken({ sub, role }, { secret: JWT_SECRET, issuer: 'waselect' })}`;
  }
  const r = await fetch(`${srv.url}${PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

type ItemResult = {
  order_id: string;
  ok: boolean;
  code?: number;
  reason?: string;
  message?: string;
  tracking_recognized?: boolean;
};
const results = (j: Record<string, unknown>): ItemResult[] => j['results'] as ItemResult[];

const shippedEvents = async (id: string): Promise<number> =>
  (await db`select 1 from order_events where order_id = ${id} and status = 'shipped'`).length;

describe('POST /admin/orders/ship-batch：逐单结果（部分成功）', () => {
  it('🔴 每一种闸门结果按行如实回来，且坏行不连累好行（逐单事务）', async () => {
    await seed('o-ok1');
    await seed('o-shipped', { status: 'shipped' });
    await seed('o-dispute', { hasDispute: true });
    await seed('o-test', { isTest: true });
    await seed('o-long');
    await seed('o-ok2');
    const r = await post({
      items: [
        { order_id: 'o-ok1', carrier: ' Japan Post ', tracking_no: 'EJ123456789JP' },
        { order_id: 'o-shipped', carrier: 'Japan Post', tracking_no: 'EJ000000001JP' },
        { order_id: 'o-dispute', carrier: 'Japan Post', tracking_no: 'EJ000000002JP' },
        { order_id: 'o-test', carrier: 'Japan Post', tracking_no: 'EJ000000003JP' },
        { order_id: 'o-missing', carrier: 'Japan Post', tracking_no: 'EJ000000004JP' },
        {
          order_id: 'o-long',
          carrier: 'Japan Post',
          tracking_no: 'T'.repeat(SHIP_MAX_CHARS.tracking_no + 1),
        },
        { order_id: 'o-ok2', carrier: 'Yamato', tracking_no: '4321-1234-5678' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json['succeeded']).toBe(2);
    expect(r.json['failed']).toBe(5);
    // 顺序与请求一致（前端按下标对回 CSV 行）
    expect(
      results(r.json).map((x) => [x.order_id, x.ok, x.code ?? null, x.reason ?? null]),
    ).toEqual([
      ['o-ok1', true, null, null],
      ['o-shipped', false, 40902, 'status_shipped'],
      ['o-dispute', false, 40909, 'dispute_open'],
      ['o-test', false, 40902, 'test_order'],
      ['o-missing', false, 40400, 'not_found'],
      ['o-long', false, 40001, 'tracking_no_too_long'],
      ['o-ok2', true, null, null],
    ]);
    // 形状认得出（S10）→ true；Yamato 的连字符号也认得出
    expect(results(r.json)[0]?.tracking_recognized).toBe(true);

    // 库是事实：好行真的发了（承运商 trim 过、actor 是 admin:<sub>），坏行一行都没动
    const ok1 = (
      await db`select status, carrier, tracking_no, shipped_at from orders where id = 'o-ok1'`
    )[0];
    expect(ok1?.['status']).toBe('shipped');
    expect(ok1?.['carrier']).toBe('Japan Post');
    expect(ok1?.['tracking_no']).toBe('EJ123456789JP');
    expect(ok1?.['shipped_at']).not.toBeNull();
    const ev =
      await db`select actor from order_events where order_id = 'o-ok1' and status = 'shipped'`;
    expect(ev.map((e) => e['actor'])).toEqual(['admin:u-admin']);
    expect((await db`select status from orders where id = 'o-ok2'`)[0]?.['status']).toBe('shipped');
    for (const id of ['o-dispute', 'o-test', 'o-long']) {
      expect((await db`select status from orders where id = ${id}`)[0]?.['status']).toBe('paid');
      expect(await shippedEvents(id)).toBe(0);
    }
    // 发货事件（→ 发货邮件）只给成功的两单
    expect([...published].sort()).toEqual(['o-ok1', 'o-ok2']);
    // 运行日志：成功单各一条 admin_order_shipped，失败单各一条带 code 的 warn，外加一条汇总
    const log = srv.sink.lines.join('\n');
    expect(srv.sink.lines.filter((l) => l.includes('"admin_order_shipped"'))).toHaveLength(2);
    expect(
      srv.sink.lines.filter((l) => l.includes('"admin_order_ship_batch_item_failed"')),
    ).toHaveLength(5);
    expect(log).toContain('"admin_order_ship_batch"');
    // 运单号不进日志（只有承运商名进事件 payload，与单单发货同口径）
    expect(log).not.toContain('EJ123456789JP');
  });

  it('🔴 admin_audit 一行：after 记的是**逐单结果**（谁成谁败），不是"请求说要发什么"', async () => {
    await seed('o-a');
    await seed('o-b', { status: 'shipped' });
    const r = await post({
      items: [
        { order_id: 'o-a', carrier: 'Japan Post', tracking_no: 'EJ123456789JP' },
        { order_id: 'o-b', carrier: 'Japan Post', tracking_no: 'EJ987654321JP' },
      ],
    });
    expect(r.status).toBe(200);
    const q = () =>
      db`select action, target, after from admin_audit where action = 'POST /admin/orders/ship-batch'`;
    await waitUntil(async () => (await q()).length > 0, '批量发货没有审计行');
    const rows = await q();
    expect(rows).toHaveLength(1);
    // ADM-8（AJ-470）：对象列此前为空，运营日志里这一行认不出是什么
    expect(rows[0]?.['target']).toBe('batch:1/2');
    const after = rows[0]?.['after'] as { results?: ItemResult[] };
    expect(after.results?.map((x) => [x.order_id, x.ok])).toEqual([
      ['o-a', true],
      ['o-b', false],
    ]);
  });

  it('全部失败 → 仍 200（逐单结果），但**不写审计**（没有发生的改动不进审计）', async () => {
    await seed('o-b', { status: 'shipped' });
    const r = await post({
      items: [{ order_id: 'o-b', carrier: 'Japan Post', tracking_no: 'EJ987654321JP' }],
    });
    expect(r.status).toBe(200);
    expect(r.json['succeeded']).toBe(0);
    // 等一个确定会写的东西作对照：审计异步，"没有"必须等过一段才算数
    await new Promise((res) => setTimeout(res, 200));
    expect(await db`select 1 from admin_audit`).toHaveLength(0);
  });

  it('🔴 某一单在事务**中途**失败 → 那一单整单回滚（不留半成品），前后两单照常发', async () => {
    await seed('o-before');
    await seed('o-boom');
    await seed('o-after');
    // 真库注入：给 o-boom 的 shipped 事件插入制造一次失败——此时 orders 行已经 update 成 shipped
    await db.unsafe(`
      create or replace function test_boom() returns trigger language plpgsql as $$
      begin
        if new.order_id = 'o-boom' and new.status = 'shipped' then
          raise exception 'boom';
        end if;
        return new;
      end $$;
      create trigger test_boom before insert on order_events
        for each row execute function test_boom();
    `);
    try {
      const r = await post({
        items: ['o-before', 'o-boom', 'o-after'].map((id) => ({
          order_id: id,
          carrier: 'Japan Post',
          tracking_no: 'EJ123456789JP',
        })),
      });
      expect(r.status).toBe(200);
      expect(results(r.json).map((x) => [x.order_id, x.ok, x.code ?? null])).toEqual([
        ['o-before', true, null],
        ['o-boom', false, 50000],
        ['o-after', true, null],
      ]);
      // 非 AppError 分支（审查 2026-10-09 C9）：固定文案、reason=internal、error 级日志带 err——
      //   把触发器原文 'boom' 泄进 message 或降成 warn 都要红
      const boomRow = results(r.json).find((x) => x.order_id === 'o-boom');
      expect(boomRow).toMatchObject({ message: '服务器内部错误', reason: 'internal' });
      // （订单 id 本身叫 o-boom，所以只查 message / reason 两个字段，不查整个响应串）
      expect(String(boomRow?.message)).not.toContain('boom');
      const failedLog = srv.sink
        .find('admin_order_ship_batch_item_failed')
        .find((l) => l['order_id'] === 'o-boom');
      expect(failedLog?.level).toBe('error');
      // 带原始异常（字段名由 logger 的 err 序列化决定，这里只认内容）
      expect(JSON.stringify(failedLog)).toContain('boom');
      const boom = (
        await db`select status, carrier, shipped_at from orders where id = 'o-boom'`
      )[0];
      expect(boom?.['status']).toBe('paid');
      expect(boom?.['carrier']).toBeNull();
      expect(boom?.['shipped_at']).toBeNull();
      expect([...published].sort()).toEqual(['o-after', 'o-before']);
    } finally {
      await db.unsafe(
        `drop trigger if exists test_boom on order_events; drop function if exists test_boom();`,
      );
    }
  });
});

describe('POST /admin/orders/ship-batch：整次拒绝（结构错误一单都不发）', () => {
  const item = (id: string) => ({
    order_id: id,
    carrier: 'Japan Post',
    tracking_no: 'EJ123456789JP',
  });

  it.each([
    ['items 不是数组', { items: 'o-1' }],
    ['缺 items', {}],
    ['空数组', { items: [] }],
    ['order_id 不是字符串', { items: [{ ...item('o-1'), order_id: 1 }] }],
    ['order_id 空白', { items: [item('o-1'), { ...item('x'), order_id: '  ' }] }],
    ['order_id 超长', { items: [item('o-1'), { ...item('x'), order_id: 'o'.repeat(65) }] }],
    ['同一单出现两次', { items: [item('o-1'), item('o-1')] }],
  ])('%s → 400 / 40001，且好的那单也没发', async (_name, body) => {
    await seed('o-1');
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.json['code']).toBe(40001);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.['status']).toBe('paid');
  });

  it(`边界：${String(SHIP_BATCH_MAX)} 单可以，${String(SHIP_BATCH_MAX + 1)} 单整次拒绝（不截断）`, async () => {
    const ids = Array.from(
      { length: SHIP_BATCH_MAX + 1 },
      (_, i) => `o-${String(i).padStart(3, '0')}`,
    );
    for (const id of ids) await seed(id);
    const tooMany = await post({ items: ids.map(item) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json['code']).toBe(40001);
    expect(srv.sink.lines.join('\n')).toContain('batch_too_large');
    expect(await db`select 1 from orders where status = 'shipped'`).toHaveLength(0);

    const max = await post({ items: ids.slice(0, SHIP_BATCH_MAX).map(item) });
    expect(max.status).toBe(200);
    expect(max.json['succeeded']).toBe(SHIP_BATCH_MAX);
  });

  it('非管理员 → 403；无 token → 401（与单单发货同一个守卫）', async () => {
    await seed('o-1');
    expect((await post({ items: [item('o-1')] }, 'user')).status).toBe(403);
    expect((await post({ items: [item('o-1')] }, 'none')).status).toBe(401);
    expect((await db`select status from orders where id = 'o-1'`)[0]?.['status']).toBe('paid');
  });
});

describe('POST /admin/orders/ship-batch：并发', () => {
  /**
   * 🔴 两个管理员同时批量发**同一批**单，且顺序相反（最容易死锁 / 双发的排列）：
   *    每单恰好一条 shipped 事件、恰好一次 order.shipped（= 一封发货邮件），
   *    两批合计成功 = 单数，另一边一律 40902，没有 500。
   * @why 守的是单单发货那一把：`lockAdminOrder`（for update）+ `markShipped ... where status = 'paid'`。
   *      批量没有另起一把锁——逐单事务各自只锁一行，所以反序也不会死锁。
   */
  it('🔴 重叠且反序的两批并发：每单只发一次', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `o-c${String(i).padStart(2, '0')}`);
    for (const id of ids) await seed(id);
    const body = (list: string[], tn: string) => ({
      items: list.map((id) => ({ order_id: id, carrier: 'Japan Post', tracking_no: tn })),
    });
    const [a, b] = await Promise.all([
      post(body(ids, 'EJ111111111JP')),
      post(body([...ids].reverse(), 'EJ222222222JP')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const all = [...results(a.json), ...results(b.json)];
    expect(all.filter((x) => x.ok)).toHaveLength(ids.length);
    expect(all.filter((x) => !x.ok).every((x) => x.code === 40902)).toBe(true);
    for (const id of ids) expect(await shippedEvents(id), id).toBe(1);
    expect([...published].sort()).toEqual(ids);
  });

  /**
   * 🔴 **强制**撞车：上一条用例两批各自串行，真正同时落在同一单上的窗口很小——
   *    缺陷注入实测（AJ-401 S11）：把行锁与 `status = 'paid'` 条件都去掉，上一条照样全绿。
   *    这里先在另一个事务里把这批单全部 `for update` 锁住，让两批**同时**堵在第一单上，
   *    放开后两边真的在同一行上竞争——每单仍只能发一次。
   */
  it('🔴 两批同序、被外部行锁堵在同一单上再同时放开：每单只发一次', async () => {
    const ids = ['o-r1', 'o-r2', 'o-r3'];
    for (const id of ids) await seed(id);
    const body = (tn: string) => ({
      items: ids.map((id) => ({ order_id: id, carrier: 'Japan Post', tracking_no: tn })),
    });
    let fired: Promise<Array<{ status: number; json: Record<string, unknown> }>> | undefined;
    await db.begin(async (tx) => {
      await tx`select id from orders where id in ${tx(ids)} for update`;
      fired = Promise.all([post(body('EJ111111111JP')), post(body('EJ222222222JP'))]);
      // 让两个请求都走到第一单的锁上（堵住），再提交放开
      await new Promise((r) => setTimeout(r, 300));
    });
    const [a, b] = await (fired ?? Promise.reject(new Error('请求未发出')));
    expect(a?.status).toBe(200);
    expect(b?.status).toBe(200);
    const all = [...results(a?.json ?? {}), ...results(b?.json ?? {})];
    expect(all.filter((x) => x.ok)).toHaveLength(ids.length);
    for (const id of ids) expect(await shippedEvents(id), id).toBe(1);
    expect([...published].sort()).toEqual(ids);
  });
});

/** @why 批量发货走同一份 shipOrder → shipInfoGuard，但"拼起来的缝"要在批量入口自己证一次（AJ-410 / N20a）。 */
describe('POST /admin/orders/ship-batch：运单号服务端归一（N20a）', () => {
  it('🔴 每行落库的是归一值（去空白、转大写），逐单结果与审计 after 也是', async () => {
    await seed('o-n1');
    await seed('o-n2');
    const r = await post({
      items: [
        { order_id: 'o-n1', carrier: 'Japan Post', tracking_no: 'ej 123456789 jp' },
        { order_id: 'o-n2', carrier: 'Yamato', tracking_no: ' 1234-5678-9012\t' },
      ],
    });
    expect(r.status).toBe(200);
    const rows =
      await db`select id, tracking_no from orders where id in ('o-n1', 'o-n2') order by id`;
    expect(rows.map((x) => [x['id'], x['tracking_no']])).toEqual([
      ['o-n1', 'EJ123456789JP'],
      ['o-n2', '1234-5678-9012'],
    ]);
    const res = r.json['results'] as { order_id: string; tracking_no?: string }[];
    expect(res.map((x) => x.tracking_no)).toEqual(['EJ123456789JP', '1234-5678-9012']);
    const q = () =>
      db`select after from admin_audit where action = 'POST /admin/orders/ship-batch'`;
    await waitUntil(async () => (await q()).length > 0, '批量发货没有审计行');
    const after = (await q())[0]?.['after'] as { results?: { tracking_no?: string }[] };
    expect(after.results?.map((x) => x.tracking_no)).toEqual(['EJ123456789JP', '1234-5678-9012']);
  });
});
