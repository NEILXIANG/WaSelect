/**
 * 职责：每日归档审核期测试单（剩余清单 3-4；AJ-192 登记的"清理 / 归档审核期测试单"待办）。
 *
 * 规则：`is_test = true` 且 `status = 'paid'` 且 `paid_at` 早于 afterHours 小时 → 迁 `cancelled`、盖 `cancelled_at`、
 *       记 `order_events(cancelled, note=test_archived, actor=system)`、按行项目回补库存。
 *
 * @why 这类单既不能发货（shipGuard 拦 is_test，AJ-179）也不能退款（mock 下线后没有通道，AJ-192）——
 *      永远停在 paid，且**一直占着真实库存**：审核员下了 3 单 = 真货少卖 3 件。
 * @why 迁 cancelled 而不是新造一个 `archived` 状态：订单状态是契约枚举（10 态），加一态要动契约、小程序、管理端三处；
 *      "测试单作废"在语义上就是取消，区分靠事件 note = test_archived。
 * @why 不走状态机（paid → cancelled 不是常规迁移）：与 auto-fulfilment 同口径，用带条件的单条 SQL，
 *      条件里**再判一次** is_test 与 status——真实订单绝不可能被这条路径碰到。
 * @why 等满 afterHours（默认 24）：给审核员留出看订单详情的时间，不在他眼前把单关掉。
 * @limitation 一：支付行（mock，status = succeeded）不动——它是测试数据，不对应真实资金；对账的"已付无成功支付行"只看 paid 单，不受影响。
 * @limitation 二：不发 `order.cancelled` 事件：它的订阅者是"作废在途机构会话"，mock 没有机构会话；发了只多一轮空跑。
 * @see app/auto-fulfilment.ts（同构的批量迁移作业）；app/internal-jobs-routes.ts（daily 列表）
 */
import type { Db } from '../adapters/db.js';
import { restoreStockForOrders } from '../adapters/orders.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const ARCHIVE_TEST_ORDERS_JOB = 'archive_test_orders';
const BATCH_LIMIT = 500;

export function createArchiveTestOrdersJob(opts: { afterHours: number }): SchedulerJob<Db> {
  return {
    name: ARCHIVE_TEST_ORDERS_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const rows = await ctx.tx<{ id: string }[]>`
        with due as (
          select id from orders
           where is_test = true and status = 'paid'
             and paid_at <= ${ctx.startedAt}::timestamptz - make_interval(hours => ${opts.afterHours})
           order by paid_at
           limit ${BATCH_LIMIT}
           for update skip locked
        ), moved as (
          update orders o set status = 'cancelled', cancelled_at = ${ctx.startedAt}, updated_at = now()
            from due where o.id = due.id and o.status = 'paid' and o.is_test = true
          returning o.id
        ), ev as (
          insert into order_events (order_id, status, note, actor, at)
          select id, 'cancelled', 'test_archived', 'system', ${ctx.startedAt} from moved
        )
        select id from moved`;
      const ids = rows.map((r) => r.id);
      // 回补跟在"迁移成功"之后、同一事务：只有本轮真正迁走的单才回补（不幂等，见 restoreStockForOrder ⚠️）
      if (ids.length > 0) await restoreStockForOrders(ctx.tx, ids);
      ctx.log.info('test_orders_archived', {
        result: 'ok',
        count: ids.length,
        ctx: { after_hours: opts.afterHours, batch_limit: BATCH_LIMIT },
      });
      return { processed: ids.length };
    },
  };
}
