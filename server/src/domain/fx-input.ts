/**
 * 职责：`POST /admin/fx` 的输入校验，以及「展示汇率 `rate`」的**唯一一处**计算（I2 U-C1）。
 *
 * @why `rate = raw_rate × (1 + buffer)` 只能有一份：
 *      它是买家看到的展示价的**唯一来源**（domain/quote.ts 经 `toRateInt` 消费
 *      `fx_rates.rate`，而管理端只提交 `raw_rate`）。这步乘法出现第二份的话，
 *      两份迟早漂移，而漂移的表现是"展示价与汇率表对不上"——不报错、不告警，
 *      只在对账时才发现。与 D-46 运费取档方向是同一类静默事故。
 *
 * @why 结果**先对齐到 1e-8 网格**再返回（`fx_rates.rate` 是 NUMERIC(18,8)）：
 *      `toRateInt` 做的是 `round(rate × 1e8)`。若 rate 带着浮点尾巴（0.0065×1.03 在
 *      double 里不精确），"存库时的 8 位截断"与"读取后的 ×1e8 取整"就是**两次**舍入，
 *      方向相反时会差 1 个最小单位——单笔看不出来，对账时是一笔糊涂账。
 *      先对齐，两次舍入变一次。
 *
 * @limitation 一：只认 **CNY / USD** 两个展示币（契约 enum）。JPY 是定价锚不是展示汇率，
 *              它的换算恒为 1，没有维护入口（ADR：JPY 唯一定价锚 = 结算币 = 记账币）。
 *              将来加展示币 = 改这里 + 契约 + 前端三处（与 PRODUCT_STATUS 同口径）。
 * @limitation 二：raw_rate 的上下界是 **per-quote 量纲护栏**，不是"合理汇率范围"——
 *              它挡的是"这个数根本不可能是这个币种的汇率"（`FX_RAW_RATE_BOUNDS`，AJ-297）。
 *              ✅ 已能挡住"打错一位"（0.0067 → 0.067 / 0.00067）：分币种看汇率是有硬边界的
 *              物理量，边界取浮动汇率时代的历史极值再放宽约 1.7 倍，而错一位是 10 倍。
 *              ⚠️ 挡不住"两个币种填反"（0.049 填到 USD 上会被区间拦住，但 0.02 填到
 *              USD 上不会——0.02 在 USD 区间边界上、恰好是 CNY 的合理值）。
 *              这类"跨币种串位"要靠前端的**样例金额**核对（`fxPreview`），不是本函数能判的。
 *              ⚠️ 也不取代路由层的 `fx_rate_jump` warn：那是"与上一行比较"的**可观测**，
 *              拦的是量纲、记的是突变，两者是互补的两层，不是同一个东西的两份实现。
 *
 * @see contracts/api-contract.yaml（FxRate / POST /admin/fx）；
 *      config.ts（FX_BUFFER_RATE，zod 已限 [0, 0.5]）；
 *      adapters/ops-config.ts（唯一写入方）；app/admin-ops-routes.ts（唯一调用方）
 */
import { FX_RAW_RATE_BOUNDS } from '@waselect/shared';
import { AppError } from '../errors.js';
import { tryParseRfc3339Ms } from './time-input.js';

/** 契约 `POST /admin/fx` 的 quote 枚举（单测与契约双向比对；JPY 不在内，见 @limitation 一）。 */
export const FX_QUOTES = ['CNY', 'USD'] as const;
export type FxQuote = (typeof FX_QUOTES)[number];

/** NUMERIC(18,8) 的小数位；对齐到这个网格，让"存库截断"与"×1e8 取整"合为一次舍入。 */
const RATE_GRID = 1e8;

