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
 * @limitation 二：raw_rate 的上界是**量纲护栏**不是"合理汇率范围"——
 *              它只挡"多打几个 0"（0.0067 打成 67），挡不住"打错一位"（0.067）。
 *              ⚠️ 后者目前**没有**任何自动防护：真正的护栏是"与上一行比较、突变超阈值就告警"，
 *              而"阈值多少"是一个没拍板的运营参数（汇率真的会剧烈波动，拦成硬失败会误伤），
 *              所以本单元只做**记录不做拦截**（路由层打一条 warn 日志，见 admin-ops-routes）。
 *              登记为待办：等运营给出可接受的日波动区间再升级为拦截。
 *
 * @see contracts/api-contract.yaml（FxRate / POST /admin/fx）；
 *      config.ts（FX_BUFFER_RATE，zod 已限 [0, 0.5]）；
 *      adapters/ops-config.ts（唯一写入方）；app/admin-ops-routes.ts（唯一调用方）
 */
import { AppError } from '../errors.js';
import { tryParseRfc3339Ms } from './time-input.js';

/** 契约 `POST /admin/fx` 的 quote 枚举（单测与契约双向比对；JPY 不在内，见 @limitation 一）。 */
export const FX_QUOTES = ['CNY', 'USD'] as const;
export type FxQuote = (typeof FX_QUOTES)[number];

/**
 * raw_rate 的量纲上界：1 円兑换超过 1000 个外币单位不成立（连 KRW 也远不到），
 * 必是录入错误。@see @limitation 二（它能挡什么、挡不了什么）。
 */
const MAX_RAW_RATE = 1000;

/** NUMERIC(18,8) 的小数位；对齐到这个网格，让"存库截断"与"×1e8 取整"合为一次舍入。 */
const RATE_GRID = 1e8;

/**
 * raw_rate 的**量纲下界**：小于它的值对齐到网格之后会变成 **0**（B25 / AJ-211）。
 *
 * @why 曾经只校验 `rawRate > 0`，而"正得离谱"的汇率同样是事故：
 *      `applyFxBuffer` 会把 `raw × (1+buffer)` 对齐到 1e-8 的网格，
 *      小于 `0.5 / RATE_GRID`（5×10⁻⁹）的值一律舍成 0 ⇒ `toRateInt(0)` 抛错 ⇒
 *      保存汇率这条**管理端写路径**直接 500，而之后每次读商品列表都会撞上同一个 0 汇率。
 * @why 取 `0.5 / RATE_GRID` 而不去算 buffer：buffer ≥ 0，所以
 *      `raw ≥ 0.5/GRID` ⇒ 缓冲后的值 ≥ 0.5/GRID ⇒ 对齐后 ≥ 1e-8 > 0，
 *      **对任意合法 buffer 都成立**——这样校验可以留在纯函数里，不需要知道配置。
 * @limitation 它只挡"舍成 0"，不挡"舍成很小但非 0"（例如 1e-8 的汇率本身没有业务意义）。
 *              那属于运营口径（A8 的二次确认与量级核对），不是本函数能判定的。
 */
const MIN_RAW_RATE = 0.5 / RATE_GRID;

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
  // 0 与负数：数学上合法、业务上是事故（全站展示价变 0 或负数），与 toRateInt 的同源判断
  if (rawRate <= 0 || rawRate > MAX_RAW_RATE) {
    throw new AppError(40001, { reason: 'raw_rate_out_of_range' });
  }
  // 正得离谱 = 对齐网格后变 0（B25 / AJ-211，见 MIN_RAW_RATE 的 @why）：
  // 分开报是为了让运营看得懂——"超出范围"与"小到会被舍成 0"是两种不同的录入错误
  if (rawRate < MIN_RAW_RATE) {
    throw new AppError(40001, { reason: 'raw_rate_too_small' });
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
