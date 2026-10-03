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
  /**
   * 最终 HTTP 状态码（SEC2-02 / AJ-339；迁移 025）。
   *
   * @why 有了它，"审计了但没做成"这个方向才被堵住：两段式写操作（如退款）
   *      第一段事务提交后、第二段调机构失败 ⇒ 回 5xx，但**改动已经发生**（订单真的进了 refunding）。
   *      这种请求必须留痕（否则最需要查的那次退款没有审计行），
   *      而留痕就必须能区分"成了"与"没成"——否则审计反而会误导事后回溯。
   * @limitation NULL = 这一行写入时还没有这一列（历史行），或当时的中间件不记状态；
   *              **不是**"状态未知/成功"的默认值。
   */
  statusCode: number | null;
  traceId: string | null;
  reqId: string | null;
}

export interface AdminAuditStore {
  append(entry: AdminAuditEntry): Promise<void>;
}
