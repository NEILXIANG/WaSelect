/**
 * 职责：管理端订单端点（I2 U-B2d）——`GET /admin/orders`、`GET /admin/orders/{id}`、
 *      `POST /admin/orders/{id}/ship`、`/refund`、`/address`。
 *
 * @why 五条路由共用**一个** `requireAdmin` 守卫实例（与 admin-product-routes 同口径）：
 *      守卫抄五遍，"将来要不要加一条审计"就得改五处，漏一处就是
 *      "某条管理端接口没守卫"——而这种漏法不会报错，只会静默地裸露。
 *
 * @why 响应里的订单主键叫 **`order_id`** 而不是 `id`（契约 `OrderSummary` 的字段名）：
 *      前端的形状断言**硬失败**在缺 `order_id` 上（`admin-web/src/orders/api.ts`
 *      @limitation 一），叫错名字的表现是"整页空白 + 网络错误"，
 *      而真因只是键名——这类错最贵的地方在于它指向完全错误的排查方向。
 *
 * @limitation 一：三个写操作都是"**事务内持锁判定 + 迁移**，**事务外调机构**"。
 *              退款的机构调用（`provider.refund`）绝不能在事务里做：
 *              事务持着 orders 行锁去等一个外部 HTTP，等于把数据库的行锁时长
 *              押在别人的响应时间上。代价是"迁移成功、机构调用失败"会留下
 *              一个停在 `refunding` 的订单（看得见、可捞、可人工重试），
 *              而不是"整单回滚、钱货对不上但没人知道"（AJ-146）。
 *              ⚠️ 但"机构调用"里**有一半不属于事务外**：通道解析（`registry.getForRefund`）
 *              是纯配置查找，必须在事务内、落 refunding 之前做——放到事务外就是
 *              "订单已迁 refunding、却拿不到 provider"，永久卡单（B8 / AJ-192）。
 * @limitation 二：`includeTest` **不在路由上开放**（仓储支持、路由不接）：
 *              契约只声明了 status / keyword / page / size，而管理端目前没有
 *              "显示测试单"的开关。等要加开关的那天**先改契约再开参数**——
 *              顺序不能倒（否则又是"契约比实现严格"的漂移）。
 *              ⚠️ 因此"按单号搜测试单"仍然可用（keyword 会绕过 is_test 过滤，
 *              见 `orders-admin.ts` @limitation 三），只是列表里默认看不到。
 * @limitation 三：改址后的快照 `id` 恒为 **null**：它表示"这条地址来自哪个地址簿条目"，
 *              而管理员手改出来的地址**不属于任何一条地址簿记录**——
 *              沿用旧 id 会让快照声称自己等于一个它已经不等于的地址。
 *
 * @see adapters/orders-admin.ts（仓储）；domain/admin-order-actions.ts（准入判定）；
 *      domain/address-input.ts（地址校验）；contracts/api-contract.yaml（AdminOrder / AdminOrderListItem）
 */
import type { Express, Request } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import { withTransaction } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { PaymentRegistry } from '../ports/payment.js';
import { executeRefund } from './refund-execution.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { ORDER_STATUS } from '@waselect/shared';
import { asOrderStatus } from '../domain/order.js';
import {
  ADMIN_NOTE_MAX_LENGTH,
  addressGuard,
  refundGuard,
  refundReasonGuard,
  releaseReasonGuard,
  shipGuard,
} from '../domain/admin-order-actions.js';
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { setAuditBefore } from './admin-audit.js';
import { parseAddressInput } from '../domain/address-input.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import {
  findAdminOrder,
  findRefundablePayment,
  listAdminOrders,
  listEventsFor,
  listOrderItemsFor,
  listPaymentsFor,
  lockAdminOrder,
  findRefundingReason,
  findRefundProgress,
  markRefunding,
  markShipped,
  releaseDisputeHold,
  updateAddressSnapshot,
  type AdminOrderListRow,
  type AdminOrderRow,
} from '../adapters/orders-admin.js';

export interface AdminOrderRoutesDeps {
  db: Db;
  logger: Logger;
  config: AppConfig;
  auth: AuthConfig;
  identity: IdentityCheck;
  clock: Clock;
  registry: PaymentRegistry;
}

/**
 * 事件 actor：`admin:<sub>`（技术文档 order_events.actor 口径）。
 * @why 发货 / 退款曾写成不带 id 的 `'admin'`（一致性审计 C3，AJ-176）：order_events 是订单时间线上
 *      "哪个管理员退的款"的留痕（admin_audit 自 AJ-183 起另有一行，但时间线只看 order_events），不带 id 就无从追责。
 *      `unknown` 只在守卫之后仍拿不到 sub 时出现（理论不可达：requireRole 已验签），保留是为了不抛。
 */
