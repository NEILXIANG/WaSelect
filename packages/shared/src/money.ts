/**
 * 职责：金额值对象 `Money` 与**唯一的**换算/取整实现（地基 F2b）。
 * 边界：纯函数，零依赖；不做汇率来源、不做格式化（格式化属前端/展示层）。
 * @see ADR-09（JPY 唯一锚，整数最小单位）、技术文档 v0.5 §0（汇率 ×1e8 整数）、§2.5、评审 #5
 * @limitation 金额一律**整数最小单位**（JPY=円，USD/CNY=分）；传小数直接抛错，不允许"先四舍五入再存"。
 * @tradeoff 取整规则定为 **half-up（远离零方向）** 并集中在 `toMinor` 一处：
 *           业务里禁止再出现 `Math.round`，否则同一笔钱在不同路径算出不同结果（差 1 分钱级事故）。
 *           代价：与部分机构"向下取整"的清算口径可能不一致——真出现差异时改这一处 + 补属性测试，不要在调用点打补丁。
 * @why 金额换算若散落在各处，`Math.round` / 浮点精度会让同一笔钱在不同路径算出不同结果（差 1 分钱级事故，
 *      且这种差异不会报错，只会在对账时冒出来）。所以这里定为**唯一入口**，业务代码禁止再自行取整。
 */

export type CurrencyCode = 'JPY' | 'USD' | 'CNY';

export interface Money {
  /** 最小货币单位的整数金额（JPY=円，USD/CNY=分） */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** 构造 Money：非整数 / 非有限数 / 未知币种一律抛错（把脏数据挡在边界上）。 */
export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amount) || !Number.isFinite(amount)) {
    throw new RangeError(`金额必须是整数最小单位，收到 ${amount}`);
  }
  return { amount, currency };
}