/** 校验后的汇率输入。 */
export interface FxInputValue {
  quote: FxQuote;
  rawRate: number;
  /**
   * 生效时间（**UTC 毫秒**）；`null` = 调用方填 `clock.now()`。
   * @why 用毫秒而不是 `Date` 对象：F10 的纯度规则在 AST 层禁一切 `new Date(...)`，
   *      连"把请求里的字符串解析成 Date"也命中（它分不出"取当前时间"与"解析输入"）。
   *      这里改用 `Date.parse`（规则明文不禁），Date 对象只在 adapters 侧构造
   *      （`clock.now()` 与仓储内部各一处，都在豁免清单内）。
   * ⚠️ 这里曾经写"毫秒是规范化的 UTC 值，**没有时区歧义**"——那句只对
   *      **带偏移的 RFC 3339** 成立，而原来的实现是 `Date.parse` 兜底：
   *      不带偏移的输入会按**本进程时区**解释（DOM3-03，本机 JST 与生产 UTC 差 8 小时），
   *      `"1"` 还会被解析成 2001 年。现在入口是 `parseRfc3339Ms`（偏移必填），
   *      这句话才真的成立——"没有歧义"是**收紧之后**的性质，不是 `Date.parse` 的性质。
   */
  effectiveFromMs: number | null;
}

/**
 * 校验并取出汇率输入（纯：不查库、不取时钟、不算 rate——算 rate 需要 config 的 buffer）。
 * @throws {AppError} 40001 形状 / 枚举 / 数值域（见文件头 @limitation 二）
 */
export function parseFxInput(body: unknown): FxInputValue {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object') throw new AppError(40001, { reason: 'body_shape' });

  const quote = b['quote'];
  if (typeof quote !== 'string' || !(FX_QUOTES as readonly string[]).includes(quote)) {
    throw new AppError(40001, { reason: 'quote_invalid' });
  }
  const rawRate = b['raw_rate'];
  if (typeof rawRate !== 'number' || !Number.isFinite(rawRate)) {
    throw new AppError(40001, { reason: 'raw_rate_invalid' });
  }
  // AJ-297：per-quote 量纲护栏。区间 = 浮动汇率时代的历史极值再放宽约 1.7 倍
  // （常量与依据在 `packages/shared/src/limits.ts`），"错一位"是 10 倍 ⇒ 必然越界，
  // 真实波动远到不了 1.7 倍 ⇒ 拦得住且不误伤。
  // @why 它把旧的三个分支**整个吞掉了**：旧的是 `<=0 || >1000`（out_of_range）与
  //      `<5e-9`（too_small，防对齐网格后变 0）。新区间 [0.002, 0.02] / [0.02, 0.17]
  //      完全落在旧区间内部 ⇒ 旧分支**不可达**，按 AJ-256 / AJ-291 的同一条纪律删掉，
  //      不留"永远取不到红灯"的死分支（0 与负数同样被 min 一并挡住，不必再单列）。
  const bounds = FX_RAW_RATE_BOUNDS[quote as FxQuote];
  if (rawRate < bounds.min || rawRate > bounds.max) {
    throw new AppError(40001, {
      reason: 'raw_rate_magnitude',
      quote,
      min: bounds.min,
      max: bounds.max,
    });
  }

  const raw = b['effective_from'];
  if (raw === undefined || raw === null) {
    return { quote: quote as FxQuote, rawRate, effectiveFromMs: null };
  }
  if (typeof raw !== 'string') throw new AppError(40001, { reason: 'effective_from_invalid' });
  // ⚠️ 走 `parseRfc3339Ms` 而不是 `Date.parse`（DOM3-03）：后者对不带偏移的输入
  //    按**本进程时区**解释（本机 JST / 生产 UTC 相差 8 小时），还接受 `"1"`（→ 2001 年）
  //    这类非 RFC 3339 串。契约写的是 `format: date-time`，偏移必填。
  const ms = tryParseRfc3339Ms(raw);
  if (ms === null) throw new AppError(40001, { reason: 'effective_from_invalid' });
  return { quote: quote as FxQuote, rawRate, effectiveFromMs: ms };
}

/**
 * 原始汇率 → 带缓冲的展示汇率（**唯一实现**，见文件头 @why）。
 * @param buffer `config.FX_BUFFER_RATE`（[0, 0.5]）
 */
export function applyFxBuffer(rawRate: number, buffer: number): number {
  return Math.round(rawRate * (1 + buffer) * RATE_GRID) / RATE_GRID;
}
