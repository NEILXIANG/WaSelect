/**
 * 职责：报价装配（I1-U5b 从 quote-routes.ts 提炼）——「行项目汇总 → 运费/目的国/关税/汇率
 *      全部解析 → computeQuote」这段编排的**唯一出处**。
 *
 * @why 报价路由（U4）与建单（U5b）需要**同一份**重算逻辑：方案 §3.5 的"服务端重算"，
 *      语义就是"按报价的同一套规则再算一遍"——各写一份的话，"报价页看到的合计"与
 *      "建单重算的合计"会在某次改动后悄悄分叉，40905 要么误伤要么失效。
 *      收敛成一个函数后，40905 的语义自动等于"与报价一致"。
 *
 * @why 返回里带上 `fxMap`（NUMERIC 原样字符串）：建单要写 fx_snapshot（建单时刻汇率快照），
 *      报价不需要——但"重算时用的汇率"与"落快照的汇率"必须是**同一次查询**的结果，
 *      所以由装配处一并返回，而不是让建单再查一次（两次查询之间汇率可能被维护方更新）。
 *
 * @limitation 一：本函数在**调用方的事务里**执行（tx 句柄即 db）：建单路径用它时
 *              读到的商品/汇率与后续扣减/插入同事务，无 TOCTOU 窗口。
 * @limitation 二：目的国/展示币的表驱动口径与 quote-routes 文件头 @why 相同
 *              （country_profiles 恰好一个 active → 它定 dest 与展示币；否则 dest=null、
 *              展示币回落 config）——两处注释刻意重复关键结论，改口径时两边一起看。
 *
 * @see app/quote-routes.ts（消费方①：报价）；app/create-order.ts（消费方②：建单重算）
 */
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { AppError } from '../errors.js';
import { createCatalogRepo } from '../adapters/catalog.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import {
  computeQuote,
  dutyRatioIntOf,
  type DisplayCurrency,
  type QuoteComputation,
  type QuoteItemsSummary,
} from '../domain/quote.js';
import { toRateInt } from '@waselect/shared';

export interface AssembledQuote {
  /** 重算结果（金额/重量/展示价/duty 全在里面）。 */
  q: QuoteComputation;
  /** 本次重算用到的汇率（quote → NUMERIC 原样字符串）；建单写 fx_snapshot 用。 */
  fxMap: ReadonlyMap<string, string>;
  /** 实际取档的承运商（记日志用）。 */
  carrier: string;
  /** 目的国（null = 无法唯一确定，duty 未估算）。 */
  dest: string | null;
  /** 本次使用的展示币列表（过滤 JPY 后）。 */
  displayCurrencies: readonly DisplayCurrency[];
}

/**
 * 装配一次报价（重算）。
 *
 * @throws {AppError} 50004 承运商 ≠1 家活跃（含运费表未配置）| 40912 包裹超过最大一档（AJ-239）
 * @throws {AppError} 50003 任一展示币汇率缺失（computeQuote 抛出）
 */
export async function assembleQuote(
  db: Db,
  config: AppConfig,
  clock: Clock,
  summary: QuoteItemsSummary,
  extraFxQuotes: readonly string[] = [],
  /** 汇率过期时打 error 日志用（剩余清单 1-2）；不传则只按缺失处理。 */
  logger?: Logger,
): Promise<AssembledQuote> {
  const catalog = createCatalogRepo(db);
  const countryProfiles = createCountryProfileRepo(db);

  // 运费取档（D-46 唯一 SQL 在 catalog 仓储）
  const weightG = summary.goodsWeightG + config.PACKAGING_WEIGHT_G;
  // ⚠️ 一条快照里做完"选承运商 + 取档"（DB3-04）：分开两条语句时，中间的整表替换
  //    会让第二条查不到刚读到的承运商 ⇒ 把"配置切换"报成 40912「超重」。
  const shipping = await catalog.findSoleCarrierShippingJpy(weightG);
  if (shipping.kind === 'no_carrier') {
    throw new AppError(50004, { reason: 'carrier_not_unambiguous' });
  }
  /**
   * `overweight` = 承运商明确、但包裹比最大一档还重（AJ-239）→ 40912（409，拆单），不是 50004。
   * @why 走到这里时"运费表没配"已被排除：`no_carrier` 已在上一条分流，而"承运商存在"
   *      的前提是它**至少有一档启用的运费**，所以剩下的唯一原因是超重。
   *      此前两种情况共用 50004：买家看到"系统错误"没有拆单指引，
   *      而且每改一次数量一条 5xx + error 日志，会把真正的配置事故淹掉。
   * @why 判别联合而不是"取不到档就再查一次"：再查一次就要拿第二个快照，
   *      而第二个快照正是 DB3-04 那个竞态的入口（曾写过的那条"再查最大档"分支
   *      在正常路径不可达，注回后没有用例会红，按约束八删掉了）。
   */
  if (shipping.kind === 'overweight') {
    throw new AppError(40912, {
      reason: 'over_max_shipping_weight',
      ctx: { carrier: shipping.carrier, weight_g: weightG },
    });
  }
  const { carrier, priceJpy: shippingJpy } = shipping;

  // 目的国 + 展示币（表驱动，@limitation 二）
  const actives = await countryProfiles.listActive();
  const dest = actives.length === 1 ? (actives[0]?.code ?? null) : null;
  const displayCurrencies = (
    actives.length === 1 ? (actives[0]?.displayCurrencies ?? []) : config.DISPLAY_CURRENCIES
  ).filter((c): c is DisplayCurrency => c !== 'JPY');

  // 关税率：同产地 + 目的国可定才估算；查不到 → duty_jpy=null（信息缺失不阻单）
  const dutyRate =
    dest !== null && summary.origins.length === 1
      ? await catalog.findDutyRate(summary.origins[0] ?? 'JP', dest)
      : null;

  // 当日汇率（缺币 → computeQuote 抛 50003）。
  // extraFxQuotes（如建单的申报价值必须 USD）并入**同一次**查询但不进 display——
  // "重算用的汇率"与"落快照/申报的汇率"必须是同一次读取（文件头 @why）
  const fxQuotes = [...new Set([...displayCurrencies, ...extraFxQuotes])];
  // 超过 FX_MAX_AGE_HOURS 未更新的汇率当作缺失（→ 50003 停止报价）：收钱路径不能用过期汇率
  const { rates: fxMap, stale } = await catalog.findFreshFxRates(
    fxQuotes,
    clock.now(),
    config.FX_MAX_AGE_HOURS,
  );
  if (stale.length > 0) {
    logger?.error('fx_rate_stale', {
      result: 'rejected',
      ctx: { quotes: stale, max_age_hours: config.FX_MAX_AGE_HOURS },
    });
  }
  const fxRateIntByCurrency: Partial<Record<DisplayCurrency, number>> = {};
  for (const c of displayCurrencies) {
    const rate = fxMap.get(c);
    if (rate !== undefined) fxRateIntByCurrency[c] = toRateInt(rate);
  }

  const q = computeQuote({
    itemsJpy: summary.itemsJpy,
    goodsWeightG: summary.goodsWeightG,
    packagingWeightG: config.PACKAGING_WEIGHT_G,
    shippingJpy,
    dutyRatioInt: dutyRatioIntOf(dutyRate),
    fxRateIntByCurrency,
    displayCurrencies,
    freeShippingThresholdJpy: config.FREE_SHIPPING_JPY ?? null,
    maxOrderJpy: config.MAX_ORDER_JPY,
  });
  return { q, fxMap, carrier, dest, displayCurrencies };
}
