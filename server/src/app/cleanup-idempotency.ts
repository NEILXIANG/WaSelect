/**
 * 职责：**定期清理过期的幂等键**（三审欠账 ①）——让"24h 后同键可重新执行"这句话真的成立。
 *
 * @why 它修的是一句**已经写进注释但从未兑现**的承诺：`adapters/idempotency.ts` 的
 *      @tradeoff 写着"过期清理交给调度器（24h）"，而全仓既没有 `delete` 也没有 job。
 *      后果是幂等键写过一次就永久重放：用户隔天重试拿到的是**昨天的响应**
 *      （价格、库存、地址快照都可能是旧的），而这件事不报错、只在"金额对不上"时才被察觉。
 *
 * @why 做成 `SchedulerJob` 而不是塞进某个请求里顺手清：清理的触发频率与请求量无关，
 *      挂在请求上会出现"流量低时永远不清、流量高峰时每次请求都多一条 delete"。
 *      调度器有心跳（`job_runs`）与锁，清理这件事因此是**可观测**的
 *      ——"最后一次成功清理是什么时候"是一个能直接回答的问题。
 *
 * @limitation 一：删已完成的行，以及**租约已过期**的崩溃遗留占位行（P2-21，AJ-386）；
 *      仍在续租的行不动（见 `deleteExpiredIdempotencyKeys` 的 @why）。
 * @limitation 二：`processed` 是删除行数；**0 是正常的**，不代表 job 失败
 *      （`ports/scheduler.ts` 的 JobOutcome 口径）。
 *
 * @see ../adapters/idempotency.ts（SQL 与 TTL 常量）；docs/地基搭建清单.md 欠账 ①
 */
import type { Db } from '../adapters/db.js';
import {
  deleteExpiredIdempotencyKeys,
  idempotencyCutoff,
  IDEMPOTENCY_TTL_HOURS,
} from '../adapters/idempotency.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const CLEANUP_IDEMPOTENCY_JOB = 'cleanup_idempotency';

/**
 * 清理任务的**唯一实例**（无状态，可复用）。
 *
 * @why 工厂而不是常量对象：与 `createSchedulerDeps` 同一形态——job 若将来需要注入
 *      （保留时长、批次上限），改的是工厂签名，调用方不用改。
 *      现在无参是"暂时没有要注入的东西"，不是"永远不需要"。
 */
export function createCleanupIdempotencyJob(): SchedulerJob<Db> {
  return {
    name: CLEANUP_IDEMPOTENCY_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      // 基准时刻取**本轮 tick 的开始**（`ctx.startedAt`）而不是 `now()`：
      //    同一轮里所有 job 看到同一个基准，否则"24h 前"这条边界会随 job 的执行先后漂移
      //    （@see ports/scheduler.ts JobContext.startedAt 的 @why）。
      //    而"减去 24h"这一步在 adapters 里做（`idempotencyCutoff`）——业务侧不自己 `new Date()`（F10）。
      const cutoff = idempotencyCutoff(ctx.startedAt);
      const deleted = await deleteExpiredIdempotencyKeys(ctx.tx, cutoff);
      ctx.log.info('idempotency_cleanup', {
        result: 'ok',
        count: deleted,
        ctx: { ttl_hours: IDEMPOTENCY_TTL_HOURS, cutoff: cutoff.toISOString() },
      });
      return { processed: deleted };
    },
  };
}
