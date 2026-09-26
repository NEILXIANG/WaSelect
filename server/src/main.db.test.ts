/**
 * 职责：组装根的 L1 集成测试（A1）——用**真库**跑 `bootstrap()`，证明生产入口真的能起来。
 *
 * @why A1 之前的状况是"测试 harness 拼了一遍依赖、生产没有入口"。
 *      这个文件的存在意义就是让"组装"这件事**有测试**：
 *      少配一个中间件、回调路径忘了登记、停机顺序写反，都会在这里红，
 *      而不是等到 Render 上"部署成功但健康检查超时"才发现。
 *
 * @limitation 走 db project（串行）：bootstrap 会占用固定端口，并行会撞端口。
 *             端口在测试里显式分配，不用 0——`PORT` 的 schema 下限是 1（0 会被判非法）。
 * @limitation 真信号投递（OS → Node 回调）那一层由 http.unit.test.ts（模拟投递形状）
 *             与 dist-boot.e2e.test.ts（真发 SIGTERM 给产物）覆盖，这里不发真信号；
 *             但停机用例会**断言退出码是 0**——"信号编号漏进退出码"这类缺陷在装配层
 *             看得见，不该只留给产物级用例去抓（2026-09-23 实抓一次）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, connect, type Server as NetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { loadConfig } from './config.js';
import { bootstrap, shouldMountSkeleton, type Runtime } from './main.js';
import { signToken } from './app/auth.js';
import { PAY_CALLBACK_PREFIX, PAY_CHANNELS_PATH } from './app/pay-routes.js';
import { recordPaymentIntent } from './app/payment-intent.js';
import type { Db } from './adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../test/db/test-db.js';
import { emitRealSignal } from '../../test/signal-harness.js';

/** 组装根测试专用端口（与 e2e 的 0 端口不冲突；db project 串行，彼此也不撞）。 */
const PORT_DEV = 4611;
const PORT_PROD = 4612;

function baseEnv(port: number): Record<string, string> {
  return {
    NODE_ENV: 'development',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: 'main-test-jwt-secret-'.repeat(3),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-TEST-1',
    // N7 默认 5s 会拖慢全部停机用例；测试统一压到 50ms（专门测等待的那条自己覆盖）
    SHUTDOWN_READY_DELAY_MS: '50',
  };
}

