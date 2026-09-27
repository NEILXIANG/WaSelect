/**
 * 职责：回调处理管线（pay-callback.ts）的 L3 端到端测试——宽限期 / 坏报文 / 验签 /
 *      重投去重 / paid:already / 早到补单 / 断链 / N22 租约，全链路走真库真 HMAC。
 *
 * @why 这批用例**原本长在 skeleton.e2e 里**（骨架只是它们的造单工具）；U6c 骨架
 *      退役时整批迁来——它们测的是生产回调管线，与骨架无关。造单从"打骨架端点"
 *      改成**直接插库**（pending_payment 单 + recordPaymentIntent 真函数）：
 *      焦点在回调，前置状态用最小成本摆出；建单链路本身由 order-routes.db.test 覆盖。
 *
 * @why 插库造单仍补一条 `order_events 'created'` 行：N22 用例断言事件序列
 *      `['created','paid']`——没有 created 行，这个序列断言就变成了"只数到一条
 *      就算对"的弱化版。
 *
 * @see server/src/app/pay-callback.ts；server/src/app/pay-routes.ts；
 *      server/src/adapters/webhooks.ts（claim/租约/栅栏）
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { recordPaymentIntent } from '../../server/src/app/payment-intent.js';
import type { MemorySink } from '../helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  E2E_CALLBACK_SECRET as CALLBACK_SECRET,
  E2E_TRACE as TRACE,
  E2E_USER as USER,
  startApp,
  type E2EServer,
} from './harness.js';

let db: Db;
let current: E2EServer;
let sink: MemorySink;
let base = '';

/** 起一个真实服务；`rawBodyPaths` 可关掉，用于验证"少配一环就断链"。 */
async function startServer(opts: { withRawBody: boolean }): Promise<E2EServer> {
  const s = await startApp(db, { withRawBody: opts.withRawBody });
  sink = s.sink;
  base = s.base;
  current = s;
  return s;
}

/**
 * 造单金额：**1,000 円**（本文件 fixture）。回调与 `payments` 行必须都用它——
 * 落账要核对金额（三审 U1），两边对不上就不落账。
 */
const CHARGE = { currency: 'JPY', amountMinor: 1000 };

/**
 * 插库造一张"等待支付"的单（pending_payment + created 事件行，文件头 @why）。
 * expires_at 给 30 分钟：mark-paid 的「到点未付」守卫与它同向，不能造一张
 * "出生即迟到"的单。
 */
async function seedPendingOrder(orderId: string): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot,
                        terms_version, expires_at)
    values (${orderId}, ${`W-${orderId}`}, ${USER}, 'pending_payment',
            ${CHARGE.amountMinor}, 0, 0, ${CHARGE.amountMinor}, 500,
            ${db.json({ USD: 0.0066 })}, ${db.json({ country: 'US' })},
            'TOS-1', now() + interval '30 minutes')
  `;
  await db`
    insert into order_events (order_id, status, actor)
    values (${orderId}, 'created', ${`user:${USER}`})
  `;
}

/**
 * 登记"这张单要在 mock 通道上收 1,000 円"（走**真函数**，不是裸 SQL）。
 *
 * @why 三审 S1②：落账现在必须绑定通道与金额，而"我们原本打算怎么收钱"这条事实
 *      只能来自发起支付时写的 `payments` 行。回调之前没有它 = 这张单从没发起过支付，
 *      任何通道的回调都不该落账——不然"持任一通道密钥 → 给任意订单置 paid"还是通的。
 */
function seedPayment(orderId: string): Promise<void> {
  return recordPaymentIntent(db, {
    id: `pay-${orderId}`,
    orderId,
    provider: 'mock',
    providerRef: `mock_cs_${orderId}`,
    chargeCurrency: CHARGE.currency,
    chargeAmount: CHARGE.amountMinor,
  });
}

/**
 * 按 mock 通道的约定给回调报文签名（HMAC-SHA256 hex）。
 *
 * ⚠️ 默认补 `type: 'payment.succeeded'`：归一化结果由 `type` 决定——
 *    不认识的类型一律 `unknown`，**不落账**。
 * ⚠️ 默认也补 `amount_minor` / `currency`：落账要拿它们与 `payments` 行对（三审 U1），
 *    报文里没有金额 = 不可核对 = **不落账**（不是"跳过核对"）。
 */
function signedCallback(payload: Record<string, unknown>, secret = CALLBACK_SECRET, trace = TRACE) {
  return signedRaw(
    JSON.stringify({
      type: 'payment.succeeded',
      amount_minor: CHARGE.amountMinor,
      currency: CHARGE.currency,
      ...payload,
    }),
    secret,
    trace,
  );
}

/** 发一段**任意原文**（可故意不是合法 JSON），签名照算——用于验证坏报文的处理。 */
function signedRaw(body: string, secret = CALLBACK_SECRET, trace = TRACE) {
  const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return fetch(`${base}${PAY_CALLBACK_PREFIX}/mock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature,
      'x-trace-id': trace,
    },
    body,
  });
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  await startServer({ withRawBody: true });
}, 30_000);

