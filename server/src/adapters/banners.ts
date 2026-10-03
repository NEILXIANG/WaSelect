/**
 * 职责：Banner 的**买家侧读**仓储（`/home`，D-51）——只回答一件事："此刻该展示哪些"。
 *
 * @why 与管理端 `banners-admin.ts` 分成**两个文件**而不是一个仓储加一个布尔开关：
 *      两侧要的是**两份不同语义**——管理端必须能看见已停用与未开始的 banner
 *      （否则"停用"这个动作等于"永久删除视图"，运营再也找不回它来重新启用）；
 *      买家侧只认"此刻生效"。合成 `listBanners({ includeInactive })`，
 *      每个调用方都得先想清楚该传什么，而传错的表现是"首页展示了已停用的 banner"
 *      或"运营列表里找不到刚停用的那条"——两种都不报错。两个名字各自只有一种读法。
 *
 * @why 行类型 `BannerRow` 与读列清单 `COLS` 放在**本文件**并由管理端仓储 import 回去：
 *      读是写的基础（写方法的 `returning` 取的也是同一组列）。分成两份的结果是
 *      "加了一列，只有一侧取到"——而那一侧看起来完全正常。
 *
 * @why 时间窗两端都取**闭区间**（`starts_at <= now <= ends_at`）：
 *      运营填的结束时间是"放到这一刻为止"，含端点最贴近直觉。
 *      真正要紧的是**两端同一条口径**——一端含、一端不含会在边界上产生"差一秒"的争论，
 *      而那一秒没有任何业务含义（banner 不是秒杀）。
 * @why `starts_at` / `ends_at` 为 NULL 时**该侧不加限制**，而不是判成"永不生效"：
 *      管理端允许只填一头（比如"从国庆开始、不设结束"），
 *      若把 NULL 当"不生效"，那条 banner 会永远不出现，且没有任何报错——
 *      运营看到的是"我配了，首页没有"，排查方向会指向图片、指向小程序，不会指向这里。
 *
 * @limitation 一：`now` 由**调用方传入**，本层不取时钟（F10）。
 *              生效判定必须是可注入的确定量，否则"到点自动下架"这件事无法被测试——
 *              而它恰好是最需要被测试的一条规则（错了的表现只是"图还在/图没了"）。
 * @limitation 二：只判 `active` 与起止时间，**不回查链接目标是否存在**
 *              （`link_type=product` 而商品已下架时，本条照常返回）。
 *              为它给每个 banner 多查一次商品表不值；"点了跳到已下架的商品"
 *              由详情页既有 40401 处理，那是一条**有提示**的路径。
 *
 * @see migrations/001_init.sql（banners 表）；./banners-admin.ts（管理端读写，本文件的对偶）；
 *      app/home-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';

/** 读出行（与契约 `Banner` 对应；`image` 完整 URL 由路由层用 IMG_BASE_URL 拼，不在本层）。 */
export interface BannerRow {
  id: string;
  image_key: string;
  link_type: string;
  link_id: string | null;
  sort: number;
  active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** 读列清单（读写两侧共用一份，见文件头 @why）。 */
export const COLS =
  'id, image_key, link_type, link_id, sort, active, starts_at, ends_at, created_at, updated_at';

/** 数据库行 → `BannerRow`。读写两侧共用（写路径的 `returning` 也走它）。 */
export function toRow(r: Record<string, unknown>): BannerRow {
  return {
    id: String(r['id']),
    image_key: String(r['image_key']),
    link_type: String(r['link_type']),
    link_id: r['link_id'] === null ? null : String(r['link_id']),
    sort: Number(r['sort']),
    active: Boolean(r['active']),
    starts_at: (r['starts_at'] as Date | null) ?? null,
    ends_at: (r['ends_at'] as Date | null) ?? null,
    created_at: r['created_at'] as Date,
    updated_at: r['updated_at'] as Date,
  };
}

export interface BannersRepo {
  /** 此刻生效的 banner：`active` 且在起止时间窗内（含端点），`sort asc, created_at asc`。 */
  listActiveBanners(now: Date): Promise<BannerRow[]>;
}

export function createBannersRepo(db: Db): BannersRepo {
  return {
    async listActiveBanners(now: Date): Promise<BannerRow[]> {
      const rows = await db`
        select ${db.unsafe(COLS)}
          from banners
         where active = true
           and (starts_at is null or starts_at <= ${now})
           and (ends_at is null or ends_at >= ${now})
         order by sort asc, created_at asc
      `;
      return rows.map((r) => toRow(r as Record<string, unknown>));
    },
  };
}
