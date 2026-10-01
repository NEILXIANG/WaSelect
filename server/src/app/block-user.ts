/**
 * 职责：**拉黑用例**（B28 / AJ-213）——封号与"连带取消该用户手上的在途单"在**同一个事务**里完成。
 *
 * @why 从路由薄壳里抽出来：拉黑原本只是 `repo.blockUser(id)` 一行（写 `blocked_at` + `token_ver+1`），
 *      而它**只作用于带 Bearer 的接口**。无鉴权的 `/pay/link` 短链不查用户状态，
 *      于是拒付滥用者被拉黑时手上的 `pending_payment` 单在支付窗口内**照样能付**，
 *      付款后进 `paid`，运营会把货发给一个已知的拒付滥用者（B28 实锤）。
 *      修法不是"给短链加一次用户状态查询"——那只是堵住四个入口里的一个，
 *      而"这张单该不该继续存在"这个问题的答案必须在**数据上**成立。
 *
 * @why **取消在途单**而不是"标记一下让发货时再拦"：后者要每个发货/退款/通知入口
 *      都记得判一次，漏一处就是"钱货两空"；取消一次，所有下游读的都是同一个状态事实。
 *      且取消**顺带复用**了既有的迟到付款口径——单已 `cancelled` 之后到账的钱
 *      会被 `mark-paid` 判成 `late_payment`（40902）转对账/人工退款，
 *      不需要为"被拉黑的人付了款"新造一条判定路径（约束九：两份判定必然漂移）。
 *
 * @why 走 `withUnitOfWork`（不是 `withTransaction`）：要发 `order.cancelled`，
 *      而 `order.cancelled` 的订阅者（`app/close-session-events.ts`）负责
 *      **作废机构侧会话**——那笔 Stripe Checkout 必须真的死掉，
 *      否则被拉黑者拿着旧链接仍能付（付了才被拒落账，要人工退款）。
 *      事件必须在提交后分发（@see unit-of-work.ts 的 @why）。
 *
 * @limitation 一：**只取消在途单**（`created` / `pending_payment`）。已付单不碰——
 *              `paid → cancelled` 不在状态迁移表里，且已付的钱只能走退款链路；
 *              "已付但还没发货"的处置是**运营判断**（退款还是照发），不由本用例代劳。
 * @limitation 二：**幂等靠迁移守卫**而不是靠"已拉黑就跳过"：即使 `already=true`
 *              也照常扫描并取消一轮。@why 重复拉黑时 `markOrderCancelled` 对已取消的单
 *              返回 false（0 行命中），不会重复回补库存；而"首次拉黑之后又建了单"
 *              （理论上不该发生，但纵深上值得覆盖）会被这一轮补掉。
 * @limitation 三：库存回补**汇总后一次性**做（A3）：逐单回补的总锁序是"每单内升序"的串接，
 *              不是全局升序，与建单的扣减路径可能成环 → 40P01。
 * @limitation 四：**可选**的 `order_id` 凭据（ADM3-01 纵深防御 / AJ-290）：带了就核对归属，
 *              不带不加约束。它**挡不住**"人看错了面板"（那种情况下 order_id 与 user_id
 *              是自洽的，那一层由前端清空待确认态解决，AJ-256）；它挡的是请求级的配错。
 *
 * @see adapters/risk-admin.ts（封号 SQL）；adapters/orders.ts（锁单 / 迁移 / 回补 / 归属核对）；
 *      app/close-session-events.ts（事件订阅者）；app/admin-risk-routes.ts（唯一调用方）；
 *      app/mark-paid.ts @limitation 一b（迟到付款守卫：本用例的下游闭环）
 */
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';
import {
  lockPayableOrdersOfUser,
  markOrderCancelled,
  orderBelongsToUser,
  restoreStockForOrders,
  voidInitiatedPayment,
} from '../adapters/orders.js';
import { withUnitOfWork } from './unit-of-work.js';
import type { BlockOutcome, RiskAdminRepo } from '../adapters/risk-admin.js';