afterAll(async () => {
  await current.server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  // orders.user_id 有外键，每轮都要有这个用户
  await db`insert into users (id, openid) values (${USER}, 'o-e2e') on conflict (id) do nothing`;
  sink.clear();
});

describe('早到与超期（N4/AJ-32 的双层结构）', () => {
  /**
   * N4/AJ-32（宽限期内）：回调先到、订单还没落库 → **503 让机构重发**，
   * 且 `processed_at` 保持 NULL（对账信号 + 同一 event_id 重发能补上的前提）。
   * @why 旧行为是一律 2xx + warn，但"可重试"的登记被 200 回应抵消——机构永不重发，
   *      "钱到单未付"只剩一条 warn。宽限期内回 503 是让机构的重发机制替我们兜底。
   */
  it('宽限期内回调先到（order_not_found）→ 503 + processed_at 保持 NULL，不静默吞掉', async () => {
    const res = await signedCallback({ order_id: 'sk-does-not-exist', event_id: 'evt-grace' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    await expect(res.json()).resolves.toMatchObject({
      received: false,
      reason: 'order_not_found_yet',
    });
    expect(sink.find('callback_early')).toHaveLength(1);
    expect(sink.find('callback_early')[0]?.level).toBe('warn');
    // processed_at 必须保持 NULL：这是对账信号，也是"同一 event_id 重发时能补上"的前提
    const rows = await db`select processed_at from webhook_events where event_id = 'evt-grace'`;
    expect(rows[0]?.processed_at).toBeNull();
    /**
     * 租约也必须**交还**（N22 补丁）：这个请求已经结束了，不算"处理中"。
     * 留着租约会让接下来 10 秒内的重投被判成 inflight → 再吃一个 503，
     * 于是"早到 → 重发 → 补上"整条链被租约掐断（本文件的重发补上用例就是这么红的）。
     */
    const lease =
      await db`select processing_until, processing_token from webhook_events where event_id = 'evt-grace'`;
    expect(lease[0]?.processing_until).toBeNull();
    expect(lease[0]?.processing_token).toBeNull();
    // 一次早到的回调不能写出任何业务事件
    const events = await db`select id from order_events`;
    expect(events).toHaveLength(0);
  });

  /**
   * 2026-09-23 自查发现：宽限期算的是"距事件**首次**到达多久"，而首次到达时间是 **DB 时钟**
   * （`received_at` 由 Postgres 的 now() 写入）。用应用的 `Date.now()` 去减它，等于拿两个时钟做减法：
   * 应用时钟快 20 分钟时，一条**刚到**的回调会被判成"超过 15 分钟宽限期" → 2xx 收下 +
   * 落 unmatched、机构不再重发——"钱到单未付"就此静默，且没有任何报错。
   * 判据必须是 DB 自己的 now()（由 claimWebhookEvent 一并返回）。
   */
  it('宽限期判定用 DB 时钟——应用时钟偏快 20 分钟也不许把早到回调判成超期', async () => {
    const OFFSET = 20 * 60 * 1000; // 比默认宽限期（15 分钟）更大
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + OFFSET);
    try {
      const res = await signedCallback({ order_id: 'sk-clock-skew', event_id: 'evt-skew' });
      // 修复前这里会是 200 + unmatched：刚到的回调被误判超期，机构不再重发
      expect(res.status).toBe(503);
      const rows =
        await db`select processed_at, result from webhook_events where event_id = 'evt-skew'`;
      expect(rows[0]?.processed_at).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * N4/AJ-32（超过宽限期）：订单一直没出现 → 2xx 收下（机构不必再重发）+
   * **error 级**告警 + `processed_at` 落 `unmatched:order_not_found`（转入对账视野）。
   * @why 宽限期外还回 503 会让"确实不存在的脏回调"占用机构重发队列；
   *      但"钱到单未付"又绝不能静默——所以这一层用 error 告警 + 对账兜底（F13）。
   */
  it('超过宽限期订单仍不存在 → 2xx + error 告警 + 落 unmatched 待对账', async () => {
    // 独立起一个 graceMs=0 的服务：任何回调都立即"超过宽限期"
    const s = await startApp(db, { withRawBody: true, graceMs: 0 });
    try {
      const raw = JSON.stringify({
        type: 'payment.succeeded',
        order_id: 'sk-never',
        event_id: 'evt-late',
      });
      const sig = createHmac('sha256', CALLBACK_SECRET).update(raw).digest('hex');
      const res = await fetch(`${s.base}${PAY_CALLBACK_PREFIX}/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': sig,
          'x-trace-id': TRACE,
        },
        body: raw,
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ received: true, ignored: 'unmatched' });
      const alert = s.sink.find('callback_unmatched')[0];
      expect(alert?.level).toBe('error');
      const rows =
        await db`select processed_at, result from webhook_events where event_id = 'evt-late'`;
      expect(rows[0]?.processed_at).not.toBeNull();
      expect(rows[0]?.result).toBe('unmatched:order_not_found');
    } finally {
      await s.server.close();
    }
  });
});

describe('报文与验签（D6：入站方问题 4xx，我们的问题 5xx）', () => {
  /**
   * @why D6 的真实形态：`JSON.parse` 抛的是**我们自己的** SyntaxError，
   *      不带 body-parser 的 `type`/`status` 标记，http.ts 的 isBodyParseError 认不出来
   *      → 折叠成 50000（HTTP 500）。机构收到 500 就会按退避重发 3 天，
   *      而"这段报文永远解析不了"重发也不会变。必须回 4xx。
   */
  it('签名正确但报文是坏 JSON → 40001（4xx，机构不必重试），不是 50000', async () => {
    const res = await signedRaw('{ not json at all');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
    // 且不能占用 5xx 通道
    expect(sink.find('unhandled_error')).toHaveLength(0);
  });

  /**
   * ⚠️ 这里是 **50000** 而不是 40001（F11 迁移时的既定行为）：
   *      `ProviderEvent.orderId` 取不到，在 `ports/payment.ts` 的口径里是
   *      "**我们**的设计缺陷"（要么是 `create` 时没把单号写进机构 metadata，
   *      要么是我们对机构字段的假设错了），不是"入站方给了脏报文"。
   *      所以 mock Provider 抛的是普通 Error → 50000 进告警让人来修，
   *      而不是回 4xx 假装"改改报文就行"。共同点不变：**不会落到 SQL 里**。
   */
  it('回调体缺 order_id → 50000（取不到单号是我们的缺陷，不是坏报文），且不落到 SQL', async () => {
    const res = await signedCallback({ wrong_field: 1 });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: 50000 });
  });

  it('回调验签失败 → 40103（4xx：入站方的问题，不占 5xx），订单状态不变', async () => {
    await seedPendingOrder('ord-badsig');
    const res = await signedCallback({ order_id: 'ord-badsig' }, 'wrong-secret');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40103 });
    const rows = await db`select status from orders where id = 'ord-badsig'`;
    expect(rows[0]?.status).toBe('pending_payment');
  });
});

describe('重投与冲突（去重在最外层，告警才有信噪比）', () => {
  /**
   * 重复投递（**同一个 event_id**）→ 在回调层就被识别，不再碰业务。
   *
   * @why 机构的重发是**同一个事件**的同一份报文；把它一路放进业务逻辑再靠状态冲突挡住，
   *      等于每次重发都要走一遍事务、并在日志里留一条 warn——
   *      于是"机构在重发"（完全正常）会把真正的冲突告警淹没。
   *      去重放在最外层，告警才有信噪比。
   */
  it('同一 event_id 重投 → duplicate:true，业务层不再执行', async () => {
    await seedPendingOrder('ord-dup');
    await seedPayment('ord-dup');
    const payload = { order_id: 'ord-dup', event_id: 'evt-dup-1' };
    expect((await signedCallback(payload)).status).toBe(200);

    const dup = await signedCallback(payload);
    expect(dup.status).toBe(200);
    await expect(dup.json()).resolves.toMatchObject({ received: true, duplicate: true });
    // 业务层根本没被调用：没有冲突告警、没有第二条 paid 事件
    expect(sink.find('callback_conflict')).toHaveLength(0);
    expect(sink.find('webhook_duplicate')).toHaveLength(1);
    const events = await db`select status from order_events where order_id = 'ord-dup'`;
    expect(events.filter((r) => r.status === 'paid')).toHaveLength(1);
  });

  /** 不同的事件（不同 event_id）落在已支付的订单上 → N13：paid:already + info，不是异常。 */
  it('另一个事件（不同 event_id）落在已支付订单 → paid:already + info，不产生第二条 paid 事件', async () => {
    await seedPendingOrder('ord-twice');
    await seedPayment('ord-twice');
    expect((await signedCallback({ order_id: 'ord-twice', event_id: 'evt-a' })).status).toBe(200);
    const second = await signedCallback({ order_id: 'ord-twice', event_id: 'evt-b' });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      received: true,
      ignored: 'paid:already',
    });
    expect(sink.find('paid_already')).toHaveLength(1);
    expect(sink.find('paid_already')[0]?.level).toBe('info');
    expect(sink.find('callback_conflict')).toHaveLength(0);
    const events = await db`select status from order_events where order_id = 'ord-twice'`;
    expect(events.filter((r) => r.status === 'paid')).toHaveLength(1);
    // 登记结果也要是 paid:already（对账时能区分"正常重发"与"真冲突"）
    const rows = await db`select result from webhook_events where event_id = 'evt-b'`;
    expect(rows[0]?.result).toBe('paid:already');
  });

  /**
   * 回调比订单先到 → 宽限期内 503（机构会重发），**同一 event_id 重发时必须能再处理一次**。
   * @why 这是"去重 vs 正确性"冲突时的裁决场景：去重只是优化，
   *      "钱到了但订单没变成 paid"是事故。503 期间 processed_at 保持 NULL，
   *      重发时 claim 得到 `retry`，于是业务再跑一遍（AJ-32 双层结构的第一层）。
   */
  it('回调先到（宽限期内 503）→ 订单出现后同一个 event_id 重发时能补上', async () => {
    // 先发一个指向尚未创建订单的回调 → 宽限期内 503
    const early = await signedCallback({ order_id: 'ord-later', event_id: 'evt-early' });
    expect(early.status).toBe(503);
    await expect(early.json()).resolves.toMatchObject({
      received: false,
      reason: 'order_not_found_yet',
    });

    // 订单随后出现（并补上"发起过支付"这条事实）
    await seedPendingOrder('ord-later');
    await seedPayment('ord-later');
    // 机构重发**同一个** event_id
    const retry = await signedCallback({ order_id: 'ord-later', event_id: 'evt-early' });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ received: true });
    const rows = await db`select status from orders where id = 'ord-later'`;
    expect(rows[0]?.status).toBe('paid');
  });
});

/**
 * 断链验证：回调验签依赖未经解析的原始字节，"配错"时的症状是验签永远失败，
 * 排查会误导向密钥/机构——很少有人第一反应是"body 被解析过了"。
 * 用一条测试把这个可能性别留给人肉排查。
 * @why 期望 **50000 而不是 40103**：拿不到原始字节是**我们装配错了**，
 *      不是"入站方给了坏签名"。回 4xx 会让排查继续指向密钥与机构
 *      （@see app/pay-routes.ts @limitation 三）。
 */
describe('断链验证：少配一环就必须失败', () => {
  it('回调路由没登记 rawBodyPaths → 50000（我们的装配 bug），不伪装成验签失败', async () => {
    const broken = await startServer({ withRawBody: false });
    const brokenBase = broken.base;
    try {
      const body = JSON.stringify({ order_id: 'ord-whatever' });
      const signature = createHmac('sha256', CALLBACK_SECRET)
        .update(Buffer.from(body))
        .digest('hex');
      const res = await fetch(`${brokenBase}${PAY_CALLBACK_PREFIX}/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': signature,
          'x-trace-id': TRACE,
        },
        body,
      });
      // 装配 bug = 5xx（进告警 + 让机构重发），且**不能**被当成入站方的问题
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ code: 50000 });
    } finally {
      await broken.server.close();
      // 还原到"正常"的服务，避免影响后续用例
      await startServer({ withRawBody: true });
    }
  });
});

