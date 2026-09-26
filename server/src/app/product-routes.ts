/**
 * 职责：公开商品/配置端点（I1-U5a）——`GET /products`、`GET /products/{id}`、
 *      `GET /terms`、`GET /fx`。全部不鉴权（契约 `security: []`）。
 *
 * @why 展示价的降级口径与报价/建单**刻意不同**：浏览路径 fx 缺失时 display 只含
 *      能算出的币种（全缺则 `{}`），不抛 50003——"运营没维护汇率"不该让 storefront 白屏；
 *      报价/建单（真要收钱的路径）才硬 50003 阻止（AJ-108）。
 *
 * @why ImageSet 映射：DB 的 images 是 JSONB 字符串数组（变体管线属 I2 /admin/upload，
 *      还不存在）。字符串条目 → 三尺寸同源的 ImageSet 占位；已是 {thumb,card,detail}
 *      形状的条目原样透传——两种存量都不得炸。
 *
 * @limitation 一：category 合法值照抄契约枚举（[beauty, daily, kitchen, food]）——
 *              它是**契约词汇表**；管理端商品上架（I2）落地时应连同 ProductInput 的
 *              category 一起提炼进 shared 枚举（现在提炼 = 为一个消费方提前设计）。
 * @limitation 二：GET /terms 的 urls 是**占位相对路径**——法务静态页属 F15/内容阶段；
 *              updated_at 没有真实来源（TERMS_VERSION 来自环境变量，无时间维度），省略不编。
 * @limitation 三：GET /fx 的 rates 缺币时**省略该币**（降级同 display）；
 *              它是"仅供文案展示"的端点（契约 summary），不是下单依据。
 *
 * @see contracts/api-contract.yaml（ProductCard/Product/Terms/Fx 响应形状）；
 *      adapters/catalog.ts（取数）；docs/I1阶段开发实施方案.md §3.5
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { AppConfig } from '../config.js';
import { createCatalogRepo } from '../adapters/catalog.js';
import { toMinor, toRateInt } from '@waselect/shared';
import type { DisplayCurrency } from '../domain/quote.js';

/** 契约 /products 的 category 枚举（@limitation 一：契约词汇表，I2 提炼进 shared）。 */
const PRODUCT_CATEGORIES = ['beauty', 'daily', 'kitchen', 'food'] as const;

/** images JSONB 条目 → 契约 ImageSet（@why 见文件头）。U5c 起订单详情也复用（app→app helper 同 parseItems 先例）。 */
export function toImageSet(raw: unknown): { thumb: string; card: string; detail: string } | null {
  if (typeof raw === 'string') return { thumb: raw, card: raw, detail: raw };
  if (raw !== null && typeof raw === 'object') {
    const o = raw as { thumb?: unknown; card?: unknown; detail?: unknown };
    if (typeof o.thumb === 'string' && typeof o.card === 'string' && typeof o.detail === 'string') {
      return { thumb: o.thumb, card: o.card, detail: o.detail };
    }
  }
  return null;
}

function imagesOf(raw: unknown): Array<{ thumb: string; card: string; detail: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map(toImageSet).filter((s) => s !== null);
}

/** 分页参数：page >= 1、size 1..50（契约束 size maximum 50）。 */
function parsePageSize(query: unknown): { page: number; size: number } {
  const q = query as { page?: unknown; size?: unknown };
  const page = q.page === undefined ? 1 : Number(q.page);
  const size = q.size === undefined ? 20 : Number(q.size);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 50) {
    throw new AppError(40001, { reason: 'page_size_invalid' });
  }
  return { page, size };
}

export interface ProductRoutesDeps {
  db: Db;
  clock: Clock;
  config: AppConfig;
}

