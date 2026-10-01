/**
 * 职责：管理端商品的**写**仓储（I2 U-A2）——建商品、改商品、上下架、管理端列表。
 *
 * @why 与 `catalog.ts`（只读）**分成两个文件**而不是往里加方法：那份文件的 @why
 *      与 @limitation 全部建立在"只读"之上（例如"运费取档 SQL 全仓库只此一份"的
 *      论证依赖它不掺杂写路径）。把写方法塞进去，它的每条注释都得重新论证一遍——
 *      而重新论证从来没人做，于是注释与事实分离（ADR-29：分离即 bug）。
 *
 * @why `updated_at` 由 **SQL `now()`** 产生，不由调用方传：业务侧不取时钟（F10），
 *      且"最后修改时间"必须是**库里的时间**——传进来的值可能是任何一个实例的时钟。
 *
 * @why ⚠️ `updated_at` 的语义是「**商品信息**最后被改的时刻」（= `insertProduct` /
 *      `updateProduct` / `setProductStatus` 三处推进），**不含库存变动**：
 *      `decrementStock` / `incrementStock`（下单扣减、取消与关单回补）刻意不碰它。
 *      它同时是管理端列表的排序键（本文件 `order by updated_at desc, id`）与
 *      `updateProduct` 的乐观锁凭据；把"实时余额"的变动算进来，会让每一次成交都
 *      ① 把商品顶到列表第一位 → 翻页漏行重行（DB3-02），
 *      ② 作废运营正在进行的编辑（AJ-175 的"编辑期间下单仍能保存"被打破）。
 *      @see adapters/orders.ts（decrementStock / incrementStock 的同名 @why）
 *
 * @why 列表**不过滤** status（不传时给全部，含 offline）：管理端要能看见已下架商品，
 *      否则"下架"这个动作等于"永久删除视图"——运营再也找不到它来重新上架。
 *
 * @limitation 一：`updateProduct` 是**整行覆盖**（PUT 语义，与契约一致），
 *              不做"只改传入字段"的合并。代价：调用方必须先取到完整行；
 *              收益：不存在"某个字段在库里有值、前端没传、于是被静默保留"的歧义。
 * @limitation 二：不做软删除——`status='offline'` 即下架，商品永不删除
 *              （订单里的 `order_items` 引用它，删了订单就说不清卖了什么）。
 *
 * @see migrations/001_init.sql（products 表与两条 CHECK）；domain/product-input.ts（输入校验）
 */
import type { Db } from './db.js';

/** 管理端写入形状（与 `domain/product-input.ts` 归一化的输出逐字段对应，可空字段显式 null）。 */
export interface AdminProductInsert {
  id: string;
  title: string;
  category: string;
  description: string | null;
  images: readonly unknown[];
  price_jpy: number;
  cost_jpy: number | null;
  weight_g: number;
  stock: number;
  compliance_tags: readonly string[];
  hs_code: string | null;
  customs_desc_en: string;
  origin_country: string;
  title_ja: string | null;
  jan_code: string | null;
  purchase_source: string | null;
  status: string;
}

/**
 * 管理端**更新**形状：不含 `status`、`stock` 可省略、`expectedUpdatedAt` 为乐观锁凭据。
 * @why `status` 只归 `PATCH /status` 管：曾经 PUT 写死 `status = 'active'`，
 *      管理员编辑一个**已下架**商品的标题，它就被悄悄重新上架、买家可以下单（AJ-175 顺带修正）。
 * @why `stock` 省略 = 保持原值（并发写的列，见 domain/product-input.ts ProductInputValue.stock）。
 * @why `expectedUpdatedAt`（ADM3-02 / AJ-258）：PUT 是**整行覆盖**，而编辑页的数据取自列表快照
 *      ——列表在屏幕上停留多久，快照就旧多久。没有凭据时，运营只补一张图保存，
 *      就会把期间别人改过的售价 / 重量 / 报关品名整条回滚，且**不报任何错**。
 *      它是 `where updated_at = $x` 的那一项，不是新列（`updated_at` 本来就在）。
 * @why 类型是 **ISO 字符串**而不是 `Date`：路由层（app/）按 F10 不得构造 `Date`
 *      （时钟与历法判定走 ports/clock，由 eslint 硬拦），而仓储在 adapters/ 可以。
 *      把字符串直接交给 Postgres 转换，等于让"解析"只有一个实现（库），而不是"JS 解析一遍、库再解析一遍"。
 */
