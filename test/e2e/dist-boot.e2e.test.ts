/**
 * 职责：**编译产物**的启动冒烟（A1 的最后一块）——`npm start` 走的到底是哪条路。
 *
 * @why A1 之前的缺口不是"没有入口"，而是"入口只在测试里被验证过"：
 *      所有用例跑的都是 **TS 源码**（vitest 直接 import `server/src/main.ts`），
 *      而生产跑的是 `node --conditions=waselect-runtime server/dist/main.js`。
 *      这两条路之间横着 `@waselect/shared` 的**条件导出**——`waselect-runtime` 命中 `dist/`，
 *      其余情况命中 `src/`。条件写反、键顺序写错、`dist` 少一个文件，
 *      后果是"CI 全绿、Render 上启动失败"，而这恰恰是最贵的一种红灯。
 *
 *      所以这里**真的 spawn 一个子进程**去跑产物：不做任何 mock，走的就是 `npm start` 的那一行。
 *
 * @limitation 一：依赖 `server/dist/` 已构建。`npm run gate` 里 `build` 排在测试之前；
 *              单独跑 `npm run test:e2e` 而 dist 不存在时，会带一句明确的提示失败——
 *              这是**有意为之**：静默跳过会让"产物启动"这件事又变成没人验证。
 * @limitation 二：不比对 dist 与 src 的新旧。构建产物过期时这里仍可能绿，
 *              但这属于构建流程问题，不该由测试兜底（`npm run gate` 的顺序已经保证）。
 * @limitation 三：`NODE_ENV=development` 是**必需的**，不是图省事：
 *              生产下 `shouldMountSkeleton()` 会拒绝挂载骨架（SEC2 闸门），
 *              进程会启动失败。所以这条用例验的是"产物能起来并跑完装配"，不是生产闸门本身
 *              （生产闸门由 `shouldMountSkeleton` 的单测负责）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestDb, TEST_DB_URL } from '../db/test-db.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_MAIN = resolve(root, 'server/dist/main.js');

/** 抓一个空闲端口：config 的 PORT 下限是 1，不能传 0 让系统分配。 */
async function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        rej(new Error('拿不到端口'));
        return;
      }
      srv.close(() => res(addr.port));
    });
  });
}

interface Booted {
  port: number;
  stdout: string;
  stderr: string;
  /** 让进程优雅退出，并等它真的退出 */
  stop: () => Promise<{ code: number | null; signal: string | null; stdout: string }>;
}

let booted: Booted | null = null;

async function boot(): Promise<Booted> {
  const port = await pickFreePort();
  const child = spawn(process.execPath, ['--conditions=waselect-runtime', DIST_MAIN], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'dist-boot-jwt-secret-'.repeat(3),
      PAYMENT_CHANNELS: 'mock',
      TERMS_VERSION: 'TOS-TEST-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.on('data', (d: string) => {
    stderr += d;
  });

  /**
   * ⚠️ 用 `close` 而不是 `exit` 作为"进程结束"的信号。
   * @why `exit` 触发时 stdout / stderr 的管道**可能还没读完**，
   *      于是在退出那一刻去断言日志内容会读到半截（表现为随机少一行）。
   *      `close` 在三个 stdio 流都关闭后才触发，那时 stdout 才是完整的。
   */
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const closed = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.on('close', (code, signal) => {
      exitInfo = { code, signal };
      res({ code, signal });
    });
  });

  // 轮询 /healthz 而不是 sleep 固定时长：前者既快又能拿到真实失败原因
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {
      // 还没起来，继续等
    }
    if (exitInfo !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!up) {
    child.kill('SIGKILL');
    throw new Error(
      `产物没能在 20s 内就绪（端口 ${port}）。\n` +
        `这通常是 @waselect/shared 的条件导出没命中 dist，或 dist 缺文件。\n` +
        `── stdout ──\n${stdout}\n── stderr ──\n${stderr}`,
    );
  }

  return {
    port,
    stdout,
    stderr,
    stop: async () => {
      child.kill('SIGTERM');
      const r = await Promise.race([
        closed,
        new Promise<null>((res) => setTimeout(() => res(null), 10_000)),
      ]);
      if (r === null) {
        child.kill('SIGKILL');
        throw new Error('发 SIGTERM 后 10s 内没退出，优雅停机有问题');
      }
      return { ...r, stdout };
    },
  };
}

beforeAll(async () => {
  if (!existsSync(DIST_MAIN)) {
    throw new Error(`缺少 ${DIST_MAIN}：先跑 npm run build（npm run gate 里已包含这一步）`);
  }
  await ensureTestDb();
  booted = await boot();
}, 60_000);

afterAll(async () => {
  if (booted !== null) await booted.stop().catch(() => undefined);
});

describe('编译产物能被 npm start 那条命令真正启动（A1）', () => {
  it('/healthz 与 /readyz 都返回 200（装配 + 数据库连通都走通了）', async () => {
    const b = booted;
    if (b === null) throw new Error('前置启动失败');
    const h = await fetch(`http://127.0.0.1:${b.port}/healthz`);
    expect(h.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${b.port}/readyz`);
    // /readyz 会真的 ping 数据库：它绿了才说明产物里的连接池配置是对的
    expect(r.status).toBe(200);
  });

  /**
   * 断言 stdout 里有 `server_started` 这一行 JSON 日志。
   * @why 只验"端口通了"会放过一类阴间情况：进程起来了，但 logger 序列化在产物里炸了
   *      （pino 的 transport / 条件导出都可能只在 dist 下出问题）。
   *      日志是本项目定位问题的唯一手段（ADR-29），它必须**在产物里**也是活的。
   */
  it('产物输出的日志里能看到 server_started（说明 logger 在 dist 下也活着）', () => {
    const b = booted;
    if (b === null) throw new Error('前置启动失败');
    const lines = b.stdout.split('\n').filter((l) => l.trim().length > 0);
    const started = lines.find((l) => l.includes('server_started'));
    expect(started, `stdout 里没有 server_started：\n${b.stdout}\n${b.stderr}`).toBeDefined();
    const parsed = JSON.parse(started ?? '{}') as { event?: string; port?: number };
    expect(parsed.event).toBe('server_started');
    expect(parsed.port).toBe(b.port);
  });

  it('发 SIGTERM 后优雅退出，且 stdout 里有 traffic_draining / server_drained', async () => {
    const b = booted;
    if (b === null) throw new Error('前置启动失败');
    const r = await b.stop();
    // 之后不再重复 stop
    booted = null;
    // 优雅停机是**自己调 process.exit(0) 退出**的，signal 为 null；
    // 若这里是被 SIGKILL 强杀，上面的 stop() 已经抛错了，不会走到这一行。
    // 所以判据是"退出码 0 且没有残留信号"，而不是"signal === SIGTERM"。
    expect(r.code, `退出码不是 0：${r.code} / ${r.signal}`).toBe(0);
    expect(r.stdout).toContain('traffic_draining');
    expect(r.stdout).toContain('server_drained');
  });
});
