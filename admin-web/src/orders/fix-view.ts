/**
 * 职责：订单"修正"动作的纯逻辑（P1-10 改运单号 / P1-11 取消未付单，AJ-386）——门槛、表单校验、提示文案。
 *
 * @why 门槛与服务端同口径：取消只认 created / pending_payment（已付款的单要退款，取消不退钱）；
 *      改运单号只认 shipped（delivered 之后改了也没人看，且物流状态已闭环）。前端先拦，省一次 409。
 * @why 上限从 shared 取（SHIP_MAX_CHARS / ADMIN_NOTE_MAX_LENGTH）：与服务端 shipInfoGuard / releaseReasonGuard 同源。
 * @limitation 运单号的"形状对不对"只由服务端判（`tracking_recognized`），这里只转述成提示，不拦——
 *             承运商五花八门，前端写一份形状规则必然与服务端漂移。
 * @see server/src/app/admin-order-fix-routes.ts；server/src/domain/tracking.ts（trackingNoRecognized）
 */
import { ADMIN_NOTE_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';

const str = (o: unknown, k: string): string => {
  const v = (o as Record<string, unknown> | null)?.[k];
  return typeof v === 'string' ? v : '';
};

export function cancelGate(order: unknown): { ok: boolean; reason: string } {
  const s = str(order, 'status');
  if (s === 'created' || s === 'pending_payment') return { ok: true, reason: '' };
  return {
    ok: false,
    reason: s === 'cancelled' ? '订单已取消' : '只有未付款的订单能取消；已付款的请走退款',
  };
}

export function shipmentFixGate(
  order: unknown,
): { ok: true; carrier: string; trackingNo: string } | { ok: false } {
  if (str(order, 'status') !== 'shipped') return { ok: false };
  return { ok: true, carrier: str(order, 'carrier'), trackingNo: str(order, 'tracking_no') };
}

export function shipmentFixErrors(f: {
  carrier: string;
  trackingNo: string;
  reason: string;
}): Record<string, string> {
  const e: Record<string, string> = {};
  const check = (k: string, v: string, max: number, label: string) => {
    const t = v.trim();
    if (t === '') e[k] = `${label}必填`;
    else if (t.length > max) e[k] = `${label}最多 ${max} 字（当前 ${t.length} 字）`;
  };
  check('carrier', f.carrier, SHIP_MAX_CHARS.carrier, '承运商');
  check('trackingNo', f.trackingNo, SHIP_MAX_CHARS.tracking_no, '运单号');
  check('reason', f.reason, ADMIN_NOTE_MAX_LENGTH, '修改原因');
  return e;
}

/** 发货 / 改运单号的响应里 `tracking_recognized === false` → 给一句核对提示（已保存，不回滚）。 */
export function trackingWarning(resp: unknown): string {
  return (resp as { tracking_recognized?: unknown } | null)?.tracking_recognized === false
    ? '已保存，但这个运单号的形状认不出（如日本邮便应为 EM123456789JP），请再核对一遍；录错可在「修改运单号」里改'
    : '';
}
