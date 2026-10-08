/**
 * 职责：运单号形状判定（服务端发货 / 改单号的 `tracking_recognized`，与管理端「确认发货」前的预检**同一份**）。
 *
 * @why 放进 shared（三端联动模拟 2026-10-08）：原先只有服务端判，管理端在发货**之后**才拿到"认不出"的提示——
 *      那时发货邮件已经带着错单号发给买家了。确认那一步就得能看到，而前端另写一份规则必然与服务端漂移。
 * @why 日本邮便国际单号是 UPU S10（2 字母 + 9 数字 + JP）；承运商写的是日本邮便却不是 S10 → 认不出。
 *      其它承运商不认识格式，只排除明显不是单号的（非字母数字、过短 / 过长）。
 * @limitation 只是形状：形状对的错号（少一位以外的笔误）照样认得出。
 * @see server/src/domain/tracking.ts（查件链接，复用这里的名单）；admin-web/src/orders/OrderDetail.tsx
 */
export const S10_JP = /^[A-Z]{2}\d{9}JP$/;

/** 被视为"日本邮便"的承运商写法（自由文本，运营 EMS / ems / 日本郵便 都有人写）。 */
export const JAPAN_POST_NAMES: readonly string[] = [
  'ems',
  'epacket',
  'e-packet',
  'japan post',
  'japanpost',
  'jppost',
  'jp post',
  '日本郵便',
  '日本邮便',
  // 中文运营的实际写法（AJ-410 / N20b）：「邮政」是中国口语对日本邮便的叫法，「郵政」是繁体 / 日文旧称
  '日本邮政',
  '日本郵政',
  '国際小包',
  '国际小包',
];

/** 整词匹配（拉丁词用词边界；中日文名本身就是完整词）——"Yamato Transport Systems" 含 ems 不算。 */
function matchesWord(carrier: string, name: string): boolean {
  if (!/^[a-z -]+$/.test(name)) return carrier.includes(name);
  const escaped = name.replace(/[-\s]/g, (m) => (m === '-' ? '\\-' : '\\s'));
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(carrier);
}

export function isJapanPostCarrier(carrier: string | null | undefined): boolean {
  const c = (carrier ?? '').trim().toLowerCase();
  return JAPAN_POST_NAMES.some((name) => matchesWord(c, name));
}

/**
 * 归一：去掉**所有**空白（含全角空格）、转大写，保留连字符。
 * S10 判定、查件链接、以及服务端发货 / 改单号**落库前**（shipInfoGuard，AJ-410）共用这一份；
 * 管理端"再输一遍确认"也按它比对，否则 `em 123` 与 `EM123` 会被判成两个号。
 */
export function normalizeTrackingNo(no: string | null | undefined): string {
  return (no ?? '').replace(/\s+/g, '').toUpperCase();
}

export function trackingNoRecognized(
  carrier: string | null | undefined,
  trackingNo: string | null | undefined,
): boolean {
  const n = normalizeTrackingNo(trackingNo);
  if (n === '') return false;
  if (S10_JP.test(n)) return true;
  if (isJapanPostCarrier(carrier)) return false;
  return /^[A-Z0-9-]{6,30}$/.test(n);
}
