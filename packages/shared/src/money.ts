/**
 * 职责：金额值对象 `Money` 与**唯一的**换算/取整实现（地基 F2b）。
 * 边界：纯函数，除同包 `enums.js` 的币种枚举（类型派生）外零依赖；不做汇率来源、不做格式化（格式化属前端/展示层）。
 * @see ADR-09（JPY 唯一锚，整数最小单位）、技术文档 v0.5 §0（汇率 ×1e8 整数）、§2.5、评审 #5
 * @limitation 金额一律**整数最小单位**（JPY=円，USD/CNY=分）；传小数直接抛错，不允许"先四舍五入再存"。
 * @tradeoff 取整规则定为 **half-up（远离零方向）** 并集中在 `toMinor` 一处：
 *           业务里禁止再出现 `Math.round`，否则同一笔钱在不同路径算出不同结果（差 1 分钱级事故）。
 *           代价：与部分机构"向下取整"的清算口径可能不一致——真出现差异时改这一处 + 补属性测试，不要在调用点打补丁。
 * @why 金额换算若散落在各处，`Math.round` / 浮点精度会让同一笔钱在不同路径算出不同结果（差 1 分钱级事故，
 *      且这种差异不会报错，只会在对账时冒出来）。所以这里定为**唯一入口**，业务代码禁止再自行取整。
 */
import type { Currency } from './enums.js';

/**
 * 币种代码（`Money.currency` 与 `CURRENCY_MINOR_DIGITS` 的键）。
 *
 * @why 刻意**从 `enums.CURRENCY` 派生**，而不是在本文件再写一份 `'JPY' | 'USD' | 'CNY'`：
 *      那等于把"支持哪几种货币"记在两处，加一种货币时改一处漏一处——
 *      漏的表现不是报错，而是 `CURRENCY_MINOR_DIGITS` 缺键、展示层退回 `—`
 *      （B43 实锤过同类事故：把 3350 显示成 `USD 3350`，读大 100 倍且不报错）。
 *      派生之后只有 `enums.CURRENCY` 一个入口；且因为 `CURRENCY_MINOR_DIGITS` 是
 *      `Record<CurrencyCode, number>`，往 `CURRENCY` 加一种货币而漏补这张表时
 *      **编译期就红**，不靠人记得。
 * @see enums.ts（`CURRENCY`，唯一真源）
 */
export type CurrencyCode = Currency;

/**
 * 各币种**最小单位的小数位**（B43 / AJ-214）：JPY=0（円就是最小单位），USD/CNY=2（分）。
 *
 * @why 这张表必须放 shared（跨端唯一真源）而不是各自在前端写：
 *      "最小单位 → 主单位"的换算在**每个显示钱的地方**都会用到，而缺了它的表现是
 *      **把 3350 显示成 USD 3350**（读大 100 倍）——不报错、不崩溃，
 *      客服据此答复客户、运营据此判断是否应诉（B43 实锤：订单详情与拒付列表都是这么错的）。
 *      前端再写一份常量就会变成两份口径，加一种货币时必漏一处（约束九）。
 * @limitation 只覆盖 `CurrencyCode` 三个币种；将来加币种**必须同时**改这里与
 *              契约的枚举（漏改的表现是显示时退回"原样输出最小单位"）。
 */
export const CURRENCY_MINOR_DIGITS: Readonly<Record<CurrencyCode, number>> = {
  JPY: 0,
  USD: 2,
  CNY: 2,
};

