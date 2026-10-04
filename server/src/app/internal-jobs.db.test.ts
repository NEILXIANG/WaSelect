/**
 * 职责：`POST /internal/jobs/daily` 与每日对账 job 的接线级真库用例（I1-U7b，欠账①）。
 *
 * @why 这个端点是"欠账①（致命级）"的兑现：没有它，三类账务异常（漏 void 的在途支付 /
 *      两本账不符 / 待人工回调）只能躺在库里没人知道。测试必须证明的是**接线**——
 *      密钥对才放行、202 之后 job 真的跑了、异常真的被扫出来落 error 日志、
 *      心跳真的写到 job_runs('daily')——而不是只证明"路由返回 202"。
 *
 * @why job 的扫描逻辑与端点在同文件测：三类异常各造一行脏数据，一次触发全部命中——
 *      分开两个文件只是多一遍装配，没有任何新信号。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { loginAttemptKey } from '../adapters/admin-auth.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { registerBusinessEventLog } from './business-events.js';
import { createInflightJobs, type InflightJobs } from './inflight-jobs.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import type { Clock } from '../ports/clock.js';
import { seedCreatedOrder } from '../../../test/helpers/seed-order.js';
import {
  RESULT_LATE_PAYMENT,
  RESULT_MISMATCH_PREFIX,
  RESULT_STATUS_CONFLICT,
} from './webhook-results.js';
import { RECONCILE_IDS_CAP } from './daily-reconciliation.js';

let db: Db;
const JOB_SECRET = 'internal-job-secret-'.padEnd(40, 'x');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(opts: {
  withSecret: boolean;
  /** OPS3-05：停在途作业的表（生产由 main.ts 装配并交给停机流）。 */
  inflightJobs?: InflightJobs | undefined;
  /** F10：注入时钟。不传 = 用 mount 的默认（`systemClock`），与生产同形。 */
  clock?: Clock | undefined;
}): Promise<{
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
    JWT_SECRET: 'internal-jobs-test-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(opts.withSecret ? { INTERNAL_JOB_SECRET: JOB_SECRET } : {}),
  });
  const app = createHttpApp({
    logger,
    mount: (a) => {
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events,
        storage: createMemoryStorage(),
        ...(opts.inflightJobs !== undefined ? { inflightJobs: opts.inflightJobs } : {}),
        ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, sink, close: server.close };
}

function trigger(url: string, secret?: string): Promise<Response> {
  return fetch(`${url}/api/v1/internal/jobs/daily`, {
    method: 'POST',
    headers: secret !== undefined ? { 'x-internal-job-secret': secret } : {},
  });
}

/**
 * 等每日作业落定——盯 `job_runs('daily')` 心跳（D-45：那是生产上唯一的事后可观测出口）。
 *
 * @why 不用"测试钩子去 await 那个 Promise"：那会在生产模块里留下测试专用导出与
 *      模块级状态（同进程的第二个 bootstrap 会覆盖它，还会让人误以为端点只跑一次）。
 *      盯心跳顺带证明"事后核实的出口"真的存在——这正是 cron 调用方唯一能看的东西。
 */
async function waitForDailyHeartbeat(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // ⚠️ 判据用 `last_processed` 而不是 `last_success_at`：beforeEach 会给 tick/daily
    //    两行造"健康心跳"（last_success_at = now()），否则看门狗会在每条用例里乱叫——
    //    于是"等 last_success_at 出现"会**立刻返回**，等到的其实是基线而不是本轮。
    //    `last_processed` 是每轮必写的本轮产物（零异常时写 0），基线把它清成 null。
    const rows = await db`select last_processed from job_runs where name = 'daily'`;
    // 行不存在也必须继续等：否则"心跳行还没被 upsert 出来"会被误判成"作业已落定"（假绿）
    if (rows[0] !== undefined && rows[0].last_processed !== null) {
      return;
    }
    if (Date.now() > deadline) throw new Error('每日作业未在超时内留下心跳（job_runs daily）');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 造三类异常各一行（配合 seedCreatedOrder 造的'created'单做对照组）。 */
async function seedAnomalies(): Promise<{ danglingPaymentId: string; paidOrderId: string }> {
  // ① 漏 void 的在途支付：单已 expired，支付行还 initiated
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values ('o-recon-expired', 'W-RECON-1', 'u-recon', 'expired', 1000, 0, 0, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', now() - interval '1 hour')
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values ('pay-recon-dangling', 'o-recon-expired', 'mock', 'mock_ref_1', 'initiated', 'JPY', 1000)
  `;
  // ② 两本账不符：单 paid 但支付行还 initiated（正常路径 mark-paid 会同事务封口）
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values ('o-recon-mismatch', 'W-RECON-2', 'u-recon', 'paid', 1000, 0, 0, 1000, 500,
            '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values ('pay-recon-mismatch', 'o-recon-mismatch', 'mock', 'mock_ref_2', 'initiated', 'JPY', 1000)
  `;
  // ③ 待人工回调异常：近 48h 内三种**管线真的会写**的 result（词表见 app/webhook-results.ts）。
  //    ⚠️ 曾经这里塞的是 'needs_refund'——管线从未写过这个值，对账 SQL 却只认它：同义反复的假绿
  //    （全量审计 2026-09-26 P0）。现在取值必须来自词表常量，管线与对账改词时这里跟着变。
  await db`
    insert into webhook_events (event_id, provider, event_type, result)
    values ('evt-recon-late', 'mock', 'payment.succeeded', ${RESULT_LATE_PAYMENT}),
           ('evt-recon-conflict', 'mock', 'payment.succeeded', ${RESULT_STATUS_CONFLICT}),
           ('evt-recon-mismatch', 'mock', 'payment.succeeded', ${RESULT_MISMATCH_PREFIX + 'amount_mismatch'}),
           ('evt-recon-noise', 'mock', 'payment.expired', 'ignored:expired')
  `;
  return { danglingPaymentId: 'pay-recon-dangling', paidOrderId: 'o-recon-mismatch' };
}

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-recon', 'o-recon')`;
  // job_runs 被刻意排除在 resetTestDb 的 truncate 外（D-45：看门狗要读心跳）——
  // 所以心跳探针状态必须显式复位，否则上一条用例的成功会"遗传"给下一条
  await db`
    update job_runs
       set last_success_at = null, last_error = null, last_processed = null
     where name = 'daily'
  `;
  // 心跳看门狗（第四类异常）的**健康基线**：本文件多数用例要的是"其它三类"的断言，
  // 若两行心跳是脏的，每条用例都会额外飘出 stalled_heartbeats。
  // ⚠️ 反过来这也说明看门狗真的在跑——把它调坏的那条用例（见下）就是它的红灯证明。
  await db`
    update job_runs set last_success_at = now(), last_error = null where name in ('tick', 'daily')
  `;
});

describe('POST /internal/jobs/daily（D-43 / D-45）', () => {
  it('密钥正确 → 202 {run_id, started_at}；异步执行真的跑完且心跳写进 job_runs(daily)', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { run_id: string; started_at: string };
      expect(body.run_id.length).toBeGreaterThan(0);
      expect(body.started_at.length).toBeGreaterThan(0);

      await waitForDailyHeartbeat();
      // 心跳：daily 行必须留下成功时间（D-45："跑没跑完看 job_runs，不看响应"）
      const runs = await db`
        select last_success_at, last_error, last_processed from job_runs where name = 'daily'
      `;
      expect(runs[0]?.last_success_at).not.toBeNull();
      expect(runs[0]?.last_error).toBeNull();
      // 012：扫出什么也要进心跳行——0 条异常是"好消息"，不是"没上报"（NULL ≠ 0）
      expect(runs[0]?.last_processed).toBe(0);
      // 零异常时只有一行 info 汇总（没有新闻就是最好的新闻）
      const summary = srv.sink.find('daily_reconciliation');
      expect(summary).toHaveLength(1);
      expect(summary[0]?.['result']).toBe('ok');
      expect(srv.sink.find('reconciliation_anomaly')).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  /**
   * 🔴 OPS3-05：daily 作业 202 之后在进程里跑——它**不是** HTTP 请求（排空等不到），
   * 也不是已 publish 的事件（事件 drain 等不到）。句柄必须交到登记表里，
   * 否则部署窗口内触发的那一轮会被 `closeDb` 拦腰截断：整轮回滚、当天不再跑，
   * 要等 26 小时后的看门狗才报得出来。
   */
  it('🔴 202 之后作业登记进停机等待表，跑完即摘（OPS3-05）', async () => {
    const jobs = createInflightJobs();
    const srv = await buildServer({ withSecret: true, inflightJobs: jobs });
    try {
      expect(jobs.pending).toBe(0);
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      // ⚠️ 关键：响应已经回来了，但作业还在跑——此时登记表里必须有它
      expect(jobs.pending).toBe(1);

      await expect(jobs.wait(10_000)).resolves.toEqual({ settled: true, pending: 0 });
      expect(jobs.pending).toBe(0);
      await waitForDailyHeartbeat();
    } finally {
      await srv.close();
    }
  });

  it('密钥错误 / 缺失 → 401，job 不执行（job_runs 不动）', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const wrong = await trigger(srv.url, 'wrong-secret');
      expect(wrong.status).toBe(401);
      const none = await trigger(srv.url);
      expect(none.status).toBe(401);
      // 判据同 waitForDailyHeartbeat：看**本轮产物** `last_processed` 仍为 null
      // （基线给 last_success_at 造了健康心跳，不能再拿它当"没执行"的判据）
      const runs = await db`select last_processed from job_runs where name = 'daily'`;
      expect(runs[0]?.last_processed).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('未配置 INTERNAL_JOB_SECRET → 50000（响亮拒绝），reason 只进日志不外发', async () => {
    const srv = await buildServer({ withSecret: false });
    try {
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(500);
      // 5xx details 不外发：对外统一"服务器内部错误"（线上区分"没配密钥"的唯一依据是日志）
      await expect(res.json()).resolves.toMatchObject({ code: 50000 });
      const refused = srv.sink.find('internal_job_disabled');
      expect(refused).toHaveLength(1);
      expect(JSON.stringify(refused[0])).toContain('INTERNAL_JOB_SECRET');
      // 匿名（不带头）请求即使在未配密钥时也只是 40101，不得刷出 error 日志（公网无限流路径）
      const anon = await fetch(`${srv.url}/api/v1/internal/jobs/daily`, { method: 'POST' });
      expect(anon.status).toBe(401);
      expect(srv.sink.find('internal_job_disabled')).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  /**
   * SEC2-04：本路由**无鉴权、无限流**，而"未配密钥"曾经是在**每个**带
   * `x-internal-job-secret` 头的请求上打一条 error 级日志——头的值任意即可，
   * 于是任何人都能持续刷 error 与告警。配置缺口与请求量无关，就该只记一次。
   *
   * @why 断言"连打 5 次仍然只有 1 条"而不是"没有日志"：**完全不记**会让
   *      "生产上忘了配密钥"变成静默（daily 作业永远不跑、没人知道）。
   *      要的是"只响一次"，不是"不响"。
   */
  it('🔴 未配密钥时用任意请求头连打 5 次：仍是 50000，但 internal_job_disabled 只有装配期那 1 条（SEC2-04）', async () => {
    const srv = await buildServer({ withSecret: false });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await fetch(`${srv.url}/api/v1/internal/jobs/daily`, {
          method: 'POST',
          headers: { 'x-internal-job-secret': `whatever-${String(i)}` },
        });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([500, 500, 500, 500, 500]);
      expect(srv.sink.find('internal_job_disabled')).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it('回调异常回看窗口边界：47h 内计入 / 49h 外不计（窗口下界来自注入时钟）', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      // 两条同类型异常，只差在 received_at：一条卡在窗口内（47h）、一条刚好在窗口外（49h）。
      // result 必须取词表里**管线真的会写**的值（app/webhook-results.ts）：`needs_refund`
      // 从未被任何路径写入，过滤条件也不再认它（全量审计 2026-09-26 P1-1）。
      // @why 单独一条用例而不是塞进上面那条：窗口边界此前**完全没有被测**
      //       （上面那条只种了 now() 的样本，窗口写成 1 小时它也是绿的）——
      //       这类"参数只在 SQL 里出现、没人钉边界"的常量，最容易被人悄悄改错。
      await db`
        insert into webhook_events (event_id, provider, event_type, result, received_at)
        values ('evt-in-47h',  'mock', 'payment.succeeded', ${RESULT_LATE_PAYMENT}, now() - interval '47 hours'),
               ('evt-out-49h', 'mock', 'payment.succeeded', ${RESULT_LATE_PAYMENT}, now() - interval '49 hours')
      `;
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();

      const cb = srv.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'callback_anomalies_48h');
      expect(cb, '窗口内有一条就该报这一类').toBeDefined();
      const ctx = cb?.['ctx'] as Record<string, unknown> | undefined;
      expect(ctx?.['count']).toBe(1); // 只有 47h 那条，49h 那条必须被窗口排除
      const ids = JSON.stringify(ctx?.['sample_ids']);
      expect(ids).toContain('evt-in-47h');
      expect(ids).not.toContain('evt-out-49h');
    } finally {
      await srv.close();
    }
  });

  /**
   * 🔴 计数**不受取样截断影响**：`count` 是满足判据的全部行数，`sample_ids` 才截到 CAP。
   *
   * @why 这条专门针对"取样 + 计数"的实现形态。旧实现是两条 SQL（各写一份 WHERE），
   *      改成 `count(*) over ()` 一条语句之后，**新写法成立的前提**是窗口函数在
   *      `limit` **之前**求值——若哪天有人把 `total` 换成 `count(取样后的行)`，
   *      报告会在积压时说"共 20 条"（实际 25 条），而"20"看起来完全合理，
   *      没有任何报错。
   * @why 用 **25 > CAP(20)** 这个量级而不是刚好卡边界：卡边界时"多算一条/少算一条"
   *      的差异容易被误读成 off-by-one，越过 CAP 才是"截断有没有生效"的判据。
   */
  it('🔴 异常数超过取样上限：count 报全部命中数，sample_ids 才截到 CAP', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const total = RECONCILE_IDS_CAP + 5;
      for (let i = 0; i < total; i += 1) {
        await db`
          insert into webhook_events (event_id, provider, event_type, result, received_at)
          values (${`evt-bulk-${String(i).padStart(2, '0')}`}, 'mock', 'payment.succeeded',
                  ${RESULT_LATE_PAYMENT}, now() - interval '1 hour')
        `;
      }
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();

      const cb = srv.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'callback_anomalies_48h');
      const ctx = cb?.['ctx'] as Record<string, unknown> | undefined;
      expect(ctx?.['count']).toBe(total); // ← 截断只影响取样，不影响计数
      const ids = ctx?.['sample_ids'] as unknown[] | undefined;
      expect(ids).toHaveLength(RECONCILE_IDS_CAP);
    } finally {
      await srv.close();
    }
  });

  it('退款滞留（F-03，AJ-178）：refunding 超过 24h 报 stuck_refunds；23h 不报；缺事件按 updated_at 兜底', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const refundingOrder = (id: string, no: string, updatedAgo: string) => db`
        insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                            total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                            expires_at, updated_at)
        values (${id}, ${no}, 'u-recon', 'refunding', 1000, 0, 0, 1000, 500,
                '{}'::jsonb, '{}'::jsonb, 'T', now(), now() - ${updatedAgo}::interval)`;
      await refundingOrder('o-refund-stuck', 'W-RF-1', '1 minute'); // updated_at 新，但事件是 25h 前
      await refundingOrder('o-refund-fresh', 'W-RF-2', '1 minute');
      await refundingOrder('o-refund-noevent', 'W-RF-3', '30 hours');
      await db`
        insert into order_events (order_id, status, note, actor, at)
        values ('o-refund-stuck', 'refunding', '缺货', 'admin:u-admin', now() - interval '25 hours'),
               ('o-refund-fresh', 'refunding', '缺货', 'admin:u-admin', now() - interval '23 hours')`;

      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();
      const hit = srv.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'stuck_refunds');
      expect(hit, 'refunding 超过 24h 必须报出').toBeDefined();
      const ctx = hit?.['ctx'] as Record<string, unknown> | undefined;
      expect(ctx?.['count']).toBe(2);
      const ids = JSON.stringify(ctx?.['sample_ids']);
      expect(ids).toContain('o-refund-stuck');
      expect(ids).toContain('o-refund-noevent');
      expect(ids).not.toContain('o-refund-fresh');
    } finally {
      await srv.close();
    }
  });

  it('每日作业含自动签收 / 自动完成（O-12 / AJ-182 接线）：31 天前发货的单被签收，且排在对账之前', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      await db`
        insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                            total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                            expires_at, shipped_at)
        values ('o-auto-deliver', 'W-AD-1', 'u-recon', 'shipped', 1000, 0, 0, 1000, 500,
                '{}'::jsonb, '{}'::jsonb, 'T', now() - interval '40 days', now() - interval '31 days')`;
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();
      const [o] = await db`select status from orders where id = 'o-auto-deliver'`;
      expect(o?.['status']).toBe('delivered');
      const order = srv.sink.rows().map((r) => String(r.event));
      const iDeliver = order.indexOf('orders_auto_delivered');
      const iComplete = order.indexOf('orders_auto_completed');
      const iRecon = order.indexOf('daily_reconciliation');
      expect(iDeliver).toBeGreaterThanOrEqual(0);
      expect(iDeliver).toBeLessThan(iComplete);
      expect(iComplete).toBeLessThan(iRecon);
    } finally {
      await srv.close();
    }
  });

  /**
   * A1+B14 的收尾（AJ-187）：`login_attempts` 是一张**由攻击者决定行数**的表
   * （不存在的邮箱被试探也会留一行），不清就是一条"某天磁盘告警但没人知道为什么"的伏笔。
   * @why 钉的是"清了什么、留了什么"：**还在锁里的行必须留**——清掉它等于给人一条
   *      "连错 5 次、等一天就能重来"的捷径，锁的语义会被清理作业悄悄抹掉。
   */
  it('每日作业含登录尝试清理（AJ-187）：过期且已解锁的删，还在锁里的留', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const stale = loginAttemptKey('stale@example.com');
      const locked = loginAttemptKey('locked@example.com');
      await db`
        insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
        values (${stale}, 2, null, now() - interval '30 hours', now() - interval '30 hours'),
               (${locked}, 0, now() + interval '10 minutes', now() - interval '30 hours',
                now() - interval '30 hours')`;
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();

      const left = await db`select key_hash from login_attempts order by key_hash`;
      expect(left.map((r) => String(r.key_hash))).toEqual([locked]);
      const cleanup = srv.sink.find('login_attempts_cleanup');
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]?.['count']).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('心跳看门狗（AJ-102 承诺的替代方案）：tick 从未成功 → 报 stalled_heartbeats', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      // 把 tick 打回"从未成功"（last_success_at = null）：常驻调度器起不来的形态
      await db`update job_runs set last_success_at = null where name = 'tick'`;
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();

      const stalled = srv.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'stalled_heartbeats');
      expect(stalled, 'tick 没有成功心跳必须被看门狗报出来').toBeDefined();
      const ctx = stalled?.['ctx'] as Record<string, unknown> | undefined;
      expect(ctx?.['count']).toBe(1);
      expect(JSON.stringify(ctx?.['sample_ids'])).toContain('tick');
      // daily 行是健康的（beforeEach 造的），不该被连带报出
      expect(JSON.stringify(ctx?.['sample_ids'])).not.toContain('daily');
    } finally {
      await srv.close();
    }
  });

  it('心跳看门狗边界：daily 停滞（30h 前）报出；daily 为 null（首次）不报', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      // ① daily 上一次成功在 30 小时前 → 超过 26h 阈值 → 报
      await db`
        update job_runs
           set last_success_at = now() - interval '30 hours'
         where name = 'daily'
      `;
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();
      const ctx1 = srv.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'stalled_heartbeats')?.[
        'ctx'
      ] as Record<string, unknown> | undefined;
      expect(ctx1, 'daily 超过 26h 没成功心跳应报').toBeDefined();
      expect(JSON.stringify(ctx1?.['sample_ids'])).toContain('daily');
    } finally {
      await srv.close();
    }

    // ② daily 为 null（首次运行，本轮就要写它）→ **不报**（否则"第一次跑必定报警"）
    const srv2 = await buildServer({ withSecret: true });
    try {
      // ⚠️ `last_processed` 也要清：它是 waitForDailyHeartbeat 的判据，① 刚写过一轮，
      //    不清则 ② 的等待**立刻返回**（等到的是 ① 的产物），srv2 关掉时作业还在跑，
      //    它的心跳会落到下一条用例的 beforeEach 之后——下一条用例的等待也跟着假返回
      //    （实测：紧随其后的"三类异常各一行"sink 里只有 2 行 http 日志、0 条 anomaly）。
      await db`
        update job_runs set last_success_at = null, last_processed = null where name = 'daily'
      `;
      await db`update job_runs set last_success_at = now() where name = 'tick'`;
      const res = await trigger(srv2.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();
      const stalled = srv2.sink
        .find('reconciliation_anomaly')
        .find((r) => (r['ctx'] as Record<string, unknown>)?.['class'] === 'stalled_heartbeats');
      expect(stalled, 'daily 首跑（null）不该被当成停滞').toBeUndefined();
    } finally {
      await srv2.close();
    }
  });

  it('三类异常各一行 → 全部扫出：三条 error 取样 + 汇总行计数 + processed 进日志', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      await seedAnomalies();
      // 对照组：一张正常的在途单（created + initiated 支付）**不该**被误报
      await seedCreatedOrder(db, 'o-recon-normal', { userId: 'u-recon' });
      await db`
        insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
        values ('pay-recon-normal', 'o-recon-normal', 'mock', 'mock_ref_3', 'initiated', 'JPY', 1000)
      `;

      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      await waitForDailyHeartbeat();

      const anomalies = srv.sink.find('reconciliation_anomaly');
      expect(anomalies).toHaveLength(3);
      const classes = anomalies.map((r) =>
        String((r['ctx'] as Record<string, unknown>)?.['class']),
      );
      expect(classes).toEqual([
        'dangling_initiated_payments',
        'paid_without_succeeded_payment',
        'callback_anomalies_48h',
      ]);
      // 取样里有真凶、没有对照组
      const payload = JSON.stringify(anomalies);
      expect(payload).toContain('pay-recon-dangling');
      expect(payload).toContain('o-recon-mismatch');
      expect(payload).toContain('evt-recon-late');
      expect(payload).toContain('evt-recon-conflict');
      expect(payload).toContain('evt-recon-mismatch');
      expect(payload).not.toContain('evt-recon-noise');
      expect(payload).not.toContain('pay-recon-normal');
      expect(payload).not.toContain('o-recon-normal');

      const summary = srv.sink.find('daily_reconciliation');
      expect(summary[0]?.['result']).toBe('anomalies_found');
      // 心跳：异常 ≠ 失败——job 本身跑完了（对账发现问题是它的产出，不是它的故障）
      const runs = await db`
        select last_success_at, last_error, last_processed from job_runs where name = 'daily'
      `;
      expect(runs[0]?.last_success_at).not.toBeNull();
      expect(runs[0]?.last_error).toBeNull();
      // 6 = ① 2 + ② 1 + ③ 3，而不是异常类数 3：**① 与 ② 落在同一行上**（pay-recon-mismatch
      // 既是"订单已 paid 而支付行仍 initiated"的悬空支付，又是"paid 但没有 succeeded 支付"的
      // 两本账不符）；③ 种了三种词表 result（噪声行 ignored:expired 不计）——
      // 三类是三个**视角**，不是三个互斥集合，所以 processed（条数之和）≠ 异常类数。
      // 这条断言顺手把"重叠"钉住：将来有人把两类改成互斥，这里会红。
      expect(runs[0]?.last_processed).toBe(6);
    } finally {
      await srv.close();
    }
  });
});

