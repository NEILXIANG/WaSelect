/**
 * 职责：订单号（对人单号）格式化与解析——唯一生成处（地基 F2b）。
 * 边界：纯函数；序号由调用方（仓储层）用 DB 序列或 ID 工厂提供，本模块不产生随机。
 * 格式：`W` + JST 日期(YYYYMMDD) + `-` + 6 位 Crockford Base32 序号 → 共 16 字符（DB `order_no VARCHAR(20)`）。
 * @see 技术文档 v0.5 §3（orders.order_no）；评审 #5
 * @limitation 序号 6 位 Base32 上限约 10 亿/天，超出会溢出到第 7 位并突破 20 字符上限——
 *             真到那个量级应当改格式（那时是幸福的问题），此处不做静默截断。
 * @tradeoff 把日期放进单号而非纯随机：客服报单号就能知道是哪天下的；代价是暴露下单日期（可接受）。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SEQ_LEN = 6;

/** 把非负整数编码为固定长度的 Crockford Base32（左补 0）。 */
export function encodeSeq(seq: number, len: number = SEQ_LEN): string {
  if (!Number.isInteger(seq) || seq < 0) throw new RangeError('序号必须是非负整数');
  let out = '';
  let n = seq;
  do {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  } while (out.length < len && n > 0);
  return out.padStart(len, '0');
}

/** 生成订单号。jstDate 为 JST 业务日（YYYYMMDD，见 businessDay.ts）。 */
export function formatOrderNo(jstDate: string, seq: number): string {
  if (!/^\d{8}$/.test(jstDate)) throw new RangeError(`jstDate 必须为 YYYYMMDD，收到 ${jstDate}`);
  return `W${jstDate}-${encodeSeq(seq)}`;
}

/** 从订单号解析出 JST 业务日（YYYYMMDD）；格式不符返回 undefined。 */
export function parseOrderNoDate(orderNo: string): string | undefined {
  const m = /^W(\d{8})-[0-9A-HJKMNP-TV-Z]+$/.exec(orderNo);
  return m?.[1];
}
