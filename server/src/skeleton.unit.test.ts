/**
 * 职责：骨架的**环境闸门**单测（SEC2）——骨架端点不得进生产。
 *
 * @why 骨架不是"演示页面"这么简单：`/skeleton/orders/:id/simulate-paid` 绕过机构验签
 *      直接把订单改成 paid，`/pay/callback/mock` 只认我们自己约定的 HMAC。
 *      这两条进了生产，等于任何脚本都能把任意订单标记成已支付——
 *      不是信息泄漏，是**可以直接骗取发货**。所以闸门必须是硬失败，不能是文档里的一句提醒。
 *
 * @limitation 这里只验"闸门本身"，不验骨架的业务行为（那部分在 `test/e2e/skeleton.e2e.test.ts`）。
 *             挂载被拒后没有真实 DB 交互，所以 db 传空壳即可——闸门在最前面就抛了。
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Db } from './adapters/db.js';
import { createLogger } from './logger.js';
import { mountSkeleton, type SkeletonDeps } from './skeleton.js';
import type { WebhookStore } from './ports/webhooks.js';
import type { IdempotencyExecutor } from './ports/idempotency.js';
import type { EventBus } from './ports/events.js';
import { systemClock } from './adapters/clock.js';
import { systemIdGen } from './adapters/ids.js';
import { MemorySink } from '../../test/helpers/memory-sink.js';

const AUTH = { secret: 'gate-test-secret-'.repeat(3), issuer: 'waselect-gate-test' };

function deps(env: SkeletonDeps['env']): { d: SkeletonDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    sink,
    d: {
      // 闸门在挂载前就抛错，不会真的用到 db / webhooks / idempotency——空壳只为满足类型
      db: {} as unknown as Db,
      webhooks: {} as unknown as WebhookStore,
      idempotency: {} as unknown as IdempotencyExecutor<Db>,
      events: {} as unknown as EventBus,
      // 闸门测试用真实时钟即可（它不涉及时间边界）；这里必填是装配纪律的一部分
      clock: systemClock,
      idGen: systemIdGen,
      logger: createLogger({
        env: env === 'production' ? 'production' : 'development',
        destination: sink,
      }),
      auth: AUTH,
      callbackSecret: 'gate-secret',
      callbackOrderGraceMs: 900_000,
      env,
    },
  };
}

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('骨架环境闸门（SEC2）', () => {
  it('production 下拒绝挂载，并留下一条 error 日志（不是静默跳过）', () => {
    const { d, sink } = deps('production');
    expect(() => mountSkeleton(express(), d)).toThrow(/生产环境/);
    const row = sink.find('skeleton_mount_refused')[0];
    expect(row?.level).toBe('error');
    expect(row?.result).toBe('refused');
  });

  it('development / staging 正常挂载（骨架是这两个环境的调试工具）', () => {
    for (const env of ['development', 'staging'] as const) {
      const { d } = deps(env);
      expect(() => mountSkeleton(express(), d)).not.toThrow();
    }
  });

  /**
   * @why 守住"闸门由显式入参决定"这个选择：若有人改成读 `process.env.NODE_ENV`，
   *      这条会变红。显式入参的价值是——装配时必须回答一次"这是什么环境"，
   *      而不是让行为随一个隐蔽的全局变量漂移（测试也就不用改进程环境才能覆盖分支）。
   */
  it('闸门看 deps.env，不看 process.env.NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    const { d } = deps('development');
    expect(() => mountSkeleton(express(), d)).not.toThrow();
  });

  /**
   * @why 抛错必须发生在**注册路由之前**。若写成"先注册再检查"，
   *      捕获异常后路由已经挂上去了，服务照常起来——闸门等于形同虚设。
   *      用真实端口验证：被拒后该路径应当完全没有路由（Express 默认 404）。
   */
  it('拒绝后不留任何骨架路由（防止"先注册后检查"的顺序错误）', async () => {
    const { d } = deps('production');
    const app = express();
    expect(() => mountSkeleton(app, d)).toThrow();

    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/skeleton/orders/anything`);
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });
});
