/**
 * 职责：报关品名禁词与 HS 编码形状——服务端（validateProductInput）与管理端（商品表单预检）共用一份。
 *
 * @why 规律排查 2026-10-12：原先两份规则互相矛盾——服务端按整词比（`\bspf\b`），"SPF50+"、"sunscreens"、"drugs"
 *      全能存进库（日本防晒品名几乎都写 SPF50+），这正是 D-51 要拦的 FDA 药品 / 功效宣称；管理端按子串比，
 *      两边对同一个品名给出相反结论。HS 编码形状只有管理端判，绕过管理端的写入可以把 "HS3304" 写进报关单。
 * @tradeoff 禁词按**词首**匹配（`\bspf`）：SPF50 / sunscreens / drugs 都命中；代价是 "drugstore" 也命中——
 *           报关品名里写药妆店的情形极少，误伤时运营换个写法即可；漏判的后果是报关被扣。
 * @limitation 拆写（"s.p.f"、"drug-free"之外的变体）仍可能绕过；报关责任最终在申报人。
 *             HS 编码只判形状（数字、可用点号分段、合计 6–10 位），不判是否真实存在（通関業者的职责）。
 * @see server/src/domain/product-input.ts；admin-web/src/products/view.ts；D-51
 */

/** 会被美国 FDA 当成药品 / 功效宣称的词（D-51）。 */
export const CUSTOMS_DESC_BLOCKED_WORDS = [
  'medicated',
  'whitening',
  'spf',
  'sunscreen',
  'drug',
] as const;

/** 品名里命中的禁词（小写、按上表顺序、不重复）；没命中返回空数组。 */
export function customsDescBlockedHits(desc: string): string[] {
  return CUSTOMS_DESC_BLOCKED_WORDS.filter((w) => new RegExp(`\\b${w}`, 'i').test(desc));
}

/** HS 编码形状：数字，可用点号分段，数字合计 6–10 位（国际 6 位 → 美国 HTS 10 位）。 */
export function hsCodeShapeOk(raw: string): boolean {
  const t = raw.trim();
  if (!/^\d+(\.\d+)*$/.test(t)) return false;
  const digits = t.replace(/\./g, '').length;
  return digits >= 6 && digits <= 10;
}
