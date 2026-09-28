/**
 * 职责：管理端风控端点（I2 U-E3）——`GET /admin/disputes`、`POST /admin/users/{id}/block`。
 *
 * @why 两条路由共用**一个** `requireRole` 守卫实例（与管理端其余页面同口径）：
 *      守卫抄两遍，"将来要不要加一条审计"就得改两处，漏一处就是
 *      "某条风控接口没守卫"——而这种漏法不会报错，只会静默地裸露。
 *
 * @why `POST /admin/users/{id}/block` 返回**空体**：
 *      契约只给 200、前端 `admin-web/src/risk/api.ts` 的 `blockUser` 返回 void 且不读 body，
 *      返回内容就是没有消费方的死数据（ADR-28）。⚠️ 但它必须**写业务日志**——
 *      拉黑是本项目迄今**不可逆**且直接影响真人的操作（契约没有解除接口，AJ-135），
 *      将来"谁在什么时候封了谁"只能靠日志答得出来。
 *
 * @why 拉黑有两条拒绝路径，走**不同的码**（40403 / 40911）：
 *      它们的处置动作完全不同——"人不存在"要刷新列表，"对方是管理员"要先撤管理员权限。
 *      折叠成一个码会让运营照着错误的方向去处理（与 AJ-150 里 40910 不折叠进 50000 同一条理由）。
 *
 * @limitation 一：**没有 `admin_audit` 写入**（与商品价格/订单操作同批欠账，AJ-150 已登记）。
 *              本路由只写 pino 业务日志（流 A）；等审计端口落地，这里要一并接入——
 *              风控动作是"最需要永久留痕"的那一类（应用日志有保留期，`admin_audit` 没有）。
 * @limitation 二：拉黑**不是即时生效**（`adapters/risk-admin.ts` @limitation 四）：
 *              身份缓存 60 秒，多实例各计。
 *
 * @see adapters/risk-admin.ts（仓储）；domain/dispute-input.ts（status 校验）；
 *      contracts/api-contract.yaml 0.6.5（Dispute、两条路由的响应清单）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { requireRole } from './auth.js';
import { createRiskAdminRepo, type DisputeRow } from '../adapters/risk-admin.js';
import { parseDisputeStatus } from '../domain/dispute-input.js';

export interface AdminRiskRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/** 仓储行 → 契约 `Dispute`（null / 未知值一律**省略字段**，不填空串或 0）。 */
function toDispute(r: DisputeRow): Record<string, unknown> {
  const iso = (d: Date | null): string | undefined => (d === null ? undefined : d.toISOString());
  return {
    order_id: r.orderId,
    order_no: r.orderNo,
    payment_id: r.paymentId,
    dispute_id: r.disputeId,
    ...(r.disputeStatus === null ? {} : { dispute_status: r.disputeStatus }),
    ...(r.disputeAmount === null ? {} : { dispute_amount: r.disputeAmount }),
    charge_currency: r.chargeCurrency,
    ...(iso(r.openedAt) === undefined ? {} : { opened_at: iso(r.openedAt) as string }),
    ...(iso(r.closedAt) === undefined ? {} : { closed_at: iso(r.closedAt) as string }),
  };
}

export function mountAdminRiskRoutes(app: Express, deps: AdminRiskRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const repo = createRiskAdminRepo(deps.db);

  app.get('/api/v1/admin/disputes', guard, (req, res, next) => {
    void (async () => {
      try {
        // 非法值 → 40001（domain/dispute-input.ts @why：静默当成"不过滤"会造出假的业务结论）
        const status = parseDisputeStatus(req.query['status']);
        const rows = await repo.listDisputes(status);
        res.json(rows.map(toDispute));
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/users/:id/block', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const outcome = await repo.blockUser(id);
        if (outcome.kind === 'not_found') throw new AppError(40403, { target_user_id: id });
        if (outcome.kind === 'is_admin') throw new AppError(40911, { target_user_id: id });
        deps.logger.info('admin_user_blocked', {
          result: 'ok',
          // ⚠️ 不能写 `actor`：那是 logger 的保留键（由 requireRole 写入上下文），
          //    调用点传会直接抛 TypeError → 500（§2 第 41 条）。记"对象"用 target_user_id。
          ctx: { target_user_id: id, already_blocked: outcome.already },
        });
        res.status(200).end();
      } catch (e) {
        next(e);
      }
    })();
  });
}