export function mountProductRoutes(app: Express, deps: ProductRoutesDeps): void {
  const catalog = createCatalogRepo(deps.db);

  /** 浏览降级版 display：能算几币种算几币种（@why 见文件头）。 */
  async function displayOf(priceJpy: number): Promise<Partial<Record<DisplayCurrency, number>>> {
    const currencies = deps.config.DISPLAY_CURRENCIES.filter(
      (c): c is DisplayCurrency => c !== 'JPY',
    );
    const fx = await catalog.findLatestFxRates(currencies, deps.clock.now());
    const out: Partial<Record<DisplayCurrency, number>> = {};
    for (const c of currencies) {
      const rate = fx.get(c);
      if (rate !== undefined) out[c] = toMinor(priceJpy, toRateInt(rate));
    }
    return out;
  }

  app.get('/api/v1/products', (req, res, next) => {
    void (async () => {
      try {
        const { page, size } = parsePageSize(req.query);
        const q = req.query as { category?: unknown; keyword?: unknown };
        if (q.category !== undefined) {
          if (
            typeof q.category !== 'string' ||
            !(PRODUCT_CATEGORIES as readonly string[]).includes(q.category)
          ) {
            throw new AppError(40001, { reason: 'category_invalid' });
          }
        }
        if (q.keyword !== undefined && typeof q.keyword !== 'string') {
          throw new AppError(40001, { reason: 'keyword_invalid' });
        }
        const { items, total } = await catalog.listActiveProducts({
          page,
          size,
          category: q.category as string | undefined,
          keyword: q.keyword as string | undefined,
        });
        // 每个商品的展示价都走同一组当日汇率：列表 N 个商品只查一次 fx
        const currencies = deps.config.DISPLAY_CURRENCIES.filter(
          (c): c is DisplayCurrency => c !== 'JPY',
        );
        const fx = await catalog.findLatestFxRates(currencies, deps.clock.now());
        const rateInts: Partial<Record<DisplayCurrency, number>> = {};
        for (const c of currencies) {
          const r = fx.get(c);
          if (r !== undefined) rateInts[c] = toRateInt(r);
        }
        res.json({
          items: items.map((p) => {
            const display: Partial<Record<DisplayCurrency, number>> = {};
            for (const [c, rateInt] of Object.entries(rateInts)) {
              display[c as DisplayCurrency] = toMinor(p.price_jpy, rateInt);
            }
            const images = imagesOf(p.images);
            return {
              id: p.id,
              title: p.title,
              category: p.category,
              price_jpy: p.price_jpy,
              display,
              ...(images[0] !== undefined ? { image: images[0] } : {}),
              stock: p.stock,
              status: 'active',
            };
          }),
          total,
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/products/:id', (req, res, next) => {
    void (async () => {
      try {
        const p = await catalog.findProductDetail(String(req.params.id));
        // 不存在与已下架同码 40401（契约 404 语义；不泄露"存在但被下架"）
        if (p === null || p.status !== 'active') {
          throw new AppError(40401, { product_id: String(req.params.id) });
        }
        res.json({
          id: p.id,
          title: p.title,
          category: p.category,
          price_jpy: p.price_jpy,
          display: await displayOf(p.price_jpy),
          images: imagesOf(p.images),
          stock: p.stock,
          status: p.status,
          description: p.description,
          weight_g: p.weight_g,
          compliance_tags: Array.isArray(p.compliance_tags) ? p.compliance_tags : [],
          hs_code: p.hs_code,
          customs_desc_en: p.customs_desc_en,
          origin_country: p.origin_country,
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/terms', (_req, res) => {
    res.json({
      version: deps.config.TERMS_VERSION,
      // 占位路径（@limitation 二）：法务静态页落地前，前端按 version 做建单比对即可
      urls: { zh: '/legal/terms.zh.html', ja: '/legal/terms.ja.html', en: '/legal/terms.en.html' },
    });
  });

  app.get('/api/v1/fx', (_req, res, next) => {
    void (async () => {
      try {
        const currencies = deps.config.DISPLAY_CURRENCIES.filter(
          (c): c is DisplayCurrency => c !== 'JPY', // 锚自身汇率恒为 1，无展示意义
        );
        const now = deps.clock.now();
        const fx = await catalog.findLatestFxRates(currencies, now);
        const rates: Record<string, number> = {};
        let asOf: string | undefined;
        for (const c of currencies) {
          const r = fx.get(c);
          if (r !== undefined) rates[c] = Number(r);
        }
        if (Object.keys(rates).length > 0) {
          // asOf = 本次返回的**这些币种**里最新的生效时间（不限币种会把无关币的行算进来）
          const rows = await deps.db`
            select max(effective_from) as latest from fx_rates
             where quote in ${deps.db([...currencies])} and effective_from <= ${now}
          `;
          const latest = rows[0]?.['latest'];
          if (latest instanceof Date) asOf = latest.toISOString();
        }
        res.json({ base: 'JPY', rates, ...(asOf !== undefined ? { asOf } : {}) });
      } catch (e) {
        next(e);
      }
    })();
  });
}
