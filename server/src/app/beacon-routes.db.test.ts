/**
 * `POST /api/v1/beacon`（M-21 / AJ-409）：真路由 + 真 Postgres（生产装配 `mountAllRoutes`）。
 *
 * 断言面：合法批次落 `user_events`（服务端时间、client_ts、trace_id / req_id、匿名 id、登录用户）；
 * 白名单外的事件 / 键 / 超批量整批 40001 且一行不写；PII 请求被拒且库里与日志里都扫不到；
 * id 不存在的事件丢弃（形状合法的 openid 形态也进不了库）；token 无效不 401（降级匿名）；append-only；限流。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { seedCreatedOrder } from '../../../test/helpers/seed-order.js';

const ANON = 'an-0123456789ABCDEFGHJK';
const TS = Date.UTC(2026, 9, 8, 3, 0, 0);
const TRACE = 'mp-BEACONTRACE0000001';

let db: Db;
let srv: ChainServer;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
});

async function beacon(
  s: ChainServer,
  payload: unknown,
  token?: string,
): Promise<{ status: number; code: unknown }> {
  const res = await fetch(`${s.url}/api/v1/beacon`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const json = text === '' ? {} : (JSON.parse(text) as { code?: unknown });
  return { status: res.status, code: json.code };
}

type Row = {
  user_id: string | null;
  session_id: string | null;
  event: string;
  props: Record<string, unknown>;
  trace_id: string | null;
  req_id: string | null;
  created_at: Date;
};
const rows = (): Promise<Row[]> =>
  db<
    Row[]
  >`select user_id, session_id, event, props, trace_id, req_id, created_at from user_events order by id`;

async function withServer(fn: (s: ChainServer) => Promise<void>, extra = {}): Promise<void> {
  srv = await buildChainServer(db, extra);
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

describe('POST /beacon：落库', () => {
  it('匿名批次 → 204，逐条落 user_events（服务端时间 + client_ts + trace_id + 匿名 id）', async () => {
    await withServer(async (s) => {
      const before = Date.now();
      const r = await beacon(s, {
        anon_id: ANON,
        events: [
          { name: 'page_view', ts: TS, props: { page: 'detail' } },
          { name: 'add_to_cart', ts: TS + 1, props: { product_id: 'p-knife' } },
          { name: 'checkout_enter', ts: TS + 2 },
        ],
      });
      expect(r.status).toBe(204);
      const got = await rows();
      expect(got.map((x) => x.event)).toEqual(['page_view', 'add_to_cart', 'checkout_enter']);
      for (const x of got) {
        expect(x.user_id).toBeNull();
        expect(x.session_id).toBe(ANON);
        expect(x.trace_id).toBe(TRACE);
        expect(x.req_id).toMatch(/.+/);
        expect(x.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      }
      expect(got[1]?.props).toEqual({ product_id: 'p-knife', client_ts: TS + 1 });
      expect(got[2]?.props).toEqual({ client_ts: TS + 2 });
    });
  });

  it('登录买家 → user_id 取自 token；pay_start / pay_abandon 的 order_id 须是真实订单', async () => {
    await seedCreatedOrder(db, 'ord-beacon-1', { userId: 'u-1' });
    await withServer(async (s) => {
      const r = await beacon(
        s,
        {
          anon_id: ANON,
          events: [
            { name: 'pay_start', ts: TS, props: { order_id: 'ord-beacon-1', channel: 'mock' } },
            { name: 'pay_abandon', ts: TS, props: { order_id: 'ord-beacon-1', reason: 'back' } },
          ],
        },
        await tokenFor('u-1'),
      );
      expect(r.status).toBe(204);
      const got = await rows();
      expect(got.map((x) => [x.user_id, x.event])).toEqual([
        ['u-1', 'pay_start'],
        ['u-1', 'pay_abandon'],
      ]);
      expect(got[1]?.props).toEqual({ order_id: 'ord-beacon-1', reason: 'back', client_ts: TS });
    });
  });

  it('token 伪造 / 被封禁 → 不 401（埋点不能触发重登），降级为匿名落库', async () => {
    await db`update users set blocked_at = now() where id = 'u-2'`;
    await withServer(async (s) => {
      const ev = { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS }] };
      expect((await beacon(s, ev, 'not-a-jwt')).status).toBe(204);
      expect((await beacon(s, ev, await tokenFor('u-2'))).status).toBe(204);
      expect((await rows()).map((x) => x.user_id)).toEqual([null, null]);
    });
  });

  it('id 形状合法但不存在（openid 形态 / 他处 id）→ 该条丢弃、同批其余照收，warn 只记条数不记值', async () => {
    const openidLike = 'oAbCdEfGhIjKlMnOpQrStUvWxYz0';
    await withServer(async (s) => {
      const r = await beacon(s, {
        anon_id: ANON,
        events: [
          { name: 'add_to_cart', ts: TS, props: { product_id: openidLike } },
          { name: 'pay_start', ts: TS, props: { order_id: 'ord-nope', channel: 'mock' } },
          { name: 'add_to_cart', ts: TS, props: { product_id: 'p-cup' } },
        ],
      });
      expect(r.status).toBe(204);
      const got = await rows();
      expect(got.map((x) => x.props.product_id)).toEqual(['p-cup']);
      const warn = s.sink.find('beacon_events_dropped');
      expect(warn).toHaveLength(1);
      expect((warn[0]?.ctx as Record<string, unknown>).dropped).toBe(2);
      expect(s.sink.lines.join('\n')).not.toContain(openidLike);
      expect(s.sink.lines.join('\n')).not.toContain('ord-nope');
    });
  });
});

describe('POST /beacon：拒绝（整批 40001，一行不写）', () => {
  const bad: [string, unknown][] = [
    ['未知事件名', { anon_id: ANON, events: [{ name: 'address_submit', ts: TS }] }],
    [
      '未知 prop',
      {
        anon_id: ANON,
        events: [{ name: 'add_to_cart', ts: TS, props: { product_id: 'p-cup', qty: 2 } }],
      },
    ],
    [
      '超批量 21 条',
      {
        anon_id: ANON,
        events: Array.from({ length: 21 }, () => ({ name: 'checkout_enter', ts: TS })),
      },
    ],
  ];
  it.each(bad)('%s → 400 / 40001', async (_t, payload) => {
    await withServer(async (s) => {
      const r = await beacon(s, payload);
      expect([r.status, r.code]).toEqual([400, 40001]);
      expect(await rows()).toEqual([]);
    });
  });

  it('PII 请求全部被拒；库里与日志里都扫不到邮箱 / 电话 / openid / 姓名 / 街道', async () => {
    const PII = {
      email: 'jane.doe@example.com',
      phone: '+14155550123',
      openid: 'o-1',
      name: 'Jane Doe',
      street: '1 Infinite Loop',
    };
    const attempts: unknown[] = [
      { anon_id: PII.email, events: [{ name: 'checkout_enter', ts: TS }] },
      {
        anon_id: ANON,
        events: [{ name: 'add_to_cart', ts: TS, props: { product_id: PII.phone } }],
      },
      {
        anon_id: ANON,
        events: [{ name: 'add_to_cart', ts: TS, props: { product_id: PII.email } }],
      },
      { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS, props: { email: PII.email } }] },
      { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS, [PII.email]: PII.name }] },
      { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS }], address: PII.street },
      {
        anon_id: ANON,
        events: [{ name: 'page_view', ts: TS, props: { page: 'home', recipient: PII.name } }],
      },
    ];
    await withServer(async (s) => {
      for (const a of attempts) {
        const r = await beacon(s, a, await tokenFor('u-1'));
        expect([r.status, r.code]).toEqual([400, 40001]);
      }
      const dump = JSON.stringify(await db`select * from user_events`);
      const logs = s.sink.lines.join('\n');
      for (const v of Object.values(PII)) {
        expect(dump).not.toContain(v);
        // openid 'o-1' 太短，会误命中日志里别的字段；它的防线是"不进库"，日志只查其余四项
        if (v !== PII.openid) expect(logs).not.toContain(v);
      }
      expect(dump).toBe('[]');
    });
  });
});

describe('POST /beacon：存储约束与限流', () => {
  it('user_events append-only：UPDATE / DELETE 被触发器拒（42501）', async () => {
    await withServer(async (s) => {
      await beacon(s, { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS }] });
    });
    await expect(db`update user_events set event = 'x'`).rejects.toMatchObject({ code: '42501' });
    await expect(db`delete from user_events`).rejects.toMatchObject({ code: '42501' });
    expect(await rows()).toHaveLength(1);
  });

  it('按 IP 限流（公开写入口同一规则，独立的桶）：超额 → 429 / 42901', async () => {
    await withServer(
      async (s) => {
        const ev = { anon_id: ANON, events: [{ name: 'checkout_enter', ts: TS }] };
        expect((await beacon(s, ev)).status).toBe(204);
        expect((await beacon(s, ev)).status).toBe(204);
        const third = await beacon(s, ev);
        expect([third.status, third.code]).toEqual([429, 42901]);
        expect(await rows()).toHaveLength(2);
      },
      { RATE_LIMIT_QUOTE_PER_MIN: '2' },
    );
  });
});