export interface Money {
  /** 最小货币单位的整数金额（JPY=円，USD/CNY=分） */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** 构造 Money：非整数 / 非有限数 / 未知币种一律抛错（把脏数据挡在边界上）。 */
export function money(amount: number, currency: CurrencyCode): Money {
  // ⚠️ 只判 `Number.isInteger` 一道：它**已经蕴含** isFinite（NaN 与 ±Infinity 都不是整数），
  //    再并一条 `|| !Number.isFinite(amount)` 是永假分支——`||` 短路后它只在 isInteger 为真时被求值，
  //    而那时 isFinite 必为真。留着它的代价不是性能，是**读错**：读者会以为这里有两道防线，
  //    于是"非有限数由哪条挡住"变得含糊，而这类含糊正是下一次改这里的人踩坑的地方（C3-01）。
  if (!Number.isInteger(amount)) {
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

/**
 * 汇率上限（**量纲护栏**，不是精度边界）。
 *
 * @why 上界取 1e6 是"JPY→外币的汇率不可能到这个量级"（JPY→USD/CNY 约 0.0067 / 0.049），
 *      用来挡"把汇率录成 600 或 100 万"这类**录入事故**——
 *      它们会让 `toMinor` 的乘积冲出安全整数域，表现是报价 / 建单 50000（DOM3-05）。
 * ⚠️ 这里**曾经**写"超过它 `rate × 1e8` 会逼近 2^53"——那是错的（DOM3-06②）：
 *      `1e6 × 1e8 = 1e14`，距 2^53（≈9.007e15）还差近两个数量级，
 *      真正的精度边界约在 rate ≈ 9e7。照旧注释读会以为 1e6 是一条**硬**精度边界，
 *      于是"把上界放宽到 1e7"看起来是越界的改动，而它其实仍然安全。
 */
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
  const out = Math.round(n * RATE_SCALE);
  /**
   * ⚠️ **取整之后**再判一次（DOM3-04）：上面那条 `n <= 0` 挡不住 `0 < n < 5e-9`
   * ——它们取整后同样是 0，于是"全站按 0 元收款"这个本条防线声称要消灭的事故照样发生。
   * @why 判定必须发生在**取整之后**，因为整数化才是真正的精度闸门：
   *      小数域里"正数"与"整数化后为 0"是两件事，而下游（`toMinor`）用的是后者。
   * @why 当前生产路径不可达（库列 NUMERIC(18,8) 的最小正值是 1e-8，`fx-input` 也拒 < 5e-9），
   *      但这条保证不该依赖"上游恰好是 NUMERIC(18,8)"——换数据源 / 放宽精度即失效。
   */
  if (out <= 0) {
    throw new RangeError(`汇率过小，×1e8 整数化后为 0（最小可用值 ${1 / RATE_SCALE}）：${n}`);
  }
  return out;
}

/**
 * **唯一的**换算 + 取整入口：日元金额 → 目标币种的**最小单位**（USD/CNY 为「分」）。
 *
 * 公式：`toMinor(jpy, rateInt) = round_half_away_from_zero(jpy × rateInt / 1e6)`
 *
 * ⚠️ 这里曾经照抄技术文档 §0 的 `Math.round(…)`（DOM3-06①）——**与实现相反**：
 *    `Math.round` 是 half-up（向 +∞），`Math.round(-0.5) = -0`；本实现是
 *    "远离零"的 half-up，`toMinor(-1, 500000) = -1`。两者只在**负数**上不同，
 *    而负数金额出现在退款拆分里。文档库 §0 应同步为"远离零"（请一并改，否则两处继续互相矛盾）。
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
 *      实现：把除法拆成整数商 q 与余数 r，用 `2r >= 1e6` 判定进位。
 *      ⚠️ 诚实标注（C3-01 更正）：上面曾经写"全程无浮点除法"——**与代码相反**，
 *      本函数确实用了 `Math.floor(abs / MINOR_DIVISOR)`。真正的保障不是"没有浮点除法"，
 *      而是**余数由 `abs - quotient × MINOR_DIVISOR` 重算**：即便浮点商少算了 1，
 *      余数会相应多出整整一个除数（≈1e6），随后 `2r >= 1e6` 判进位把它加回来——
 *      减一次加一次，误差被吸收，进位判定仍然正确。
 *      ⚠️ 这与上方"注入实验显示换回浮点除法属性测试不会变红"**不矛盾**，是同一件事的两面：
 *      在当前取值区间内两种写法结果本就一致，而"余数重算"保证的是放宽区间后**仍**一致。
 * @limitation 乘积 `jpy × rateInt` 必须落在 2^53 内（约 9e15），超出抛 `RangeError`。
 *             ⚠️ 这里曾经写"按 MAX_ORDER_JPY=180,000 与 rateInt ≤ 1e8 计算，乘积上限 1.8e13，安全"
 *             ——那句只在"汇率 ≤ 1"时成立（DOM3-05）。
 *             ⚠️ **2026-10-02（AJ-297）再改一次**：上一版修正引用的是 `fx-input` 的
 *             `MAX_RAW_RATE = 1000`（raw_rate ≳ 500 就顶穿），而那个常量已被 per-quote 区间
 *             `FX_RAW_RATE_BOUNDS` 取代（USD ≤ 0.02 / CNY ≤ 0.17）——**引用一个已删除的常量
 *             比算错更糟**，它让人按一条不存在的防线去推理。
 *             · 按**新**上界重算：rate ≤ 0.17 × (1 + 缓冲 0.5) = 0.255 ⇒ rateInt ≤ 2.55e7，
 *               单价又有 `validateProductInput` 的上界（MAX_ORDER_JPY=180,000）⇒
 *               单件商品怎么都不可能顶穿（1.8e5 × 2.55e7 ≈ 4.6e12，差 3 个数量级）。
 *             · **那是不是就不可达了？不是**——溢出换到了**金额侧**：报价**不硬拦**
 *               MAX_ORDER_JPY（它只是 `split_hint`，建单才 40906），所以
 *               `itemsJpy` 可以随 qty 放大到远超单笔上限；顶穿只需约 ¥3.5 億
 *               （= 上限价 18 万円 × 约 2000 件库存的同一商品加进车里）。
 *               ⇒ 本函数**仍然**保持抛 RangeError（响亮），由 `domain/quote.ts` 折成
 *               50003「汇率不可用」。安全域是**两个模块的乘积约束**，
 *               不是 money.ts 自己能承诺的——这正是它必须由调用方兜住的原因。
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
  // 归一化 -0（同 applyRate：负数小额乘率商的符号位会产出 -0）
  const out = sign * (quotient + roundUp);
  return out === 0 ? 0 : out;
}

/**
 * 无量纲比率（关税率等）→ ×1e8 的整数。
 *
 * @why 与 `toRateInt` 拆成两个函数而不是加参数：**汇率**为 0 是事故（全站按 0 元收款），
 *      **比率**为 0 是合法业务（零关税）。共用一个入口就得靠调用方记"这里 0 合法"，
 *      而"靠调用方记得"正是 toRateInt 三审 P3-6 要消灭的东西。
 * @param rate 比率（duty_rates.rate 是 NUMERIC(6,5)，驱动返回 string）；合法域 [0, MAX_RATE)
 * @throws {RangeError} 非有限数、为负、或超出可精确表示范围
 */
export function toRatioInt(rate: number | string): number {
  const n = typeof rate === 'string' ? Number(rate) : rate;
  if (!Number.isFinite(n)) {
    throw new RangeError(`比率必须是有限数，收到 ${String(rate)}`);
  }
  if (n < 0) {
    throw new RangeError(`比率不得为负，收到 ${n}`);
  }
  if (n >= MAX_RATE) {
    throw new RangeError(`比率超出可精确表示的范围（< ${MAX_RATE}）：${n}`);
  }
  return Math.round(n * RATE_SCALE);
}

/**
 * 同币种比率应用：`amount × ratio`（ratioInt 为 ratio × 1e8 的整数），half-up 取整。
 *
 * 用途：`duty_jpy = applyRate(items_jpy, dutyRatioInt)`——JPY → JPY 乘一个**无量纲**比率，
 * 不是币种换算。与 `toMinor` 的唯一区别是除数（1e8 vs 1e6）：
 * toMinor 是"换算到目标币最小单位"，本函数是"同币种乘率"，两者共用同一套 half-up 纪律
 * （整数商 + 余数，无浮点除法），取整规则仍只存在于本文件。
 *
 * @limitation 乘积 `amount × ratioInt` 必须落在 2^53 内：按 MAX_ORDER_JPY=180,000 与
 *             duty_rates 的 CHECK（rate < 1，即 ratioInt < 1e8）乘积上限 1.8e13，安全。
 */
export function applyRate(amount: number, ratioInt: number): number {
  if (!Number.isInteger(amount)) throw new RangeError(`金额必须是整数，收到 ${amount}`);
  if (!Number.isInteger(ratioInt))
    throw new RangeError(`比率必须是 ×1e8 后的整数，收到 ${ratioInt}`);
  if (ratioInt < 0) throw new RangeError(`比率不得为负，收到 ${ratioInt}`);

  const product = amount * ratioInt;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`乘率乘积超出安全整数范围：${amount} × ${ratioInt}`);
  }
  const sign = product < 0 ? -1 : 1;
  const abs = Math.abs(product);
  const quotient = Math.floor(abs / RATE_SCALE);
  const remainder = abs - quotient * RATE_SCALE;
  const roundUp = remainder * 2 >= RATE_SCALE ? 1 : 0;
  // 归一化 -0：sign × 0 会得到 -0，Object.is(-0, 0) 为 false、
  // 且 -0 进 JSON/日志后与 0 无法区分地漂移（applyRate 属性测试实抓：amount=-1, ratioInt=1）
  const out = sign * (quotient + roundUp);
  return out === 0 ? 0 : out;
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
  // ⚠️ 末尾把 `-0` 归一成 `0`（DOM3-06③）：负总额 + 零权重项会走出 `Math.floor(-0) = -0`,
  //    而本文件 `applyRate` / `toMinor` 都专门归一过它——-0 进 JSON / 日志后与 0 无法区分地漂移。
  //    同文件两种口径是最容易复发的一种不一致（下一次改这里的人不会记得去看 toMinor）。
  return floors.map((v, i) => {
    const out = bumped.has(i) ? v + 1 : v;
    return out === 0 ? 0 : out;
  });
}
