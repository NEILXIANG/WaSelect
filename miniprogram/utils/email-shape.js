/**
 * 职责：联系邮箱形状判据（小程序镜像）+ 常见拼错提示（MP-9，AJ-479，第二轮审计 2026-10-11）。
 *
 * @why 判据真源在 `packages/shared/src/email-shape.ts`（服务端建单入口用它）；小程序进不了 shared
 *      （nodeModules 未开，同 cart-store `MAX_LINE_QTY` 的做法），只能镜像一份——
 *      `email-shape.unit.test.ts` 让两边跑同一张判例表，任何一边改了另一边红。
 * @why 拼错提示**只提示不拦**：`gmial.com` 也可能是真域名，拦下来就是误拒；提示一句"是不是想填…"，
 *      买家自己判断。邮件是唯一通知渠道（AJ-369），填错的代价是完全收不到付款 / 发货 / 退款通知。
 * @limitation 拼错表只收常见的几家（中美日买家常用）与 `.con` 这类明显不存在的后缀；表外的拼错照样放过。
 */

/** 与 shared `CONTACT_EMAIL_MAX_LENGTH` 同值（orders.contact_email VARCHAR(255)）。 */
export const CONTACT_EMAIL_MAX_LENGTH = 255;

// eslint-disable-next-line no-control-regex -- 刻意排除控制字符（ORD3-04），与 shared 同一条
const PART = /^[^\s@\u0000-\u001f\u007f]+$/;
const DIGITS = /^\d+$/;

/** 与 shared `isContactEmailShape` 逐行同义（@see 文件头）。 */
export function isContactEmailShape(v) {
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

/** 整个域名的常见拼错 → 正确域名（只收真实常见的几家）。 */
const DOMAIN_FIXES = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmil.com': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'outlok.com': 'outlook.com',
  'icoud.com': 'icloud.com',
  'iclould.com': 'icloud.com',
};
/** 后缀的明显拼错（这些后缀不存在）→ `.com`。⚠️ 不含 `.co`：那是真实后缀（哥伦比亚 / 公司），也是 `.co.jp` 的一部分。 */
const TLD_FIXES = { con: 'com', cmo: 'com', comm: 'com', vom: 'com', xom: 'com' };

/**
 * 常见拼错提示（不拦）。
 * @param {unknown} raw 输入框的值
 * @returns {string} 提示句；空串 = 没认出拼错
 */
export function emailTypoHint(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  const at = v.lastIndexOf('@');
  if (at <= 0) return '';
  const local = v.slice(0, at);
  const domain = v.slice(at + 1).toLowerCase();
  let fixed = DOMAIN_FIXES[domain];
  if (fixed === undefined) {
    const dot = domain.lastIndexOf('.');
    const tld = dot > 0 ? domain.slice(dot + 1) : '';
    const tldFix = Object.prototype.hasOwnProperty.call(TLD_FIXES, tld)
      ? TLD_FIXES[tld]
      : undefined;
    if (tldFix !== undefined) {
      const base = domain.slice(0, dot + 1) + tldFix;
      fixed = DOMAIN_FIXES[base] ?? base;
    }
  }
  return fixed === undefined || fixed === domain
    ? ''
    : `是不是想填 ${local}@${fixed}？请核对，填错将收不到通知`;
}
