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
 * ~~@limitation 一：category 合法值照抄契约枚举~~ **已解决（I2-U-A1）**：已提炼进
 *              shared 的 `PRODUCT_CATEGORY`（与契约 `GET /products?category` 由单测双向比对），
 *              本文件不再手抄——管理端上架是第二个消费方，两份手抄必然漂移。
 * @limitation 二：GET /terms 的 urls 是**占位相对路径**——法务静态页属 F15/内容阶段；
 *              updated_at 没有真实来源（TERMS_VERSION 来自环境变量，无时间维度），省略不编。
 * @limitation 三：GET /fx 的 rates 缺币时**省略该币**（降级同 display）；
 *              它是"仅供文案展示"的端点（契约 summary），不是下单依据。
 * @limitation 四：`keyword` 有**长度上限** `SEARCH_KEYWORD_MAX_LENGTH`（超限 40001 +
 *              `keyword_too_long`；CAT2-07 / AJ-360）。它原样进 `ILIKE '%kw%'` 且
 *              `products` 上没有索引，而本文件**全部端点都不鉴权也不限流**——
 *              上限是这条路径上唯一的成本控制手段（读路径配额按 U7 再定，见 AJ-360）。
 * @limitation 五：`IMG_BASE_URL` 未配置时，按 **image_id** 存的图**整键省略**
 *              （与 Banner 的 `toBannerView` @limitation 一 同口径）；
 *              按完整 URL 存的旧条目不受影响（它们不需要拼域名）。
 *              ⚠️ 因此"商品突然都没图了"要先看**存的是哪种形态**，不是一律"图床挂了"。
 *
 * @see contracts/api-contract.yaml（ProductCard/Product/Terms/Fx 响应形状）；
 *      adapters/catalog.ts（取数）；docs/I1阶段开发实施方案.md §3.5
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createCatalogRepo } from '../adapters/catalog.js';
import { PRODUCT_CATEGORY, SEARCH_KEYWORD_MAX_LENGTH, toMinor, toRateInt } from '@waselect/shared';
import type { DisplayCurrency } from '../domain/quote.js';
import { imageObjectKey, isImageId } from '../domain/upload-image.js';

// category 合法值：来自 shared（契约词汇表的唯一出处），本文件不再手抄一份。
const PRODUCT_CATEGORIES = PRODUCT_CATEGORY;

/**
 * images JSONB 条目 → 契约 ImageSet（@why 见文件头）。U5c 起订单详情也复用（app→app helper 同 parseItems 先例）。
 *
 * @param imgBaseUrl `IMG_BASE_URL`（未配置 = `undefined`）。**只在"条目是 image_id"时需要**
 *      ——另两种形态的值是完整 URL，不需要拼。
 * @returns 渲染不出来的条目返回 `null`（调用方 `filter` 掉 ⇒ 契约里整键缺席）。
 *
 * @why 条目有三种形态：
 *      ① `{image_id}`（0.6.28 / AJ-361 **新**形态）→ 三档键由 `imageObjectKey` 生成再拼域名；
 *      ② 裸字符串（**旧**形态：一档 URL）→ 三档同源；
 *      ③ `{thumb,card,detail}`（管理端当前存的：三档完整 URL）→ 原样透传。
 *      ① 做成**对象**而不是裸字符串 id，是为了让"这是 id"**写在形状里**——
 *      裸字符串分支（②）对任何字符串都成立，若让 id 也走裸字符串，读路径只能靠
 *      "像不像 id"去猜，那正是 AJ-143 已否掉的"靠字符串巧合工作"。
 * @limitation 判定顺序 ① → ③ → ②；① 与 ③ **混填**时以 ① 为准（不报错也不降级）。
 *              写入侧（`readImages`）已拒混填，所以这里只可能遇到**直改库**留下的脏数据，
 *              按"能渲染就渲染"处理；不额外加一条实际走不到的分支——拿不到红灯证据的
 *              分支留着就是自欺（AJ-256 里我自己写出来又删掉的那处同因）。
 * @why ① 在 `IMG_BASE_URL` 未配置时返回 `null`（**整键省略**）而不是吐一个裸键：
 *      与 Banner 的 `toBannerView` @limitation 一 同口径——空串/裸键会被前端当成
 *      "有一张图、图裂了"，而事实是"没有可展示的 URL"，两件事的处置不同。
 * @why 三档键走 `imageObjectKey` 而不是字符串拼接：键形只有 `domain/upload-image.ts`
 *      一处定义（AJ-143 已否掉"消费方自己拼档位"——靠字符串巧合工作，规则一变就静默错）。
 * @why `image_id` 不合法时返回 `null` 而**不抛**：它来自 `products.images` JSONB，
 *      与脏价格 / 脏汇率同属"库里可能有脏数据"（AJ-211 / AJ-357 / AJ-359 同一条立场）——
 *      读侧必须自己降级，不能让一条脏图把订单详情或商品列表打成 500。
 */
