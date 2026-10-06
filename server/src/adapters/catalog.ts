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

/**
 * 可空字符串列 → `string | null`。
 * @why 与 `orders-admin.ts` 里同名那份是**同一条规则**（NULL/未定义 → null，其余 String()），
 *      两处各自私有而没有提到共享模块：它是 1 行，为它引一层"行归一化"依赖不值；
 *      而两个文件都已经在用它处理自己那一组可空列，跨文件 import 会让
 *      "catalog ← orders-admin" 这种无业务关系的依赖凭空出现。
 */
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * products 表读出的一行（报价/建单视角的列集；title 报价不用、建单写 title_snapshot 用）。
 *
 * @why 带上 `title_ja` / `jan_code` / `purchase_source` 三列（迁移 021 / D-39）：
 *      建单要把它们**快照**进 `order_items`，供管理端的待采购清单使用。
 *      ⚠️ 这三列**只有建单消费**，报价与买家路径一个都不用——
 *      所以它们不进 `ProductListRow` / `ProductDetailRow`：采购信息是**内部信息**，
 *      多一处 select 就多一处"顺手下发给买家"的机会（泄露采购渠道 = 泄露供应链）。
 * @why 三列在 `products` 上都可空 → 这里用 `string | null` 而不是给空串兜底：
 *      "商品没填 JAN 码"与"JAN 码是空字符串"是两件事，前者是事实、后者是脏数据。
 *      建单照着原样落快照（null 就落 null），由**展示层**决定怎么降级。
 */
export interface QuoteProductRow {
  id: string;
  title: string;
  price_jpy: number;
  weight_g: number;
  stock: number;
  status: string;
  origin_country: string;
  title_ja: string | null;
  jan_code: string | null;
  purchase_source: string | null;
  /** 剩余清单 1-3（迁移 027）：成本价 / HS 码 / 英文报关品名，同样只供建单落快照。 */
  cost_jpy: number | null;
  hs_code: string | null;
  customs_desc_en: string | null;
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
  /**
   * 编辑口径三字段（020 / AJ-296①）——S4 的 `pick-card` 要它们。
   * @why 放在**列表行**而不只是详情行：`pick-card` 用在首页列表上，
   *      "为什么值得买"必须是"要不要点进去"之前就能读到的东西——
   *      只在详情里给的话，卡上那句 why 永远渲染不出来，组件迁过去等于没迁。
   */
  why: string | null;
  maker: string | null;
  tags: readonly string[];
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
   * 第一个 `max_weight_g >= 包裹重` 的档（向上取档）。超重返回 null（用例层 → 40912，AJ-239）。
   */
  findShippingPriceJpy(carrier: string, weightG: number): Promise<number | null>;
  /**
   * **一次快照**里同时做「选承运商」与「取档」（DB3-04）。
   *
   * @why 分成 `resolveSingleActiveCarrier()` 与 `findShippingPriceJpy()` 两条语句时，
   *      READ COMMITTED 下每条语句各拿一个新快照，中间可以夹进一次**整表替换**提交
   *      （运营把占位承运商换成真实承运商）：第一条读到 `placeholder`，第二条
   *      `where carrier='placeholder' and active` 已经 0 行 ⇒ 返回 null ⇒
   *      用例层按 AJ-239 抛 **40912「包裹超重」**。买家看到"超重"，实际是配置切换，
   *      文案误导，且错误码被对账 / 告警误分类。
   * @why 合并成一条 SQL 而不是把建单事务提到 REPEATABLE READ：
   *      后者要改整条建单链路的隔离级别（影响面远大于这一处），
   *      而"取档"这件事本来就只需要一个快照。
   * @returns 判别联合——`no_carrier` = 活跃承运商 ≠1 家（→ 50004）；
   *          `overweight` = 承运商明确、但包裹比最大一档还重（→ 40912）；
   *          `ok` = 取到档。
   *      @why 不返回 `null` 让调用方猜：这三种的处置完全不同（50004 / 40912 / 用），
   *      返回 null 等价于要求调用方再查一次——而"再查一次"正是本次要消灭的第二次查询。
   */
  findSoleCarrierShippingJpy(weightG: number): Promise<ShippingQuoteRow>;
  /** 关税率（NUMERIC 原样字符串返回，转换在 domain 的 dutyRatioIntOf）；无行 → null。 */
  findDutyRate(origin: string, dest: string): Promise<string | null>;
  /**
   * 各币种的当日汇率：`effective_from <= now` 里最新的一行。
   * @returns quote → rate（NUMERIC 原样字符串）；缺失的币种**不在 map 里**（调用方判 50003）。
   */
  findLatestFxRates(quotes: readonly string[], now: Date): Promise<ReadonlyMap<string, string>>;
  /**
   * 同 {@link findLatestFxRates}，但**超过 `maxAgeHours` 未更新的币种当作缺失**，并单独列出（剩余清单 1-2）。
   * @why 只取"已生效的最新一行"时，管理员一个月没录汇率照样报价、照样按它收美元，汇损自担且无人知道。
   *      报价与建单（收钱路径）用它；商品浏览的展示价仍用 findLatestFxRates（只是参考，降级展示即可）。
   * @returns `rates`：仍然新鲜的币种；`stale`：有汇率但已过期的币种（调用方据此打 error 日志）
   */
  findFreshFxRates(
    quotes: readonly string[],
    now: Date,
    maxAgeHours: number,
  ): Promise<{ rates: ReadonlyMap<string, string>; stale: readonly string[] }>;
}

