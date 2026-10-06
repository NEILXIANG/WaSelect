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
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
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
  const where = db`
    where (${q.actor === undefined ? db`true` : db`actor = ${q.actor}`})
      and (${q.target === undefined ? db`true` : db`target = ${q.target}`})`;
  const rows = await db`
    select id, actor, action, target, status_code, trace_id, created_at
      from admin_audit ${where}
     order by created_at desc, id desc
     limit ${q.size} offset ${(q.page - 1) * q.size}`;
  const [c] = await db`select count(*)::int as n from admin_audit ${where}`;
  return {
    total: Number(c?.['n'] ?? 0),
    items: rows.map((r) => ({
      id: Number(r['id']),
      actor: String(r['actor']),
      action: String(r['action']),
      target: r['target'] === null ? null : String(r['target']),
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
