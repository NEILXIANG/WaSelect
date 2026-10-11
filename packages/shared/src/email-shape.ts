/**
 * 职责：联系邮箱（`contact_email`）的**形状判据**——服务端建单入口与小程序结算页的单一来源（MP-9，AJ-479）。
 *
 * @why 邮件是付款 / 发货 / 退款通知的唯一渠道（AJ-369，订阅消息未开通）。原判据只要求"有 @、无空白、无控制字符"，
 *      `a@b`、`x@b..com`、`x@b.c` 全部放行——填错的买家完全收不到通知，而店家也联系不上他（第二轮审计 MP-9 实测：`a@b` 建单 201）。
 * @why 只收紧**域名**这一侧（必须有点、不许空段、后缀 ≥ 2 且不是纯数字），本地部分仍宽松：
 *      本地部分的合法写法五花八门（加号子地址、点号、UTF-8），按 RFC 写死只会误拒真实地址；
 *      而域名这一侧的错几乎都是手滑（漏后缀、连点、句号粘进来），收紧的误拒面最小。
 * @why 放在 shared：服务端入口与小程序各写一份必然漂移（"前端说对、提交被拒"）。小程序进不了 shared，
 *      镜像在 miniprogram/utils/email-shape.js，两边跑同一张判例表（email-shape.cases.ts）。
 * @limitation 一：只判形状，不判能不能收信（MX / 退信要发信才知道，那是邮件服务商的事）。
 * @limitation 二：不拒非 ASCII（国际化邮箱 `用户@例子.中国` 放行）——邮件服务商是否支持 SMTPUTF8 未实测，
 *              拒掉会误伤，放行的代价是那一封可能发不出去（与原判据同口径）。
 * @limitation 三：不认 IP 字面量域名（`a@[1.2.3.4]`）与引号本地部分——买家通知邮箱里不出现这两种。
 * @tradeoff 判据收紧后，存量订单里已有的不合规邮箱不受影响（只拦新建单）；代价是那些老单的邮件照旧发往错误地址。
 */

/** 与 `orders.contact_email VARCHAR(255)` 同值（超长会撞 22001）。 */
export const CONTACT_EMAIL_MAX_LENGTH = 255;

/** 一段（本地部分 / 域名的一节）：非空，不含空白、@、控制字符。域名按点切分后逐节套用，所以空节（连点、点开头结尾）自然不过。 */
// eslint-disable-next-line no-control-regex -- 刻意排除控制字符（ORD3-04：PG 拒收 0x00，BEL 等会被收下入库）
const PART = /^[^\s@\u0000-\u001f\u007f]+$/;
/** 纯数字后缀（多半是把 IP 或电话粘进来了）。 */
const DIGITS = /^\d+$/;

/**
 * @param v 任意值（非字符串 → false，不抛）
 * @returns 形状是否可以作为联系邮箱
 */
export function isContactEmailShape(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0 || v.length > CONTACT_EMAIL_MAX_LENGTH) return false;
  const at = v.indexOf('@');
  // 第二个 @ 不必单判：PART 不含 @，它会让所在那一段不过
  if (at <= 0) return false;
  if (!PART.test(v.slice(0, at))) return false;
  const labels = v.slice(at + 1).split('.');
  if (labels.length < 2 || !labels.every((l) => PART.test(l))) return false;
  const tld = labels[labels.length - 1] ?? '';
  return tld.length >= 2 && !DIGITS.test(tld);
}