/**
 * SEC-14：注入的时钟必须**贯穿到** daily 端点与它拉起的那一整串作业。
 *
 * @why `mount.ts` 承诺"测试传 `clock` ⇒ 全站时间受控"（`MountContext.clock`），
 *      而这条端点曾经**直接 import `systemClock`**：于是注入时钟时，响应里的 `started_at`
 *      与整串作业（自动签收 / 自动完成的 `afterDays`、对账的 48h 回看窗口）用真钟，
 *      同一进程里其它路由用注入钟 —— **一半一半，且不报任何错**。
 *      这类分叉最危险的地方在于：它只在"有人真的注入了时钟"之后才出现，
 *      而那正是你想把时间钉住去测到期边界的时刻——你以为钉住了，其实没钉住。
 *
 * @limitation 只钉 `started_at` 这一个**可见**出口：`started_at` 是响应体里唯一的时间，
 *      也是"时钟有没有穿透到这条路径"唯一的观测面（作业内部的到期判定要靠种数据才能观测，
 *      那是各作业自己的用例的事）。
 */
describe('SEC-14：daily 端点走注入时钟（不是 systemClock）', () => {
  it('🔴 注入时钟后响应的 started_at 就是那个时刻，不是真实时间', async () => {
    const FIXED = '2026-01-02T12:00:00.000Z';
    const srv = await buildServer({ withSecret: true, clock: fixedClock(FIXED) });
    try {
      const res = await trigger(srv.url, JOB_SECRET);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { run_id: string; started_at: string };
      // 真钟的话这里是"现在"，绝不会等于 2026-01-02（⚠️ 别在注释里写"差了好几年"这类
      // 会随时间失真的具体量：只说"不等于"，它永远成立）
      expect(body.started_at).toBe(FIXED);
      // run_id 仍来自真 uuid：注入的 idGen 返回固定串，拿它当 runId 会让两轮作业撞键
      expect(body.run_id).not.toBe('');
    } finally {
      await srv.close();
    }
  });
});
