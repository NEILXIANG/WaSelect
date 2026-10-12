/**
 * 职责：运营日志的只读查询（剩余清单 3-2）——管理员操作审计 `admin_audit`、每日对账结果 `reconciliation_runs`。
 *
 * @why 只选列表要用的列，**不选 before / after**：审计中间件记的是改动前后的业务快照，
 *      列表页用不到，而它们可能含地址、改价前后等业务数据——少 select 一列就少一处"顺手下发"的机会。
 * @limitation 过滤只支持 actor / target 精确匹配（两者都有索引：actor+created_at、target+created_at）；
 *             按 action 模糊查需要新索引，等真有需求再加。
 *             target 认四种写法（内部 id / 订单号 / 商品名 / 账号邮箱），都是整串相等，不做模糊。
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
   * 对象的人话名（AJ-499）：订单 → 订单号，商品 → 商品名，账号 → 邮箱（有邮箱时）；认不出（图片键、分类键、批量发货摘要……）为 null。
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
  // 对象可按**页面上看得到的名字**筛（两端输入测试 2026-10-12）：对象列显示订单号 / 商品名 / 账号邮箱（AJ-499），
  //   筛选框却只认内部 id，照着表格填进去查出 0 条——内部 id 在后台界面上根本看不到。
  //   与 actorCond 同一做法：先把名字换成 id 集合，仍落在 (target, created_at) 索引上；内部 id 照旧可用（订单详情的链接用它）。
  //   @limitation 商品名要整名相同（同名商品会一起出来）；订单号兼收小写（单号本身是大写，运营照念的常写小写）。
  const targetCond =
    q.target === undefined
      ? db`true`
      : db`a.target in (
          select ${q.target}::text
          union all select o2.id from orders o2 where o2.order_no in (${q.target}, upper(${q.target}))
          union all select p2.id from products p2 where p2.title = ${q.target}
          union all select u3.id from users u3 where lower(u3.email) = ${q.target.toLowerCase()}
        )`;
  const where = db`
    where (${actorCond})
      and (${targetCond})
      and (${q.createdFrom === undefined ? db`true` : db`a.created_at >= ${q.createdFrom}`})
      and (${q.createdTo === undefined ? db`true` : db`a.created_at < ${q.createdTo}`})`;
  const rows = await db`
    select a.id, a.actor, a.action, a.target, a.status_code, a.trace_id, a.created_at, u.email as actor_email,
           coalesce(o.order_no, p.title, tu.email) as target_label
      from admin_audit a
      left join users u on a.actor = 'admin:' || u.id
      left join orders o on o.id = a.target
      left join products p on p.id = a.target
      left join users tu on tu.id = a.target
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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORDER_REF = new RegExp(`ord-${UUID}`);
const PAYMENT_REF = new RegExp(`^pay-${UUID}$`);

/**
 * 对账取样 → 所属订单（订单号），给运营看（两端逐页走查 2026-10-12）。
 * @why 取样存的是内部编号（`ord-…`、`pay-…`，以及 `order.paid:ord-…` / `evt_late_ord-…` 这类带前缀的键）——
 *      运营在后台任何地方都看不到这些编号，"示例"等于没给。读的时候换成订单号，存的仍是编号（对账行 append-only，不改历史）。
 * @limitation 只认订单与支付两种；订单已删 / 别的形状（时间、整句说明）不出现在结果里，页面退回原样显示。
 */
export async function sampleOrders(
  db: Db,
  samples: Record<string, string[]>,
): Promise<Record<string, { order_id: string; order_no: string }>> {
  const raws = [...new Set(Object.values(samples).flat())];
  const orderIdOf = new Map<string, string>();
  const payIds: string[] = [];
  for (const s of raws) {
    if (PAYMENT_REF.test(s)) payIds.push(s);
    else {
      const m = ORDER_REF.exec(s);
      if (m !== null) orderIdOf.set(s, m[0]);
    }
  }
  const payRows =
    payIds.length === 0
      ? []
      : await db<{ id: string; order_id: string }[]>`
          select id, order_id from payments where id in ${db(payIds)}`;
  for (const p of payRows) orderIdOf.set(p.id, p.order_id);
  const ids = [...new Set(orderIdOf.values())];
  const orders =
    ids.length === 0
      ? []
      : await db<{ id: string; order_no: string }[]>`
          select id, order_no from orders where id in ${db(ids)}`;
  const noOf = new Map(orders.map((o) => [o.id, o.order_no]));
  const out: Record<string, { order_id: string; order_no: string }> = {};
  for (const [raw, oid] of orderIdOf) {
    const no = noOf.get(oid);
    if (no !== undefined) out[raw] = { order_id: oid, order_no: no };
  }
  return out;
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
