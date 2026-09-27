/**
 * 职责：限流中间件与**接线**的用例（I1-U3）——中间件行为用桩验，"真的挂上了"用真请求验。
 *
 * @why 接线用例（最后一组）是本文件存在的理由：限流器"组件做对了但没挂到路由上"
 *      不会让任何单测红（§2 第 35 条"能力存在 ≠ 能力被用上"）——只有真发第 31 个请求、
 *      看到 40101 变成 42901，才能证明挂载成立。探针用 `POST /orders/quote`：
 *      它的限流挂在 mount.ts 的 `app.use` 层（**先于**路由处理器），而无鉴权请求
 *      在 requireRole 处 40101——恰好提供"限流前置计数、与业务结果无关"的现成探针。
 *      （骨架退役前探针用的是骨架写路径，同一手法，U6c 迁到业务写路径。）
 *
 * @see app/rate-limit.ts（被测）；app/mount.ts（挂载点）；ports/rate-limit.ts；
 *      test/helpers/mount-ctx.ts（stub 装配上下文）
 */
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { stubMountContext } from '../../../test/helpers/mount-ctx.js';
import { createMemoryRateLimitStore } from '../adapters/rate-limit-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { rateLimiter, type RateLimiterDeps } from './rate-limit.js';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');

function makeDeps(): { deps: RateLimiterDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    deps: {
      store: createMemoryRateLimitStore(),
      clock: fixedClock('2026-01-02T12:00:00.000Z'),
      logger: createLogger({ env: 'test', destination: sink }),
    },
    sink,
  };
}

const RULE = { routeKey: 'test.route', limit: 2, windowMs: 60_000 };

interface Captured {
  err?: unknown;
  headers: Record<string, string>;
}

function run(deps: RateLimiterDeps, ip: string | undefined): Captured {
  const captured: Captured = { headers: {} };
  const handler = rateLimiter(deps, RULE);
  const req = { ip, method: 'POST', path: '/api/v1/x' } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
  } as unknown as Response;
  const next: NextFunction = (e?: unknown) => {
    captured.err = e;
  };
  handler(req, res, next);
  return captured;
}

describe('rateLimiter 中间件（桩）', () => {
  it('限额内放行（第 1、2 次无错误透传）', () => {
    const { deps } = makeDeps();
    expect(run(deps, '1.1.1.1').err).toBeUndefined();
    expect(run(deps, '1.1.1.1').err).toBeUndefined();
  });

  it('超限 → AppError(42901) + Retry-After 头 + warn 日志', () => {
    const { deps, sink } = makeDeps();
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    const third = run(deps, '1.1.1.1');
    expect(third.err).toBeInstanceOf(AppError);
    expect((third.err as AppError).code).toBe(42901);
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const log = sink.find('rate_limited')[0];
    expect(log?.level).toBe('warn');
    expect(log?.['http_path']).toBe('/api/v1/x');
  });

  it('按 IP 隔离：A 超限不影响 B', () => {
    const { deps } = makeDeps();
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1'); // A 超限
    expect(run(deps, '2.2.2.2').err).toBeUndefined();
  });

  it('req.ip 缺失按 unknown 计（绝不自己读 X-Forwarded-For）', () => {
    const { deps } = makeDeps();
    run(deps, undefined);
    run(deps, undefined);
    expect(run(deps, undefined).err).toBeInstanceOf(AppError);
  });

  it('时间用注入时钟（窗口边界可被测试钉住）', () => {
    // 注入 T0 的时钟：所有 hit 落在同一窗口；若中间件自己 new Date()，
    // 这条用例会随真实时间漂移（偶发绿/红）
    const { deps } = makeDeps();
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    expect(T0).toBe(Date.parse('2026-01-02T12:00:00.000Z')); // 锚定注释所言的时钟
    expect(run(deps, '1.1.1.1').err).toBeInstanceOf(AppError);
  });
});

describe('限流接线（真请求，防"组件对了但没挂上"）', () => {
  it('业务写路径（POST /orders/quote）：前 30 次 40101（鉴权拦下），第 31 次 42901（限流拦下）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const app = createHttpApp({
      logger,
      mount: (a) => mountAllRoutes(a, stubMountContext({ logger })),
    });
    const server = await listen(app);
    try {
      const url = `http://127.0.0.1:${server.port}/api/v1/orders/quote`;
      const post = () =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      // 默认 RATE_LIMIT_QUOTE_PER_MIN=30：前 30 次穿过限流，被 requireRole 拦成 40101
      for (let i = 0; i < 30; i += 1) {
        const res = await post();
        const body = (await res.json()) as { code: number };
        expect(body.code).toBe(40101);
      }
      // 第 31 次：限流先于鉴权
      const res = await post();
      const body = (await res.json()) as { code: number };
      expect(res.status).toBe(429);
      expect(body.code).toBe(42901);
      expect(res.headers.get('retry-after')).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});
