/**
 * 职责：`AdminAuditStore` 的 Postgres 实现——往 `admin_audit` 追加一行（F-02 / AJ-183）。
 *
 * @why JSONB 列用 `db.json()` 传对象（单重编码；`${字符串}::jsonb` 会双重编码，见 adapters/orders.ts 的 ⚠️）。
 *      undefined / null 一律写 SQL NULL（"没有改前值"与"改前值是 null"在审计语义上不区分）。
 * @limitation 字段长度按列宽截断（action 64 / target 128）：超长的只会是路由模板或 id 本身异常，
 *             截断后仍可检索，比 22001 让整条审计丢掉好。
 *
 * @see ports/admin-audit.ts；migrations/002_hardening.sql
 */
import type { Db, JSONValue } from './db.js';
import type { AdminAuditEntry, AdminAuditStore } from '../ports/admin-audit.js';

function jsonOrNull(db: Db, v: unknown) {
  return v === undefined || v === null ? null : db.json(v as JSONValue);
}

export function createAdminAuditStore(db: Db): AdminAuditStore {
  return {
    async append(e: AdminAuditEntry): Promise<void> {
      await db`
        insert into admin_audit (actor, action, target, before, after, trace_id, req_id)
        values (${e.actor}, ${e.action.slice(0, 64)}, ${e.target === null ? null : e.target.slice(0, 128)},
                ${jsonOrNull(db, e.before)}, ${jsonOrNull(db, e.after)}, ${e.traceId}, ${e.reqId})
      `;
    },
  };
}