/** 收日志用的极简 sink（比 MemorySink 轻：这里只关心有没有那几行）。 */
function sink(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

beforeAll(async () => {
  await ensureTestDb();
}, 30_000);

describe('组装根 bootstrap（A1）', () => {
  it('能起来、探活 200、并把密钥脱敏后落一条启动日志', async () => {
    const { lines, write } = sink();
    let rt: Runtime | undefined;
    try {
      rt = await bootstrap({
        env: baseEnv(PORT_DEV),
        logDestination: { write },
        exit: () => undefined,
      });
      const res = await fetch(`http://127.0.0.1:${PORT_DEV}/healthz`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: 'ok' });

      // 启动日志必须存在，且密钥必须是掩码（泄露 JWT_SECRET 是最贵的一类事故）
      const configLine = lines.find((l) => l.includes('config_loaded'));
      expect(configLine).toBeDefined();
      expect(configLine).toContain('"JWT_SECRET":"***"');
      expect(configLine).not.toContain('main-test-jwt-secret');
      expect(lines.some((l) => l.includes('server_started'))).toBe(true);
    } finally {
      rt?.uninstallSignals();
      rt?.uninstallProcessErrors();
      await rt?.server.close().catch(() => undefined);
      await rt?.db.end().catch(() => undefined);
    }
  });

  it('停机是「排空后关库」：afterDrain 之后连接池真的关了', async () => {
    const { write } = sink();
    const rt = await bootstrap({
      env: baseEnv(PORT_DEV),
      logDestination: { write },
      // 只注入退出函数，不让 finish() 真的去 process.exit（会把 vitest 一起带走）
      exit: () => undefined,
    });
    try {
      // 停之前：库可用
      await expect(rt.db`select 1 as ok`).resolves.toBeDefined();
      await rt.server.close();
      // 手动走一段 afterDrain 的语义：bootstrap 里挂的就是 closeDb
      await (async () => {
        const { closeDb } = await import('./adapters/db.js');
        await closeDb(rt.db);
      })();
      // 停之后：连接已关，再查必然抛错——这证明"关库"真的发生了
      await expect(rt.db`select 1 as ok`).rejects.toThrow();
    } finally {
      rt.uninstallSignals();
      rt.uninstallProcessErrors();
    }
  });

  /**
   * 骨架挂载策略单独断言（不启服务）。
   * @why 生产分支没法靠"启一个生产服务"来验证：生产的跨字段规则会拒绝指向 localhost
   *      的 DATABASE_URL，而测试库只能是本机的。所以策略抽成 `shouldMountSkeleton()`
   *      单独测，再配一条 staging 用例证明"非生产确实挂上了"。
   */
  it('骨架挂载策略：仅生产不挂', () => {
    expect(shouldMountSkeleton('development')).toBe(true);
    expect(shouldMountSkeleton('staging')).toBe(true);
    expect(shouldMountSkeleton('production')).toBe(false);
  });

  it('非生产环境确实挂上了骨架（无 token → 40101，而不是 404 没这个路由）', async () => {
    const { write } = sink();
    let rt: Runtime | undefined;
    try {
      // MOCK_CALLBACK_SECRET：staging + mock 无显式密钥会被规则 3b 拒（公网环境不许回落公开占位值，
      // 见 config.ts 规则 3b / AJ-87）——本条用例验"骨架挂载"与密钥无关，显式给一个测试密钥
      rt = await bootstrap({
        env: {
          ...baseEnv(PORT_PROD),
          NODE_ENV: 'staging',
          MOCK_CALLBACK_SECRET: 'main-db-test-mock-secret',
        },
        logDestination: { write },
        exit: () => undefined,
      });
      const res = await fetch(`http://127.0.0.1:${PORT_PROD}/api/v1/skeleton/orders/whatever`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 40101 });
    } finally {
      rt?.uninstallSignals();
      rt?.uninstallProcessErrors();
      await rt?.server.close().catch(() => undefined);
      await rt?.db.end().catch(() => undefined);
    }
  });

  /**
   * D21：就绪探针必须连着真实依赖，且能被停机摘掉。
   * @why 只验 `/healthz` 是不够的：进程活着但库连不上时，`/healthz` 照样 200，
   *      于是平台继续把下单请求打进来，全部 500——这类"半死不活"的状态只有 /readyz 能表达。
   */
  it('/readyz：库通的时候 200；库关掉之后 503（半死不活的状态必须能表达）', async () => {
    const { write } = sink();
    const rt = await bootstrap({
      env: baseEnv(PORT_DEV),
      logDestination: { write },
      exit: () => undefined,
    });
    try {
      await expect((await fetch(`http://127.0.0.1:${PORT_DEV}/readyz`)).status).toBe(200);

      // 断掉依赖（模拟 DB 抖动）：进程还活着、/healthz 还是 200，但已经不该接新流量了
      await rt.db.end();
      await expect((await fetch(`http://127.0.0.1:${PORT_DEV}/readyz`)).status).toBe(503);
      // 同一时刻 /healthz 必须还是 200——存活探针绑依赖会把 DB 抖动放大成全站重启
      await expect((await fetch(`http://127.0.0.1:${PORT_DEV}/healthz`)).status).toBe(200);
    } finally {
      rt.uninstallSignals();
      rt.uninstallProcessErrors();
      await rt.server.close().catch(() => undefined);
      await rt.db.end().catch(() => undefined);
    }
  });

  it('停机先摘流量：SIGTERM 后 traffic_draining 排在 server_drained 之前', async () => {
    const { lines, write } = sink();
    const rt = await bootstrap({
      env: baseEnv(PORT_DEV),
      logDestination: { write },
      exit: () => undefined,
    });
    // 清掉上一次停机留下的退出码，保证下面的断言只反映**本次**停机
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // 形状与 Node 真实投递一致：(信号名, 信号编号)
      emitRealSignal('SIGTERM');
      // ⚠️ 这里**不能**自己再调 server.close()：那会让停机处理器撞上"已关闭的 server"，
      //    于是它走的是 server_stop_failed 分支，测出来的顺序是假的。
      //    正确做法：等它自己走完。
      for (let i = 0; i < 100 && !lines.some((l) => l.includes('server_stopped')); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const draining = lines.findIndex((l) => l.includes('traffic_draining'));
      const drained = lines.findIndex((l) => l.includes('server_drained'));
      expect(draining).toBeGreaterThanOrEqual(0);
      expect(drained).toBeGreaterThanOrEqual(0);
      expect(draining).toBeLessThan(drained);
      // 正常停机的退出码必须是 0，**不能是信号编号 15**：
      // 生产靠 process.exitCode 自然退出（不调 process.exit，否则会丢日志），
      // 所以这里断言 exitCode 才是与生产一致的判据（注入的 exit 只在 2s 兜底时才被调）。
      await vi.waitFor(() => expect(process.exitCode).toBe(0), { timeout: 1000 });
    } finally {
      process.exitCode = prevExitCode;
      rt.uninstallSignals();
      rt.uninstallProcessErrors();
      await rt.server.close().catch(() => undefined);
      await rt.db.end().catch(() => undefined);
    }
  });

  /**
   * N7 端到端：SIGTERM → /readyz 立刻 503 → **等待窗口内**仍然 503（平台靠它摘流）
   * → 窗口结束后才排空关资源。这条证明配置真的流到了停机流（SHUTDOWN_READY_DELAY_MS → readyDelayMs），
   * 且窗口期 /readyz 的语义正确——这是"平台按 503 优雅摘流"成立的全部前提。
   */
  it('N7：摘流等待窗口内 /readyz 持续 503，窗口结束后才完成停机', async () => {
    const { lines, write } = sink();
    const rt = await bootstrap({
      env: { ...baseEnv(PORT_DEV), SHUTDOWN_READY_DELAY_MS: '400' },
      logDestination: { write },
      exit: () => undefined,
    });
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect((await fetch(`http://127.0.0.1:${PORT_DEV}/readyz`)).status).toBe(200);
      const t0 = performance.now();
      emitRealSignal('SIGTERM');
      // 窗口期（400ms 内）：/readyz 必须已经是 503，且停机还没完成
      await new Promise((r) => setTimeout(r, 120));
      await expect((await fetch(`http://127.0.0.1:${PORT_DEV}/readyz`)).status).toBe(503);
      expect(lines.some((l) => l.includes('server_drained'))).toBe(false);
      // 等它自己走完
      for (let i = 0; i < 200 && !lines.some((l) => l.includes('server_stopped')); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(performance.now() - t0).toBeGreaterThanOrEqual(380);
      expect(lines.some((l) => l.includes('drain_ready_waited'))).toBe(true);
      expect(lines.some((l) => l.includes('server_stopped'))).toBe(true);
      await vi.waitFor(() => expect(process.exitCode).toBe(0), { timeout: 1000 });
    } finally {
      process.exitCode = prevExitCode;
      rt.uninstallSignals();
      rt.uninstallProcessErrors();
      await rt.server.close().catch(() => undefined);
      await rt.db.end().catch(() => undefined);
    }
  });

  /** D21：跨域按配置白名单生效——没配就一个都不放行。 */
  it('CORS_ORIGINS 未配置时不回任何跨域头（默认关闭，不是默认放行）', async () => {
    const { write } = sink();
    let rt: Runtime | undefined;
    try {
      rt = await bootstrap({
        env: baseEnv(PORT_DEV),
        logDestination: { write },
        exit: () => undefined,
      });
      const res = await fetch(`http://127.0.0.1:${PORT_DEV}/api/v1/admin/orders`, {
        method: 'OPTIONS',
        headers: { origin: 'https://any.example.com', 'access-control-request-method': 'GET' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      rt?.uninstallSignals();
      rt?.uninstallProcessErrors();
      await rt?.server.close().catch(() => undefined);
      await rt?.db.end().catch(() => undefined);
    }
  });

  it('配置不合法时启动失败，且不会留下没关的连接池（否则进程挂住、端口还占着）', async () => {
    const { write } = sink();
    const bad = { ...baseEnv(PORT_PROD), JWT_SECRET: 'short' };
    await expect(
      bootstrap({ env: bad, logDestination: { write }, exit: () => undefined }),
    ).rejects.toThrow(/配置校验失败|JWT_SECRET/);
  });
});

afterAll(() => {
  // 保险：任何一条用例漏了 uninstall，这里兜住，避免污染其它测试文件的信号监听器计数
  expect(process.listeners('SIGTERM').length).toBeLessThanOrEqual(1);
});

/**
 * 配置驱动的通道下线（二次审查 P1-NEW-1 的**链路级**证明）。
 *
 * @why e2e harness 的 `mockRegistry(enabled)` 手工构造注册表，**绕过了
 *      `buildPaymentRegistry`**——而二次审查批次 A 改的恰恰是这个函数
 *      （配置 → listed 集合 → enabled 派生 → offline 清单 → mock 例外）。
 *      单测证明装配函数本身，e2e 证明注册表下游；唯有走**真 bootstrap**
 *      （真 loadConfig + 真装配 + 真路由 + 真库）才能证明"运维改配置重启"
 *      这个动作在真实链路上的完整效果。这是"各件各自绿、拼起来有缝"的
 *      典型盲区，本 describe 把它钉死。
 */
describe('配置驱动的通道下线（P1-NEW-1 链路级证明）', () => {
  const PORT_LINK = 4613;
  const MOCK_SECRET = 'main-db-offline-mock-secret';
  const LINK_USER = 'u-link';
  let db: Db;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetTestDb(db);
    await db`insert into users (id, openid) values (${LINK_USER}, 'o-link') on conflict (id) do nothing`;
  });

  /** 与装配处的 JWT 配置同源（app/mount.ts: issuer 写死 'waselect'，secret 来自 env；I1-U1 起装配在 mount.ts）。 */
  function linkToken(env: Record<string, string>): Promise<string> {
    return signToken(
      { sub: LINK_USER, role: 'user' },
      { secret: env.JWT_SECRET as string, issuer: 'waselect' },
    );
  }

  /**
   * 与 test/e2e/harness.ts 的 signMockCallback 同一算法（HMAC-SHA256 hex）。
   * 不跨层 import：e2e 可以依赖 db 层 helper，反过来会把层次倒置。
   */
  function sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  }

  async function shutdown(rt: Runtime | undefined): Promise<void> {
    rt?.uninstallSignals();
    rt?.uninstallProcessErrors();
    await rt?.server.close().catch(() => undefined);
    await rt?.db.end().catch(() => undefined);
  }

  async function createOrder(port: number, env: Record<string, string>): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/skeleton/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await linkToken(env)}`,
        'content-type': 'application/json',
        'idempotency-key': `link-${randomUUID()}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { order_id: string }).order_id;
  }

  function channelsUrl(port: number): string {
    return `http://127.0.0.1:${port}${PAY_CHANNELS_PATH}?country=US&currency=JPY&amount_jpy=10000`;
  }

  it('通道从 PAYMENT_CHANNELS 删掉 → 入口消失；在途回调仍落账（含启动日志三清单）', async () => {
    // ── 服务 A：mock 在列（PAYMENT_CHANNELS=mock，来自 baseEnv）──
    const envA = { ...baseEnv(PORT_LINK), MOCK_CALLBACK_SECRET: MOCK_SECRET };
    let rt = await bootstrap({
      env: envA,
      logDestination: { write: () => undefined },
      exit: () => undefined,
    });
    let orderId = '';
    try {
      await expect((await fetch(channelsUrl(PORT_LINK))).json()).resolves.toEqual({
        // icon 来自 CHANNEL_DEFAULTS——e2e harness 的手工注册表没配 icon，
        // 这条断言正是"真装配 vs 手工装配"漂移的探测器，不要随手删掉它
        items: [{ channel: 'mock', entryMode: 'in_app', icon: 'flask', label: '模拟支付' }],
      });
      // 在途支付：单是通道下线**之前**建的
      orderId = await createOrder(PORT_LINK, envA);
    } finally {
      await shutdown(rt);
    }

    // ── 服务 B：mock 从 PAYMENT_CHANNELS 删掉（PAYMENT_CHANNELS=stripe 占位，
    //    但 stripe 密钥不全被静默跳过；mock 凭显式密钥保留下线注册）──
    const { lines, write } = sink();
    rt = await bootstrap({
      env: { ...envA, PAYMENT_CHANNELS: 'stripe' },
      logDestination: { write },
      exit: () => undefined,
    });
    try {
      // ① 入口消失：mock 已下线、stripe 未注册 → 空列表（前端显示"暂无可用支付方式"，不是报错）
      await expect((await fetch(channelsUrl(PORT_LINK))).json()).resolves.toEqual({ items: [] });

      // ② 启动日志三清单并列（批次 A 新增）：configured / registered / offline 各自有含义，
      //    "下线通道的在途订单还活着"是运营事实，必须在日志里可见
      const regLine = lines.find((l) => l.includes('payment_channels_registered'));
      expect(regLine).toBeDefined();
      expect(regLine).toContain('"configured":["stripe"]');
      expect(regLine).toContain('"registered":["mock"]');
      expect(regLine).toContain('"offline":["mock"]');

      // ③ 在途回调照样落账——钱不能因为运维改配置而丢
      //    ⚠️ 先登记支付意图（走**真函数**而不是裸 SQL）：落账必须核对
      //    "这笔单本来打算在哪个通道、按什么金额收"（AJ-93 的 S1② / U1）。
      //    少了这一行，回调会以 settlement_unverifiable 被拒——那不是缺陷，正是那条防线的目的：
      //    "通道下线"这个运维动作不能顺带把"核对"也关掉。
      await recordPaymentIntent(db, {
        id: randomUUID(),
        orderId,
        provider: 'mock',
        providerRef: 'cs_1',
        chargeCurrency: 'JPY',
        chargeAmount: 1000,
      });
      //    同时回调必须带 currency / amount_minor：落账要拿它跟上面登记的意图对一遍（AJ-93 的 U1）。
      //    ⚠️ 少了这两个字段会以 settlement_unverifiable 被拒——机构没报金额就是核对不了，
      //    这时宁可不落账 + 告警，也不能"相信回调里的订单号就置 paid"。
      const body = JSON.stringify({
        event_id: 'evt-link-offline',
        type: 'payment.succeeded',
        order_id: orderId,
        provider_ref: 'cs_1',
        currency: 'JPY',
        amount_minor: 1000,
      });
      const res = await fetch(`http://127.0.0.1:${PORT_LINK}${PAY_CALLBACK_PREFIX}/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': sign(body, MOCK_SECRET),
        },
        body,
      });
      expect(res.status).toBe(200);
      const rows = await db`select status from orders where id = ${orderId}`;
      expect(rows[0]?.status).toBe('paid');
      const events =
        await db`select status from order_events where order_id = ${orderId} order by id`;
      expect(events.map((r) => r.status)).toEqual(['created', 'paid']);
    } finally {
      await shutdown(rt);
    }
  });

  it('mock 未列出且未显式配密钥 → 不注册（公开占位值不能开门）：回调 40001，零留痕', async () => {
    const env = { ...baseEnv(PORT_LINK), PAYMENT_CHANNELS: 'stripe' }; // 刻意不给 MOCK_CALLBACK_SECRET
    const rt = await bootstrap({
      env,
      logDestination: { write: () => undefined },
      exit: () => undefined,
    });
    try {
      await expect((await fetch(channelsUrl(PORT_LINK))).json()).resolves.toEqual({ items: [] });
      const orderId = await createOrder(PORT_LINK, env);

      // 即使用开发占位密钥（公开值）正确签名，没注册就是没注册——响亮 40001，
      // 不验签、不落 webhook_events（与"编造通道名"同形态，但语义是"配置没让它存在"）
      const body = JSON.stringify({
        event_id: 'evt-link-nokey',
        type: 'payment.succeeded',
        order_id: orderId,
        provider_ref: 'cs_1',
      });
      const res = await fetch(`http://127.0.0.1:${PORT_LINK}${PAY_CALLBACK_PREFIX}/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': sign(body, 'dev-mock-callback-secret-do-not-use-in-prod'),
        },
        body,
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 40001 });
      const logged =
        await db`select event_id from webhook_events where event_id = 'evt-link-nokey'`;
      expect(logged.length).toBe(0);
      const rows = await db`select status from orders where id = ${orderId}`;
      expect(rows[0]?.status).toBe('created');
    } finally {
      await shutdown(rt);
    }
  });

  it('PAYMENT_CHANNELS 全空 → 启动直接拒绝（min(1)：不许"没有任何支付入口"的配置静默上线）', async () => {
    const { write } = sink();
    await expect(
      bootstrap({
        env: { ...baseEnv(PORT_LINK), PAYMENT_CHANNELS: '' },
        logDestination: { write },
        exit: () => undefined,
      }),
    ).rejects.toThrow(/配置校验失败/);
  });
});

