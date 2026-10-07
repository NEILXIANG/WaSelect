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
 * @limitation 一：`admin_audit` 由 /api/v1/admin 前缀上的审计中间件统一写（F-02 / AJ-183，app/admin-audit.ts）：
 *              拉黑成功即留一行（actor / target / trace_id），本路由不直接写表。
 * @limitation 二：拉黑**本进程即时生效**（F-06 / AJ-183：成功后作废身份缓存）；多实例时其它实例仍要等
 *              60 秒 TTL——render.yaml 固定单实例并由 render-env.unit.test.ts 钉住。
 * @limitation 三：拉黑**连带取消该用户的在途单**（B28 / AJ-213），由 `app/block-user.ts` 承担——
 *              本路由只负责"翻译成 HTTP"：判别联合 → 40403 / 40911，成功 → 空体 + 日志。
 *              ⚠️ 取消的订单 id 要进日志：封号是**不可逆**的写操作
 *              （⚠️ 曾经写"唯一不可逆"——不成立：运费整表替换
 *               `admin-ops-routes.ts` 与 Banner 删除 `admin-banner-routes.ts` 同样不可逆，
 *               三处各自都写了"要取改前值"，凭的是**同一条**理由而不是三件不同的事），
 *              "连带关掉了哪几张单"将来只能靠日志答得出来。
 * @limitation 四：请求体可带**可选**的 `order_id` 凭据（ADM3-01 纵深防御 / AJ-290）：
 *              带了由服务端核对"这张单属于 `{id}`"，不过 → **40915**（一点没写）；
 *              不带 → 不加约束。🈲 非字符串 / 空串不得静默当成"没传"——
 *              那会让校验看起来在而实际不在。@see app/block-user.ts @limitation 四
 *
 * @see adapters/risk-admin.ts（仓储）；app/block-user.ts（拉黑用例）；
 *      domain/dispute-input.ts（status 校验）；
 *      contracts/api-contract.yaml 0.6.5（Dispute、两条路由的响应清单）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import type { AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { requireRole } from './auth.js';
import { createRiskAdminRepo, type DisputeRow } from '../adapters/risk-admin.js';
import { parseDisputeStatus } from '../domain/dispute-input.js';
import { blockUser } from './block-user.js';
import { releaseReasonGuard } from '../domain/admin-order-actions.js';
import { setAuditBefore } from './admin-audit.js';

export interface AdminRiskRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
  /** 拉黑要发 `order.cancelled`（连带作废机构会话），见 `app/block-user.ts` 文件头。 */
  events: EventBus;
  clock: Clock;
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

  /**
   * 已拉黑的用户（AJ-384）：解除入口要先能找到人。只给 id / 拉黑时刻 / 注册时刻 / 订单数，不给 openid 等身份字段。
   */
  app.get('/api/v1/admin/users', guard, (req, res, next) => {
    void (async () => {
      try {
        if (req.query['blocked'] !== 'true') {
          throw new AppError(40001, { reason: 'only_blocked_true_supported' });
        }
        const rows = await repo.listBlockedUsers();
        res.json({
          items: rows.map((r) => ({
            id: r.id,
            blocked_at: r.blockedAt.toISOString(),
            created_at: r.createdAt.toISOString(),
            order_count: r.orderCount,
          })),
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  /**
   * 解除拉黑（AJ-384；工程缺口第二轮 §6.3 G7）。原因必填（进审计）。
   * @why 原先没有解除接口，误拉黑只能直接改库——绕过审计，事后答不出谁、为什么解封。
   * @why 拉黑时被连带取消的在途单**不恢复**：库存已回补，恢复会超卖；买家重新下单即可。
   * @why 作废本进程身份缓存：不作废的话"已拉黑"还会被缓存最多 60 秒（与拉黑同口径）。
   */
  app.post('/api/v1/admin/users/:id/unblock', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const reason = releaseReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reason.ok) throw new AppError(reason.code, { reason: reason.reason });
        const out = await repo.unblockUser(id);
        if (out.kind === 'not_found') throw new AppError(40403, { target_user_id: id });
        setAuditBefore(res, { blocked_at: out.blockedAt?.toISOString() ?? null });
        deps.identity.invalidate?.(id);
        deps.logger.info('admin_user_unblocked', {
          result: 'ok',
          ctx: { target_user_id: id, already_unblocked: out.already },
        });
        res.json({ already_unblocked: out.already });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/users/:id/block', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        // 可选的订单凭据（ADM3-01 纵深防御 / AJ-290）：**传了才校验**，不传不加约束。
        // ⚠️ 非字符串（数字 / 数组 / 对象）一律 40001，不静默当成"没传"——
        //    "静默退化成不校验"正是纵深防御最容易烂掉的方式（看起来在校验，实际没有）。
        const rawOrderId = (req.body as { order_id?: unknown } | null)?.order_id;
        let orderId: string | undefined;
        if (rawOrderId !== undefined) {
          if (typeof rawOrderId !== 'string' || rawOrderId.trim() === '') {
            throw new AppError(40001, { reason: 'order_id_must_be_non_empty_string' });
          }
          orderId = rawOrderId.trim();
        }
        const outcome = await blockUser(
          { db: deps.db, events: deps.events, clock: deps.clock, logger: deps.logger, repo },
          { userId: id, ...(orderId === undefined ? {} : { orderId }) },
        );
        if (outcome.kind === 'not_found') throw new AppError(40403, { target_user_id: id });
        if (outcome.kind === 'is_admin') throw new AppError(40911, { target_user_id: id });
        // 归属核对不过：**一点没写**（核对在封号之前，@see app/block-user.ts）。
        // ⚠️ 不能用 40403 / 40400：用户是在的，也不涉及"别人的资源要防探测"——
        //    运营照那两个码会去刷用户列表，而该刷的是拒付列表。
        if (outcome.kind === 'order_mismatch') {
          throw new AppError(40915, { target_user_id: id, order_id: orderId ?? '' });
        }
        // 即时生效（F-06 / AJ-183）：作废本进程的身份缓存，被拉黑者的下一个请求就回源、就被拒——
        // 不作废的话缓存命中还会放行最多 60 秒（IDENTITY_CACHE_TTL_MS）
        deps.identity.invalidate?.(id);
        deps.logger.info('admin_user_blocked', {
          result: 'ok',
          // ⚠️ 不能写 `actor`：那是 logger 的保留键（由 requireRole 写入上下文），
          //    调用点传会直接抛 TypeError → 500（§2 第 41 条）。记"对象"用 target_user_id。
          ctx: {
            target_user_id: id,
            already_blocked: outcome.already,
            cancelled_order_ids: outcome.cancelledOrderIds,
            // 凭据进日志：将来要答"这次拉黑是从哪一单发起的"，只有这里记着。
            ...(orderId === undefined ? {} : { order_id: orderId }),
          },
        });
        res.status(200).end();
      } catch (e) {
        next(e);
      }
    })();
  });
}
