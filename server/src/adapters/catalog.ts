/**
 * 职责：报价/建单共用的**只读**目录仓储（I1-U4）——商品快照、运费取档、关税率、当日汇率。
 *
 * 边界：只做 SQL 与行 → 类型的翻译，不含业务规则（计算在 domain/quote.ts，装配在
 *      app/quote-routes.ts）。建单（U5）的事务内读法会另起函数，不复用这里的非事务读。
 *
 * @why 运费取档是本仓库的 **D-46 红线**：`max_weight_g` 是"上限（含）"，
 *      必须取**第一个 ≥ 包裹重**的档（向上）。商业测算模型曾用 VLOOKUP 向下取档，
 *      每单少收 900–1,000 円（占单均净贡献 24–26%）且**静默不报错**。
 *      所以这条 SQL 全仓库只允许有这一份（本文件），红线向量测试钉死它：
 *      `w=1850 → 4950`（若返回 4050 即为向下取档，立刻失败）。
 *
 * @why `resolveSingleActiveCarrier`：shipping_rates 表有 carrier 列但 MVP 只有一家占位
 *      承运商（'placeholder'，真实报价到位后整体替换）。承运商**选择规则**（最便宜？ fastest？
 *      还是 country_profiles.allowed_carriers 过滤？）是一个尚未做的业务决策——
 *      在它被做之前，"活跃承运商恰好一家"是唯一不含糊的答案；≠1 返回 null，
 *      由路由层抛 50004（运费不可计算），而不是悄悄挑一家。
 *
 * @limitation 一：shipping_rates **没有 dest_country 列**（ADR-28 的多国家方向里有，
 *              但 MVP 只发美国，加列属"没有真实消费方的 schema 变更"，与 payment_channels
 *              不接消费方同口径——等多国家报价真实落地时再加）。
 * @limitation 二：fx_rates 只有读者没有写者（汇率刷新属 daily job / 管理端，I1 范围外）。
 *              报价读到空 → 50003（错误码 action 本就是"管理员维护汇率"）。
 * @limitation 三：duty_rates 查询按调用方给的 (origin, dest) 直查，**不做**"同产地多行取最新"
 *              之类的扩展——主键就是 (origin,dest)，一行就是全部事实。
 *
 * @see migrations/001_init.sql（products/shipping_rates/fx_rates）、010（duty_rates）；
 *      test/factories/catalog.ts（SHIPPING_TIERS 阶梯素材与红线向量）；
 *      docs/I1阶段开发实施方案.md §3.4；技术文档 §2.5（D-46）
 */
import type { Db } from './db.js';

/** products 表读出的一行（报价/建单视角的列集；title 报价不用、建单写 title_snapshot 用）。 */
export interface QuoteProductRow {
  id: string;
  title: string;
  price_jpy: number;
  weight_g: number;
  stock: number;
  status: string;
  origin_country: string;
}

/** 商品列表查询（参数已在路由层校验过形状）。 */
export interface ProductListQuery {
  page: number;
  size: number;
  category?: string | undefined;
  keyword?: string | undefined;
}

/** 列表行（ProductCard 所需列 + images 原始 JSONB，ImageSet 映射在路由层）。 */
export interface ProductListRow {
  id: string;
  title: string;
  category: string;
  price_jpy: number;
  images: unknown;
  stock: number;
}

/** 详情行（Product 全量公开列）。 */
export interface ProductDetailRow extends ProductListRow {
  description: string | null;
  weight_g: number;
  compliance_tags: unknown;
  hs_code: string | null;
  customs_desc_en: string | null;
  origin_country: string;
  status: string;
}

export interface CatalogRepo {
  /** 按 id 批量取商品快照（不存在的 id 不出现在结果里，由 domain 判 40401）。 */
  findProductsForQuote(ids: readonly string[]): Promise<QuoteProductRow[]>;
  /** 上架商品分页（新到旧）；category/keyword 为可选过滤。 */
  listActiveProducts(q: ProductListQuery): Promise<{ items: ProductListRow[]; total: number }>;
  /** 商品详情（含下架的——"下架 → 40401"是路由的业务判定，仓储不过滤）。 */
  findProductDetail(id: string): Promise<ProductDetailRow | null>;
  /**
   * 活跃承运商恰好一家时返回其 carrier，否则 null（路由层 → 50004）。
   * @see 文件头 @why
   */
  resolveSingleActiveCarrier(): Promise<string | null>;
  /**
   * 运费取档（**D-46 唯一正确 SQL，全仓库只此一份**）：
   * 第一个 `max_weight_g >= 包裹重` 的档（向上取档）。超重返回 null（路由层 → 50004）。
   */
  findShippingPriceJpy(carrier: string, weightG: number): Promise<number | null>;
  /** 关税率（NUMERIC 原样字符串返回，转换在 domain 的 dutyRatioIntOf）；无行 → null。 */
  findDutyRate(origin: string, dest: string): Promise<string | null>;
  /**
   * 各币种的当日汇率：`effective_from <= now` 里最新的一行。
   * @returns quote → rate（NUMERIC 原样字符串）；缺失的币种**不在 map 里**（调用方判 50003）。
   */
  findLatestFxRates(quotes: readonly string[], now: Date): Promise<ReadonlyMap<string, string>>;
}