export function toImageSet(
  raw: unknown,
  imgBaseUrl: string | undefined,
): { thumb: string; card: string; detail: string } | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const id = o['image_id'];
    if (typeof id === 'string' && isImageId(id)) {
      if (imgBaseUrl === undefined) return null; // @limitation 五
      const base = imgBaseUrl.replace(/\/+$/, ''); // 尾部斜杠只在拼接处处理一次
      return {
        thumb: `${base}/${imageObjectKey(id, 'thumb')}`,
        card: `${base}/${imageObjectKey(id, 'card')}`,
        detail: `${base}/${imageObjectKey(id, 'detail')}`,
      };
    }
    if (
      typeof o['thumb'] === 'string' &&
      typeof o['card'] === 'string' &&
      typeof o['detail'] === 'string'
    ) {
      return { thumb: o['thumb'], card: o['card'], detail: o['detail'] };
    }
    return null;
  }
  if (typeof raw === 'string') return { thumb: raw, card: raw, detail: raw };
  return null;
}

function imagesOf(
  raw: unknown,
  imgBaseUrl: string | undefined,
): Array<{ thumb: string; card: string; detail: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => toImageSet(it, imgBaseUrl)).filter((s) => s !== null);
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
  /** 展示价算不出时的降级日志（B25 / AJ-211）。 */
  logger: Logger;
}

