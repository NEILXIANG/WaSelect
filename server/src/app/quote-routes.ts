/**
 * 职责：`POST /orders/quote` 路由薄壳（I1-U4）——报价 = 装配 + 域纯函数，不落库、不扣库存。
 *
 * 分层：本文件只做「HTTP 形状校验 → 调装配 → 契约形状出参」。
 *      计算规则全在 domain/quote.ts，SQL 全在 adapters/catalog.ts，
 *      「汇总 → 运费/目的国/关税/汇率 → computeQuote」的编排在 app/quote-assembly.ts
 *      （与建单重算共用同一份，40905 的语义因此自动等于"与报价一致"）。
 *
 * @why 目的国与展示币的取值是**表驱动**而不是写死（ADR-28"业务核心不认识任何国家"）：
 *      `country_profiles` 恰好一个 active → 它既是目的国也是展示币来源；
 *      零个/多个 active → 目的国 null（duty_jpy=null 不阻单），展示币回落 config。
 *      MVP 种子恰好一个 US，行为与"写死 US"一致，但改数据就能改行为，不发版。
 *
 * @limitation 一：items 上限 50 行是**防滥用**拍的（真实购物车个位数）；超了 40001。
 *              它没有配置项——这不是运营参数，是请求形状护栏。
 * @limitation 二：报价不做并发安全（不落库）；同一商品被两个购物车同时看到"有货"，
 *              最终只能成交一件——硬保证在建单（事务内条件更新扣减），契约 summary 已写明。
 * @limitation 三：限流不在本文件挂载（规则表 rateLimitRules.publicWrite，30 次/分钟/IP）——
 *              挂载点统一在 mount.ts，"全站哪些入口有限流"只有那一处能看全。
 *
 * @see docs/I1阶段开发实施方案.md §3.4；contracts/api-contract.yaml（Quote schema）；
 *      app/quote-assembly.ts（编排）；domain/quote.ts（计算）
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
import { summarizeQuoteItems, type QuoteItemInput, type QuoteProduct } from '../domain/quote.js';
import { assembleQuote } from './quote-assembly.js';

/** 请求形状护栏：单报价最多 50 行（@limitation 一）。建单（U5b）同上限。 */
export const MAX_QUOTE_ITEMS = 50;

/** 校验并取出 items（形状层）；数量/重复/库存的语义校验在 domain。建单路由复用本函数。 */
export function parseItems(body: unknown): QuoteItemInput[] {
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

export interface QuoteRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity?: IdentityCheck | undefined;
  config: AppConfig;
}

export function mountQuoteRoutes(app: Express, deps: QuoteRoutesDeps): void {
  app.post(
    '/api/v1/orders/quote',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);

          const items = parseItems(req.body);
          const catalog = createCatalogRepo(deps.db);
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
          // ② 装配（运费/目的国/关税/汇率 → computeQuote；50003/50004 在这段抛出）
          const { q, carrier, dest } = await assembleQuote(
            deps.db,
            deps.config,
            deps.clock,
            summary,
          );

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
