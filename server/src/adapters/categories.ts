/**
 * 职责：商品分类（product_categories，迁移 039）的读写——后台管理与买家端可见清单（AJ-491）。
 *
 * @why 分类原是写死的四个（shared PRODUCT_CATEGORY + CHECK + 契约 enum），加一类要改三端再发版；
 *      用户 2026-10-11 要求后台可加分类、小程序动态识别、空分类不显示——分类成了后台维护的数据。
 * @why "可见"按**在售商品**判（status = 'active'），不按库存：售罄的商品仍在售，分类不会随库存上下跳；
 *      整类一件在售的都没有时才隐藏（成熟电商店铺分类的口径）。
 * @limitation 一：键建好后不能改（只改名称 / 排序 / 启停）——商品外键、Banner 的 link_id、埋点都存键。
 * @limitation 二：删除只允许"没有任何商品"的分类（含草稿 / 下架）；有商品时由运营先把商品改到别的分类。
 * @see migrations/039_product_categories.sql；server/src/app/admin-category-routes.ts
 */
import type { Db } from './db.js';

export interface AdminCategoryRow {
  key: string;
  name: string;
  sort: number;
  active: boolean;
  /** 在售商品数（决定买家端显不显示）。 */
  active_product_count: number;
  /** 全部商品数（含草稿 / 下架；> 0 时不能删）。 */
  product_count: number;
}

/** 唯一冲突落在哪一项：键（主键）或名称（唯一索引）。 */
export type Duplicate = { ok: false; field: 'key' | 'name' };

/**
 * @measured postgres.js 3.4.9 + PostgreSQL 16.15（after-sales.ts 同一探针）：SQLSTATE 在 `.code`、约束 / 索引名在 `.constraint_name`。
 *           本表主键约束名 `product_categories_pkey`（PG 默认命名），名称唯一索引 `uq_product_categories_name`——
 *           由 categories.db.test.ts 的"键或名称重复"用例实测钉住。
 */
function duplicateOf(e: unknown): Duplicate | null {
  const pg = e as { code?: string; constraint_name?: string };
  if (pg.code !== '23505') return null;
  if (pg.constraint_name === 'product_categories_pkey') return { ok: false, field: 'key' };
  if (pg.constraint_name === 'uq_product_categories_name') return { ok: false, field: 'name' };
  return null;
}

/** 后台列表：全部分类（含停用），按排序、键。 */
export async function listAdminCategories(db: Db): Promise<AdminCategoryRow[]> {
  const rows = await db`
    select c.key, c.name, c.sort, c.active,
           count(p.id) filter (where p.status = 'active')::int as active_product_count,
           count(p.id)::int as product_count
      from product_categories c
      left join products p on p.category = c.key
     group by c.key
     order by c.sort, c.key`;
  return rows.map((r) => ({
    key: String(r.key),
    name: String(r.name),
    sort: Number(r.sort),
    active: r.active === true,
    active_product_count: Number(r.active_product_count),
    product_count: Number(r.product_count),
  }));
}

/** 买家端：启用且至少有一件在售商品的分类，按排序。 */
export async function listVisibleCategories(db: Db): Promise<{ key: string; name: string }[]> {
  const rows = await db`
    select c.key, c.name
      from product_categories c
     where c.active
       and exists (select 1 from products p where p.category = c.key and p.status = 'active')
     order by c.sort, c.key`;
  return rows.map((r) => ({ key: String(r.key), name: String(r.name) }));
}

/** 分类存在吗（不论启停）——商品录入校验用。 */
export async function categoryExists(db: Db, key: string): Promise<boolean> {
  const rows = await db`select 1 from product_categories where key = ${key}`;
  return rows.length > 0;
}

export async function createCategory(
  db: Db,
  c: { key: string; name: string; sort: number },
): Promise<{ ok: true } | Duplicate> {
  try {
    await db`insert into product_categories (key, name, sort) values (${c.key}, ${c.name}, ${c.sort})`;
    return { ok: true };
  } catch (e) {
    const d = duplicateOf(e);
    if (d !== null) return d;
    throw e;
  }
}

/** 改名称 / 排序 / 启停（只改给了的项）。不存在 → null；名称撞了 → Duplicate。 */
export async function updateCategory(
  db: Db,
  key: string,
  patch: { name?: string; sort?: number; active?: boolean },
): Promise<{ key: string; name: string; sort: number; active: boolean } | null | Duplicate> {
  try {
    const [r] = await db`
      update product_categories
         set name = coalesce(${patch.name ?? null}, name),
             sort = coalesce(${patch.sort ?? null}::int, sort),
             active = coalesce(${patch.active ?? null}::boolean, active),
             updated_at = now()
       where key = ${key}
      returning key, name, sort, active`;
    if (r === undefined) return null;
    return {
      key: String(r.key),
      name: String(r.name),
      sort: Number(r.sort),
      active: r.active === true,
    };
  } catch (e) {
    const d = duplicateOf(e);
    if (d !== null) return d;
    throw e;
  }
}

/**
 * 删除：还有商品（任何状态）→ in_use；还有 Banner 跳到它 → banner_ref；都不删。
 * 先查后删之间的并发插入商品由外键 RESTRICT 兜底（23503 照抛）。
 * @why banner_ref（三天提交复查 2026-10-12）：Banner 到分类没有外键；删了分类，跳到它的 Banner 点进去是空页，
 *      且那条 Banner 再保存会被 link_target_missing 拒（AJ-512），运营连关都关不掉。
 * @limitation 先查后删之间新建指向它的 Banner 拦不住（没有外键）；那条 Banner 保存时已校验目标存在，窗口只有毫秒级。
 */
export async function deleteCategory(
  db: Db,
  key: string,
): Promise<'deleted' | 'in_use' | 'banner_ref' | 'not_found'> {
  const used = await db`select 1 from products where category = ${key} limit 1`;
  if (used.length > 0) {
    const exists = await categoryExists(db, key);
    return exists ? 'in_use' : 'not_found';
  }
  const linked =
    await db`select 1 from banners where link_type = 'category' and link_id = ${key} limit 1`;
  if (linked.length > 0) return 'banner_ref';
  const gone = await db`delete from product_categories where key = ${key} returning key`;
  return gone.length > 0 ? 'deleted' : 'not_found';
}
