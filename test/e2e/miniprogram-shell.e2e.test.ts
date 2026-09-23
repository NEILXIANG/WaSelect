/**
 * 职责：小程序壳（F6c 客户端半边）的 L3 端到端测试——用**真服务端**验证 `miniprogram/utils/request.js`。
 *
 * @why `request.unit.test.ts` 注入的是假 `wx.request`，它只能证明"我们的 if 分支写对了"，
 *      证明不了**与真实服务端对齐**。下面这些是真实会发生、且单测一条也测不出来的：
 *        1. 服务端错误体到底叫 `code` 还是 `error.code`（取错 → 前端永远弹 undefined）；
 *        2. 微信把非 2xx 也交给 `success` 而不是 `fail`（写反 → 业务错误被当成网络错误）；
 *        3. `x-trace-id` 头是不是**真被服务端接受并沿用**（拼错一个字符就全程串不起来）；
 *        4. `idempotency-key` 由封装注入后，服务端是不是真的按它去重。
 *      这些全是"两端各自都对、接起来错"的类型，只有真跑一遍才会暴露。
 *
 * 假的部分只有一处：`wx.request` 这个宿主 HTTP 通道（见 `fake-wx-request.ts` 的边界说明）。
 * 传输是真的：真端口、真 TCP、真 JSON 解析、真错误体。
 *
 * @see docs/地基搭建清单.md F6c；miniprogram/utils/request.js @limitation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import { fakeWxRequest } from '../helpers/fake-wx-request.js';
import { E2E_USER, startSkeleton, userToken, type SkeletonServer } from './harness.js';

// 被直接测的是小程序源码本身（js，非 ts）——allowJs 已开，v8 覆盖率也会统计到它
import { ApiError, NETWORK_ERROR_CODE, createRequester } from '../../miniprogram/utils/request.js';
import { newTraceId } from '../../miniprogram/utils/trace.js';

let db: Db;
let app: SkeletonServer;

/** 埋点出口：ADR-29 流 C 的用户行为。骨架期还没接 /beacon，先在这里收着断言。 */
let beacons: Array<Record<string, unknown>>;
let api: ReturnType<typeof createRequester>;
let token = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  app = await startSkeleton(db);
  beacons = [];
  api = createRequester({
    request: fakeWxRequest,
    getToken: () => token,
    // request.js 是 js（allowJs 未开 checkJs），回调参数无推断，这里显式标注
    log: (fields: unknown) => beacons.push(fields as Record<string, unknown>),
  });
}, 30_000);

afterAll(async () => {
  await app.server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values (${E2E_USER}, 'o-e2e') on conflict (id) do nothing`;
  beacons = [];
  token = await userToken();
  app.sink.clear();
});

describe('小程序壳 → 真服务端：一条链路走到底', () => {
  it('建单 → 模拟支付 → 读回，三跳共用客户端生成的同一个 trace_id', async () => {
    // 客户端生成 trace，后续每一跳都传它——这是"一次用户操作一条链"的落地方式
    const traceId = newTraceId();

    const created = (await api({
      url: `${app.base}/api/v1/skeleton/orders`,
      method: 'POST',
      data: {},
      idempotencyKey: 'mp-key-1',
      traceId,
    })) as { order_id: string; status: string };
    expect(created.status).toBe('created');

    await api({
      url: `${app.base}/api/v1/skeleton/orders/${created.order_id}/simulate-paid`,
      method: 'POST',
      traceId,
    });

    const got = (await api({
      url: `${app.base}/api/v1/skeleton/orders/${created.order_id}`,
      traceId,
    })) as { status: string; trace_id: string };

    expect(got.status).toBe('paid');
    // 服务端把当前上下文的 trace_id 回显：等于证明"客户端的头真被服务端接受了"，
    // 而不是"客户端自己生成一个自娱自乐"。这一条是整条测试的核心断言。
    expect(got.trace_id).toBe(traceId);

    // 服务端日志：三跳全在同一条链上（客户端的 ID 直接出现在服务端日志里）
    const traced = app.sink.rows().filter((r) => r.trace_id !== undefined);
    expect(traced.length).toBeGreaterThan(0);
    expect([...new Set(traced.map((r) => String(r.trace_id)))]).toEqual([traceId]);

    // 流 C 用户行为埋点：三次成功各一条，且带同一个 trace_id
    const okBeacons = beacons.filter((b) => b.event === 'api_ok');
    expect(okBeacons).toHaveLength(3);
    expect([...new Set(okBeacons.map((b) => String(b.trace_id)))]).toEqual([traceId]);
  });

  it('没带 token（未登录）→ ApiError 40101，且服务端没有落任何单', async () => {
    token = '';
    await expect(
      api({
        url: `${app.base}/api/v1/skeleton/orders`,
        method: 'POST',
        data: {},
        idempotencyKey: 'mp-key-2',
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 40101 });

    const rows = await db`select id from orders`;
    expect(rows).toHaveLength(0);

    // 401 在微信里走 success 而不是 fail——如果封装写反，这里会变成 -1
    const failed = beacons.filter((b) => b.event === 'api_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.code).toBe(40101);
    expect(beacons.filter((b) => b.event === 'api_network_error')).toHaveLength(0);
  });

  it('连不上（端口没人听）→ code 为网络错误码，不是业务码', async () => {
    await expect(api({ url: 'http://127.0.0.1:1/api/v1/skeleton/orders' })).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
    });
    expect(beacons.filter((b) => b.event === 'api_network_error')).toHaveLength(1);
  });

  it('封装注入的 Idempotency-Key 被服务端真的用上：连点两次只建一张单', async () => {
    const traceId = newTraceId();
    const opts = {
      url: `${app.base}/api/v1/skeleton/orders`,
      method: 'POST',
      data: {},
      idempotencyKey: 'mp-dup-key',
      traceId,
    };
    const first = (await api(opts)) as { order_id: string };
    const second = (await api(opts)) as { order_id: string };
    expect(second.order_id).toBe(first.order_id);
    expect(await db`select id from orders`).toHaveLength(1);
  });

  it('ApiError 的 message 来自服务端错误体，不是占位符（否则用户看到的是空提示）', async () => {
    token = '';
    const err = (await api({
      url: `${app.base}/api/v1/skeleton/orders`,
      method: 'POST',
      data: {},
      idempotencyKey: 'mp-key-3',
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});
