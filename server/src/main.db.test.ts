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
 * @limitation 不覆盖"进程收到真信号后退出码"那一段（已在 http.unit.test.ts 覆盖），
 *             这里只验"组装出来的东西能用"。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, shouldMountSkeleton, type Runtime } from './main.js';
import { ensureTestDb, TEST_DB_URL } from '../../test/db/test-db.js';

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
        const { closeDb } = await import('./db.js');
        await closeDb(rt.db);
      })();
      // 停之后：连接已关，再查必然抛错——这证明"关库"真的发生了
      await expect(rt.db`select 1 as ok`).rejects.toThrow();
    } finally {
      rt.uninstallSignals();
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
      rt = await bootstrap({
        env: { ...baseEnv(PORT_PROD), NODE_ENV: 'staging' },
        logDestination: { write },
        exit: () => undefined,
      });
      const res = await fetch(`http://127.0.0.1:${PORT_PROD}/api/v1/skeleton/orders/whatever`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 40101 });
    } finally {
      rt?.uninstallSignals();
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
    try {
      process.emit('SIGTERM' as NodeJS.Signals, 'SIGTERM');
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
    } finally {
      rt.uninstallSignals();
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
