/**
 * 职责：JAN 码（日本的商品条形码，GS1 的 EAN-13 / EAN-8）的形状、校验位与输入归一——服务端与管理端共用。
 *
 * @why 两端输入测试 2026-10-12：服务端原先只判长度（≤13），"123abc" 能存进去；采购按 JAN 对货、管理端按 JAN 搜，都对不上。
 * @why 形状（8 或 13 位数字）是**硬规则**，校验位只**提醒**：模拟库里有编出来的测试 JAN 校验位不对，
 *      真货的 JAN 校验位一定对——错了多半是抄错一位，但拦下来会让旧数据改不动，所以交给运营核对。
 * @limitation 不认 12 位 UPC（美国货）：本店卖日本商品；真要收 UPC 再放宽形状。
 */

/** 8 位或 13 位数字。 */
export function janShapeOk(v: string): boolean {
  return /^(?:\d{8}|\d{13})$/.test(v);
}

/** GS1 校验位（mod 10，从右数第 2 位起奇数位 ×3）；形状不对返回 false。 */
export function janCheckDigitOk(v: string): boolean {
  if (!janShapeOk(v)) return false;
  const d = [...v].map(Number);
  const last = d.pop() ?? -1;
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === last;
}

/** 输入归一：全角数字转半角（NFKC），去掉空格与横线（照着条形码分段抄的常见写法）。 */
export function normalizeJan(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s-]/g, '');
}