export type AdminProductUpdate = Omit<AdminProductInsert, 'status' | 'stock'> & {
  stock?: number | undefined;
  /** ISO 8601（`YYYY-MM-DDTHH:mm:ss.sssZ`，即 `toISOString()` 的形状）。 */
  expectedUpdatedAt: string;
};

/** 读出行（含服务端生成的 updated_at）。 */
export interface AdminProductRow extends AdminProductInsert {
  updated_at: Date;
}

export interface AdminProductListQuery {
  page: number;
  size: number;
  /** 不传 = 全部（含下架，见文件头 @why）。 */
  status?: 'active' | 'offline' | undefined;
}

/**
 * `updateProduct` 的结果。
 * @why 用**判别联合**而不是 `row | null`：ADM3-02 之后"没写成"有两种完全不同的含义——
 *      id 不存在（404，该去查是不是链接错了）与 `updated_at` 对不上（40914，该刷新重做）。
 *      曾经只有一个 `null`，两者都被折叠成 40401；把"被别人改过"说成"商品不存在"，
 *      运营会去找一个根本不存在的商品，而不是去刷新——**错误码指错方向比不报错更贵**。
 */
export type UpdateProductResult =
  { ok: true; row: AdminProductRow } | { ok: false; reason: 'not_found' | 'stale' };

export interface CatalogAdminRepo {
  listAdminProducts(q: AdminProductListQuery): Promise<{ items: AdminProductRow[]; total: number }>;
  insertProduct(row: AdminProductInsert): Promise<AdminProductRow>;
  /**
   * 带乐观锁的整行更新：`expectedUpdatedAt` 不匹配时不写、返回 `{ok:false, reason:'stale'}`。
   * @see {@link UpdateProductResult} 的 @why（为什么区分两种失败）
   */
  updateProduct(id: string, row: AdminProductUpdate): Promise<UpdateProductResult>;
  /** @returns 是否命中（id 不存在 → false） */
  setProductStatus(id: string, status: 'active' | 'offline'): Promise<boolean>;
}

const COLS = `id, title, category, description, images, price_jpy, cost_jpy, weight_g, stock,
              compliance_tags, hs_code, customs_desc_en, origin_country, title_ja, jan_code,
              purchase_source, status, updated_at`;

/** JSONB 列：postgres.js 需要显式 json()，否则数组参数会被当成 postgres array。 */
function j(db: Db, v: readonly unknown[]): ReturnType<Db['json']> {
  return db.json(v as never);
}

function toRow(r: Record<string, unknown>): AdminProductRow {
  return {
    id: String(r.id),
    title: String(r.title),
    category: String(r.category),
    description: r.description === null ? null : String(r.description),
    images: (r.images ?? []) as readonly unknown[],
    price_jpy: Number(r.price_jpy),
    cost_jpy: r.cost_jpy === null ? null : Number(r.cost_jpy),
    weight_g: Number(r.weight_g),
    stock: Number(r.stock),
    compliance_tags: (r.compliance_tags ?? []) as readonly string[],
    hs_code: r.hs_code === null ? null : String(r.hs_code),
    customs_desc_en: String(r.customs_desc_en),
    origin_country: String(r.origin_country),
    title_ja: r.title_ja === null ? null : String(r.title_ja),
    jan_code: r.jan_code === null ? null : String(r.jan_code),
    purchase_source: r.purchase_source === null ? null : String(r.purchase_source),
    status: String(r.status),
    updated_at: r.updated_at as Date,
  };
}

