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
 *              字符串被 toRateInt 拒掉，JPY 相关汇率到不了那个量级（赌汇率不失控，
 *              真到了那一步汇率本身已是事故）。
 * @limitation 二：快照里缺的币种静默少显示（读路径降级，domain 函数 @why 同口径）。
 *
 * @see domain/quote.ts（buildDisplayFromRates）；adapters/orders.ts（取数）；
 *      contracts/api-contract.yaml（OrderSummary/Order）
 */
import { toRateInt } from '@waselect/shared';
import { buildDisplayFromRates, type DisplayCurrency } from '../domain/quote.js';
import type {
  OrderDetailRow,
  OrderItemReadRow,
  OrderListRow,
  OrderPaymentSummary,
} from '../adapters/orders.js';
import { toImageSet } from './product-routes.js';

type JsonObject = Record<string, unknown>;

/** 从 fx_snapshot 重建展示价（文件头 @why/@limitation 一）。 */
export function snapshotDisplay(
  totalJpy: number,
  fxSnapshot: unknown,
  displayCurrencies: readonly DisplayCurrency[],
): Partial<Record<DisplayCurrency, number>> {
  const fx = (fxSnapshot ?? {}) as Record<string, unknown>;
  const rates: Partial<Record<DisplayCurrency, number>> = {};
  for (const c of displayCurrencies) {
    const raw = fx[c];
    if (typeof raw === 'number') rates[c] = toRateInt(String(raw));
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

/** 行项目 → 契约 Order.items 条目（图取商品现图第一张，无图省略 image 字段）。 */
export function toOrderItemView(item: OrderItemReadRow): JsonObject {
  const images = Array.isArray(item.images) ? item.images : [];
  const image = images.length > 0 ? toImageSet(images[0]) : null;
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
  },
  displayCurrencies: readonly DisplayCurrency[],
): JsonObject {
  return {
    ...toOrderSummary(row, displayCurrencies),
    ...(row.contact_email !== null ? { contact_email: row.contact_email } : {}),
    terms_version: row.terms_version,
    items: parts.items.map(toOrderItemView),
    address: row.address_snapshot,
    items_jpy: row.items_jpy,
    shipping_jpy: row.shipping_jpy,
    duty_jpy: row.duty_jpy,
    expires_at: row.expires_at.toISOString(),
    ...(row.carrier !== null ? { carrier: row.carrier } : {}),
    ...(row.tracking_no !== null ? { tracking_no: row.tracking_no } : {}),
    timeline: parts.timeline.map((t) => ({ status: t.status, at: t.at.toISOString() })),
    ...(parts.payment !== null ? { payment: toPaymentView(parts.payment) } : {}),
  };
}
