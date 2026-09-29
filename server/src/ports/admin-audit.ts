/**
 * 职责：管理端操作审计（流 B，ADR-29）的**写入端口**（F-02 / AJ-183）。
 *
 * @why 端口而不是各路由直接 insert：审计是"每条管理端写接口都要有"的横切关注点，
 *      直接写就会出现"第一份实现 + 后面各抄一遍"（admin-ops-routes.ts 早先的 @why 正是因此不肯先写）。
 *      唯一调用方是 app/admin-audit.ts 的中间件：路由不需要知道审计的存在。
 * @limitation 只追加不修改（表上有 append-only 触发器，迁移 002）；端口也只给 append。
 *
 * @see migrations/002_hardening.sql（admin_audit）；app/admin-audit.ts；adapters/admin-audit.ts
 */

/** 一条审计记录（列与 admin_audit 一一对应）。 */
export interface AdminAuditEntry {
  /** `admin:<sub>`（与 order_events.actor 同口径）。 */
  actor: string;
  /** `方法 + 路由模板`，如 `PATCH /admin/products/:id/status`（≤64）。 */
  action: string;
  /** 路径参数 id（没有则 null，≤128）。 */
  target: string | null;
  /** 改前值（路由显式提供时才有，见 app/admin-audit.ts setAuditBefore）。 */
  before: unknown;
  /** 请求体（已脱敏）。 */
  after: unknown;
  traceId: string | null;
  reqId: string | null;
}

export interface AdminAuditStore {
  append(entry: AdminAuditEntry): Promise<void>;
}