/**
 * `findSoleCarrierShippingJpy` 的结果（判别联合）。
 * @why 三种结果对应三种**完全不同**的处置，用"null + 再查一次"会让调用方长出第二份判定
 *      （ADR-29：同一判断的第二份实现就是漂移的起点），而且第二次查询本身就是竞态的入口。
 */
export type ShippingQuoteRow =
  | { kind: 'ok'; carrier: string; priceJpy: number }
  /** 承运商明确，但包裹比最大一档还重（用例层 → 40912，AJ-239）。 */
  | { kind: 'overweight'; carrier: string }
  /** 活跃承运商不是恰好一家（0 家或多家）→ 50004。 */
  | { kind: 'no_carrier' };

export function createCatalogRepo(db: Db): CatalogRepo {
  return {
    async findProductsForQuote(ids: readonly string[]): Promise<QuoteProductRow[]> {
      if (ids.length === 0) return [];
      const rows = await db`
        select id, title, price_jpy, weight_g, stock, status, origin_country,
               title_ja, jan_code, purchase_source, cost_jpy, hs_code, customs_desc_en
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
        title_ja: strOrNull(r.title_ja),
        jan_code: strOrNull(r.jan_code),
        purchase_source: strOrNull(r.purchase_source),
        cost_jpy: r.cost_jpy === null ? null : Number(r.cost_jpy),
        hs_code: strOrNull(r.hs_code),
        customs_desc_en: strOrNull(r.customs_desc_en),
      }));
    },

    async listActiveProducts(
      q: ProductListQuery,
    ): Promise<{ items: ProductListRow[]; total: number }> {
      // ILIKE 通配符必须转义：不转义的话搜 "100%" 会变成"以 100 开头的任何东西"——
      // 静默错配，而且只有用户搜到怪结果才会被发现
      const kw = q.keyword?.replace(/[\\%_]/g, (m) => `\\${m}`);
      const rows = await db`
        select id, title, category, price_jpy, images, stock, why, maker, tags
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
          why: r.why === null || r.why === undefined ? null : String(r.why),
          maker: r.maker === null || r.maker === undefined ? null : String(r.maker),
          tags: (r.tags ?? []) as readonly string[],
        })),
        total: Number(counts[0]?.n ?? 0),
      };
    },

    async findProductDetail(id: string): Promise<ProductDetailRow | null> {
      const rows = await db`
        select id, title, category, price_jpy, images, stock, description, weight_g,
               compliance_tags, hs_code, customs_desc_en, origin_country, status,
               why, maker, tags
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
        why: r.why === null || r.why === undefined ? null : String(r.why),
        maker: r.maker === null || r.maker === undefined ? null : String(r.maker),
        tags: (r.tags ?? []) as readonly string[],
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

    async findSoleCarrierShippingJpy(weightG: number): Promise<ShippingQuoteRow> {
      /**
       * ⚠️ 一条 SQL、一个快照（DB3-04）。
       * @why `with c as (...)` 里的 `distinct carrier` 与 lateral 子查询**同属一条语句**，
       *      于是 PG 用同一个快照取两者：要么全是旧表、要么全是新表，不再有"半张表"。
       * @why 仍然只保留**一份**取档口径（D-46 红线）：`max_weight_g >= $1` + 升序取第一行
       *      与 `findShippingPriceJpy` 完全一致，没有第二份实现。
       * @why `left join lateral ... on true`：承运商存在但**没有能装下这个包裹的档**时
       *      lateral 返回 0 行，`left join` 保留 c 行且 `price_jpy` 为 null ⇒ 能区分
       *      "没有承运商"与"有承运商但超重"（这正是 50004 与 40912 的分界）。
       */
      const rows = await db`
        with c as (select distinct carrier from shipping_rates where active = true)
        select (select count(*) from c) as n,
               c.carrier,
               r.price_jpy
          from c
          left join lateral (
            select price_jpy from shipping_rates
             where carrier = c.carrier and active = true and max_weight_g >= ${weightG}
             order by max_weight_g asc
             limit 1
          ) r on true
      `;
      if (rows.length !== 1) return { kind: 'no_carrier' }; // 0 家或多家
      const row = rows[0];
      if (row === undefined) return { kind: 'no_carrier' };
      const carrier = String(row.carrier);
      const price = row.price_jpy;
      if (price === null || price === undefined) return { kind: 'overweight', carrier };
      return { kind: 'ok', carrier, priceJpy: Number(price) };
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

    async findFreshFxRates(
      quotes: readonly string[],
      now: Date,
      maxAgeHours: number,
    ): Promise<{ rates: ReadonlyMap<string, string>; stale: readonly string[] }> {
      const rates = new Map<string, string>();
      const stale: string[] = [];
      if (quotes.length === 0) return { rates, stale };
      const rows = await db`
        select distinct on (quote) quote, rate,
               effective_from <= ${now}::timestamptz - make_interval(hours => ${maxAgeHours}) as is_stale
          from fx_rates
         where quote in ${db([...quotes])} and effective_from <= ${now}
         order by quote, effective_from desc
      `;
      for (const r of rows) {
        const q = String(r.quote).trim();
        if (r.is_stale === true) stale.push(q);
        else rates.set(q, String(r.rate));
      }
      return { rates, stale };
    },
  };
}