/**
 * N22（二审 P0-3）：同一个 event_id 的**并发**重复投递，只允许一个请求进入业务。
 *
 * @why 三态时期（new/handled/retry）把"正在处理"和"崩溃遗留"压成同一个 `retry`：
 *      库里两者长得一模一样（`processed_at IS NULL`），于是并发的第二次投递也会去处理。
 *      订单状态有 `for update` 兜底不会写错，但**事件行的 result 会被后写完的覆盖**——
 *      而这张表存在的唯一理由就是"这条回调到底怎么处理的"要说得清（举证）。
 *
 * @why 这道闸门是**编排**出来的，不是 `Promise.all` 碰运气。
 *      AJ-37 的硬要求：竞态窗口必须被编排，靠 sleep 或并发碰运气的测试
 *      在慢机器上会假绿、在快机器上会假红，二者都等于没测。
 *      办法是在 `db.begin`（markPaid 的事务入口）上装一道闸：A 进闸即停，
 *      我们从容地发 B、断言它的响应，再放行 A。窗口 100% 落在我们要的地方。
 * @tradeoff 闸门打在 `begin` 上意味着"处理中段"由事务入口近似——
 *          好处是稳定；代价是它不覆盖"claim 之后、事务之前"那段（那段没有 IO，窗口极窄，
 *          由 webhooks.db.test.ts 用直接调库的方式覆盖）。
 */
