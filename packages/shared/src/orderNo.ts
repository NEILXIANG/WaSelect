/**
 * 职责：订单号（`order_no`，对人单号）的生成与解析——唯一生成处（地基 F2b）。
 * 边界：纯函数；**冲突重试不在这里**（要靠 DB 唯一约束判定，属仓储层职责，见 @limitation）。
 *
 * 格式（技术文档 v0.5 §1，逐字对齐）：`YYMMDD` + `-` + 6 位大写 Crockford Base32，例 `260919-K7Q2MN`。
 *
 * ⚠️ 示例**必须**能通过 `ORDER_NO_PATTERN`（曾经写的是 `260919-K7Q2ML`，含被排除的 `L`，
 *    于是"规范示例"会被本文件的 `formatOrderNo` 抛 RangeError 拒绝——
 *    文档与代码对不上时，照抄文档的人会写出永远无法入库的单号）。
 *    `orderNo.unit.test.ts` 里有一条用例专门钉住这个示例串。
 * 日期按 **JST** 业务日（见 `businessDay.jstDateShort()`）。DB `orders.order_no VARCHAR(20)`，本格式恒 13 字符。
 *
 * @why 随机段而**不是自增序号**（§1 明文"禁止自增"）：
 *      ① 自增会暴露每天的单量（从两个单号之差就能推算日销）；
 *      ② 顺序号可预测，等于给了一个枚举订单的入口（配合详情接口就是越权温床）。
 *      本文件曾实现为 `W` + YYYYMMDD + 自增序号，外部审查指出与文档冲突后改为随机段——
 *      **口径以技术文档为准，代码跟着改**，这是"单一事实来源"的执行方式。
 *
 * @limitation 一：随机段空间 32⁶ ≈ 10.7 亿/天。单日单量到十万级时碰撞概率约 0.5%（生日悖论），
 *              必须在写库时靠 `order_no` 唯一约束捕获冲突并**换新随机段重试**（§1 规定）。
 *              本模块只负责生成、不知道是否已存在；重试已在建单用例落地（`server/src/app/create-order.ts`：
 *              savepoint 内捕获唯一约束冲突、换新随机段重试 3 次；一致性审计 C9 更正原"F8 之后接入"）。
 * @limitation 二：`rand` 默认 `Math.random`，**不是密码学安全随机源**。
 *              默认值只为"不需要不可预测性"的场景留着（单测就靠它注入确定性随机段复现固定单号）；
 *              生产侧一律**注入 CSPRNG**：服务端在 `adapters/ids.ts` 注入 `node:crypto` 的 `randomInt`
 *              （PAY-001，2026-10-15）——单号对外暴露（支付短链、订单详情、客服沟通），可预测即枚举入口。
 *              注入时上界取 {@link ORDER_SEQ_SPACE}，别另写一个 `32 ** 6`。
 * @limitation 三：曾有一个"序号溢出静默截断"的缺陷——`encodeSeq(32⁶)` 与 `encodeSeq(0)` 都返回 `000000`，
 *              注释还写着"不做静默截断"，与实现相反。改成随机段后该问题从根上消失（不存在序号递增）。
 *
 * @see 技术文档 v0.5 §1（单号口径：YYMMDD + 6 位 base32，禁止自增）、§3（orders.order_no）；评审 #5
 */

/** Crockford Base32 字母表：去掉易混淆的 I / L / O / U。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SEQ_LEN = 6;

/**
 * 随机段的取值空间（32⁶ ≈ 10.7 亿）：注入 CSPRNG 时用它做上界。
 * @why 由 `ALPHABET` / `SEQ_LEN` 推出而不是再写一个 `32 ** 6`：上界写小了末位字符取不到（分布偏置），
 *      写大了又与字母表长度漂移——取值空间只能有一处定义。
 * @why 上界恰好整除字母表长度（32⁶ 是 32 的倍数），故 `randomInt(ORDER_SEQ_SPACE) / ORDER_SEQ_SPACE`
 *      映射回字符下标是均匀的，没有取模偏置。
 */
export const ORDER_SEQ_SPACE = ALPHABET.length ** SEQ_LEN;

/** 订单号格式：6 位日期 + 连字符 + 6 位随机段。 */
export const ORDER_NO_PATTERN = /^\d{6}-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * 生成 6 位随机段。
 * @param rand 随机源，返回 [0,1)；测试注入以确定值复现
 */
export function randomOrderSeq(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < SEQ_LEN; i += 1) {
    const idx = Math.floor(rand() * ALPHABET.length);
    // 兜底：某些 rand() 实现可能返回 1（越界），夹紧到末位字符而不是产生 undefined
    out += ALPHABET[Math.min(idx, ALPHABET.length - 1)];
  }
  return out;
}

/**
 * 拼装订单号。
 * @param yymmdd JST 业务日的 **6 位** YYMMDD（用 `businessDay.jstDateShort()` 取）
 * @param seq 6 位随机段（用 `randomOrderSeq()` 取）
 */
export function formatOrderNo(yymmdd: string, seq: string): string {
  if (!/^\d{6}$/.test(yymmdd)) {
    throw new RangeError(`日期段必须是 YYMMDD（6 位数字），收到 ${yymmdd}`);
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(seq)) {
    throw new RangeError(`随机段必须是 6 位 Crockford Base32 大写字符，收到 ${seq}`);
  }
  return `${yymmdd}-${seq}`;
}

/** 从订单号解析出 JST 业务日（YYMMDD，6 位）；格式不符返回 undefined。 */
export function parseOrderNoDate(orderNo: string): string | undefined {
  return /^(\d{6})-[0-9A-HJKMNP-TV-Z]{6}$/.exec(orderNo)?.[1];
}

/** 是否为合法订单号形状（入库前预校验，避免拿脏串去查库）。 */
export function isValidOrderNo(orderNo: string): boolean {
  return ORDER_NO_PATTERN.test(orderNo);
}