export function createCatalogRepo(db: Db): CatalogRepo {
  return {
    async findProductsForQuote(ids: readonly string[]): Promise<QuoteProductRow[]> {
      if (ids.length === 0) return [];
      const rows = await db`
        select id, title, price_jpy, weight_g, stock, status, origin_country
          from products where id in ${db([...ids])}
      `;
      return rows.map((r) => ({
        id: String(r.id),
        title: String(r.title),
        price_jpy: Number(r.price_jpy),
        weight_g: Number(r.weight_g),
        stock: Number(r.stock),
        status: String(r.status),
        origin_country: String(r.origin_country),
      }));
    },

    async listActiveProducts(
      q: ProductListQuery,
    ): Promise<{ items: ProductListRow[]; total: number }> {
      // ILIKE 通配符必须转义：不转义的话搜 "100%" 会变成"以 100 开头的任何东西"——
      // 静默错配，而且只有用户搜到怪结果才会被发现
      const kw = q.keyword?.replace(/[\\%_]/g, (m) => `\\${m}`);
      const rows = await db`
        select id, title, category, price_jpy, images, stock
          from products
         where status = 'active'
           ${q.category !== undefined ? db`and category = ${q.category}` : db``}
           ${kw !== undefined && kw !== '' ? db`and title ilike ${'%' + kw + '%'}` : db``}
         order by created_at desc, id
         limit ${q.size} offset ${(q.page - 1) * q.size}
      `;
      const counts = await db`
        select count(*)::int as n
          from products
         where status = 'active'
           ${q.category !== undefined ? db`and category = ${q.category}` : db``}
           ${kw !== undefined && kw !== '' ? db`and title ilike ${'%' + kw + '%'}` : db``}
      `;
      return {
        items: rows.map((r) => ({
          id: String(r.id),
          title: String(r.title),
          category: String(r.category),
          price_jpy: Number(r.price_jpy),
          images: r.images,
          stock: Number(r.stock),
        })),
        total: Number(counts[0]?.n ?? 0),
      };
    },

    async findProductDetail(id: string): Promise<ProductDetailRow | null> {
      const rows = await db`
        select id, title, category, price_jpy, images, stock, description, weight_g,
               compliance_tags, hs_code, customs_desc_en, origin_country, status
          from products where id = ${id}
      `;
      const r = rows[0];
      if (r === undefined) return null;
      return {
        id: String(r.id),
        title: String(r.title),
        category: String(r.category),
        price_jpy: Number(r.price_jpy),
        images: r.images,
        stock: Number(r.stock),
        description: r.description === null ? null : String(r.description),
        weight_g: Number(r.weight_g),
        compliance_tags: r.compliance_tags,
        hs_code: r.hs_code === null ? null : String(r.hs_code),
        customs_desc_en: r.customs_desc_en === null ? null : String(r.customs_desc_en),
        origin_country: String(r.origin_country),
        status: String(r.status),
      };
    },

    async resolveSingleActiveCarrier(): Promise<string | null> {
      const rows = await db`
        select distinct carrier from shipping_rates where active = true
      `;
      if (rows.length !== 1) return null;
      return String(rows[0]?.carrier);
    },

    async findShippingPriceJpy(carrier: string, weightG: number): Promise<number | null> {
      // ⚠️ D-46 红线：`max_weight_g` 是上限（含），必须 `>=` + 升序取第一行（向上取档）。
      //    改成 `<` 或降序 = 向下取档 = 每单少收约 1,000 円且静默不报错（红线测试 w=1850→4950 钉死）
      const rows = await db`
        select price_jpy from shipping_rates
         where carrier = ${carrier} and active = true and max_weight_g >= ${weightG}
         order by max_weight_g asc
         limit 1
      `;
      const row = rows[0];
      return row === undefined ? null : Number(row.price_jpy);
    },

    async findDutyRate(origin: string, dest: string): Promise<string | null> {
      const rows = await db`
        select rate from duty_rates
         where origin_country = ${origin} and dest_country = ${dest}
      `;
      const row = rows[0];
      return row === undefined ? null : String(row.rate);
    },

    async findLatestFxRates(
      quotes: readonly string[],
      now: Date,
    ): Promise<ReadonlyMap<string, string>> {
      const out = new Map<string, string>();
      if (quotes.length === 0) return out;
      // distinct on：每个币种取"已生效的最新一行"；future-dated 行（提前录入的明日汇率）不算
      const rows = await db`
        select distinct on (quote) quote, rate
          from fx_rates
         where quote in ${db([...quotes])} and effective_from <= ${now}
         order by quote, effective_from desc
      `;
      for (const r of rows) out.set(String(r.quote).trim(), String(r.rate));
      return out;
    },
  };
}
