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
 * @limitation 二：测试单（is_test）默认不列；`include_test=true` 才列（契约 0.6.32 先开参数、再接路由，剩余清单 3-4）。
 *              "按单号搜测试单"不受影响（keyword 会绕过 is_test 过滤，见 `orders-admin.ts` @limitation 三）。
 * @limitation 二½（AJ-400，契约 0.6.44）：列表的 `status` 可逗号分隔多选；`created_from` / `created_to` 是 JST 日历日、两端都含，
 *              解析与日界换算只在 shared `order-list-filter.ts`。CSV 导出（admin-export-routes）是**另一条 SQL**、不共用这组参数，
 *              本次不接日期筛选（导出不分页，接之前要先定区间跨度上限）。
 * @limitation 三：改址后的快照 `id` 恒为 **null**：它表示"这条地址来自哪个地址簿条目"，
 *              而管理员手改出来的地址**不属于任何一条地址簿记录**——
 *              沿用旧 id 会让快照声称自己等于一个它已经不等于的地址。
 *
 * @limitation 四（AJ-401）：发货的执行体在 `ship-order.ts`，本文件的 `/ship` 与 `admin-ship-batch-routes.ts` 共用它。
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
import { toImageSet } from './product-routes.js';
import type { Clock } from '../ports/clock.js';
import type { PaymentRegistry } from '../ports/payment.js';
import type { EventBus } from '../ports/events.js';
import { executeRefund } from './refund-execution.js';
import { sumPartialRefunds, listPartialRefunds } from '../adapters/order-refunds.js';
import { partialRefundView } from './partial-refund-routes.js';
import { fullRefundAmount } from '../domain/partial-refund.js';
import { withTrackingUrl } from '../domain/tracking.js';
import { shipOrder } from './ship-order.js';
import { findCustomer } from '../adapters/customers-admin.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import {
  parseJstDateRange,
  parseOrderStatusList,
  LIST_SORT_KEYS,
  parseListSort,
} from '@waselect/shared';
import { asOrderStatus } from '../domain/order.js';
import {
  ADMIN_NOTE_MAX_LENGTH,
  addressGuard,
  refundGuard,
  refundReasonGuard,
  releaseReasonGuard,
} from '../domain/admin-order-actions.js';
import {
  isOrderAttention,
  REFUND_REASON_MAX_LENGTH,
  SEARCH_KEYWORD_MAX_LENGTH,
  shipOverdueCutoff,
} from '@waselect/shared';
import { markAuditCommitted, setAuditAfter, setAuditBefore } from './admin-audit.js';
import { parseAddressInput } from '../domain/address-input.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import { listAfterSales } from '../adapters/after-sales.js';
import { listAddressHistory } from '../adapters/orders-admin.js';
import { adminAfterSaleView } from './after-sale-routes.js';
import {
  findAdminOrder,
  findLatePaidPayment,
  findRefundablePayment,
  hasLatePaid,
  listAdminOrders,
  listEventsFor,
  listOrderItemsFor,
  listPaymentsFor,
  lockAdminOrder,
  findRefundingReason,
  findRefundProgress,
  markRefunding,
  releaseDisputeHold,
  updateAddressSnapshot,
  type AdminOrderItemRow,
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
  /** 业务事件总线（剩余清单 2-1：发货 / 退款落定后发事件，邮件订阅者据此发信）。 */
  events: EventBus;
}

/**
 * 事件 actor：`admin:<sub>`（技术文档 order_events.actor 口径）。
 * @why 发货 / 退款曾写成不带 id 的 `'admin'`（一致性审计 C3，AJ-176）：order_events 是订单时间线上
 *      "哪个管理员退的款"的留痕（admin_audit 自 AJ-183 起另有一行，但时间线只看 order_events），不带 id 就无从追责。
 *      `unknown` 只在守卫之后仍拿不到 sub 时出现（理论不可达：requireRole 已验签），保留是为了不抛。
 */
export function adminActor(req: Request): string {
  return `admin:${req.auth?.sub ?? 'unknown'}`;
}

