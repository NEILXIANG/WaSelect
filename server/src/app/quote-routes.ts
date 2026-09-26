/**
 * 职责：`POST /orders/quote` 路由薄壳（I1-U4）——报价 = 仓储解析 + 域纯函数，不落库、不扣库存。
 *
 * 分层：本文件只做「HTTP 形状校验 → 仓储取数 → 调 domain → 契约形状出参」。
 *      计算规则全在 domain/quote.ts，SQL 全在 adapters/catalog.ts。
 *
 * @why 目的国与展示币的取值是**表驱动**而不是写死（ADR-28"业务核心不认识任何国家"）：
 *      - `country_profiles` 恰好一个 active → 它既是目的国（duty 查询的 dest）也是展示币来源；
 *      - 零个/多个 active → 目的国 null（duty_jpy=null 不阻单，信息字段而已），
 *        展示币回落 config.DISPLAY_CURRENCIES。
 *      MVP 种子恰好一个 US，所以行为与"写死 US"一致，但改数据就能改行为，不发版。
 *
 * @why duty 只在「全部商品同产地 ∧ 目的国可定」时查询：MVP 商品被 DB CHECK 钉死 'JP'，
 *      origins 恒为 ['JP']；多产地混篮的估算口径没定之前，null 比瞎算诚实。
 *
 * @limitation 一：items 上限 50 行是**防滥用**拍的（真实购物车个位数）；超了 40001。
 *              它没有配置项——这不是运营参数，是请求形状护栏。
 * @limitation 二：报价不做并发安全（不落库）；同一商品被两个购物车同时看到"有货"，
 *              最终只能成交一件——硬保证在建单（U5 事务内扣减），契约 summary 已写明。
 * @limitation 三：限流不在本文件挂载（规则表 rateLimitRules.publicWrite，30 次/分钟/IP）——
 *              挂载点统一在 mount.ts，"全站哪些入口有限流"只有那一处能看全。
 *
 * @see docs/I1阶段开发实施方案.md §3.4；contracts/api-contract.yaml（Quote schema）；
 *      domain/quote.ts（计算）；adapters/catalog.ts（取数）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { AppConfig } from '../config.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { createCatalogRepo } from '../adapters/catalog.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import {
  computeQuote,
  dutyRatioIntOf,
  summarizeQuoteItems,
  type DisplayCurrency,
  type QuoteItemInput,
  type QuoteProduct,
} from '../domain/quote.js';
import { toRateInt } from '@waselect/shared';

/** 请求形状护栏：单报价最多 50 行（@limitation 一）。 */
const MAX_QUOTE_ITEMS = 50;

export interface QuoteRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity?: IdentityCheck | undefined;
  config: AppConfig;
}

/** 校验并取出 items（形状层）；数量/重复/库存的语义校验在 domain。 */
function parseItems(body: unknown): QuoteItemInput[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_QUOTE_ITEMS) {
    throw new AppError(40001, { reason: 'items_shape', max: MAX_QUOTE_ITEMS });
  }
  return items.map((raw) => {
    const it = raw as { product_id?: unknown; qty?: unknown };
    if (typeof it?.product_id !== 'string' || it.product_id.length === 0) {
      throw new AppError(40001, { reason: 'product_id_shape' });
    }
    if (typeof it.qty !== 'number') throw new AppError(40001, { reason: 'qty_shape' });
    return { productId: it.product_id, qty: it.qty };
  });
}

export function mountQuoteRoutes(app: Express, deps: QuoteRoutesDeps): void {
  const catalog = createCatalogRepo(deps.db);
  const countryProfiles = createCountryProfileRepo(deps.db);

  app.post(
    '/api/v1/orders/quote',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);

          const items = parseItems(req.body);
          const rows = await catalog.findProductsForQuote(items.map((i) => i.productId));
          const products: QuoteProduct[] = rows.map((r) => ({
            productId: r.id,
            priceJpy: r.price_jpy,
            weightG: r.weight_g,
            stock: r.stock,
            active: r.status === 'active',
            originCountry: r.origin_country,
          }));

          // ① 行项目汇总（40001/40401/40901 全在这段抛出）
          const summary = summarizeQuoteItems(items, products);

          // ② 运费取档（D-46）：承运商 ≠1 家或超重 → 50004（运费不可计算）
          const carrier = await catalog.resolveSingleActiveCarrier();
          if (carrier === null) {
            throw new AppError(50004, { reason: 'carrier_not_unambiguous' });
          }
          const weightG = summary.goodsWeightG + deps.config.PACKAGING_WEIGHT_G;
          const shippingJpy = await catalog.findShippingPriceJpy(carrier, weightG);
          if (shippingJpy === null) {
            throw new AppError(50004, { carrier, weight_g: weightG });
          }

          // ③ 目的国 + 展示币（表驱动，见文件头 @why）
          const actives = await countryProfiles.listActive();
          const dest = actives.length === 1 ? (actives[0]?.code ?? null) : null;
          const displayCurrencies: readonly DisplayCurrency[] = (
            actives.length === 1
              ? (actives[0]?.displayCurrencies ?? [])
              : deps.config.DISPLAY_CURRENCIES
          ).filter((c): c is DisplayCurrency => c !== 'JPY'); // JPY 是锚、恒显示，不进 display

          // ④ 关税率：同产地 + 目的国可定才估算；查不到 → duty_jpy=null（信息缺失不阻单）
          const dutyRate =
            dest !== null && summary.origins.length === 1
              ? await catalog.findDutyRate(summary.origins[0] ?? 'JP', dest)
              : null;

          // ⑤ 当日汇率（缺币 → computeQuote 抛 50003）
          const fxMap = await catalog.findLatestFxRates(displayCurrencies, deps.clock.now());
          const fxRateIntByCurrency: Partial<Record<DisplayCurrency, number>> = {};
          for (const c of displayCurrencies) {
            const rate = fxMap.get(c);
            if (rate !== undefined) fxRateIntByCurrency[c] = toRateInt(rate);
          }

          const q = computeQuote({
            itemsJpy: summary.itemsJpy,
            goodsWeightG: summary.goodsWeightG,
            packagingWeightG: deps.config.PACKAGING_WEIGHT_G,
            shippingJpy,
            dutyRatioInt: dutyRatioIntOf(dutyRate),
            fxRateIntByCurrency,
            displayCurrencies,
            freeShippingThresholdJpy: deps.config.FREE_SHIPPING_JPY ?? null,
            maxOrderJpy: deps.config.MAX_ORDER_JPY,
          });

          deps.logger.info('quote_computed', {
            result: 'ok',
            ctx: {
              item_count: items.length,
              total_jpy: q.totalJpy,
              weight_g: q.weightG,
              carrier,
              dest,
              duty_estimated: q.dutyEstimated,
            },
          });

          res.json({
            items_jpy: q.itemsJpy,
            shipping_jpy: q.shippingJpy,
            duty_jpy: q.dutyJpy,
            duty_estimate: q.dutyEstimated,
            total_jpy: q.totalJpy,
            weight_g: q.weightG,
            display: q.display,
            ...(q.freeShippingRemainingJpy !== null
              ? { free_shipping_remaining_jpy: q.freeShippingRemainingJpy }
              : {}),
            split_hint: q.splitHint,
          });
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
