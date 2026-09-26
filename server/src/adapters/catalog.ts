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

/** products 表读出的一行（报价视角所需的最小列集）。 */
export interface QuoteProductRow {
  id: string;
  price_jpy: number;
  weight_g: number;
  stock: number;
  status: string;
  origin_country: string;
}

export interface CatalogRepo {
  /** 按 id 批量取商品快照（不存在的 id 不出现在结果里，由 domain 判 40401）。 */
  findProductsForQuote(ids: readonly string[]): Promise<QuoteProductRow[]>;
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
        select id, price_jpy, weight_g, stock, status, origin_country
          from products where id in ${db([...ids])}
      `;
      return rows.map((r) => ({
        id: String(r.id),
        price_jpy: Number(r.price_jpy),
        weight_g: Number(r.weight_g),
        stock: Number(r.stock),
        status: String(r.status),
        origin_country: String(r.origin_country),
      }));
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
