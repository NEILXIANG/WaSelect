/**
 * 职责：用户行为流（流 C，ADR-29）的落库、id 存在性核对，以及**唯一的受控删除路径**——
 *       `user_events` 的唯一写入方（M-21 / AJ-409）与唯一删除方（AJ-413）。
 *
 * @why 整批**一条 INSERT**（unnest 两个并列数组）：同批要么全进要么全不进，
 *      且一次往返——埋点是全站最高频的写，逐条 INSERT 等于每次冲刷 N 次往返。
 * @why props 以 `text[]` 传入再在 SQL 里 `::jsonb`：postgres.js 对"数组里的对象"没有可靠的 jsonb 推断，
 *      先序列化成文本、让 PG 自己解析，类型由库保证（解析失败是 22P02，不会静默存成字符串）。
 * @why 删除走**事务内 GUC 窄口**（`SET LOCAL waselect.user_events_purge = 'on'`，迁移 036）：
 *      append-only 触发器只在这个 GUC 为 'on' 时放行 DELETE（UPDATE 永远拒）。两个删除函数都要求调用方传入
 *      **事务句柄**——`SET LOCAL` 在事务外只给 WARNING、不生效，于是紧接着的 DELETE 被触发器拒（42501）：
 *      拿错句柄的后果是"报错"而不是"静默删了"，这是选 SET LOCAL 而不是 SET 的全部理由。
 *      @measured（2026-10-09，PG 16.15 / postgres.js 池连接）：`purgeUserEventsByUser(db, …)` → 42501，一行未删
 *      （`user-events.db.test.ts` 边 ③）。
 * @why 删完立刻把 GUC 设回 'off'：daily 作业把多个 job 放在同一个事务里跑，口子不该留给后面的 job。
 *      失败路径不用 finally 关——DELETE 抛错时事务已中止，GUC 随事务一起消失。
 * @why 保留期清理**分批**（`USER_EVENTS_PURGE_BATCH`）：一次 DELETE 上百万行会长时间持锁、WAL 暴涨；
 *      批次大小是经验值，不是实测得来的最优值（@limitation 三）。
 *
 * @limitation 一：类型上拦不住"传进来的不是事务"（`Db` 在事务内外同一个类型），只能靠运行时 42501 兜底。
 * @limitation 二：按 user_id 删除只覆盖**登录态**写入的行；同一个人匿名时段的行（user_id 为 NULL）无法关联到他，
 *              只能等保留期到期。隐私政策的口径与此一致（"登录后的使用记录"）。
 * @limitation 三：批次 5000 与每轮上限见 app/user-events-retention.ts；真实数据量下要不要调，等上线后看 daily 的 `capped`。
 *
 * @see migrations/002_hardening.sql（表）；migrations/036_user_events_purge_path.sql（窄口触发器 + created_at 索引）；
 *      app/beacon-routes.ts（写入调用方）；app/user-events-retention.ts / app/admin-customer-routes.ts（两个删除调用方）；
 *      docs/自主决策记录.md AJ-413
 */
import type { Db } from './db.js';

export interface UserEventRow {
  event: string;
  props: Record<string, string | number>;
}
export interface UserEventBatchMeta {
  userId: string | null;
  sessionId: string;
  traceId: string | null;
  reqId: string | null;
}

export interface UserEventsRepo {
  /** 给定 id 里哪些是真实商品（不看上下架：下架商品的详情页也会被看）。 */
  existingProductIds(ids: readonly string[]): Promise<Set<string>>;
  /**
   * 给定 id 里哪些是 **userId 本人的**订单（审计 PAY-14，2026-10-14，AJ-529；原先只看存在不看归属）。
   * userId 为 null（匿名）→ 空集：匿名请求不能把事件挂到任何订单上。
   */
  ownedOrderIds(ids: readonly string[], userId: string | null): Promise<Set<string>>;
  append(meta: UserEventBatchMeta, rows: readonly UserEventRow[]): Promise<void>;
}

export function createUserEventsRepo(db: Db): UserEventsRepo {
  const productIdsIn = async (ids: readonly string[]) => {
    if (ids.length === 0) return new Set<string>();
    const found = await db<
      { id: string }[]
    >`select id from products where id = any(${[...ids]}::text[])`;
    return new Set(found.map((r) => r.id));
  };
  const ownedOrderIdsIn = async (ids: readonly string[], userId: string | null) => {
    if (ids.length === 0 || userId === null) return new Set<string>();
    const found = await db<{ id: string }[]>`
      select id from orders where id = any(${[...ids]}::text[]) and user_id = ${userId}`;
    return new Set(found.map((r) => r.id));
  };
  return {
    existingProductIds: (ids) => productIdsIn(ids),
    ownedOrderIds: (ids, userId) => ownedOrderIdsIn(ids, userId),
    async append(meta, rows) {
      if (rows.length === 0) return;
      await db`
        insert into user_events (user_id, session_id, event, props, trace_id, req_id)
        select ${meta.userId}, ${meta.sessionId}, t.e, t.p::jsonb, ${meta.traceId}, ${meta.reqId}
          from unnest(${rows.map((r) => r.event)}::text[], ${rows.map((r) => JSON.stringify(r.props))}::text[])
            with ordinality as t(e, p, n)
         order by t.n
      `;
    },
  };
}

/** 保留期（天）。隐私政策写的就是这个数（AJ-138 定、AJ-413 落地）；改它要同步改政策文案。 */
export const USER_EVENTS_RETENTION_DAYS = 180;
/** 保留期清理一批最多删的行数（@limitation 三）。 */
export const USER_EVENTS_PURGE_BATCH = 5_000;

/** 由给定时刻回退 180 天：不按天取整、不按 JST 截断（与 idempotencyCutoff 同口径）。 */
export function userEventsRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - USER_EVENTS_RETENTION_DAYS * 86_400_000);
}

/** 在**当前事务**内开 / 关触发器的窄口（迁移 036）。只有本文件会碰这个 GUC。 */
async function setPurgeGate(tx: Db, on: boolean): Promise<void> {
  if (on) await tx`set local waselect.user_events_purge = 'on'`;
  else await tx`set local waselect.user_events_purge = 'off'`;
}

/**
 * 删掉 `created_at` 早于 `cutoff` 的行，**一批最多 `batch` 行**，返回本批删除数。
 * 调用方循环到"一批没删满"为止（app/user-events-retention.ts）。`tx` 必须是事务句柄（文件头 @why）。
 */
export async function purgeExpiredUserEvents(
  tx: Db,
  cutoff: Date,
  batch: number = USER_EVENTS_PURGE_BATCH,
): Promise<number> {
  await setPurgeGate(tx, true);
  const rows = await tx`
    delete from user_events
     where id in (select id from user_events where created_at < ${cutoff} order by id limit ${batch})
    returning id
  `;
  await setPurgeGate(tx, false);
  return rows.length;
}

/**
 * 删掉某个用户的**全部**行为记录（不论多旧），返回删除数（0 = 本来就没有，不是失败）。
 * APPI「用户要求删除」的后台路径；审计由调用它的管理端路由负责（admin_audit 中间件）。`tx` 必须是事务句柄。
 */
export async function purgeUserEventsByUser(tx: Db, userId: string): Promise<number> {
  await setPurgeGate(tx, true);
  const rows = await tx`delete from user_events where user_id = ${userId} returning id`;
  await setPurgeGate(tx, false);
  return rows.length;
}
