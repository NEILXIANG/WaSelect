/**
 * 职责：用户行为流（流 C，ADR-29）的落库与 id 存在性核对——`user_events` 的唯一写入方（M-21 / AJ-409）。
 *
 * @why 整批**一条 INSERT**（unnest 两个并列数组）：同批要么全进要么全不进，
 *      且一次往返——埋点是全站最高频的写，逐条 INSERT 等于每次冲刷 N 次往返。
 * @why props 以 `text[]` 传入再在 SQL 里 `::jsonb`：postgres.js 对"数组里的对象"没有可靠的 jsonb 推断，
 *      先序列化成文本、让 PG 自己解析，类型由库保证（解析失败是 22P02，不会静默存成字符串）。
 * @limitation `user_events` 有 append-only 触发器（迁移 002）：本模块**只写不改**；
 *      180 天保留期的清理与 APPI「按 user_id 删除」需要绕过触发器的专门路径，未实现（AJ-409 未做清单）。
 * @see migrations/002_hardening.sql（表与触发器）；app/beacon-routes.ts（唯一调用方）
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
  /** 给定 id 里哪些是真实订单（不看归属，理由见 beacon-routes.ts @limitation）。 */
  existingOrderIds(ids: readonly string[]): Promise<Set<string>>;
  append(meta: UserEventBatchMeta, rows: readonly UserEventRow[]): Promise<void>;
}

export function createUserEventsRepo(db: Db): UserEventsRepo {
  const idsIn = async (table: 'products' | 'orders', ids: readonly string[]) => {
    if (ids.length === 0) return new Set<string>();
    const found =
      table === 'products'
        ? await db<{ id: string }[]>`select id from products where id = any(${[...ids]}::text[])`
        : await db<{ id: string }[]>`select id from orders where id = any(${[...ids]}::text[])`;
    return new Set(found.map((r) => r.id));
  };
  return {
    existingProductIds: (ids) => idsIn('products', ids),
    existingOrderIds: (ids) => idsIn('orders', ids),
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
