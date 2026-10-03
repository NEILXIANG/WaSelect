/**
 * 职责：Banner **仓储行 → 契约 `Banner`** 的唯一转换（管理端 `/admin/banners` 与
 *       买家侧 `/home` 共用这一份）。
 *
 * @why 抽出来是因为 `/home` 成了第二个消费方。留在 `admin-banner-routes.ts` 里的话，
 *      买家侧要么复制一份（两份"行 → 契约"必然漂移：管理端带 `image`、首页不带，
 *      或某天一边加了字段另一边没加），要么去 import 一个**管理端路由文件**——
 *      后者更糟：买家侧的公开端点从此依赖管理端模块，改管理端会动到首页。
 *      app → app helper 在项目里有先例（`product-routes.ts` 的 `toImageSet`）。
 *
 * @why `image`（完整 URL）由服务端用 `IMG_BASE_URL` 拼，**不存进表里**：
 *      表里存的是 `image_key`（AJ-143 的定论）。把完整 URL 存进业务表，
 *      换域名/换图床时要改历史数据；反过来让前端从 URL 反解 key，
 *      是靠字符串巧合工作，规则一变就静默产出错 key 且无人报错。
 *
 * @limitation 一：`IMG_BASE_URL` **未配置时整键省略 `image`**（而不是给空串）：
 *      空串会被前端当成"有一张图、图裂了"；字段缺席才是"没有可展示的 URL"。
 *      与浏览降级同口径（汇率缺币就少显示一个展示价，不显示 0）。
 *      首页据此**整条不展示**该 banner（vm 的过滤），不退化成占位图——
 *      占位图是"商品没图"的语义，用在 banner 上会把"没配图床"洗成"这张 banner 没图"。
 *
 * @see adapters/banners.ts（行类型真源）；contracts/api-contract.yaml（Banner 形状）；
 *      app/admin-banner-routes.ts、app/home-routes.ts（两个调用方）
 */
import type { BannerRow } from '../adapters/banners.js';

/** 契约侧的 ISO 时间串；NULL → 省略（契约里 `starts_at` / `ends_at` 都不是必填）。 */
function at(d: Date | null): string | undefined {
  return d === null ? undefined : d.toISOString();
}

/**
 * 仓储行 → 契约 `Banner`（`BannerInput` 全部字段 + `id` + `image`）。
 * @returns `image` 缺席的情况见文件头 @limitation 一
 */
export function toBannerView(
  r: BannerRow,
  imgBaseUrl: string | undefined,
): Record<string, unknown> {
  const startsAt = at(r.starts_at);
  const endsAt = at(r.ends_at);
  return {
    id: r.id,
    image_key: r.image_key,
    link_type: r.link_type,
    ...(r.link_id !== null ? { link_id: r.link_id } : {}),
    sort: r.sort,
    active: r.active,
    ...(startsAt === undefined ? {} : { starts_at: startsAt }),
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    // 尾部斜杠只在拼接处处理一次：库里存的是 key，不是 URL
    ...(imgBaseUrl === undefined
      ? {}
      : { image: `${imgBaseUrl.replace(/\/+$/, '')}/${r.image_key}` }),
  };
}
