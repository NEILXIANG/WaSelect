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

export interface CatalogAdminRepo {
  listAdminProducts(q: AdminProductListQuery): Promise<{ items: AdminProductRow[]; total: number }>;
  insertProduct(row: AdminProductInsert): Promise<AdminProductRow>;
  /** @returns 更新后的行；id 不存在 → null（路由层据此 40401） */
  updateProduct(id: string, row: AdminProductInsert): Promise<AdminProductRow | null>;
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
      const rows = await db`
        update products set title = ${row.title}, category = ${row.category},
               description = ${row.description}, images = ${j(db, row.images)},
               price_jpy = ${row.price_jpy}, cost_jpy = ${row.cost_jpy}, weight_g = ${row.weight_g},
               stock = ${row.stock}, compliance_tags = ${j(db, row.compliance_tags)},
               hs_code = ${row.hs_code}, customs_desc_en = ${row.customs_desc_en},
               origin_country = ${row.origin_country}, title_ja = ${row.title_ja},
               jan_code = ${row.jan_code}, purchase_source = ${row.purchase_source},
               status = ${row.status}, updated_at = now()
         where id = ${id}
        returning ${db(COLS.split(',').map((c) => c.trim()))}
      `;
      const r = rows[0] as Record<string, unknown> | undefined;
      return r === undefined ? null : toRow(r);
    },

    async setProductStatus(id, status) {
      const rows = await db`
        update products set status = ${status}, updated_at = now() where id = ${id} returning id
      `;
      return rows.length > 0;
    },
  };
}