/**
 * 生产装配路径（三审欠账 ⑧：此前 NODE_ENV=production 的 bootstrap 全仓零集成测试）。
 *
 * @why 生产与开发的装配差异全在 `isProd` 分支里：骨架不挂、mock 只认列出的、跨字段校验全开。
 *      这些分支各自有单测（config.unit / channels.unit / main.unit 的 shouldMountSkeleton），
 *      但"生产配置 → loadConfig → buildPaymentRegistry → 路由挂载 → 真库"这条链此前没人端到端跑过——
 *      两轮审计的 P1 共同形态正是"各件各自绿、拼起来有缝"。
 *
 * @how 生产规则 4 禁止 DATABASE_URL 指向本机，而测试库闸门又**只允许**本机——两条守卫方向相反。
 *      这里不放宽任何一条：在本机的一个**非环回**网卡地址上起一个纯 TCP 转发器，把连接转到
 *      127.0.0.1 的测试库；DATABASE_URL 的 hostname 因此是网卡地址（规则 4 放行），而字节仍落在测试库。
 *      没有非环回 IPv4 的机器（极少见）跳过该用例并说明原因，**不把跳过伪装成通过**。
 *
 * @limitation 转发器只转字节，不理解 PG 协议；SSL 协商由 postgres.js 与 PG 直接完成（本机 PG 无 SSL）。
 * @limitation macOS 应用防火墙对"进程在网卡地址上监听"可能弹一次授权框（连接来自本机，通常不拦）。
 */