function adminActor(req: Request): string {
  return `admin:${req.auth?.sub ?? 'unknown'}`;
}

/** 列表行 → 契约 `AdminOrderListItem`（主键改叫 order_id，见文件头 @why）。 */
function toListItem(r: AdminOrderListRow): Record<string, unknown> {
  return {
    order_id: r.id,
    order_no: r.order_no,
    user_id: r.user_id,
    status: r.status,
    total_jpy: r.total_jpy,
    ...(r.contact_email !== null ? { contact_email: r.contact_email } : {}),
    ...(r.carrier !== null ? { carrier: r.carrier } : {}),
    ...(r.tracking_no !== null ? { tracking_no: r.tracking_no } : {}),
    ...(r.recipient !== null ? { recipient: r.recipient } : {}),
    has_dispute: r.has_dispute,
    is_test: r.is_test,
    created_at: r.created_at.toISOString(),
  };
}

/** 详情 → 契约 `AdminOrder`（= Order + 管理端专有块）。 */
function toAdminOrder(
  r: AdminOrderRow,
  items: readonly Record<string, unknown>[],
  payments: readonly Record<string, unknown>[],
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const latest = payments[payments.length - 1] as
    | { provider?: unknown; charge_currency?: unknown; charge_amount?: unknown; status?: unknown }
    | undefined;
  return {
    order_id: r.id,
    order_no: r.order_no,
    user_id: r.user_id,
    status: r.status,
    items_jpy: r.items_jpy,
    shipping_jpy: r.shipping_jpy,
    duty_jpy: r.duty_jpy,
    total_jpy: r.total_jpy,
    items,
    address: r.address_snapshot,
    fx_snapshot: r.fx_snapshot,
    terms_version: r.terms_version,
    expires_at: r.expires_at.toISOString(),
    created_at: r.created_at.toISOString(),
    has_dispute: r.has_dispute,
    is_test: r.is_test,
    payments,
    events,
    // `payment` 是契约 Order 里的"最新一条摘要"（{channel, charge_currency, charge_amount}）；与 payments 末条同源。
    // ⚠️ 键名按契约叫 `channel`：曾把末条原样透传（键叫 provider），admin-web 读 payment.channel 永远为空
    //    （一致性审计 C5，AJ-176）。明细仍在 `payments[]`（带 provider / status / 机构单号）。
    ...(latest !== undefined
      ? {
          payment: {
            channel: latest.provider,
            charge_currency: latest.charge_currency,
            charge_amount: latest.charge_amount,
          },
        }
      : {}),
    ...(r.contact_email !== null ? { contact_email: r.contact_email } : {}),
    ...(r.carrier !== null ? { carrier: r.carrier } : {}),
    ...(r.tracking_no !== null ? { tracking_no: r.tracking_no } : {}),
    ...(r.paid_at !== null ? { paid_at: r.paid_at.toISOString() } : {}),
    ...(r.shipped_at !== null ? { shipped_at: r.shipped_at.toISOString() } : {}),
  };
}

/** 分页参数校验（契约：page 默认 1，size 默认 20、最大 100）。 */
function readPaging(q: { page?: unknown; size?: unknown }): { page: number; size: number } {
  const page = q.page === undefined ? 1 : Number(q.page);
  const size = q.size === undefined ? 20 : Number(q.size);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) {
    throw new AppError(40001, { reason: 'page_size_invalid' });
  }
  return { page, size };
}

