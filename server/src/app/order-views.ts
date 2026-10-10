/**
 * 职责：订单**读路径的响应映射**（I1-U5c）——仓储行 → 契约 OrderSummary / Order 形状。
 *
 * @why 从路由里抽出来：响应 shaping 是纯函数（同一行 → 同一 JSON），
 *      放在路由里会让路由文件膨胀且无法脱离 HTTP 单测；
 *      这里每个函数都可以直接拿仓储行断言。
 *
 * @why display 用订单自己的 **fx_snapshot** 重建（不查当日汇率）：
 *      订单页展示的换算金额应等于用户**下单时看到的**；用当日汇率会让同一笔订单的
 *      展示价每天漂移，与 fx_snapshot 对不上账。顺带省掉列表每行一次 fx 查询（N+1）。
 *
 * @limitation 一：fx_snapshot 的值是 number（U5b 落库时 `Number(NUMERIC串)`），
 *              重建 rateInt 走 `toRateInt(String(raw))`——JS number → string 对
 *              常规汇率（0.0066 量级）是精确十进制；极小值（<1e-7）会变成科学计数
 *              字符串被 toRateInt 拒掉，JPY 相关汇率到不了那个量级。
 *              ⚠️ 这里**曾经**写"赌汇率不失控，真到了那一步汇率本身已是事故"——
 *              那句默认了"被 toRateInt 拒 ⇒ 抛 ⇒ 整个订单页 500"，而读路径不该这么赌：
 *              见 @limitation 三，被拒的汇率现在只丢一个币种。
 * @limitation 二：快照里缺的币种静默少显示（读路径降级，domain 函数 @why 同口径）。
 * @limitation 三：快照里**脏**的汇率（被 toRateInt 拒：`≤ 0`、`|rate| ≥ 1e6`、非有限值、
 *              ×1e8 取整后为 0）与"缺币种"同处理——只丢这一个币种，**不许**把整页订单
 *              打成 500（AJ-359）。结论同 `product-routes` 的 `rateIntOrUndefined`（AJ-357），
 *              **不同**的是那里 error 级记日志、这里静默：
 *              `/products` 的脏汇率每请求至多 M 条（M = 展示币种数，汇率在商品循环外
 *              先算一次），本函数是**每行一次**——列表端点无分页（order-query-routes
 *              @limitation 二），N 行 × M 币会把一次刷新放大成 N×M 条 error；
 *              且 fx_snapshot 是**落库那一刻**就坏掉的历史数据（不是当日运维事故），
 *              该由数据审计/订正发现，不该让每次列表刷新替它喊一遍。
 *
 * @see domain/quote.ts（buildDisplayFromRates）；adapters/orders.ts（取数）；
 *      contracts/api-contract.yaml（OrderSummary/Order）
 */
import { toRateInt } from '@waselect/shared';
import { withTrackingUrl } from '../domain/tracking.js';
import { buildDisplayFromRates, type DisplayCurrency } from '../domain/quote.js';
import type {
  OrderDetailRow,
  OrderItemReadRow,
  OrderListRow,
  OrderPaymentSummary,
  OwnedOrderListRow,
} from '../adapters/orders.js';
import { toImageSet } from './product-routes.js';
import type { PartialRefundRow } from '../adapters/order-refunds.js';

/**
 * 部分退款 → 买家视图（P2-12，AJ-386）。
 * @why 只出 成功 / 处理中（initiated / pending / unknown 都折成 `pending`）：failed 是钱没动的内部重试，
 *      给买家看只会制造"退了又没退"的困惑。
 * @why 不出 `reason` / `actor` / `provider_ref`：原因是管理员写给自己看的（可能是"客户难缠"），
 *      操作人是内部账号——两者都不该出现在买家可见的响应里。
 */
export function toBuyerPartialRefunds(rows: readonly PartialRefundRow[]): JsonObject[] {
  return rows
    .filter((r) => r.status !== 'failed')
    .map((r) => ({
      status: r.status === 'succeeded' ? 'succeeded' : 'pending',
      currency: r.currency,
      amount_minor: r.amount_minor,
      created_at: r.created_at.toISOString(),
      ...(r.settled_at !== null ? { settled_at: r.settled_at.toISOString() } : {}),
    }));
}

type JsonObject = Record<string, unknown>;

/**
 * 从 fx_snapshot 重建展示价（文件头 @why/@limitation 一、**三**）。
 *
 * @why `toRateInt` 单独 try：它在 `≤ 0` / `|rate| ≥ 1e6` / 非有限值 / ×1e8 取整后为 0
 *      时抛 RangeError，而它此前在**循环里裸调** ⇒ 一条脏汇率让 `GET /orders` 整页 500
 *      ——文件头 @limitation 二 声称的"缺哪个币少显示哪个"在脏汇率面前其实是空的：
 *      那时缺币能降级，"有币但是坏的"反而能打挂整页。
 * @why 静默而不记日志：见 @limitation 三（每请求 N×M 放大 + 历史数据非当日事故）。
 */
export function snapshotDisplay(
  totalJpy: number,
  fxSnapshot: unknown,
  displayCurrencies: readonly DisplayCurrency[],
): Partial<Record<DisplayCurrency, number>> {
  const fx = (fxSnapshot ?? {}) as Record<string, unknown>;
  const rates: Partial<Record<DisplayCurrency, number>> = {};
  for (const c of displayCurrencies) {
    const raw = fx[c];
    if (typeof raw !== 'number') continue; // 缺币种（@limitation 二）
    try {
      rates[c] = toRateInt(String(raw));
    } catch {
      continue; // 脏汇率（@limitation 三）：只丢这一个币种
    }
  }
  return buildDisplayFromRates(totalJpy, rates, displayCurrencies);
}