/** 结果 = 仓储的判别联合 + 连带取消的订单 id（调用方要写日志 / 要能测）。 */
export type BlockUserResult =
  | (BlockOutcome & { cancelledOrderIds: string[] })
  /** 带了 `order_id` 但归属核对不过（ADM3-01 纵深防御 / AJ-290）：**一点没写**。 */
  | { kind: 'order_mismatch'; cancelledOrderIds: [] };

export interface BlockUserDeps {
  db: Db;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  repo: RiskAdminRepo;
}

export interface BlockUserInput {
  /** 要拉黑的用户（路径参数 `{id}`）。 */
  userId: string;
  /**
   * **可选**：发起这次拉黑的那一单（风控页点"处理"的那一单）。
   * 带了就在封号**之前**核对它属于 `userId`（ADM3-01 纵深防御 / AJ-290）。
   */
  orderId?: string | undefined;
}

/**
 * 拉黑（幂等）。**封号与取消在途单要么一起落，要么一起滚。**
 *
 * @throws 不抛业务错：`not_found` / `is_admin` / `order_mismatch` 以判别联合返回，
 *         由路由层转 40403 / 40911 / 40915（三条路径的处置动作不同，
 *         折叠成一个码会误导运营，见 admin-risk-routes.ts @why）。
 */
export async function blockUser(
  deps: BlockUserDeps,
  input: BlockUserInput,
): Promise<BlockUserResult> {
  const { db, events, clock, logger, repo } = deps;
  const { userId, orderId } = input;

  return withUnitOfWork(db, events, async (tx, emit) => {
    // ── 凭据核对必须在**任何写入之前**（AJ-290）──
    // @why 拉黑不可逆且没有解除接口。放在 `repo.blockUser` 之后的话，
    //      "核对不过"这条路径上人已经被封了（事务里的 update 已经跑过），
    //      此时返回"拒绝"是**谎言**——而返回"成功"就更糟。先核对，拒绝才真的是拒绝。
    // @why 不抛 AppError 而走判别联合：与 not_found / is_admin 同一条约定
    //      （本用例不抛业务错，转码是路由层的职责）。
    // @limitation 四：**这条核对优先于 40403 / 40911**——若 `{id}` 不存在、
    //      或对方是管理员**且**带了不属于他的 order_id，会先报 40915。
    //      @why 风控页总是从同一张单的详情里同时拿到 order_id 与 user_id，
    //      两者不可能只有一个错；能造出这种组合的只有手搓请求，
    //      而 40915 的处置动作（关掉面板、回列表重新点"处理"）对它也成立。
    //      ⚠️ 代价记在这里：不假装"码的优先级"在所有输入下都符合直觉。
    if (orderId !== undefined && !(await orderBelongsToUser(tx, orderId, userId))) {
      return { kind: 'order_mismatch', cancelledOrderIds: [] };
    }

    const outcome = await repo.blockUser(tx, userId);
    if (outcome.kind !== 'blocked') {
      return { ...outcome, cancelledOrderIds: [] } as BlockUserResult;
    }

    const at = clock.now();
    const orderIds = await lockPayableOrdersOfUser(tx, userId);
    const cancelled: string[] = [];
    let voided = 0;
    for (const orderId of orderIds) {
      // false = 被并发抢先迁走（恰好落账/关单），不是错误、不发事件（与 expire-orders 同口径）
      if (!(await markOrderCancelled(tx, orderId, userId, at, 'admin:block'))) continue;
      cancelled.push(orderId);
      voided += await voidInitiatedPayment(tx, orderId);
      emit({ name: 'order.cancelled', at: at.toISOString(), orderId });
    }
    // 汇总后一次性回补（@limitation 三：全局锁序）
    const restored = cancelled.length > 0 ? await restoreStockForOrders(tx, cancelled) : 0;

    logger.info('block_user_orders_cancelled', {
      result: 'ok',
      // ⚠️ 不能写 `actor`：logger 保留键（§2 第 41 条）。记"对象"用 target_user_id。
      ctx: {
        target_user_id: userId,
        cancelled: cancelled.length,
        payments_voided: voided,
        stock_rows_restored: restored,
      },
    });
    return { kind: 'blocked', already: outcome.already, cancelledOrderIds: cancelled };
  });
}
