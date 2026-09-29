/**
 * 职责：**超时关单 job**（I1-U2，D-33）——把"30 分钟未支付"的订单关为 `expired`。
 *
 * @why 这是全库**致命级**欠账（三次全量审查 P3）：没有它，`expires_at` 就是一列没人读的死数据——
 *      订单永远停在待支付，用户第二天付款成功钱照扣（迟到付款），
 *      而"这张单到底还算不算数"没有任何系统行为支撑。mark-paid 的 expires_at 守卫
 *      （本单元另一半）只挡"迟到的钱"，本 job 负责让"到点的单"在数据上真的死掉——
 *      两件事互为表里：守卫决定"拒"，job 决定"状态事实"。
 *
 * @why 做成 `SchedulerJob` 插在 tick 里（而不是独立定时器）：调度器已经有锁（多实例互斥）、
 *      savepoint（失败不拖垮其它 job）、心跳（job_runs 可观测）——白拿的可靠性，不用就是倒退。
 *      且按 scheduler.ts @limitation 一的既定顺序，**关单排在所有 job 最前**
 *      （同一张单的后续处理都建立在"它是否还活着"之上）。
 *
 * @why `emit('order.expired')` 只在 `markOrderExpired` 返回 true 时发：
 *      返回 false = 状态已被别人迁走（比如恰好被回调置 paid），那张单的"关单"并未发生，
 *      发了事件就是幽灵副作用（与 scheduler.ts runOneJob 的登记时机同一个事故形态）。
 *
 * @limitation 一：**不主动通知用户**（无邮件/服务通知）——通知通道本身还没建（MAIL_PROVIDER_* 未接线），
 *              用户在小程序里看到的是订单列表/详情里的"已关闭"。通知属售后阶段，届时订阅
 *              `order.expired` 即可，本 job 不需要改。
 * @limitation 二：关单**不碰 payments 行**：一张单可能有 initiated 的支付意图，
 *              它的善后由 `order.expired` 的订阅者负责（`app/close-session-events.ts`：提交后库内作废 +
 *              best-effort 作废机构会话，D-50）；到账则由 mark-paid 按"迟到付款"拒落账。职责不重叠。
 * @limitation 三：`EXPIRE_BATCH_LIMIT` 是**代码常量**不是配置项：它是"单轮事务时长"的保护阀，
 *              不是运营参数；真要调大说明单量已到该重新审视调度形态的量级，那次调整本该发版。
 *              （与 IDEMPOTENCY_TTL_HOURS 同口径。）
 * @limitation 四：I1-U5b 起关单连带**释放库存**（建单扣减的镜像）。技术文档 §1 要求的
 *              "取消该订单所有未完成的支付意图"（Stripe checkout.sessions.expire）已由 `order.expired`
 *              订阅者在**事务提交后**执行（`app/close-session-events.ts`，D-50；一致性审计 C9 更正原"待接线"）。
 *
 * @see adapters/orders.ts（SQL 与两个 @why：含等号边界 / SKIP LOCKED）；
 *      app/mark-paid.ts（另一半：迟到付款守卫）；docs/I1阶段开发实施方案.md §3.2
 */
import type { Db } from '../adapters/db.js';
import {
  lockExpiredPayableOrders,
  markOrderExpired,
  restoreStockForOrders,
} from '../adapters/orders.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const EXPIRE_ORDERS_JOB = 'expire_orders';

/**
 * 单轮最多关多少单（见文件头 @limitation 三）。
 * @why 100 的依据：MVP 单量下"一天全站订单"都到不了这个数，而真正要防的是
 *      "某次故障后积压几万张死单，第一轮 tick 就开一个分钟级长事务"——
 *      长事务占着连接与锁，回调落账会被拖慢。积压时宁可分轮消化（每轮 60s × 100）。
 */
export const EXPIRE_BATCH_LIMIT = 100;

export function createExpireOrdersJob(opts: { batchLimit?: number } = {}): SchedulerJob<Db> {
  const limit = opts.batchLimit ?? EXPIRE_BATCH_LIMIT;
  return {
    name: EXPIRE_ORDERS_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      // 判定基准 = 本轮 tick 的 startedAt（同一轮所有 job 同一基准，ports/scheduler.ts 的既定口径）
      const ids = await lockExpiredPayableOrders(ctx.tx, ctx.startedAt, limit);
      // ── 两段式：先逐单迁移，再**一次性**按全局锁序回补 ────────────────────────
      // ⚠️ 不可在循环里逐单回补：那会让总锁序变成"每单内升序"的串接而不是全局升序，
      //    两个批次只要串接断点不同就可能成环（A3，2026-09-29 全量审查：
      //    探针复现批 X1=[B]、X2=[A] 对建单 A→B 时 40P01 且**整批回滚**）。
      //    先收集、后统一回补，锁序才是一个全局升序。
      // ⚠️ 顺序仍然不可换：markOrderExpired 的 true 是"本次迁移是我干的"的排他凭证，
      //    "哪些单算我关的"必须在这轮定下来（restoreStockForOrders 不幂等，见 adapters/orders.ts 的 ⚠️），
      //    只是"把库存加回去"这一步挪到循环之后——仍在同一个事务里，要么一起落要么一起滚。
      const closedIds: string[] = [];
      for (const id of ids) {
        // false = 被别人抢先迁走（恰好落账/取消），不是错误，不发事件（文件头 @why ③）
        if (await markOrderExpired(ctx.tx, id, ctx.startedAt)) {
          closedIds.push(id);
          ctx.emit({ name: 'order.expired', at: ctx.startedAt.toISOString(), orderId: id });
        }
      }
      if (closedIds.length > 0) await restoreStockForOrders(ctx.tx, closedIds);
      const closed = closedIds.length;
      ctx.log.info('orders_expired', {
        result: 'ok',
        count: closed,
        // scanned ≠ closed 时说明有单被并发迁走——这个数字是观察"关单/落账竞速"的窗口
        ctx: { scanned: ids.length, batch_limit: limit },
      });
      return { processed: closed };
    },
  };
}