/** 列表/详情共用的 OrderSummary 段。 */
export function toOrderSummary(
  row: OrderListRow,
  displayCurrencies: readonly DisplayCurrency[],
): JsonObject {
  return {
    order_id: row.id,
    order_no: row.order_no,
    total_jpy: row.total_jpy,
    display: snapshotDisplay(row.total_jpy, row.fx_snapshot, displayCurrencies),
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * 买家列表行（契约 `OrderListItem`，0.6.49 / AJ-408）= OrderSummary + `item_count` + 可选 `first_image`
 * + 可选 `first_title`（0.6.54 / AJ-416 A8：首行快照标题；没有 / 空串 → 整键省略）
 * + `after_sale_state`（0.6.60 / AJ-430：open / closed / null，恒下发）+ `expires_at`（0.6.61 / AJ-435：ISO，恒下发）。
 * @why 首图与详情行项目走**同一个** `toImageSet(images[0], imgBaseUrl)`：三种存储形态
 *      （image_id / 裸 URL / 三档对象）的处理只有一份，配不出 URL 时整键省略（不给空串、不给裸键）。
 */
export function toOrderListItem(
  row: OwnedOrderListRow,
  displayCurrencies: readonly DisplayCurrency[],
  imgBaseUrl: string | undefined,
): JsonObject {
  const images = Array.isArray(row.first_images) ? row.first_images : [];
  const image = images.length > 0 ? toImageSet(images[0], imgBaseUrl) : null;
  return {
    ...toOrderSummary(row, displayCurrencies),
    item_count: row.item_count,
    ...(image !== null ? { first_image: image } : {}),
    ...(row.first_title !== null && row.first_title !== '' ? { first_title: row.first_title } : {}),
    // AJ-430：恒下发（null = 没有售后申请），小程序据此把有售后的单归进「售后·退款」页签
    after_sale_state: row.after_sale_state,
    // AJ-435：付款截止，与详情 Order.expires_at 同列同格式；待付款行据此写"几点前付款"
    expires_at: row.expires_at.toISOString(),
  };
}

/**
 * 行项目 → 契约 Order.items 条目（图取商品现图第一张，无图省略 image 字段）。
 * @param imgBaseUrl `IMG_BASE_URL`：商品图按 image_id 存时要用它拼 URL
 *      （0.6.28 / AJ-361）。本文件是纯 mapper（文件头 @why），值由路由层传进来，
 *      不在 mapper 里读配置——否则它就不再是"拿仓储行就能断言"的纯函数。
 */
export function toOrderItemView(
  item: OrderItemReadRow,
  imgBaseUrl: string | undefined,
): JsonObject {
  const images = Array.isArray(item.images) ? item.images : [];
  const image = images.length > 0 ? toImageSet(images[0], imgBaseUrl) : null;
  return {
    product_id: item.product_id,
    title: item.title_snapshot,
    qty: item.qty,
    unit_price_jpy: item.unit_price_jpy,
    ...(image !== null ? { image } : {}),
  };
}

/** 支付摘要 → 契约 Order.payment（provider 在契约里叫 channel；缺省字段省略不编）。 */
export function toPaymentView(p: OrderPaymentSummary): JsonObject {
  return {
    channel: p.provider,
    charge_currency: p.charge_currency,
    charge_amount: p.charge_amount,
    ...(p.paid_amount !== null ? { paid_amount: p.paid_amount } : {}),
    ...(p.paid_currency !== null ? { paid_currency: p.paid_currency } : {}),
  };
}

/** 详情全量（OrderSummary + 契约 Order 的其余字段；null 字段省略）。 */
export function toOrderDetail(
  row: OrderDetailRow,
  parts: {
    items: readonly OrderItemReadRow[];
    timeline: readonly { status: string; at: Date }[];
    payment: OrderPaymentSummary | null;
    /** 关单后才到的付款（late_paid 事件，P2-11）：买家侧据此说"已收到付款，正在退款"。 */
    latePaid: boolean;
    partialRefunds: readonly PartialRefundRow[];
  },
  displayCurrencies: readonly DisplayCurrency[],
  imgBaseUrl: string | undefined,
): JsonObject {
  return {
    ...toOrderSummary(row, displayCurrencies),
    ...(row.contact_email !== null ? { contact_email: row.contact_email } : {}),
    terms_version: row.terms_version,
    items: parts.items.map((it) => toOrderItemView(it, imgBaseUrl)),
    address: row.address_snapshot,
    items_jpy: row.items_jpy,
    shipping_jpy: row.shipping_jpy,
    duty_jpy: row.duty_jpy,
    expires_at: row.expires_at.toISOString(),
    ...(row.carrier !== null ? { carrier: row.carrier } : {}),
    ...(row.tracking_no !== null ? { tracking_no: row.tracking_no } : {}),
    // 剩余清单 3-5：官方查件链接（认不出承运商 → 整键省略，不猜）
    ...withTrackingUrl(row.carrier, row.tracking_no),
    timeline: parts.timeline.map((t) => ({ status: t.status, at: t.at.toISOString() })),
    ...(parts.payment !== null ? { payment: toPaymentView(parts.payment) } : {}),
    late_paid: parts.latePaid,
    partial_refunds: toBuyerPartialRefunds(parts.partialRefunds),
  };
}
