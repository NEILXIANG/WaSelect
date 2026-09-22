/**
 * 职责：金额值对象 `Money` 与**唯一的**换算/取整实现（地基 F2b）。
 * 边界：纯函数，零依赖；不做汇率来源、不做格式化（格式化属前端/展示层）。
 * @see ADR-09（JPY 唯一锚，整数最小单位）、技术文档 v0.5 §2.5、评审 #5
 * @limitation 金额一律**整数最小单位**（JPY=円，USD/CNY=分）；传小数直接抛错，不允许"先四舍五入再存"。
 * @tradeoff 取整规则定为 **half-up（远离零方向）** 并集中在 `convert` 一处：
 *           业务里禁止再出现 `Math.round`，否则同一笔钱在不同路径算出不同结果（差 1 分钱级事故）。
 *           代价：与部分机构"向下取整"的清算口径可能不一致——真出现差异时改这一处 + 补属性测试，不要在调用点打补丁。
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
 * 换算 + 取整的**唯一**入口：half-up（正数四舍五入，负数对称）。
 * @param amount 源币种整数金额
 * @param rate 1 源币 = rate 目标币（例如 1 JPY = 0.00676 USD）
 * @returns 目标币种整数金额（已取整）
 */
export function convert(amount: number, rate: number): number {
  const raw = amount * rate;
  return raw >= 0 ? Math.floor(raw + 0.5) : Math.ceil(raw - 0.5);
}

/**
 * 按权重把总额**精确拆分**到各项（最大余额法），保证各项之和 === 总额，不产生 1 分钱误差。
 * 用途：把订单总额按商品金额占比摊到申报价值 / 退款拆分等场景。
 * @returns 与 weights 等长的整数数组，其和恒等于 total
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0) throw new RangeError('权重之和必须为正');
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((acc, v) => acc + v, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    remainder -= 1;
  }
  return out;
}
