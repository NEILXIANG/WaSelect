/**
 * 职责：Banner 的读写仓储（I2 U-D2）——`banners` 表（D-51）。
 *
 * @why `updated_at` 由 **SQL `now()`** 产生，不由调用方传（与 `catalog-admin.ts` 同一条理由）：
 *      业务侧不取时钟（F10），且"最后修改时间"必须是**库里的时间**——
 *      传进来的值可能是任何一个实例的时钟。
 *
 * @why 列表**不过滤** active、不过滤起止时间：管理端要能看见已停用与未开始的 banner，
 *      否则"停用"这个动作等于"永久删除视图"——运营再也找不到它来重新启用。
 *      "当前该展示哪些"是**买家侧** `adapters/banners.ts` 的判定（`/home`），不是管理端列表的职责。
 *
 * @limitation 一：`updateBanner` 是**整行覆盖**（PUT 语义，与契约一致），
 *              不做"只改传入字段"的合并——不存在"某个字段前端没传、于是被静默保留"的歧义。
 *              0 行命中返回 null（由路由转 40402），不抛错。
 * @limitation 二：`deleteBanner` 对不存在的 id 返回 **false 而不是报错**（路由转 204）：
 *              DELETE 的幂等语义是"让它不存在"，重复删除不该报错。
 *              ⚠️ 代价：id 写错时也返回"成功"——但管理端的 id 恒来自列表，
 *              不存在"手输 id"这条路径；而"删两次"是真实会发生的（双击）。
 * @limitation 三：没有"排序唯一性"约束（`sort` 可重复，前端 view.ts @limitation 二 同口径）：
 *              重复排序不是错误，顺序由 `sort asc, created_at asc` 兜底决定。
 *
 * @see migrations/001_init.sql（banners 表）；domain/banner-input.ts（输入校验，写之前已过）；
 *      ./banners.ts（行类型与读列清单的真源，本文件 import 回来）；
 *      app/admin-banner-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';
import { COLS, toRow, type BannerRow } from './banners.js';

/** 行类型**转手再导出**：调用方（管理端路由）不必知道它现在住在 `banners.ts`。 */
export type { BannerRow };

/** 写入形状（时间用 UTC 毫秒：domain 侧产出，见 banner-input.ts @limitation 一）。 */
export interface BannerWrite {
  imageKey: string;
  linkType: string;
  linkId: string | null;
  sort: number;
  active: boolean;
  startsAtMs: number | null;
  endsAtMs: number | null;
}

export interface BannersAdminRepo {
  /** 全部 banner（含停用与未开始）；`sort asc, created_at asc`。 */
  listBanners(): Promise<BannerRow[]>;
  /** 按 id 取一行；无 → null。 */
  findBanner(id: string): Promise<BannerRow | null>;
  /**
   * 跳转目标在不在（商品不论上下架、分类不论启停——下架 / 停用是可恢复的，见 banners.ts @limitation）。
   * @why 规律排查 2026-10-12：原先只判 link_id 非空，接口可写入指向不存在商品 / 分类的 Banner，买家点进去是空页。
   */
  linkTargetExists(type: 'product' | 'category', id: string): Promise<boolean>;
  /** 插入一行并返回读出行。 */
  insertBanner(row: BannerWrite & { id: string }): Promise<BannerRow>;
  /** 整行覆盖（@limitation 一）；0 行命中 → null。 */
  /**
   * 带乐观锁的整行更新（S-09）：`expectedUpdatedAt` 与库里不一致时不写。
   * @returns 改好的行；`'missing'` = 这条已不存在；`'stale'` = 打开编辑之后被别人改过
   */
  updateBanner(
    id: string,
    row: BannerWrite,
    expectedUpdatedAt: string,
  ): Promise<BannerRow | 'missing' | 'stale'>;
  /** 删除（@limitation 二）；0 行命中 → false。 */
  deleteBanner(id: string): Promise<boolean>;
}

/** 毫秒 → Date（本文件在 adapters 豁免清单内，可以构造 Date；@see banner-input.ts @limitation 一）。 */
function atOf(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export function createBannersAdminRepo(db: Db): BannersAdminRepo {
  return {
    async listBanners(): Promise<BannerRow[]> {
      const rows = await db`
        select ${db.unsafe(COLS)} from banners order by sort asc, created_at asc
      `;
      return rows.map((r) => toRow(r as Record<string, unknown>));
    },

    async linkTargetExists(type: 'product' | 'category', id: string): Promise<boolean> {
      const rows =
        type === 'product'
          ? await db`select 1 from products where id = ${id}`
          : await db`select 1 from product_categories where key = ${id}`;
      return rows.length > 0;
    },

    async findBanner(id: string): Promise<BannerRow | null> {
      const rows = await db`
        select ${db.unsafe(COLS)} from banners where id = ${id}
      `;
      const r = rows[0];
      return r === undefined ? null : toRow(r as Record<string, unknown>);
    },

    async insertBanner(row: BannerWrite & { id: string }): Promise<BannerRow> {
      const out = await db`
        insert into banners (id, image_key, link_type, link_id, sort, active, starts_at, ends_at)
        values (${row.id}, ${row.imageKey}, ${row.linkType}, ${row.linkId}, ${row.sort},
                ${row.active}, ${atOf(row.startsAtMs)}, ${atOf(row.endsAtMs)})
        returning ${db.unsafe(COLS)}
      `;
      const r = out[0];
      if (r === undefined) throw new Error('banners 插入未返回行');
      return toRow(r as Record<string, unknown>);
    },

    async updateBanner(
      id: string,
      row: BannerWrite,
      expectedUpdatedAt: string,
    ): Promise<BannerRow | 'missing' | 'stale'> {
      // 毫秒截断后比较：下发给前端的是 toISOString()（毫秒），库里是微秒（与商品 PUT 同口径）
      const out = await db`
        update banners
           set image_key = ${row.imageKey}, link_type = ${row.linkType}, link_id = ${row.linkId},
               sort = ${row.sort}, active = ${row.active},
               starts_at = ${atOf(row.startsAtMs)}, ends_at = ${atOf(row.endsAtMs)},
               updated_at = now()
         where id = ${id}
           and date_trunc('millisecond', updated_at) = ${expectedUpdatedAt}::timestamptz
        returning ${db.unsafe(COLS)}
      `;
      const r = out[0];
      if (r !== undefined) return toRow(r as Record<string, unknown>);
      const exists = await db`select 1 from banners where id = ${id}`;
      return exists.length === 0 ? 'missing' : 'stale';
    },

    async deleteBanner(id: string): Promise<boolean> {
      const out = await db`delete from banners where id = ${id} returning id`;
      return out.length > 0;
    },
  };
}
