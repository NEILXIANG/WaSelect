/**
 * 职责：报价域纯函数（I1-U4）——购物车 → 金额/重量/展示价的**全部计算规则**都在这里。
 *
 * 边界：不查库、不读时钟、不认识承运商与国家档案。运费档价格、关税率、汇率都作为
 *      **已解析的输入**传入（解析是 adapters/catalog.ts 的事，装配是 app/quote-routes.ts 的事）。
 *
 * @why 拆成 `summarizeQuoteItems` + `computeQuote` 两段而不是一个大函数：
 *      运费取档（SQL）夹在"算总重"与"算总价"中间——总重是取档的输入，运费是总价的输入。
 *      若合成一个函数，要么把 SQL 塞进纯函数（分层破），要么在外面把校验逻辑拆开写两遍。
 *
 * @why duty_jpy 是**信息字段、不计入 total**（契约 Quote.duty_jpy 描述，13b 未定）：
 *      MVP 是 DDP（价格已含关税），向用户展示"其中关税估算 X"只是透明度，
 *      基数与口径（15% / 13.04% / 17.25% 三口径待 D 决策）没定之前，它绝不能参与应收。
 *
 * @limitation 一：duty 基数取**商品小计**（items_jpy，不含运费）——三口径未定前的展示口径；
 *              决策落地时改这一处 + duty_rates.note，不要在调用点打补丁。
 * @limitation 二：库存校验是**报价时刻**的快照判定（stock < qty → 40901）；
 *              真正的扣减与并发安全在建单（U5，事务内条件更新），这里只是提前拦住明显不行的。
 * @limitation 三：display 只换算 total_jpy（DDP 应收）；不按行项目换算——
 *              前端要行项目展示价时自行按同一汇率换算（展示价本来就不参与金额计算，ADR-09）。
 *
 * @see docs/I1阶段开发实施方案.md §3.4；adapters/catalog.ts（输入解析）；
 *      packages/shared/src/money.ts（toMinor / applyRate 唯一取整口）；ADR-09（JPY 唯一锚）
 */
import { applyRate, toMinor, toRatioInt } from '@waselect/shared';
import { AppError } from '../errors.js';

/** 锚之外的展示币（JPY 是锚、恒显示，见 country_profiles.display_currencies 的注释口径）。 */
export type DisplayCurrency = 'USD' | 'CNY';

/** 报价请求的一个行项目（客户端输入）。 */
export interface QuoteItemInput {
  productId: string;
  qty: number;
}

/** 参与报价的商品快照（由仓储从 products 表读出并翻译好）。 */
export interface QuoteProduct {
  productId: string;
  /** 整数円（products.price_jpy，DB 约束 > 0）。 */
  priceJpy: number;
  /** 单件克重（products.weight_g，DB 约束 > 0）。 */
  weightG: number;
  stock: number;
  /** status === 'active' 的翻译结果——domain 不认识 status 词表，只认"能不能卖"。 */
  active: boolean;
  /** 原产地（products.origin_country；MVP 被 DB CHECK 钉死为 'JP'，D-43）。 */
  originCountry: string;
}

/** 行项目汇总结果（运费取档的前置输入）。 */
export interface QuoteItemsSummary {
  itemsJpy: number;
  /** 商品总重（**不含**包材）。 */
  goodsWeightG: number;
  /** 去重后的原产地集合（报价单内全部商品同产地时才可能给出 duty 估算）。 */
  origins: readonly string[];
}

/** computeQuote 的输入（除行项目汇总外的全部外部解析结果）。 */
export interface QuoteComputationInput {
  itemsJpy: number;
  goodsWeightG: number;
  /** 包材自重（config.PACKAGING_WEIGHT_G，D-42）。 */
  packagingWeightG: number;
  /** 已取档的运费（整数円）。取不到档属路由层 50004，不进本函数。 */
  shippingJpy: number;
  /** 关税率（`toRatioInt` 后的 ×1e8 整数）；null = duty_rates 无此 (origin,dest) 行。 */
  dutyRatioInt: number | null;
  /** 各展示币的汇率（`toRateInt` 后的 ×1e8 整数）；缺币 → 50003。 */
  fxRateIntByCurrency: Readonly<Partial<Record<DisplayCurrency, number>>>;
  displayCurrencies: readonly DisplayCurrency[];
  /** 包邮阈值（整数円）；null = 不包邮（config.FREE_SHIPPING_JPY 未配置）。 */
  freeShippingThresholdJpy: number | null;
  /** 单笔上限（config.MAX_ORDER_JPY，D-42）；只用于 split_hint，报价不硬拦（建单才 40906）。 */
  maxOrderJpy: number;
}

/** 报价结果（对齐契约 Quote schema；字段名在路由层转 snake_case）。 */
export interface QuoteComputation {
  itemsJpy: number;
  /** 实际收取的运费（包邮后为 0）。 */
  shippingJpy: number;
  /** 关税估算（信息字段）；null = 无法估算（税率缺失或产地不唯一）。 */
  dutyJpy: number | null;
  /** duty_jpy 是否是估算值（false 时 duty_jpy 为 null，前端不得展示具体数字）。 */
  dutyEstimated: boolean;
  /** 应收合计 = items + shipping（**不含 duty**）。 */
  totalJpy: number;
  /** 包裹总重（**含**包材，契约 Quote.weight_g 同口径）。 */
  weightG: number;
  /** 各展示币的 total 展示价（整数分）。 */
  display: Partial<Record<DisplayCurrency, number>>;
  /** 距包邮还差多少（円）；不包邮或已包邮时为 null。 */
  freeShippingRemainingJpy: number | null;
  /** 金额超 MAX_ORDER_JPY → true，提示拆单（D-42；建单时硬拦 40906）。 */
  splitHint: boolean;
}

