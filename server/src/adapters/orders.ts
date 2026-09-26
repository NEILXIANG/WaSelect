/**
 * 职责：`orders` 表的 SQL 仓储（I1-U2 起；U5 建单/查询会继续生长本文件）。
 *
 * 边界：只做 SQL 与行 ↔ 类型的映射，不含业务规则（状态机迁移表在 `domain/order.ts`，U5）。
 *
 * @why 关单扫描的两个 SQL 细节都是踩过坑才定下的，写在这里而不是散落在 job 里：
 *      ① `expires_at <= now`（**含等号**）——语义是"可支付窗口为 `[created, expires_at)`"：
 *         到点的这一瞬间就不可付了。mark-paid 守卫用**同一个**比较方向（`now >= expires_at` 即迟到），
 *         两边若一个含等号一个不含，"恰好在 expires_at 那一毫秒付款"的订单会同时被
 *         "关单 job 放过"和"落账守卫拒绝"，谁也解释不清它到底算不算超时。
 *      ② `FOR UPDATE SKIP LOCKED`——关单 job 与支付回调会**同时**盯上同一张单
 *         （用户在 29 分 59 秒付款、30 分 00 秒 tick 醒来）：
 *         行锁被落账事务持有时，扫描**跳过**这张单而不是整批卡死等锁；
 *         下一轮 tick 它若仍未支付自然会被再扫到。写成裸 `FOR UPDATE` 的后果是
 *         落账慢 5 秒、整批关单就堵 5 秒，且这种堵塞只在"快超时还在付"的真实场景才出现。
 *
 * @limitation 一：扫描限量（`LIMIT $3`）——单轮最多取 `limit` 条，剩余的**下一轮**再关。
 *              换来单轮事务时长有上界（D-43 进程内调度器，长事务会拖累整条连接池）；
 *              代价是积压时关单有延迟（每轮 60s × 每轮 limit 条），MVP 单量下可接受。
 * @limitation 二：`markOrderExpired` 的 WHERE 里重复了状态条件（不只靠扫描时的过滤）：
 *              扫描与更新之间若有人抢先改了状态（理论上同事务内不可能，但本函数也对
 *              事务外调用方开放），0 行命中 → 返回 false，调用方不得把它当错误。
 *
 * @see app/expire-orders.ts（消费方：超时关单 job）；migrations/001_init.sql（orders 表）；
 *      docs/I1阶段开发实施方案.md §3.2；D-33（30 分钟超时关单）
 */
import type { Db } from './db.js';

/**
 * 可支付状态：只有这两个状态的订单会被超时关单。
 * @why 不从 shared 的 ORDER_STATUS 推导子集——"哪些状态算可支付"是**业务判定**，
 *      显式写出来比在枚举里做索引切片可读，且加状态（如 `price_review`）时
 *      这里是编译期会逼你想一遍的地方。
 */
export const PAYABLE_STATUSES = ['created', 'pending_payment'] as const;

/**
 * 锁定并取出"到点未支付"的订单 id（按 expires_at 升序：最老的先关）。
 *
 * @param now 判定基准——**调用方必须传本轮 tick 的 startedAt**（ports/scheduler.ts
 *            JobContext.startedAt 的 @why：同一轮里所有 job 用同一个基准，
 *            否则边界订单的命运取决于它在队列里排第几）。
 */
export async function lockExpiredPayableOrders(
  tx: Db,
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await tx`
    select id from orders
     where status in ${tx([...PAYABLE_STATUSES])}
       and expires_at <= ${now}
     order by expires_at asc
     limit ${limit}
     for update skip locked
  `;
  return rows.map((r) => String(r.id));
}

/**
 * 把一张订单关为 `expired` 并写审计事件（同一事务）。
 *
 * @returns true = 本次真的关了（随后应 emit `order.expired`）；
 *          false = 状态已被别人抢先迁走（0 行命中，**不是错误**，见文件头 @limitation 二）。
 */
export async function markOrderExpired(tx: Db, orderId: string, at: Date): Promise<boolean> {
  const updated = await tx`
    update orders
       set status = 'expired', updated_at = now()
     where id = ${orderId}
       and status in ${tx([...PAYABLE_STATUSES])}
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, actor, at)
    values (${orderId}, 'expired', 'system', ${at})
  `;
  return true;
}