export function createCatalogAdminRepo(db: Db): CatalogAdminRepo {
  return {
    async listAdminProducts(q) {
      const rows = await db`
        select ${db(COLS.split(',').map((c) => c.trim()))} from products
         ${q.status !== undefined ? db`where status = ${q.status}` : db``}
         order by updated_at desc, id
         limit ${q.size} offset ${(q.page - 1) * q.size}
      `;
      const counts = await db`
        select count(*)::int as n from products
         ${q.status !== undefined ? db`where status = ${q.status}` : db``}
      `;
      return { items: rows.map(toRow), total: Number(counts[0]?.n ?? 0) };
    },

    async insertProduct(row) {
      const rows = await db`
        insert into products (id, title, category, description, images, price_jpy, cost_jpy,
                              weight_g, stock, compliance_tags, hs_code, customs_desc_en,
                              origin_country, title_ja, jan_code, purchase_source, status)
        values (${row.id}, ${row.title}, ${row.category}, ${row.description}, ${j(db, row.images)},
                ${row.price_jpy}, ${row.cost_jpy}, ${row.weight_g}, ${row.stock},
                ${j(db, row.compliance_tags)}, ${row.hs_code}, ${row.customs_desc_en},
                ${row.origin_country}, ${row.title_ja}, ${row.jan_code}, ${row.purchase_source},
                ${row.status})
        returning ${db(COLS.split(',').map((c) => c.trim()))}
      `;
      return toRow(rows[0] as Record<string, unknown>);
    },

    async updateProduct(id, row) {
      // ⚠️ `date_trunc('millisecond', updated_at)` 不能省（ADM3-02 实测踩到的量纲坑）：
      //    `updated_at` 是 timestamptz，Postgres 默认精度 **6 位（微秒）**，而 `now()` 也写到微秒；
      //    可前端拿到的是 `toISOString()`、**毫秒**精度。直接 `updated_at = $x` 时，
      //    库里 `…12:00:00.123456` 与传入的 `…12:00:00.123` 永不相等 → **每一笔 PUT 都被判成 stale**，
      //    表现为"商品编辑彻底不能用"，而且只在真库上出现（单测用假仓储看不到）。
      //    截断到毫秒后两边同量纲；代价是同一毫秒内的两次更新会被判冲突——
      //    管理端人工编辑不可能发生在同一毫秒，且冲突方向是"请刷新"（安全侧）。
      const rows = await db`
        update products set title = ${row.title}, category = ${row.category},
               description = ${row.description}, images = ${j(db, row.images)},
               price_jpy = ${row.price_jpy}, cost_jpy = ${row.cost_jpy}, weight_g = ${row.weight_g},
               stock = coalesce(${row.stock ?? null}::int, stock),
               compliance_tags = ${j(db, row.compliance_tags)},
               hs_code = ${row.hs_code}, customs_desc_en = ${row.customs_desc_en},
               origin_country = ${row.origin_country}, title_ja = ${row.title_ja},
               jan_code = ${row.jan_code}, purchase_source = ${row.purchase_source},
               updated_at = now()
         where id = ${id}
           and date_trunc('millisecond', updated_at) = ${row.expectedUpdatedAt}::timestamptz
        returning ${db(COLS.split(',').map((c) => c.trim()))}
      `;
      const r = rows[0] as Record<string, unknown> | undefined;
      if (r !== undefined) return { ok: true, row: toRow(r) };
      // 0 行命中：区分"id 不存在"与"被别人改过"（见 UpdateProductResult 的 @why）
      const exists = await db`select 1 as hit from products where id = ${id}`;
      return { ok: false, reason: exists.length > 0 ? 'stale' : 'not_found' };
    },

    async setProductStatus(id, status) {
      const rows = await db`
        update products set status = ${status}, updated_at = now() where id = ${id} returning id
      `;
      return rows.length > 0;
    },
  };
}
