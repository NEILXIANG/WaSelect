/**
 * 职责：`cleanup-idempotency.ts`（幂等键过期清理 job）的单测。
 *
 * @why 第三轮审查 TST3-03：这个 job 原来**没有任何测试 import 它**（覆盖率 33%），
 *      靠全局 85% 的均值蒙混过关。它守的是"24h 后同键可重新执行"这句承诺——
 *      基准时刻取错（用 now() 而不是 tick 开始）或 TTL 方向写反，用户隔天重试就会拿到昨天的响应。
 * @limitation SQL 本身（只删已完成行）由 idempotency 的 db 用例守；这里用假 tx 只验 job 的编排：
 *             cutoff 取自 `ctx.startedAt − 24h`、processed = 删除行数、日志落一条。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../adapters/db.js';
import { CLEANUP_IDEMPOTENCY_JOB, createCleanupIdempotencyJob } from './cleanup-idempotency.js';

function fakeTx(rows: unknown[]) {
  const seen: unknown[][] = [];
  const tx = ((_s: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(values);
    return Promise.resolve(rows);
  }) as unknown as Db;
  return { tx, seen };
}

describe('createCleanupIdempotencyJob', () => {
  it('cutoff = tick 开始时刻 − 24h；processed = 删除行数；落一条 idempotency_cleanup 日志', async () => {
    const { tx, seen } = fakeTx([{ key: 'k1' }, { key: 'k2' }]);
    const logs: { msg: string; fields: Record<string, unknown> }[] = [];
    const log = {
      info: (msg: string, fields: Record<string, unknown>) => logs.push({ msg, fields }),
      warn: () => undefined,
      error: () => undefined,
    };
    const job = createCleanupIdempotencyJob();
    expect(job.name).toBe(CLEANUP_IDEMPOTENCY_JOB);
    const out = await job.run({
      tx,
      emit: () => undefined,
      startedAt: new Date('2026-09-30T03:00:00.000Z'),
      log: log as never,
    });
    expect(out).toEqual({ processed: 2 });
    expect(seen[0]?.[0]).toEqual(new Date('2026-09-29T03:00:00.000Z'));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe('idempotency_cleanup');
    expect(logs[0]?.fields).toMatchObject({
      result: 'ok',
      count: 2,
      ctx: { ttl_hours: 24, cutoff: '2026-09-29T03:00:00.000Z' },
    });
  });

  it('没有可删的行 → processed 0（正常，不是失败）', async () => {
    const { tx } = fakeTx([]);
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const out = await createCleanupIdempotencyJob().run({
      tx,
      emit: () => undefined,
      startedAt: new Date('2026-09-30T03:00:00.000Z'),
      log: log as never,
    });
    expect(out).toEqual({ processed: 0 });
  });
});
