/**
 * 职责：售后申请仓储（迁移 038，AJ-420）——插一条、按单列出、取最新一条、锁一条改状态。
 *
 * @why 插入撞部分唯一索引 `uq_after_sale_requests_open`（23505）时返回 `null`，不抛：
 *      "这单已有进行中的申请"是可预期的业务结果（买家连点），调用方要把它折成 40902 而不是 500。
 *      只认这一个约束名——别的 23505（例如主键）仍按异常抛，不被误吞成"已有申请"。
 * @why created_at / updated_at 由调用方传入（Clock 端口），与 order_notes 同口径。
 * @limitation 没有分页：一张订单的售后申请是个位数。
 * @see migrations/038_after_sale_requests.sql；app/after-sale-routes.ts
 */
import {
  AFTER_SALE_OPEN_STATUSES,
  type AfterSaleReason,
  type AfterSaleStatus,
} from '@waselect/shared';
import type { Db } from './db.js';

export interface AfterSaleRow {
  id: string;
  order_id: string;
  user_id: string;
  reason: AfterSaleReason;
  description: string;
  status: AfterSaleStatus;
  resolution_note: string | null;
  handled_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'id, order_id, user_id, reason, description, status, resolution_note, handled_by, created_at, updated_at';

function toRow(r: Record<string, unknown>): AfterSaleRow {
  return {
    id: String(r['id']),
    order_id: String(r['order_id']),
    user_id: String(r['user_id']),
    reason: String(r['reason']) as AfterSaleReason,
    description: String(r['description']),
    status: String(r['status']) as AfterSaleStatus,
    resolution_note: typeof r['resolution_note'] === 'string' ? r['resolution_note'] : null,
    handled_by: typeof r['handled_by'] === 'string' ? r['handled_by'] : null,
    created_at: r['created_at'] as Date,
    updated_at: r['updated_at'] as Date,
  };
}

/** 插入一条；已有进行中的申请 → `null`（见文件头 @why 一）。 */
export async function insertAfterSale(
  db: Db,
  a: {
    id: string;
    orderId: string;
    userId: string;
    reason: AfterSaleReason;
    description: string;
    at: Date;
  },
): Promise<AfterSaleRow | null> {
  try {
    const [r] = await db`
      insert into after_sale_requests (id, order_id, user_id, reason, description, created_at, updated_at)
      values (${a.id}, ${a.orderId}, ${a.userId}, ${a.reason}, ${a.description}, ${a.at}, ${a.at})
      returning ${db.unsafe(COLS)}`;
    if (r === undefined) throw new Error('after_sale_requests insert returned no row');
    return toRow(r);
  } catch (e) {
    // @measured postgres.js 3.4.9 + PostgreSQL 16.15，撞**部分**唯一索引（临时表探针 uq_t_probe）：
    //   {"code":"23505","constraint_name":"uq_t_probe","message":"duplicate key value violates unique constraint \"uq_t_probe\""}
    //   → SQLSTATE 在 `.code`，索引名在 `.constraint_name`（部分唯一索引也填，不只是表约束）。
    const pg = e as { code?: string; constraint_name?: string };
    if (pg.code === '23505' && pg.constraint_name === 'uq_after_sale_requests_open') return null;
    throw e;
  }
}

/** 一张单的全部申请，按提交先后。 */
export async function listAfterSales(db: Db, orderId: string): Promise<AfterSaleRow[]> {
  const rows = await db`
    select ${db.unsafe(COLS)} from after_sale_requests
     where order_id = ${orderId} order by created_at, id`;
  return rows.map(toRow);
}

/** 一张单最新的一条（买家详情只展示这条）；没有 → null。 */
export async function findLatestAfterSale(db: Db, orderId: string): Promise<AfterSaleRow | null> {
  const [r] = await db`
    select ${db.unsafe(COLS)} from after_sale_requests
     where order_id = ${orderId} order by created_at desc, id desc limit 1`;
  return r === undefined ? null : toRow(r);
}

/** 锁住一条（必须属于该订单）；不存在 → null。须在事务里调。 */
export async function lockAfterSale(
  tx: Db,
  orderId: string,
  id: string,
): Promise<AfterSaleRow | null> {
  const [r] = await tx`
    select ${tx.unsafe(COLS)} from after_sale_requests
     where id = ${id} and order_id = ${orderId} for update`;
  return r === undefined ? null : toRow(r);
}

/** 改状态与处理说明（流转是否合法由调用方先判）。 */
export async function updateAfterSale(
  tx: Db,
  u: { id: string; status: AfterSaleStatus; note: string | null; handledBy: string; at: Date },
): Promise<AfterSaleRow> {
  const [r] = await tx`
    update after_sale_requests
       set status = ${u.status}, resolution_note = coalesce(${u.note}, resolution_note),
           handled_by = ${u.handledBy}, updated_at = ${u.at}
     where id = ${u.id}
     returning ${tx.unsafe(COLS)}`;
  if (r === undefined) throw new Error('after_sale_requests update returned no row');
  return toRow(r);
}

/**
 * 本单有没有**进行中**的售后（open / processing；AJ-440 撤销发货闸门用）。
 * @why 口径与部分唯一索引 `uq_after_sale_requests_open` 一致：那条索引定义了什么叫"进行中"。
 * @why 取值**从 shared 取**而不是在 SQL 里写字面量（规律排查 2026-10-13）：原先写死
 *      `status in ('open', 'processing')`，是全仓第 6 份副本。漂移的后果是撤销发货闸门放行
 *      "其实还有一条进行中的申请"的单——运营撤了发货，买家那边的售后还在等处理。
 *      ⚠️ 索引本体（`WHERE status IN (...)`，迁移 038）**仍是另一份**，且迁移不可改写：
 *      往"进行中"里加一档时，除了 shared 还要**加一条新迁移**改 CHECK 与索引，否则
 *      唯一索引不再覆盖新状态（两条并存的申请不会被 23505 拦下）。这一点写在门禁的 @limitation 里。
 * @why 写法与 `adapters/orders.ts` 的三处（132 / 554 / 646，管理端待办、买家售后页签、订单筛选）
 *      **完全一致**（`in ${db([...AFTER_SALE_OPEN_STATUSES])}`）——那不是巧合，是同一个判据在四个查询里
 *      共用一种形态，将来再被抄走时也有个"看着眼熟"的样板。
 */
export async function hasOpenAfterSale(db: Db, orderId: string): Promise<boolean> {
  const rows = await db`
    select 1 from after_sale_requests where order_id = ${orderId} and status in ${db([...AFTER_SALE_OPEN_STATUSES])} limit 1`;
  return rows.length > 0;
}