export function mountProductRoutes(app: Express, deps: ProductRoutesDeps): void {
  const catalog = createCatalogRepo(deps.db);
  // 商品图的域名：**未配置**时 `images` 里按 image_id 存的条目渲染不出来（整键省略，见 @limitation 五）
  const imgBase = deps.config.IMG_BASE_URL;

  /**
   * 单币种的展示价；算不出 → `undefined`（**降级，不是整页 500**，B25 / AJ-211）。
   *
   * @why 曾经整批换算是同一个 try ⇒ 一个商品（或一个币种）算不出就让**整页** 500。
   *      `toMinor` 在 `price_jpy × rateInt` 超过 2^53 时抛 RangeError，
   *      而新建的问题商品按 `created_at desc` 落在首页第一屏——
   *      于是"录入时多打一个零"等于"全站商品列表打不开"，
   *      正好违背文件头 AJ-108 承诺的"浏览路径降级、不白屏"。
   * @why 省略该币种而不是报错：展示价是**文案**不是下单依据（报价/建单另走硬 50003，AJ-108），
   *      缺一个币种比整页白屏好——与"fx 缺失就省略"是同一条口径。
   * @limitation 每次失败都打一条 error 日志：它属于**数据问题**（库里有一个算不出的价格），
   *      必须有人去看；写入侧的上界（B25 的另一半）只挡新建，挡不住存量脏数据。
   */
  function minorOrUndefined(
    priceJpy: number,
    rateInt: number,
    currency: DisplayCurrency,
    productId: string,
  ): number | undefined {
    try {
      return toMinor(priceJpy, rateInt);
    } catch (e) {
      deps.logger.error('display_price_failed', {
        result: 'failed',
        ctx: { product_id: productId, currency, price_jpy: priceJpy, rate_int: rateInt },
        err: e instanceof Error ? e : new Error(String(e)),
      });
      return undefined;
    }
  }

  /**
   * 汇率 → ×1e8 整数；算不出来 → `undefined`（**降级，不是整页 500**，CAT2-04）。
   *
   * @why 与 {@link minorOrUndefined} 是**同一个承诺的两半**：那边守"脏价格"，这边守"脏汇率"。
   *      `toRateInt` 会为 `|rate| ≥ 1e6` / `≤ 0` / 非有限值抛 RangeError，
   *      而它此前在两个 try **之外**调用 ⇒ **一条**脏汇率让整页 500——
   *      于是文件头那句"能算几币种算几币种"在汇率侧其实是空的：
   *      脏价格（AJ-211）已经能降级，脏汇率却能把整个公开目录打挂。
   * @why 不能靠"写入侧有上界"来排除可达性：`fx_rates` 的 DB 约束只有 `rate > 0`（023 迁移），
   *      **没有上界**——与 `products.price_jpy` 一样。这正是 B25 当年决定
   *      "读侧必须自己能降级"的理由：迁移、手工改库、上界收紧之前的旧数据，
   *      都不是写入侧校验能拦住的。`MAX_RATE = 1e6` 会**抛**，抛出来之后由谁接住，就是本函数。
   * @limitation 与 `minorOrUndefined` 一样是 **error 级**：库里有一个算不出的汇率是数据事故，
   *      必须有人去看；但它**不阻断**请求——展示价是文案不是下单依据（AJ-108）。
   * @param productId 详情页传（定位到商品）；列表页是"一次汇率影响全部商品"，不传。
   */
  function rateIntOrUndefined(
    raw: string,
    currency: DisplayCurrency,
    productId?: string,
  ): number | undefined {
    try {
      return toRateInt(raw);
    } catch (e) {
      deps.logger.error('fx_rate_invalid', {
        result: 'failed',
        // 不回显原始 rate：错误消息里已经带了具体值（toRateInt 的 RangeError），
        // 再原样记一遍只是把客户端/库里的脏值复制一份进日志。
        ctx: { currency, ...(productId === undefined ? {} : { product_id: productId }) },
        err: e instanceof Error ? e : new Error(String(e)),
      });
      return undefined;
    }
  }

  /** 浏览降级版 display：能算几币种算几币种（@why 见文件头）。 */
  async function displayOf(
    priceJpy: number,
    productId: string,
  ): Promise<Partial<Record<DisplayCurrency, number>>> {
    const currencies = deps.config.DISPLAY_CURRENCIES.filter(
      (c): c is DisplayCurrency => c !== 'JPY',
    );
    const fx = await catalog.findLatestFxRates(currencies, deps.clock.now());
    const out: Partial<Record<DisplayCurrency, number>> = {};
    for (const c of currencies) {
      const rate = fx.get(c);
      if (rate === undefined) continue;
      const rateInt = rateIntOrUndefined(rate, c, productId);
      if (rateInt === undefined) continue; // 脏汇率：只丢这一个币种
      const minor = minorOrUndefined(priceJpy, rateInt, c, productId);
      if (minor !== undefined) out[c] = minor;
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
        if (q.keyword !== undefined) {
          if (typeof q.keyword !== 'string') {
            throw new AppError(40001, { reason: 'keyword_invalid' });
          }
          // CAT2-07 / AJ-360：keyword 原样进 `ILIKE '%' || kw || '%'`（无索引，CAT-19），
          // 而本端点既不鉴权也不限流 ⇒ 无上限时一次请求就能让 PG 拿几 KB 的模式串去全表扫。
          // ⚠️ details 只带 reason、**不带原值**：超限的值正是"客户端可控的长串"，
          //    回显它等于把 CAT2-03 那条链（可控输入进日志）又接回去（AJ-356 只截断了长度）。
          if (q.keyword.length > SEARCH_KEYWORD_MAX_LENGTH) {
            throw new AppError(40001, { reason: 'keyword_too_long' });
          }
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
          if (r === undefined) continue;
          const ri = rateIntOrUndefined(r, c); // 列表页是"一次汇率影响全部商品"，没有 product_id
          if (ri !== undefined) rateInts[c] = ri;
        }
        res.json({
          items: items.map((p) => {
            const display: Partial<Record<DisplayCurrency, number>> = {};
            for (const [c, rateInt] of Object.entries(rateInts)) {
              const minor = minorOrUndefined(p.price_jpy, rateInt, c as DisplayCurrency, p.id);
              if (minor !== undefined) display[c as DisplayCurrency] = minor;
            }
            const images = imagesOf(p.images, imgBase);
            return {
              id: p.id,
              title: p.title,
              category: p.category,
              price_jpy: p.price_jpy,
              display,
              ...(images[0] !== undefined ? { image: images[0] } : {}),
              stock: p.stock,
              status: 'active',
              // 编辑口径三字段（020）：null / 空数组 = "编辑还没撰写"，前端**降级**而不是报错
              ...(p.why !== null ? { why: p.why } : {}),
              ...(p.maker !== null ? { maker: p.maker } : {}),
              tags: [...p.tags],
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
          display: await displayOf(p.price_jpy, p.id),
          images: imagesOf(p.images, imgBase),
          stock: p.stock,
          status: p.status,
          description: p.description,
          weight_g: p.weight_g,
          compliance_tags: Array.isArray(p.compliance_tags) ? p.compliance_tags : [],
          hs_code: p.hs_code,
          customs_desc_en: p.customs_desc_en,
          origin_country: p.origin_country,
          // FTC 发货时限承诺（D-39⑦ / AJ-180）：店铺级配置，随详情下发省一次请求；前端照此出文案、不编数字
          ship_within_business_days: deps.config.SHIP_WITHIN_BUSINESS_DAYS,
          // 编辑口径三字段（020）：null = 没撰写 → 整键省略（前端据此降级，不用通用话术顶上）
          ...(p.why !== null ? { why: p.why } : {}),
          ...(p.maker !== null ? { maker: p.maker } : {}),
          tags: [...p.tags],
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