export function mountAdminOrderRoutes(app: Express, deps: AdminOrderRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const countryProfiles = createCountryProfileRepo(deps.db);

  app.get('/api/v1/admin/orders', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = req.query as {
          status?: unknown;
          keyword?: unknown;
          page?: unknown;
          size?: unknown;
        };
        const { page, size } = readPaging(q);
        const status = q.status === undefined ? undefined : String(q.status);
        if (status !== undefined && !(ORDER_STATUS as readonly string[]).includes(status)) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        const rawKw = q.keyword === undefined ? undefined : String(q.keyword).trim();
        const { items, total } = await listAdminOrders(deps.db, {
          page,
          size,
          ...(status !== undefined ? { status } : {}),
          ...(rawKw !== undefined && rawKw !== '' ? { keyword: rawKw } : {}),
        });
        res.json({ items: items.map(toListItem), total });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/orders/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const order = await findAdminOrder(deps.db, id);
        if (order === null) throw new AppError(40400, { order_id: id });
        // 三类附属数据各**一次**批量查询（本页只有一张单，但形态与列表将来共用）
        const [items, payments, events] = await Promise.all([
          listOrderItemsFor(deps.db, [id]),
          listPaymentsFor(deps.db, [id]),
          listEventsFor(deps.db, [id]),
        ]);
        res.json(
          toAdminOrder(
            order,
            items.map((i) => ({
              product_id: i.product_id,
              title: i.title_snapshot,
              qty: i.qty,
              unit_price_jpy: i.unit_price_jpy,
            })),
            payments.map((p) => ({
              provider: p.provider,
              status: p.status,
              charge_currency: p.charge_currency,
              charge_amount: p.charge_amount,
              ...(p.provider_ref !== null ? { provider_ref: p.provider_ref } : {}),
              ...(p.transaction_id !== null ? { transaction_id: p.transaction_id } : {}),
              ...(p.settled_jpy !== null ? { settled_jpy: p.settled_jpy } : {}),
              ...(p.fee_jpy !== null ? { fee_jpy: p.fee_jpy } : {}),
              created_at: p.created_at.toISOString(),
            })),
            events.map((e) => ({
              status: e.status,
              ...(e.note !== null ? { note: e.note } : {}),
              ...(e.actor !== null ? { actor: e.actor } : {}),
              at: e.at.toISOString(),
            })),
          ),
        );
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/ship', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const b = req.body as { carrier?: unknown; tracking_no?: unknown } | null;
        const carrier = typeof b?.carrier === 'string' ? b.carrier.trim() : '';
        const trackingNo = typeof b?.tracking_no === 'string' ? b.tracking_no.trim() : '';
        if (carrier === '' || trackingNo === '') {
          throw new AppError(40001, { reason: 'carrier_tracking_no_required' });
        }
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = shipGuard(asOrderStatus(row.status), row.has_dispute, row.is_test);
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          if (
            !(await markShipped(tx, id, carrier, trackingNo, deps.clock.now(), adminActor(req)))
          ) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
        });
        deps.logger.info('admin_order_shipped', { result: 'ok', order_id: id });
        res.json({ order_id: id, status: 'shipped', carrier, tracking_no: trackingNo });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/refund', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        // 理由的校验（非空 + 长度上限）在事务**之前**：见 refundReasonGuard 的 @why——
        // 上限这条如果放进事务，理由就已经被写进 append-only 的 order_events 了。
        const reasonCheck = refundReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reasonCheck.ok) {
          throw new AppError(reasonCheck.code, {
            reason: reasonCheck.reason,
            ctx: { max: REFUND_REASON_MAX_LENGTH },
          });
        }
        const reason = reasonCheck.reason;
        // ── 第一段（事务内）：持锁判定 → 落 refunding（AJ-146：先记账再对外）──
        const plan = await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = refundGuard(asOrderStatus(row.status), row.has_dispute);
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          const pay = await findRefundablePayment(tx, id);
          if (pay === null) {
            throw new AppError(40902, { order_id: id, reason: 'no_succeeded_payment' });
          }
          if (pay.provider_ref === null) {
            throw new AppError(50000, { order_id: id, reason: 'provider_ref_missing' });
          }
          // ── B8（AJ-192）：通道**必须在事务内、落 refunding 之前**解析 ──
          // @why 通道查找是纯配置查找（`registry.getForRefund`），没有任何理由放在事务外，
          //      而放在事务外的后果是"通道不可用"发生在订单**已经**迁到 refunding 之后：
          //      拿不到 provider → 40001，订单却停在 refunding；再点走的是重试分支
          //      （refunding → refunding 不是迁移，refundGuard 放行），每次都再拿一次 40001
          //      ⇒ 订单永久停在 refunding，stuck_refunds 每天报警，而它其实一分钱都没动过。
          //      典型触发面：审核期（REVIEW_MODE）的 mock 已付单在审核结束、mock 移出
          //      `PAYMENT_CHANNELS` 之后去退；以及 Stripe 凭据缺失 / 轮换期。
          //      ⚠️ 放在事务内，失败即整体回滚：订单仍是 paid，一条 refunding 事件都没有。
          // @limitation 因此 is_test（审核期测试单）在 mock 下线后**没有退款出口**——
          //      它既不能发货（AJ-179）也不能退款，只能停在 paid。这是**可见且无害**的
          //      （没有资金状态错误、不触发对账告警），而给它开"不调机构直接落 refunded"
          //      等于造一扇能把任意订单标记成已退款的门，风险远大于收益。
          //      正确的出口是"清理/归档审核期测试单"的作业，已登记为待办（AJ-192）。
          const provider = deps.registry.getForRefund(pay.provider);
          // 重试（KD-4，AJ-175）：上一次机构调用失败后订单停在 refunding。
          // 不再迁移状态（refunding → refunding 不是迁移），也不写第二条 refunding 事件；
          // 机构请求沿用**首次**的理由——机构幂等键按订单固定，换理由 = 同键异参 = 机构 400。
          // @measured(docs.stripe.com/error-low-level#idempotency, 2026-09-28)：
          //   "as long as an API method began execution, Stripe's API servers will cache the results
          //   of the request regardless of what they were"（含 500）；同键同参重试回首次结果。
          //   → 最常见的卡单原因"机构已执行、我们没收到答复"（超时/断网）：重试拿回首次那笔退款，正确。
          // @limitation 机构**报错**（HTTP 4xx/5xx，结果被缓存）时，24 小时内同键重试回的是同一个错误——
          //   重试不会成功，要么等 24 小时键过期，要么在 Stripe 控制台人工处理后再点；stuck_refunds 会报出。
          //   不改成"每次重试换新键"：原请求的结果不确定（可能已退），新键 = 可能退第二次。
          //   机构**确认失败**（退款对象 status=failed/canceled）不属于这里：F-03（AJ-178）起换新键重新发起，
          //   见 refund-execution.ts。stripe-golden-chain.db.test.ts「KD-4」「F-03」两组用例分别钉住两条路。
          let refundReason = reason; // 已由 refundReasonGuard trim 过
          if (row.status === 'refunding') {
            const original = await findRefundingReason(tx, id);
            if (original === null) {
              throw new AppError(50000, { order_id: id, reason: 'refunding_event_missing' });
            }
            refundReason = original;
            deps.logger.warn('admin_order_refund_retry', {
              result: 'retry',
              order_id: id,
              ctx: { provider: pay.provider },
            });
          } else if (
            !(await markRefunding(tx, id, refundReason, deps.clock.now(), adminActor(req)))
          ) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
          // ⚠️ 在这里把已收窄的 providerRef 带出去：出了这个闭包 TS 的收窄就丢了，
          //    而 `RefundRequest.providerRef` 是 `string`——不带上就得在调用点再判一次
          //    （或用 `!`，那等于把"这里不可能为 null"的论证从类型里拿掉）。
          const progress = await findRefundProgress(tx, id);
          return { row, pay, provider, providerRef: pay.provider_ref, refundReason, progress };
        });

        // ── 第二段（事务外）：调机构。失败不回滚——停在 refunding 是**可见**的状态 ──
        // 查询在途单 / 确认失败换键 / 结果未知同键，全部在 refund-execution.ts（F-03，AJ-178）
        const outcome = await executeRefund(deps, plan.provider, {
          orderId: id,
          paymentId: plan.pay.id,
          channel: plan.pay.provider,
          request: {
            orderId: id,
            providerRef: plan.providerRef,
            amountJpy: plan.row.total_jpy,
            currency: plan.pay.charge_currency,
            amountMinor: plan.pay.charge_amount,
            reason: plan.refundReason,
          },
          progress: plan.progress,
          actor: adminActor(req),
          // OPS3-03：拒付在途时"换新键重新发起"由执行层拦（40907）；闸门已放行 refunding 的查询与同键重放。
          // ⚠️ 只能从 `plan.row` 取：`row` 是事务闭包内的局部变量，出了闭包就不存在。
          hasDispute: Boolean(plan.row.has_dispute),
        });
        // pending：留在 refunding，单号已落库；再点即查询，超过 24h 由每日对账 stuck_refunds 报出
        deps.logger.info('admin_order_refund_accepted', {
          result: 'ok',
          order_id: id,
          ctx: { outcome },
        });
        res.status(202).json({ order_id: id, outcome });
      } catch (e) {
        next(e);
      }
    })();
  });

  /**
   * 人工解除拒付限制（B1b / AJ-194）——**逃生口**。
   *
   * @why 必须有这个口：`has_dispute` 一旦为 true，发货（40909）与退款（40907）
   *      就都被锁住，而能保证它变回 false 的路径**只有一条**——机构发来
   *      `charge.dispute.closed`。那条链会断在任何一环：机构漏发、我们当时没接住、
   *      未知状态被拒落库（`dispute_result_unknown`）、败诉单后来与买家协商好了。
   *      断了之后的终点都是"订单永久锁死，唯一解法是直连数据库改行"——
   *      那既不留痕也不可复核。
   * @why 与"结案"分开成两个动作：结案是**机构**说的（写 `payments.dispute_*`，
   *      是不可抹掉的事实），解除是**我们**说的（只动 `orders.has_dispute`）。
   *      合成一个动作就等于让人能改写机构判决——那不是逃生口，是橡皮擦。
   *      ⚠️ 所以这里**不碰** `payments.dispute_*`：风控列表照样看得到这条拒付。
   *
   * @limitation 一：**已经没锁的订单返回 40902** `dispute_not_locking`，不是幂等 200。
   *      @why 这个口最危险的用法是"点错单号却显示成功"——运营以为解开了 A 单，
   *           实际上什么都没发生（或解的是 B 单）。响亮失败比静默成功安全得多，
   *           与全仓既定的"改（PUT）命中 0 行必须 404/409"同一条口径。
   * @limitation 二：审计由 `/admin` 前缀的中间件**自动**写（`app/admin-audit.ts`），
   *              本路由不自己 insert；额外用 `setAuditBefore` 记改前值——
   *              解锁是**不可逆**的（契约没有"重新上锁"的接口），
   *              按该中间件的口径，不可逆操作才取改前值。
   * @limitation 三：~~管理端 UI 暂无这个按钮~~ **2026-10-02 已补齐（AJ-291）**：
   *              订单详情页在 `has_dispute === true` 时出现「人工解除拒付限制」
   *              （理由必填 + 两步确认），落点 `admin-web/src/orders/OrderDetail.tsx`。
   *              ⚠️ 只在**详情页**给入口，**不**放进订单列表的每一行：
   *              本动作不可逆且契约没有"重新上锁"，逐行按钮会把"点错单号"变成
   *              一次真实且收不回的解除——服务端那条 40902 是兜底，不该是主防。
   */
  app.post('/api/v1/admin/orders/:id/dispute/release', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const reasonCheck = releaseReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reasonCheck.ok) {
          throw new AppError(reasonCheck.code, {
            reason: reasonCheck.reason,
            ctx: { max: ADMIN_NOTE_MAX_LENGTH },
          });
        }
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          // 🔴 没锁着就响亮失败（@limitation 一）：静默成功会让"点错单号"变成看不见的事故。
          //    ⚠️ 行为上这一层与 `releaseDisputeHold` 的 `and has_dispute = true` **重复**——
          //    去掉它，仓储那句照样命中 0 行、照样 40902（缺陷注入实测：删掉这段用例仍全绿）。
          //    保留它是为了**日志里的 reason 正确**：仓储那层只能报 `status_raced`，
          //    而"这张单本来就没锁"和"并发下被别人抢先改了"是两件事——
          //    报成后者会让排查的人去查并发，方向整个反掉。
          if (row.has_dispute !== true) {
            throw new AppError(40902, { order_id: id, reason: 'dispute_not_locking' });
          }
          if (
            !(await releaseDisputeHold(
              tx,
              id,
              reasonCheck.reason,
              deps.clock.now(),
              adminActor(req),
            ))
          ) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
          // 不可逆 → 记改前值（admin-audit 中间件只在显式提供时才写 before）
          setAuditBefore(res, { has_dispute: true });
        });
        deps.logger.warn('admin_order_dispute_released', {
          result: 'ok',
          order_id: id,
          ctx: { reason_length: reasonCheck.reason.length },
        });
        res.json({ order_id: id, has_dispute: false });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/address', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const input = parseAddressInput(req.body);
        // 国家：表驱动的"可下单目的国"（与买家地址簿同一份校验链，只补这一步）
        const profile = await countryProfiles.get(input.country);
        if (profile === null || !profile.active) {
          throw new AppError(40002, { field: 'country', country: input.country });
        }
        // 快照 = 纯地址值：不带 is_default（订单快照没有"默认"），id 恒 null（@limitation 三）
        const snapshot = {
          id: null,
          recipient: input.recipient,
          phone: input.phone,
          line1: input.line1,
          line2: input.line2,
          city: input.city,
          state: input.state,
          postal_code: input.postal_code,
          country: input.country,
        };
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = addressGuard(asOrderStatus(row.status));
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          if (
            !(await updateAddressSnapshot(
              tx,
              id,
              snapshot as never,
              adminActor(req),
              deps.clock.now(),
            ))
          ) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
        });
        deps.logger.info('admin_order_address_changed', { result: 'ok', order_id: id });
        res.json({ order_id: id, address: snapshot });
      } catch (e) {
        next(e);
      }
    })();
  });
}