/**
 * 汇总行项目：校验 + 商品小计 + 商品总重。
 *
 * @throws {AppError} 40001 items 为空 / 数量非法 / 商品 id 重复（重复 id 的合并语义不明，响亮拒绝）
 * @throws {AppError} 40401 商品不存在或已下架
 * @throws {AppError} 40901 库存不足（报价时刻快照，见文件头 @limitation 二）
 */
export function summarizeQuoteItems(
  items: readonly QuoteItemInput[],
  products: readonly QuoteProduct[],
): QuoteItemsSummary {
  if (items.length === 0) throw new AppError(40001, { reason: 'items_empty' });

  const byId = new Map(products.map((p) => [p.productId, p]));
  const seen = new Set<string>();
  let itemsJpy = 0;
  let goodsWeightG = 0;
  const origins = new Set<string>();

  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw new AppError(40001, { reason: 'qty_invalid', product_id: item.productId });
    }
    if (seen.has(item.productId)) {
      throw new AppError(40001, { reason: 'product_id_duplicated', product_id: item.productId });
    }
    seen.add(item.productId);

    const p = byId.get(item.productId);
    // 不存在与已下架同码（40401 文案本就是"商品不存在或已下架"）：
    // 分开两条会向前端泄露"这个 id 存在但被下了"——与 readOwnedOrder 用 40400 防探测同一判断
    if (p === undefined) throw new AppError(40401, { product_id: item.productId });
    if (!p.active) throw new AppError(40401, { product_id: item.productId, reason: 'inactive' });
    if (p.stock < item.qty) {
      throw new AppError(40901, { product_id: item.productId, stock: p.stock, qty: item.qty });
    }
    itemsJpy += p.priceJpy * item.qty;
    goodsWeightG += p.weightG * item.qty;
    origins.add(p.originCountry);
  }
  return { itemsJpy, goodsWeightG, origins: [...origins] };
}

/**
 * 计算报价（行项目汇总之后的全部金额规则）。
 *
 * @throws {AppError} 50003 任一展示币的汇率缺失（fx_rates 无当日行）——阻止下单（错误码 action 口径）
 */
export function computeQuote(input: QuoteComputationInput): QuoteComputation {
  const free =
    input.freeShippingThresholdJpy !== null && input.itemsJpy >= input.freeShippingThresholdJpy;
  const shippingJpy = free ? 0 : input.shippingJpy;
  const freeShippingRemainingJpy =
    input.freeShippingThresholdJpy === null || free
      ? null
      : input.freeShippingThresholdJpy - input.itemsJpy;

  const totalJpy = input.itemsJpy + shippingJpy;

  const dutyEstimated = input.dutyRatioInt !== null;
  // 基数 = 商品小计（@limitation 一，13b 未定）；取整走 shared 唯一口（applyRate）
  const dutyJpy = dutyEstimated ? applyRate(input.itemsJpy, input.dutyRatioInt ?? 0) : null;

  const display: Partial<Record<DisplayCurrency, number>> = {};
  for (const c of input.displayCurrencies) {
    const rateInt = input.fxRateIntByCurrency[c];
    if (rateInt === undefined) throw new AppError(50003, { currency: c });
    display[c] = toMinor(totalJpy, rateInt);
  }

  return {
    itemsJpy: input.itemsJpy,
    shippingJpy,
    dutyJpy,
    dutyEstimated,
    totalJpy,
    weightG: input.goodsWeightG + input.packagingWeightG,
    display,
    freeShippingRemainingJpy,
    splitHint: totalJpy > input.maxOrderJpy,
  };
}

/**
 * 把 duty_rates 的 NUMERIC 字符串转成 `computeQuote` 的入参（null 直通）。
 * @why 收敛在 domain 而不是路由：「null = 无税率行」是**领域语义**，路由不该各自判断。
 */
export function dutyRatioIntOf(rate: string | null): number | null {
  return rate === null ? null : toRatioInt(rate);
}

/**
 * 读路径的展示价换算（I1-U5c）：用**订单自己的 fx_snapshot** 把 JPY 锚金额换算成展示币。
 *
 * @why 与 computeQuote 的 display 循环是**两种语义**，刻意不合并：
 *      报价/建单是收钱路径，缺币必须 50003 阻止下单；
 *      订单列表/详情是读路径，快照里缺哪个币就静默少显示哪个（与 /fx、/products 的
 *      浏览降级同口径）——"运营没维护汇率"不该让订单页打不开。
 *      共用的只是 `toMinor` 这一个取整口（shared 唯一），判定逻辑各写各的。
 *
 * @why 用快照而不用当日汇率：订单页展示的换算金额应该等于用户**下单时看到的**，
 *      用当日汇率重算会让同一笔订单的展示价每天漂移，对账时与 fx_snapshot 对不上。
 *      顺带省掉列表场景每行一次的 fx 查询（N+1）。
 */
export function buildDisplayFromRates(
  amountJpy: number,
  fxRateIntByCurrency: Readonly<Partial<Record<DisplayCurrency, number>>>,
  displayCurrencies: readonly DisplayCurrency[],
): Partial<Record<DisplayCurrency, number>> {
  const display: Partial<Record<DisplayCurrency, number>> = {};
  for (const c of displayCurrencies) {
    const rateInt = fxRateIntByCurrency[c];
    if (rateInt !== undefined) display[c] = toMinor(amountJpy, rateInt);
  }
  return display;
}
