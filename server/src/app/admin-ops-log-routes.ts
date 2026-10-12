/**
 * 职责：运营日志接口（剩余清单 3-2）。
 *   GET /api/v1/admin/audit                    管理员操作审计分页（actor / target 精确过滤）
 *   GET /api/v1/admin/reconciliation/latest    最近一次每日对账结果
 *
 * @why 只读：两张表都是 append-only，这里不提供任何写入口。
 * @why 本身也是 /api/v1/admin 前缀下的 GET——审计中间件只记写操作，"谁查过审计"不进审计（避免自我膨胀）。
 * @limitation 不下发 before / after（见 adapters/ops-log.ts @why）；要看改动细节去库里按 id 查。
 * @see adapters/ops-log.ts；contracts/api-contract.yaml 0.6.32
 */
import type { Express } from 'express';
import { parseJstDateRange } from '@waselect/shared';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { latestReconciliation, listAdminAudit, sampleOrders } from '../adapters/ops-log.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';

export interface AdminOpsLogRoutesDeps {
  db: Db;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/** 可选的精确过滤参数：非字符串 / 空串 → 40001（不静默当成"不过滤"）。 */
function optionalExact(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '')
    throw new AppError(40001, { reason: `${name}_invalid` });
  return v.trim();
}

export function mountAdminOpsLogRoutes(app: Express, deps: AdminOpsLogRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.get('/api/v1/admin/audit', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = req.query as Record<string, unknown>;
        const page = q['page'] === undefined ? 1 : Number(q['page']);
        const size = q['size'] === undefined ? 50 : Number(q['size']);
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > 100
        ) {
          throw new AppError(40001, { reason: 'page_size_invalid' });
        }
        // 评估 P2（契约 0.6.53）：日期范围，口径同订单列表（JST 日历日、两端都含；格式不对 / 倒置 → 40001）
        const asStr = (v: unknown): string | undefined =>
          typeof v === 'string' ? v : v === undefined ? undefined : '';
        const range = parseJstDateRange(asStr(q['created_from']), asStr(q['created_to']));
        if (!range.ok) throw new AppError(40001, { reason: range.reason });
        const r = await listAdminAudit(deps.db, {
          page,
          size,
          actor: optionalExact(q['actor'], 'actor'),
          target: optionalExact(q['target'], 'target'),
          ...(range.from !== null ? { createdFrom: range.from } : {}),
          ...(range.to !== null ? { createdTo: range.to } : {}),
        });
        res.json({
          total: r.total,
          items: r.items.map((i) => ({
            id: i.id,
            actor: i.actor,
            ...(i.actorEmail !== null ? { actor_email: i.actorEmail } : {}),
            action: i.action,
            ...(i.target !== null ? { target: i.target } : {}),
            // AJ-499：订单号 / 商品名（认不出不带）
            ...(i.targetLabel !== null ? { target_label: i.targetLabel } : {}),
            ...(i.statusCode !== null ? { status_code: i.statusCode } : {}),
            ...(i.traceId !== null ? { trace_id: i.traceId } : {}),
            created_at: i.createdAt.toISOString(),
          })),
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/reconciliation/latest', guard, (_req, res, next) => {
    void (async () => {
      try {
        const run = await latestReconciliation(deps.db);
        res.json({
          run:
            run === null
              ? null
              : {
                  ran_at: run.ranAt.toISOString(),
                  counts: run.counts,
                  samples: run.samples,
                  // 取样换成订单号给运营看（两端逐页走查 2026-10-12；@see sampleOrders）
                  sample_orders: await sampleOrders(deps.db, run.samples),
                },
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