/**
 * 列表行 → 契约 `AdminOrderListItem`（主键改叫 order_id，见文件头 @why）。
 *
 * @param lineItems 该单的行项目（已转成 `AdminOrderItem` 形状）。
 *
 * @why 列表**固定**带 `items`，而不是"只在 `status=paid` 时带"：
 *      技术文档 §2.7 定义「待采购清单 = GET /admin/orders?status=paid」，
 *      即清单就是这条查询——筛 `paid` 之后**这一页本身就是清单**，
 *      行里必须有采购快照，否则采购员要一张张点开详情（50 单点 50 次）。
 *      ⚠️ "按查询参数决定响应形状"看起来省流量，但代价是前端永远要写 `items?` 判空，
 *      且契约只能标 optional——将来任何一处忘了判空就是"某个筛选下清单变空白"。
 *      形状固定 > 省流量：一页最多 100 单、每单 1–3 行，多出来的只是几 KB。
 * @tradeoff 放弃了"列表响应更小"（列表的其它用途，比如只看单号搜单，也带着 items）。
 *           换取的是**一种形状、没有条件分支**，以及"清单"这个用法不需要额外端点。
 */
function toListItem(
  r: AdminOrderListRow,
  lineItems: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    order_id: r.id,
    order_no: r.order_no,
    user_id: r.user_id,
    status: r.status,
    total_jpy: r.total_jpy,
    items: lineItems,
    ...(r.contact_email !== null ? { contact_email: r.contact_email } : {}),
    ...(r.carrier !== null ? { carrier: r.carrier } : {}),
    ...(r.tracking_no !== null ? { tracking_no: r.tracking_no } : {}),
    ...withTrackingUrl(r.carrier, r.tracking_no),
    ...(r.recipient !== null ? { recipient: r.recipient } : {}),
    has_dispute: r.has_dispute,
    is_test: r.is_test,
    late_paid: r.late_paid,
    // AJ-425（契约 0.6.58）：列表里一眼看见"这单有进行中的售后 / 下单人已被拉黑"
    after_sale_open: r.after_sale_open,
    user_blocked: r.user_blocked,
    // AJ-484（契约 0.6.70）：超时未发货
    ship_overdue: r.ship_overdue,
    created_at: r.created_at.toISOString(),
  };
}

/**
 * `order_items` 行 → 契约的订单行项目。
 *
 * @why 抽成函数而不是内联：详情与（将来的）待采购清单都要同一份形状。
 *      两处各写一份 `items.map(...)` 的结果是"详情带了 jan_code、清单没带"——
 *      而那种不一致不会报错，只是采购员在某个页面看不到 JAN 码。
 *
 * @why 采购快照三列（`title_ja` / `jan_code` / `purchase_source`）为 null 时**整键省略**
 *      而不是给 null 或空串：与 `why` / `maker` 同一条降级口径——
 *      "没记录"用**字段缺席**表达，"空字符串"留给真正的脏数据（运营填了又删空）。
 *      前端据此显示"未记录"（而不是空白，空白会被读成"这个值就是空的"）。
 *      ⚠️ 迁移 021 之前的历史订单行三列都是 NULL → 全部走这个分支。
 */
function toAdminOrderItem(i: AdminOrderItemRow, imgBase?: string): Record<string, unknown> {
  // 商品现图（三端联动 UI 模拟 2026-10-08）：运营对照实物发货 / 采购要看图，详情原先只有文字
  const image = i.first_image === null ? null : toImageSet(i.first_image, imgBase);
  return {
    ...(image !== null ? { image } : {}),
    product_id: i.product_id,
    title: i.title_snapshot,
    qty: i.qty,
    unit_price_jpy: i.unit_price_jpy,
    // AJ-407（契约 0.6.48）：打印「面单信息」用——申报价是建单时分摊好的**美分整数**（create-order.ts @limitation 二），
    // 重量是行项目快照。二者 NOT NULL，恒下发。
    declared_value_usd: i.declared_value_usd,
    weight_g: i.weight_g,
    ...(i.title_ja !== null ? { title_ja: i.title_ja } : {}),
    ...(i.jan_code !== null ? { jan_code: i.jan_code } : {}),
    ...(i.purchase_source !== null ? { purchase_source: i.purchase_source } : {}),
    // 迁移 027 快照，同一条"null 整键省略"口径
    ...(i.cost_jpy !== null ? { cost_jpy: i.cost_jpy } : {}),
    ...(i.hs_code !== null ? { hs_code: i.hs_code } : {}),
    ...(i.customs_desc_en !== null ? { customs_desc_en: i.customs_desc_en } : {}),
  };
}

/** 详情 → 契约 `AdminOrder`（= Order + 管理端专有块）。 */
function toAdminOrder(
  r: AdminOrderRow,
  items: readonly Record<string, unknown>[],
  payments: readonly Record<string, unknown>[],
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  // 取最后一笔**非作废**的（第三轮缺口 P1-3 同病：并发换通道时作废行的 created_at 可能更晚）；全作废才取最后一笔
  const latest = ([...payments].reverse().find((p) => p['status'] !== 'cancelled') ??
    payments[payments.length - 1]) as
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
    late_paid: r.late_paid,
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
    ...withTrackingUrl(r.carrier, r.tracking_no),
    ...(r.paid_at !== null ? { paid_at: r.paid_at.toISOString() } : {}),
    ...(r.shipped_at !== null ? { shipped_at: r.shipped_at.toISOString() } : {}),
  };
}