/** 同币种相加；跨币种抛错（禁止隐式换算）。 */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new TypeError(`跨币种相加被禁止：${a.currency} + ${b.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

/** 同币种列表求和（空列表返回 0）。 */
export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  let total = 0;
  for (const it of items) {
    if (it.currency !== currency) throw new TypeError(`币种不一致：${it.currency} != ${currency}`);
    total += it.amount;
  }
  return money(total, currency);
}

/**
 * 汇率放大倍数：`fx_rates.rate` 是 NUMERIC(18,8)，在程序里一律以 **rate × 1e8 的整数**参与运算。
 * @why 技术文档 §0 明文规定：汇率按 ×1e8 整数参与运算，换算函数唯一 `toMinor(jpy, rateInt)`。
 *      浮点乘法在边界上会差 1 个最小单位（实测：1250 × 0.0676 的浮点结果是 84.4999…，
 *      half-up 得 84 而精确值是 85），而"差 1 分钱"在跨境对账里是最难查的一类事故。
 */
export const RATE_SCALE = 100_000_000;

/** `toMinor` 的除数：`jpy × rateInt / 1e6` = `jpy × rate × 100`（主单位 → 最小单位）。 */
const MINOR_DIVISOR = 1_000_000;

/** 汇率上限：超过它 `rate × 1e8` 会逼近 2^53 而失去整数精确性。JPY→USD/CNY 的汇率永远远小于此。 */
const MAX_RATE = 1_000_000;

/**
 * 把汇率转成 ×1e8 的整数——**所有换算前必须先过这一层**。
 * @param rate 汇率；可以是 `NUMERIC(18,8)` 驱动返回的 **string**（postgres.js 把 numeric 返回成字符串），也可以是 number
 * @limitation 只支持 |rate| < 1e6：超出后 `rate × 1e8` 超过 2^53，整数运算不再精确。
 *             本项目只涉及 JPY→USD/CNY（约 0.0067 / 0.049），永远够用；真出现大汇率应当改走 BigInt。
 */
export function toRateInt(rate: number | string): number {
  const n = typeof rate === 'string' ? Number(rate) : rate;
  if (!Number.isFinite(n)) {
    throw new RangeError(`汇率必须是有限数，收到 ${String(rate)}`);
  }
  if (Math.abs(n) >= MAX_RATE) {
    throw new RangeError(`汇率超出可精确表示的范围（|rate| < ${MAX_RATE}）：${n}`);
  }
  // 三审 P3-6：0 / 负汇率在数学上"合法"，在业务上是事故（全站按 0 元或负数收款）——
  // 唯一换算入口必须把它挡住，不能指望上游（fx 仓储属 I1）都记得校验
  if (n <= 0) {
    throw new RangeError(`汇率必须为正数，收到 ${n}`);
  }
  // 浮点乘法后取整：double 相对误差约 1e-16，乘 1e8 后绝对误差约 1e-8，远小于 0.5，故取整安全
  return Math.round(n * RATE_SCALE);
}

/**
 * **唯一的**换算 + 取整入口：日元金额 → 目标币种的**最小单位**（USD/CNY 为「分」）。
 *
 * 公式（技术文档 §0）：`toMinor(jpy, rateInt) = Math.round(jpy × rateInt / 1e6)`
 *
 * @param jpy 日元金额（整数円）
 * @param rateInt `toRateInt()` 的结果（rate × 1e8 的整数），**不是裸小数汇率**
 * @returns 目标币种的整数最小单位
 *
 * @why 内部用**整数商 + 余数**实现 half-up，而不是 `Math.round(乘积 / 1e6)`。
 *      ⚠️ 诚实标注：我做过注入实验——把这里换回浮点除法，属性测试**不会**变红。
 *      在本项目取值区间内两者结果一致（乘积是精确整数、商 ≤ 2e7，double 绝对误差约 1e-9，
 *      远小于 1e-6 的进位判定粒度），所以整数实现属**纵深防御**，不是已证实的修复。
 *      **真正的修复在 `toRateInt`**：把小数汇率转成 ×1e8 整数，才消灭了
 *      `1250 × 0.0676 = 84.4999…` 那一类误差。保留整数实现只为将来放开单笔上限 / 汇率范围时不静默退化。
 *      实现：把除法拆成整数商 q 与余数 r，用 `2r >= 1e6` 判定进位，全程无浮点除法。
 * @limitation 乘积 `jpy × rateInt` 必须落在 2^53 内（约 9e15）。按 MAX_ORDER_JPY=180,000 与
 *             rateInt ≤ 1e8 计算，乘积上限 1.8e13，安全；若将来放开单笔上限，需先改走 BigInt。
 */
export function toMinor(jpy: number, rateInt: number): number {
  if (!Number.isInteger(jpy)) throw new RangeError(`日元金额必须是整数，收到 ${jpy}`);
  if (!Number.isInteger(rateInt)) throw new RangeError(`汇率必须是 ×1e8 后的整数，收到 ${rateInt}`);

  const product = jpy * rateInt;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`换算乘积超出安全整数范围：${jpy} × ${rateInt}`);
  }

  const sign = product < 0 ? -1 : 1;
  const abs = Math.abs(product);
  const quotient = Math.floor(abs / MINOR_DIVISOR);
  const remainder = abs - quotient * MINOR_DIVISOR;
  const roundUp = remainder * 2 >= MINOR_DIVISOR ? 1 : 0;
  return sign * (quotient + roundUp);
}

/**
 * 按权重把总额**精确拆分**到各项（最大余额法），保证各项之和 === 总额，不产生 1 分钱误差。
 * 用途：把订单总额按商品金额占比摊到申报价值 / 退款拆分等场景。
 * @param total 整数（最小货币单位）；负总额合法（退款拆分，D18 复核结论）
 * @param weights 各项权重，**不得为负**（N14：负权重会摊出负数项、而和仍等于总额——静默错）
 * @returns 与 weights 等长的整数数组，其和恒等于 total
 * @throws {RangeError} 总额非整数（floor 会静默抹掉小数）、权重为负或非有限数、权重之和为 0
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  // N14：输入校验必须在分摊之前。这两类非法输入的共同点是**不抛错、结果还自洽**：
  // 负权重摊出的数组和仍等于总额；非整数总额被 floor 抹掉后各项都是整数——
  // 下游任何"和校验"都发现不了，只能在这里挡。
  if (!Number.isInteger(total)) {
    throw new RangeError(`总额必须是整数（最小货币单位），收到 ${total}`);
  }
  for (const w of weights) {
    if (!Number.isFinite(w)) throw new RangeError(`权重必须是有限数，收到 ${w}`);
    if (w < 0) throw new RangeError(`权重不得为负（会摊出负数项），收到 ${w}`);
  }
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0) throw new RangeError('权重之和必须为正');
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  const remainder = total - floors.reduce((acc, v) => acc + v, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  // 余数降序的前 remainder 项各 +1。用 Set + map 而不是"按下标自增"：
  // 后者在 `noUncheckedIndexedAccess` 下必须写 `out[i] ?? 0`，而那是一条**不可达分支**——
  // 既骗不过覆盖率门禁（实测卡住 money.ts 分支 96.66%），又暗示了不存在的风险。
  const bumped = new Set(order.slice(0, remainder).map((o) => o.i));
  return floors.map((v, i) => (bumped.has(i) ? v + 1 : v));
}
