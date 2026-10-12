/**
 * 职责：订单"修正"动作的纯逻辑（P1-10 改运单号 / P1-11 取消未付单，AJ-386；撤销发货，AJ-440）——门槛、表单校验、提示文案。
 *
 * @why 门槛与服务端同口径：取消只认 created / pending_payment（已付款的单要退款，取消不退钱）；
 *      改运单号只认 shipped（delivered 之后改了也没人看，且物流状态已闭环）。前端先拦，省一次 409。
 * @why 上限从 shared 取（SHIP_MAX_CHARS / ADMIN_NOTE_MAX_LENGTH）：与服务端 shipInfoGuard / releaseReasonGuard 同源。
 * @limitation 运单号的"形状对不对"只由服务端判（`tracking_recognized`），这里只转述成提示，不拦——
 *             承运商五花八门，前端写一份形状规则必然与服务端漂移。
 * @see server/src/app/admin-order-fix-routes.ts；server/src/domain/tracking.ts（trackingNoRecognized）
 */
import {
  ADMIN_NOTE_MAX_LENGTH,
  SHIP_MAX_CHARS,
  SHIPMENT_REVERT_WINDOW_HOURS,
} from '@waselect/shared';

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

/**
 * 撤销发货按钮的门槛（AJ-440），与服务端 `revertShipmentGuard` 同口径、同顺序。
 * @returns null = 不是已发货单，不显示按钮；否则给出能否撤销与**不能的原因**（按钮禁用时显示在旁边）。
 * @why 已发货但不能撤时仍显示（禁用 + 原因），而不是藏起来：运营最常问的是"为什么撤不了"，
 *      藏起按钮等于让人去翻文档；超时的引导到「修改运单号」，那是超时后录错单号的正路。
 * @limitation `nowMs` 是浏览器时钟；与服务器偏差几分钟时，临界处可能按钮可点而服务端拒（409 原样转述）。
 */
export function shipmentRevertGate(
  order: unknown,
  nowMs: number,
): { ok: boolean; reason: string } | null {
  if (str(order, 'status') !== 'shipped') return null;
  const o = order as Record<string, unknown>;
  if (o['has_dispute'] === true) return { ok: false, reason: '有拒付限制，不能撤销发货' };
  const sales = Array.isArray(o['after_sales']) ? (o['after_sales'] as unknown[]) : [];
  if (sales.some((a) => ['open', 'processing'].includes(str(a, 'status'))))
    return { ok: false, reason: '有进行中的售后，先处理售后再撤销' };
  const at = Date.parse(str(order, 'shipped_at'));
  if (!Number.isFinite(at)) return { ok: false, reason: '缺发货时间，不能撤销' };
  if (nowMs - at >= SHIPMENT_REVERT_WINDOW_HOURS * 3_600_000)
    return {
      ok: false,
      reason: `发货已满 ${String(SHIPMENT_REVERT_WINDOW_HOURS)} 小时，不能撤销；运单号录错请用「修改运单号」`,
    };
  return { ok: true, reason: '' };
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

/** 确认发货 / 确认改单号之前的提示（形状规则与服务端同一份：shared trackingNoRecognized）。 */
export const TRACKING_SHAPE_WARNING =
  '⚠️ 这个运单号的形状认不出（日本邮便应为 2 字母 + 9 位数字 + JP，如 EM123456789JP）：确认后买家就会看到这个运单号，请先核对';

/** 发货 / 改运单号的响应里 `tracking_recognized === false` → 给一句核对提示（已保存，不回滚）。 */
export function trackingWarning(resp: unknown): string {
  return (resp as { tracking_recognized?: unknown } | null)?.tracking_recognized === false
    ? '已保存，但这个运单号的形状认不出（如日本邮便应为 EM123456789JP），请再核对一遍；录错可在「修改运单号」里改'
    : '';
}

/**
 * 修正动作完成后的提示。
 * @why 邮件只发给 `contact_email`（服务端 order-mail.ts：没留邮箱只记 skipped）；没留邮箱时还说"已发邮件"，
 *      运营会以为买家已被通知而不再另行联系（2026-10-11 模拟实测撞到）。
 * @limitation 只看订单上有没有邮箱，不知道服务商最终有没有送达（那在 mail_deliveries 里）。
 */
export function fixDoneNotice(mode: 'cancel' | 'fix' | 'revert', order: unknown): string {
  if (mode === 'cancel') return '订单已取消，库存已回补';
  const hasEmail = str(order, 'contact_email').trim() !== '';
  if (mode === 'revert')
    return `已撤销发货：订单回到待发货，运单已清空；${hasEmail ? '已给买家发更正邮件' : '买家未留邮箱，没有发更正邮件，请另行告知'}`;
  return `运单号已更新；${hasEmail ? '已给买家重发发货邮件' : '买家未留邮箱，没有重发发货邮件'}`;
}

/**
 * 撤销发货 / 改运单号 / 取消的确认句（规律排查 2026-10-12：完成提示早已按邮箱说，确认句却一律说会发邮件）。
 * @limitation 同 `fixDoneNotice`：只看订单上有没有邮箱。
 */
export function fixConfirmText(mode: 'cancel' | 'fix' | 'revert', order: unknown): string {
  if (mode === 'cancel') return '确认取消？不可撤销，库存会回补。';
  const hasEmail = str(order, 'contact_email').trim() !== '';
  if (mode === 'revert')
    return `确认撤销？订单回到待发货、运单号清空，${hasEmail ? '并给买家发一封更正邮件。' : '买家没留邮箱，不会收到更正邮件，请另行告知。'}`;
  return `确认修改？${hasEmail ? '会给买家重发一封发货邮件。' : '买家没留邮箱，不会收到新的发货邮件。'}`;
}

/**
 * 单单发货的确认句与完成提示（全入口点击测试 2026-10-11）：按订单有没有联系邮箱说（与 `fixDoneNotice` 同一口径）。
 * @why 原写"确认后发货邮件立即发给买家""运单号已随发货邮件发给买家"——没留邮箱的买家收不到，运营会以为买家已被通知。
 * @limitation 只看订单上有没有邮箱，不知道服务商最终有没有送达（那在 mail_deliveries 里）。
 */
export function shipMailNotes(order: unknown): { confirm: string; done: string } {
  const hasEmail = str(order, 'contact_email').trim() !== '';
  return hasEmail
    ? { confirm: '确认后会给买家发发货邮件。', done: '已发货，发货邮件会发到买家留的邮箱' }
    : {
        confirm: '买家没留邮箱，不会收到发货邮件。',
        done: '已发货；买家没留邮箱，不会收到发货邮件，如需告知请另行联系',
      };
}