describe('生产装配路径（NODE_ENV=production 的真 bootstrap）', () => {
  const PORT_PROD_LINK = 4614;

  /** 与 render.yaml 同形状的最小生产配置；DATABASE_URL 由用例自行给出。 */
  function prodEnv(port: number, databaseUrl: string): Record<string, string> {
    return {
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      TRUST_PROXY_HOPS: '1',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'main-prod-jwt-secret-'.repeat(3),
      PAYMENT_CHANNELS: 'stripe',
      TERMS_VERSION: 'TOS-TEST-1',
      STRIPE_SECRET_KEY: 'sk_live_e2e_placeholder_not_real',
      STRIPE_WEBHOOK_SECRET: 'whsec_e2e_placeholder_not_real',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
      CORS_ORIGINS: 'https://admin.example.com',
      SHUTDOWN_READY_DELAY_MS: '50',
    };
  }

  function lanIPv4(): string | undefined {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('127.'))
          return ni.address;
      }
    }
    return undefined;
  }

  /** 在 `host` 上监听，把每条连接原样转到 127.0.0.1:5432（测试库）。 */
  async function forwarder(
    host: string,
    targetPort: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server: NetServer = createServer((client) => {
      const upstream = connect({ host: '127.0.0.1', port: targetPort });
      client.pipe(upstream).pipe(client);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', drop);
      upstream.on('error', drop);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('生产 + 未列出 mock + 残留 MOCK_CALLBACK_SECRET → 启动拒绝（规则 1b；控制组去掉密钥即通过校验）', async () => {
    const env = {
      ...prodEnv(PORT_PROD_LINK, 'postgresql://app:pw@db.invalid:5432/japan_shop'),
      MOCK_CALLBACK_SECRET: 'leftover-review-period-secret-0001',
    };
    const { lines, write } = sink();
    await expect(
      bootstrap({ env, logDestination: { write }, exit: () => undefined }),
    ).rejects.toThrow(/配置校验失败/);
    // 拒启发生在建连接池之前：没有任何一行日志被写出（logger 在 loadConfig 之后才建）
    expect(lines).toEqual([]);
    // 控制组：同一份生产配置只去掉残留密钥 → 通过校验（证明红的是 1b，不是别的生产规则）
    const withoutSecret = Object.fromEntries(
      Object.entries(env).filter(([k]) => k !== 'MOCK_CALLBACK_SECRET'),
    );
    expect(loadConfig(withoutSecret).PAYMENT_CHANNELS).toEqual(['stripe']);
  });

  it('生产装配：骨架 404、mock 通道不存在（回调 40001 零留痕）、stripe 入口在、启动日志标 production', async () => {
    const host = lanIPv4();
    if (host === undefined) {
      // 不伪装成通过：没有非环回网卡就无法在不放宽任何守卫的前提下让生产配置连上测试库
      console.warn('[skip] 本机没有非环回 IPv4 网卡，生产装配链路用例无法运行');
      return;
    }
    const target = new URL(TEST_DB_URL);
    const fwd = await forwarder(host, Number(target.port || 5432));
    const dbUrl = new URL(TEST_DB_URL);
    dbUrl.hostname = host;
    dbUrl.port = String(fwd.port);
    const env = prodEnv(PORT_PROD_LINK, dbUrl.toString());
    const { lines, write } = sink();
    let rt: Runtime | undefined;
    try {
      rt = await bootstrap({ env, logDestination: { write }, exit: () => undefined });
      const base = `http://127.0.0.1:${PORT_PROD_LINK}`;

      // ① 探活通：说明生产配置真的连上了库（不是"起来了但半死"）
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);

      // ② 骨架路由在生产不存在（SEC2 闸门）：404，不是 40101
      const skeleton = await fetch(`${base}/api/v1/skeleton/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(skeleton.status).toBe(404);

      // ③ 通道视图：只有 stripe（USD 场景），mock 不存在
      const usd = (await (
        await fetch(`${base}${PAY_CHANNELS_PATH}?country=US&currency=USD&amount_jpy=10000`)
      ).json()) as { items: { channel: string }[] };
      expect(usd.items.map((i) => i.channel)).toEqual(['stripe']);
      const jpy = (await (await fetch(channelsUrl(PORT_PROD_LINK))).json()) as { items: unknown[] };
      expect(jpy.items).toEqual([]);

      // ④ mock 回调在生产是"没有这个通道"（40001），不验签、不落 webhook_events
      const body = JSON.stringify({
        event_id: 'evt-prod-mock',
        type: 'payment.succeeded',
        order_id: 'o-x',
      });
      const cb = await fetch(`${base}${PAY_CALLBACK_PREFIX}/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': sign(body, 'dev-mock-callback-secret-do-not-use-in-prod'),
        },
        body,
      });
      expect(cb.status).toBe(400);
      await expect(cb.json()).resolves.toMatchObject({ code: 40001 });
      const db = testDb();
      try {
        const logged =
          await db`select event_id from webhook_events where event_id = 'evt-prod-mock'`;
        expect(logged.length).toBe(0);
      } finally {
        await db.end();
      }

      // ⑤ 启动日志：环境是 production，且密钥全部掩码
      const configLine = lines.find((l) => l.includes('config_loaded'));
      expect(configLine).toContain('"NODE_ENV":"production"');
      expect(configLine).toContain('"STRIPE_SECRET_KEY":"***"');
      expect(configLine).not.toContain('sk_live_e2e_placeholder');
      expect(lines.some((l) => l.includes('server_started'))).toBe(true);
    } finally {
      rt?.uninstallSignals();
      rt?.uninstallProcessErrors();
      await rt?.server.close().catch(() => undefined);
      await rt?.db.end().catch(() => undefined);
      await fwd.close();
    }
  });

  /** 与上一个 describe 相同的 HMAC 算法（本 describe 独立，不跨 describe 借用闭包）。 */
  function sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  }
  function channelsUrl(port: number): string {
    return `http://127.0.0.1:${port}${PAY_CHANNELS_PATH}?country=US&currency=JPY&amount_jpy=10000`;
  }
});