/**
 * 查询参数 → 单个字符串；没给 → undefined。
 * @why 重复参数被 Express 解析成数组，这里把它变成一个**必然非法**的值（`'\u0000'`）交给下游判错，
 *      而不是取第一个——"取第一个"会让 `?created_from=a&created_from=b` 静默按 a 筛。
 */
function asQueryString(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : '\u0000';
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
          include_test?: unknown;
          created_from?: unknown;
          created_to?: unknown;
          sort?: unknown;
          attention?: unknown;
          user_id?: unknown;
        };
        const { page, size } = readPaging(q);
        // AJ-486：按买家筛（客户详情"查看全部订单"）。形状白名单：会进日志与 SQL 参数，挡掉空格 / 引号 / 超长（七类 G）
        if (
          q.user_id !== undefined &&
          (typeof q.user_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.user_id))
        ) {
          throw new AppError(40001, { reason: 'user_id_invalid' });
        }
        const userId = q.user_id;
        // 评估 4.5（契约 0.6.53）：白名单排序；非法 → 40001（不静默按默认排，否则运营以为排过了）
        const sort = parseListSort(q.sort, LIST_SORT_KEYS.orders);
        if (!sort.ok) throw new AppError(40001, { reason: sort.reason });
        // 剩余清单 3-4（契约 0.6.32）：只认 'true' / 'false'，其它 → 40001（不静默当成"不含"）
        if (
          q.include_test !== undefined &&
          q.include_test !== 'true' &&
          q.include_test !== 'false'
        ) {
          throw new AppError(40001, { reason: 'include_test_invalid' });
        }
        const includeTest = q.include_test === 'true';
        // AJ-425（契约 0.6.58）：待处理筛选，白名单取自 shared；非法 → 40001（不静默当成"不筛"，否则运营以为筛过了）
        if (q.attention !== undefined && !isOrderAttention(q.attention)) {
          throw new AppError(40001, { reason: 'attention_invalid' });
        }
        const attention = q.attention;
        // AJ-400（契约 0.6.44）：逗号分隔的多状态（页签"售后·退款" = refunding,refunded）。
        // ⚠️ 重复参数（`?status=a&status=b`）Express 解析成数组——不是 string 一律非法，不去猜拼接方式。
        const statuses =
          q.status === undefined
            ? undefined
            : typeof q.status === 'string'
              ? parseOrderStatusList(q.status)
              : null;
        if (statuses === null) throw new AppError(40001, { reason: 'status_invalid' });
        // AJ-400：下单日期（JST 日历日、两端都含）；日界换算只在 shared 里做一次
        const range = parseJstDateRange(asQueryString(q.created_from), asQueryString(q.created_to));
        if (!range.ok) throw new AppError(40001, { reason: range.reason });
        // AJ-360：与公开 `/products` 同口径挡一次长度（同一个常量；CAT2-07）。
        // 量的是**原始输入**（trim 之前）：上限要框住"客户端能送进来多少"，
        // 而不是"去掉空格后还剩多少"——后者会让"64 字 + 一万空格"照样进 SQL。
        const kwInput = q.keyword === undefined ? undefined : String(q.keyword);
        if (kwInput !== undefined && kwInput.length > SEARCH_KEYWORD_MAX_LENGTH) {
          throw new AppError(40001, { reason: 'keyword_too_long' });
        }
        const rawKw = kwInput === undefined ? undefined : kwInput.trim();
        const { items, total } = await listAdminOrders(deps.db, {
          page,
          size,
          ...(statuses !== undefined ? { statuses } : {}),
          ...(rawKw !== undefined && rawKw !== '' ? { keyword: rawKw } : {}),
          ...(range.from !== null ? { createdFrom: range.from } : {}),
          ...(range.to !== null ? { createdTo: range.to } : {}),
          ...(sort.key !== null ? { sort: { key: sort.key, dir: sort.dir } } : {}),
          ...(attention !== undefined ? { attention } : {}),
          ...(userId !== undefined ? { userId } : {}),
          // AJ-484：超时未发货截止按注入的时钟算（JST 工作日，shared shipOverdueCutoff）
          shipOverdueCutoff: shipOverdueCutoff(
            deps.clock.now(),
            deps.config.SHIP_WITHIN_BUSINESS_DAYS,
          ),
          includeTest,
        });
        // 行项目**一次批量**取（N+1 的反面）：`listOrderItemsFor` 一条 `in (…)` 拿全部，
        // 再按 order_id 归堆。⚠️ 空 ids 时它早退返回 []，不进 SQL（见仓储的用例）。
        const lineItems = await listOrderItemsFor(
          deps.db,
          items.map((r) => r.id),
        );
        const byOrder = new Map<string, AdminOrderItemRow[]>();
        for (const it of lineItems) {
          const bucket = byOrder.get(it.order_id);
          if (bucket === undefined) byOrder.set(it.order_id, [it]);
          else bucket.push(it);
        }
        res.json({
          items: items.map((r) =>
            toListItem(
              r,
              (byOrder.get(r.id) ?? []).map((i) => toAdminOrderItem(i)),
            ),
          ),
          total,
        });
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
        const [items, payments, events, partials, customer, afterSales, addressHistory] =
          await Promise.all([
            listOrderItemsFor(deps.db, [id]),
            listPaymentsFor(deps.db, [id]),
            listEventsFor(deps.db, [id]),
            listPartialRefunds(deps.db, id),
            // 客户卡片（AJ-404，§4.2 第 168 行）：口径与客户页同一份（customers-admin.ts 文件头表）
            findCustomer(deps.db, order.user_id),
            listAfterSales(deps.db, id),
            listAddressHistory(deps.db, id),
          ]);
        // AJ-484：与列表同一个截止口径（同一个时钟、同一份配置）
        const overdueCutoff = shipOverdueCutoff(
          deps.clock.now(),
          deps.config.SHIP_WITHIN_BUSINESS_DAYS,
        );
        res.json({
          ship_overdue:
            order.status === 'paid' &&
            order.paid_at !== null &&
            order.paid_at.getTime() < overdueCutoff.getTime(),
          ...toAdminOrder(
            order,
            items.map((i) => toAdminOrderItem(i, deps.config.IMG_BASE_URL)),
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
              ...(e.actor_email !== null ? { actor_email: e.actor_email } : {}),
              at: e.at.toISOString(),
            })),
          ),
          // 部分退款（AJ-383，契约 0.6.35）：按发起顺序；没有时是空数组（形状固定）
          partial_refunds: partials.map(partialRefundView),
          // 售后申请（AJ-420，契约 0.6.56）：按提交先后；没有时是空数组（形状固定）
          after_sales: afterSales.map(adminAfterSaleView),
          // 改址历史（AJ-455，契约 0.6.67）：改前完整地址；没改过是空数组
          address_history: addressHistory.map((h) => ({
            id: h.id,
            snapshot: h.snapshot,
            ...(h.actor !== null ? { actor: h.actor } : {}),
            at: h.at.toISOString(),
          })),
          // 客户卡片（AJ-404，契约 0.6.47）：下单人若是管理员（findCustomer → null）则整键省略
          ...(customer === null
            ? {}
            : {
                customer: {
                  user_id: customer.id,
                  order_count: customer.stats.orderCount,
                  paid_total_jpy: customer.stats.paidTotalJpy,
                  blocked: customer.blockedAt !== null,
                },
              }),
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/ship', guard, (req, res, next) => {
    void (async () => {
      try {
        // 整段执行（校验 / 持锁闸门 / 迁移 / 提交后发事件）与批量发货共用一份（AJ-401，ship-order.ts）
        const shipped = await shipOrder(deps, String(req.params.id), req.body, adminActor(req));
        // 审计 after 记**落库的归一值**而不是请求体（AJ-410）：请求体里的 `em 123 jp` 与库里对不上
        setAuditAfter(res, { carrier: shipped.carrier, tracking_no: shipped.tracking_no });
        res.json(shipped);
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
          // 迟到付款（剩余清单 1-5）：已关单只有带 late_paid 凭据才放行，退的是凭据对应的那笔
          const closed = row.status === 'expired' || row.status === 'cancelled';
          const latePaid = closed && (await hasLatePaid(tx, id));
          const gate = refundGuard(asOrderStatus(row.status), row.has_dispute, latePaid);
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          // 扫描 M-01：迟到付款单进了 refunding 之后 `closed` 为假，原实现只按 succeeded 找钱——
          //    迟到的支付行永远不是 succeeded（落账事务回滚了），重试就 40902，订单卡死在 refunding。
          //    所以 refunding 时先按常规找，找不到再按迟到付款凭据找（与第一次退款选中的是同一行）。
          const pay = latePaid
            ? await findLatePaidPayment(tx, id)
            : ((await findRefundablePayment(tx, id)) ??
              (row.status === 'refunding' && (await hasLatePaid(tx, id))
                ? await findLatePaidPayment(tx, id)
                : null));
          if (pay === null) {
            throw new AppError(40902, { order_id: id, reason: 'no_succeeded_payment' });
          }
          if (pay.provider_ref === null) {
            throw new AppError(50000, { order_id: id, reason: 'provider_ref_missing' });
          }
          // ── 部分退款（AJ-383）：整单退款只退**余额**，且不与在途的部分退款并行 ──
          // @why 先部分退过的单，按实收全额去退会被机构以"超出可退金额"拒绝 ⇒ 订单卡死在 refunding。
          // @why 有一笔部分退款在途（可能已经退出去）时拒绝：余额此刻不确定，算错就是多退。
          //      同一把订单行锁之下判定，部分退款路由也在这把锁里登记——两边互相看得见。
          // @why refunding 重试时同样算：部分退款在 refunding 期间被闸门挡住（状态不在可部分退款之列），
          //      余额不会变，重试的金额与首次一致（同键同参）。
          const partials = await sumPartialRefunds(tx, id);
          if (partials.inFlight) {
            // data.reason 公开（AJ-456）：管理端据此说"先去部分退款点同步"，而不是一句"状态不允许"
            throw new AppError(
              40902,
              { order_id: id, reason: 'partial_refund_in_flight' },
              { reason: 'partial_refund_in_flight' },
            );
          }
          const refundAmountMinor = fullRefundAmount(pay.charge_amount, partials.succeededMinor);
          if (refundAmountMinor === 0) {
            throw new AppError(
              40902,
              { order_id: id, reason: 'fully_refunded_by_partials' },
              { reason: 'fully_refunded_by_partials' },
            );
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
          return {
            row,
            pay,
            provider,
            providerRef: pay.provider_ref,
            refundReason,
            progress,
            refundAmountMinor,
          };
        });

        // ⚠️ 声明"改动已提交"（SEC2-02 / AJ-339）：第一段事务到这里已经 COMMIT，
        //    订单真的在 `refunding` 了。第二段调机构若失败会回 5xx，而审计中间件默认只写 2xx ⇒
        //    "谁在什么时候发起了这笔退款"会**一行都没有**——偏偏那是最需要查的一次
        //    （机构超时 = 钱可能已经退了）。审计是 append-only，事后补不回来。
        //    ⚠️ 放在这里而不是第二段之后：`executeRefund` 抛错就不会走到后面，
        //    而"抛错的那次"正是本条要覆盖的场景。
        markAuditCommitted(res);

        // ── 第二段（事务外）：调机构。失败不回滚——停在 refunding 是**可见**的状态 ──
        // 查询在途单 / 确认失败换键 / 结果未知同键，全部在 refund-execution.ts（F-03，AJ-178）
        // 发给机构的请求单独成一个值：下面的 accepted 日志记的就是**它**的金额——
        // 日志若另算一遍，"实际发出去多少"与"日志说多少"可以不一致而没人发现（AJ-383 注回验证时踩到）
        const request = {
          orderId: id,
          providerRef: plan.providerRef,
          amountJpy: plan.row.total_jpy,
          currency: plan.pay.charge_currency,
          // 余额而不是实收（AJ-383）：见第一段"部分退款"那条
          amountMinor: plan.refundAmountMinor,
          reason: plan.refundReason,
        };
        const outcome = await executeRefund(deps, plan.provider, {
          orderId: id,
          paymentId: plan.pay.id,
          channel: plan.pay.provider,
          request,
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
          ctx: {
            outcome,
            currency: request.currency,
            amount_minor: request.amountMinor,
          },
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
        const archiveId = await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = addressGuard(asOrderStatus(row.status));
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          const archived = await updateAddressSnapshot(
            tx,
            id,
            snapshot as never,
            adminActor(req),
            deps.clock.now(),
          );
          if (archived === false)
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          return archived;
        });
        // S-2（AJ-455）：审计 after 只记归档号。审计表 append-only、不可匿名化，新地址（含城市 / 州 / 收件人）
        //   不该进去——改前地址在 019 专门迁出了这类表，改后地址再写回去等于白迁。要看地址：详情 address_history 与 orders 本身。
        setAuditAfter(res, { archive_id: archiveId });
        deps.logger.info('admin_order_address_changed', { result: 'ok', order_id: id });
        res.json({ order_id: id, address: snapshot });
      } catch (e) {
        next(e);
      }
    })();
  });
}
