/**
 * 职责：运营日志的只读查询（剩余清单 3-2）——管理员操作审计 `admin_audit`、每日对账结果 `reconciliation_runs`。
 *
 * @why 只选列表要用的列，**不选 before / after**：审计中间件记的是改动前后的业务快照，
 *      列表页用不到，而它们可能含地址、改价前后等业务数据——少 select 一列就少一处"顺手下发"的机会。
 * @limitation 过滤只支持 actor / target 精确匹配（两者都有索引：actor+created_at、target+created_at）；
 *             按 action 模糊查需要新索引，等真有需求再加。
 * @see migrations/002_hardening.sql（admin_audit）；migrations/028_reconciliation_runs.sql
 */
import type { Db } from './db.js';

export interface AuditListQuery {
  page: number;
  size: number;
  actor?: string | undefined;
  target?: string | undefined;
  /**
   * 操作时间窗（评估 P2，2026-10-09）：`created_at >= createdFrom` 且 `< createdTo`（左闭右开；
   * JST 日界由 shared `parseJstDateRange` 算好，与订单列表的下单日期同一函数）。
   */
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
}

export interface AuditRow {
  id: number;
  actor: string;
  /** 操作人邮箱（actor = `admin:<id>` 时按 users 查得；CLI / 已删账号为 null。三端联动 UI 模拟 2026-10-08）。 */
  actorEmail: string | null;
  action: string;
  target: string | null;
  /**
   * 对象的人话名（AJ-499）：订单 → 订单号，商品 → 商品名；认不出（图片键、分类键、批量发货摘要……）为 null。
   * @why 运营日志"对象"列原只有内部 id（ord-… / 商品 uuid），运营认不出是哪张单、哪件商品（全入口点击测试 2026-10-12）。
   * @limitation 按 target 与 orders.id / products.id 主键相等关联：对象被删了（商品物理删除）就回落为 null，前端照旧显示缩短 id。
   */
  targetLabel: string | null;
  statusCode: number | null;
  traceId: string | null;
  createdAt: Date;
}

export interface ReconciliationRunRow {
  ranAt: Date;
  counts: Record<string, number>;
  samples: Record<string, string[]>;
}

export async function listAdminAudit(
  db: Db,
  q: AuditListQuery,
): Promise<{ items: AuditRow[]; total: number }> {
  // 操作人可按**邮箱**筛（含 @ 时）：运营记得的是同事邮箱，不是 `admin:<内部 id>`（三端联动 UI 模拟 2026-10-08）。
  //   邮箱 → id 走 users 主键表，仍落在 (actor, created_at) 索引上。
  const actorCond =
    q.actor === undefined
      ? db`true`
      : q.actor.includes('@')
        ? db`a.actor in (select 'admin:' || u2.id from users u2 where lower(u2.email) = ${q.actor.toLowerCase()})`
        : db`a.actor = ${q.actor}`;
  const where = db`
    where (${actorCond})
      and (${q.target === undefined ? db`true` : db`a.target = ${q.target}`})
      and (${q.createdFrom === undefined ? db`true` : db`a.created_at >= ${q.createdFrom}`})
      and (${q.createdTo === undefined ? db`true` : db`a.created_at < ${q.createdTo}`})`;
  const rows = await db`
    select a.id, a.actor, a.action, a.target, a.status_code, a.trace_id, a.created_at, u.email as actor_email,
           coalesce(o.order_no, p.title) as target_label
      from admin_audit a
      left join users u on a.actor = 'admin:' || u.id
      left join orders o on o.id = a.target
      left join products p on p.id = a.target
      ${where}
     order by a.created_at desc, a.id desc
     limit ${q.size} offset ${(q.page - 1) * q.size}`;
  const [c] = await db`select count(*)::int as n from admin_audit a ${where}`;
  return {
    total: Number(c?.['n'] ?? 0),
    items: rows.map((r) => ({
      id: Number(r['id']),
      actor: String(r['actor']),
      actorEmail: typeof r['actor_email'] === 'string' ? r['actor_email'] : null,
      action: String(r['action']),
      target: r['target'] === null ? null : String(r['target']),
      targetLabel: typeof r['target_label'] === 'string' ? r['target_label'] : null,
      statusCode: r['status_code'] === null ? null : Number(r['status_code']),
      traceId: r['trace_id'] === null ? null : String(r['trace_id']),
      createdAt: r['created_at'] as Date,
    })),
  };
}

/** 最近一次对账；没跑过 → null。 */
export async function latestReconciliation(db: Db): Promise<ReconciliationRunRow | null> {
  const [r] = await db`
    select ran_at, counts, samples from reconciliation_runs order by ran_at desc, id desc limit 1`;
  if (r === undefined) return null;
  return {
    ranAt: r['ran_at'] as Date,
    counts: r['counts'] as Record<string, number>,
    samples: r['samples'] as Record<string, string[]>,
  };
}

/** 对账作业写一行（append-only，见迁移 028）。 */
export async function insertReconciliationRun(
  db: Db,
  run: ReconciliationRunRow & { traceId?: string | undefined },
): Promise<void> {
  await db`
    insert into reconciliation_runs (ran_at, counts, samples, trace_id)
    values (${run.ranAt}, ${db.json(run.counts)}, ${db.json(run.samples)}, ${run.traceId ?? null})`;
}
