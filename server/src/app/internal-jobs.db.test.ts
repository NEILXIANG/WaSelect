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
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { registerBusinessEventLog } from './business-events.js';
import { seedCreatedOrder } from '../../../test/helpers/seed-order.js';

let db: Db;
const JOB_SECRET = 'internal-job-secret-'.padEnd(40, 'x');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(opts: { withSecret: boolean }): Promise<{
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
      mountAllRoutes(a, { config, logger, db, events });
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
    const rows =
      await db`select last_success_at, last_error, last_processed from job_runs where name = 'daily'`;
    // 行不存在也必须继续等：否则"心跳行还没被 upsert 出来"会被误判成"作业已落定"（假绿）
    if (
      rows[0] !== undefined &&
      (rows[0].last_success_at !== null || rows[0].last_error !== null)
    ) {
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
  // ③ 待人工回调异常：近 48h 一条 needs_refund
  await db`
    insert into webhook_events (event_id, provider, event_type, result)
    values ('evt-recon-late', 'mock', 'payment.succeeded', 'needs_refund')
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

  it('密钥错误 / 缺失 → 401，job 不执行（job_runs 不动）', async () => {
    const srv = await buildServer({ withSecret: true });
    try {
      const wrong = await trigger(srv.url, 'wrong-secret');
      expect(wrong.status).toBe(401);
      const none = await trigger(srv.url);
      expect(none.status).toBe(401);
      const runs = await db`select last_success_at from job_runs where name = 'daily'`;
      expect(runs[0]?.last_success_at).toBeNull();
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
    } finally {
      await srv.close();
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
      // 4 而不是 3：**① 与 ② 落在同一行上**（pay-recon-mismatch 既是"订单已 paid 而支付行
      // 仍 initiated"的悬空支付，又是"paid 但没有 succeeded 支付"的两本账不符）——
      // 三类是三个**视角**，不是三个互斥集合，所以 processed（条数之和）≠ 异常类数（3）。
      // 这条断言顺手把"重叠"钉住：将来有人把两类改成互斥，这里会红。
      expect(runs[0]?.last_processed).toBe(4);
    } finally {
      await srv.close();
    }
  });
});
