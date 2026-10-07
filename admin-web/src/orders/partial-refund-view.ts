/**
 * 职责：管理端**部分退款**的纯函数层（AJ-383）——金额换算、可退额度、准入、列表行。
 *
 * @why 服务端收的是**支付币种最小单位**（USD 的 10.00 = 1000），运营填的是"10.00"。换算放这一处、用字符串拆整数部分与小数部分，
 *      不走 `Number(x) * 100`：浮点 0.29 × 100 = 28.999…，取整就少退一分，而这种差错没人会去核。
 * @why 准入与服务端 `partialRefundGuard` 同口径：前端拦只为"早一步说清楚"，最终以服务端为准。
 * @limitation 小数位数取 shared `CURRENCY_MINOR_DIGITS`，只覆盖 JPY / USD / CNY；认不出的币种按 2 位。
 *
 * @see server/src/domain/partial-refund.ts；./PartialRefunds.tsx；契约 0.6.35 PartialRefund
 */
import { CURRENCY_MINOR_DIGITS, type CurrencyCode } from '@waselect/shared';
import type { Gate } from './view.js';

interface RefundLike {
  id?: unknown;
  status?: unknown;
  currency?: unknown;
  amount_minor?: unknown;
  reason?: unknown;
  created_at?: unknown;
}

const IN_FLIGHT = new Set(['initiated', 'pending', 'unknown']);
const ALLOWED_STATUS = new Set(['paid', 'shipped', 'delivered', 'completed']);

const STATUS_TEXT: Record<string, string> = {
  initiated: '已登记（点同步取回结果）',
  pending: '机构处理中（点同步查询）',
  succeeded: '已退款',
  failed: '失败（未退，额度已释放）',
  unknown: '结果未知（点同步取回）',
};

function digitsOf(currency: string): number {
  return (CURRENCY_MINOR_DIGITS as Record<string, number>)[currency as CurrencyCode] ?? 2;
}

function refundsOf(order: unknown): RefundLike[] {
  const list = (order as { partial_refunds?: unknown } | null)?.partial_refunds;
  return Array.isArray(list) ? (list as RefundLike[]) : [];
}

/** "10.05" → 1005（USD）；格式不对 / ≤0 / 小数位超出币种精度 → 拒。 */
export function parseAmountToMinor(
  raw: string,
  currency: string,
): { ok: true; minor: number } | { ok: false; reason: string } {
  const digits = digitsOf(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (m === null) return { ok: false, reason: '金额只能是数字，例如 10.50' };
  const frac = m[2] ?? '';
  if (frac.length > digits) {
    return {
      ok: false,
      reason: digits === 0 ? `${currency} 没有小数` : `${currency} 最多 ${digits} 位小数`,
    };
  }
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(minor) || minor < 1) return { ok: false, reason: '金额必须大于 0' };
  return { ok: true, minor };
}

/** 1005 USD → "10.05 USD"；JPY 带千分位。 */
export function formatMinor(minor: number, currency: string): string {
  const digits = digitsOf(currency);
  const major = minor / 10 ** digits;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** 可退额度 = succeeded 支付行实收 − 除 failed 外的部分退款；没有 succeeded 支付行 → null。 */
export function refundableMinor(order: unknown): { currency: string; minor: number } | null {
  const pays = (order as { payments?: unknown } | null)?.payments;
  const pay = (Array.isArray(pays) ? pays : []).find(
    (p: { status?: unknown }) => p?.status === 'succeeded',
  ) as { charge_currency?: unknown; charge_amount?: unknown } | undefined;
  if (pay === undefined || typeof pay.charge_amount !== 'number') return null;
  const used = refundsOf(order)
    .filter((r) => r.status !== 'failed')
    .reduce((s, r) => s + (typeof r.amount_minor === 'number' ? r.amount_minor : 0), 0);
  return { currency: String(pay.charge_currency), minor: Math.max(0, pay.charge_amount - used) };
}

export function partialRefundGate(order: unknown): Gate {
  const status = (order as { status?: unknown } | null)?.status;
  if (typeof status !== 'string' || !ALLOWED_STATUS.has(status)) {
    return { ok: false, reason: '只有已付款 / 已发货 / 已签收 / 已完成的订单可以部分退款' };
  }
  if ((order as { has_dispute?: unknown }).has_dispute === true) {
    return { ok: false, reason: '有拒付进行中，部分退款会被拒（40907）' };
  }
  if (refundsOf(order).some((r) => IN_FLIGHT.has(String(r.status)))) {
    return { ok: false, reason: '已有一笔部分退款在途，请先点它的「同步」取回结果' };
  }
  const left = refundableMinor(order);
  if (left === null || left.minor < 1) return { ok: false, reason: '已没有可退金额' };
  return { ok: true, reason: `最多可退 ${formatMinor(left.minor, left.currency)}` };
}

export interface PartialRefundRowView {
  id: string;
  amount: string;
  statusText: string;
  reason: string;
  createdAt: string;
  canSync: boolean;
}

export function partialRefundRows(order: unknown): PartialRefundRowView[] {
  return refundsOf(order).map((r) => ({
    id: String(r.id),
    amount: formatMinor(Number(r.amount_minor), String(r.currency)),
    statusText: STATUS_TEXT[String(r.status)] ?? String(r.status),
    reason: String(r.reason ?? ''),
    createdAt: String(r.created_at ?? ''),
    canSync: IN_FLIGHT.has(String(r.status)),
  }));
}