describe('N22：并发重复投递只有一个持有者（processing_until 租约 + 栅栏令牌）', () => {
  /** 在 `db.begin` 上装一道可控闸门：armed 之后第一个事务会停在闸内，直到 release()。 */
  function gatedDb(real: Db): {
    db: Db;
    arm: () => void;
    entered: Promise<void>;
    release: () => void;
  } {
    let armed = false;
    let enteredResolve: () => void = () => undefined;
    let releaseResolve: () => void = () => undefined;
    const entered = new Promise<void>((r) => {
      enteredResolve = r;
    });
    const release = new Promise<void>((r) => {
      releaseResolve = r;
    });
    const gated = new Proxy(real, {
      get(target, prop) {
        if (prop === 'begin' && armed) {
          return async (fn: unknown) => {
            enteredResolve();
            await release;
            return (target.begin as (f: unknown) => unknown)(fn);
          };
        }
        const v: unknown = Reflect.get(target, prop);
        // 绑回真实对象：postgres.js 的方法靠内部字段工作，this 必须是 target 而不是代理
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return {
      db: gated,
      arm: () => {
        armed = true;
      },
      entered,
      release: () => releaseResolve(),
    };
  }

  it('同一 event_id 并发重投：一个处理、另一个 503 already_processing，业务只跑一次', async () => {
    const gate = gatedDb(db);
    const s = await startApp(gate.db, { withRawBody: true });
    try {
      await seedPendingOrder('ord-n22');
      await seedPayment('ord-n22');
      const raw = JSON.stringify({
        type: 'payment.succeeded',
        amount_minor: CHARGE.amountMinor,
        currency: CHARGE.currency,
        order_id: 'ord-n22',
        event_id: 'evt-concurrent',
      });
      const signature = createHmac('sha256', CALLBACK_SECRET).update(raw).digest('hex');
      const post = () =>
        fetch(`${s.base}${PAY_CALLBACK_PREFIX}/mock`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mock-signature': signature,
            'x-trace-id': TRACE,
          },
          body: raw,
        });

      gate.arm();
      const first = post();
      // A 已进闸（持有租约、业务尚未写完）——此刻发 B，必然撞上"处理中"
      await gate.entered;

      const second = await post();
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('10');
      await expect(second.json()).resolves.toMatchObject({
        received: false,
        reason: 'already_processing',
      });

      // B 绝不能顺手把业务做了：此时还没有任何 paid 事件，事件行也没封口
      expect(await db`select id from order_events where status = 'paid'`).toHaveLength(0);
      const mid = await db`
        select processed_at, processing_until > now() as lease_live
          from webhook_events where event_id = 'evt-concurrent'
      `;
      expect(mid[0]?.processed_at).toBeNull();
      expect(mid[0]?.lease_live).toBe(true);
      expect(s.sink.find('webhook_inflight')).toHaveLength(1);

      // 放行 A
      gate.release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);

      // 业务只跑了一次：一条 paid 事件（created 是造单时插的，文件头 @why），事件行封口且租约已交还
      const events =
        await db`select status from order_events where order_id = 'ord-n22' order by id`;
      expect(events.map((r) => r.status)).toEqual(['created', 'paid']);
      const rows = await db`
        select result, processed_at, processing_until
          from webhook_events where event_id = 'evt-concurrent'
      `;
      expect(rows[0]?.result).toBe('paid');
      expect(rows[0]?.processed_at).not.toBeNull();
      expect(rows[0]?.processing_until).toBeNull();
      // 没有"结果没写成"的告警：A 是唯一持有者，令牌对得上
      expect(s.sink.find('webhook_result_not_written')).toHaveLength(0);
    } finally {
      gate.release();
      await s.server.close();
    }
  });

  /**
   * 崩溃遗留 → 下一次投递**必须能接管**。
   * @why 这是租约机制的两面之一：上面那条证明"活的持有者不被抢"，
   *      这条证明"死了的持有者不挡路"。只测前者的租约会把崩溃的回调永久卡死——
   *      那正是 N22 想修的问题换了个方向复发。
   * @why 用**过期租约 + processed_at IS NULL** 精确模拟崩溃：进程死了，
   *      行留在那儿，租约到期后自然可被接管（不需要心跳，见 webhooks.ts @limitation）。
   */
  it('租约过期（上次处理崩了）→ 下一次投递接管并补上，订单最终 paid', async () => {
    await seedPendingOrder('ord-crash');
    await seedPayment('ord-crash');
    // 手工造一行"崩溃遗留"：登记过、没处理完、租约已过期
    await db`
      insert into webhook_events (provider, event_id, event_type, payload_hash,
                                  processing_until, processing_token)
      values ('mock', 'evt-crashed', 'payment.succeeded', 'deadbeef',
              now() - interval '1 second', gen_random_uuid())
    `;

    const res = await signedCallback({ order_id: 'ord-crash', event_id: 'evt-crashed' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true });

    const rows = await db`select status from orders where id = 'ord-crash'`;
    expect(rows[0]?.status).toBe('paid');
    const w = await db`
      select result, processed_at from webhook_events where event_id = 'evt-crashed'
    `;
    expect(w[0]?.result).toBe('paid');
    expect(w[0]?.processed_at).not.toBeNull();
  });
});
