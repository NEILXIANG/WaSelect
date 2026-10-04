/**
 * 职责：`POST/PUT /admin/banners` 的输入校验（I2 U-D1）。
 *
 * @why 规则必须与前端 `admin-web/src/banners/view.ts` 的 `bannerFormErrors` **逐条对齐**：
 *      两端的校验一旦漂移，表现是"前端放行、服务端 40001"（或反过来），
 *      而运营看到的是**"保存失败但没有原因"**——字段级明细按设计只进日志
 *      （`admin-product-routes.ts` @limitation 一），前端那一层就成了唯一可读的解释。
 *      两端规则不一致时，那层解释会指向错误的字段。
 *
 * @why 🔴 "结束必须晚于开始"和"选了跳转就必须填目标"这两条必须在服务端也拦：
 *      它们的失效形态是**静默**——时间填反的 banner 永远不展示、
 *      `link_type=product` 没填 id 的小程序点了会跳到不存在的商品，
 *      两件事都不会有任何一方报错（契约只说 `format: date-time`，DB 也没有 CHECK）。
 *      与 D-46 取档方向是同一类：错了不响。
 *
 * @limitation 一：与 `fx-input.ts` 同因——返回 **UTC 毫秒**而不是 `Date`
 *              （F10 的 AST 规则连"解析请求里的字符串"也命中），Date 只在 adapters 构造。
 * @limitation 二：`link_id` **不校验"目标存在"**（不查 products / 分类字典）。
 *              理由：分类是字符串字典没有表；商品存在性校验要查库，
 *              而"banner 指向一个随后被下架的商品"是合法状态（前端点了会 40401，看得见）。
 *              查库校验留给有真实事故再说——现在加会把"编辑 banner"变成一个依赖商品表的操作。
 *
 * @see contracts/api-contract.yaml（BannerInput / Banner）；
 *      admin-web/src/banners/view.ts（前端同一套规则）
 */
import { AppError } from '../errors.js';
import { tryParseRfc3339Ms } from './time-input.js';
import { optionalBool } from './bool-input.js';

/** 契约 `BannerInput.link_type` 枚举（单测与契约双向比对）。 */
export const BANNER_LINK_TYPES = ['none', 'product', 'category'] as const;
export type BannerLinkType = (typeof BANNER_LINK_TYPES)[number];

/** 校验后的 Banner 输入（键名与契约 `BannerInput` 一致；时间是 UTC 毫秒，见 @limitation 一）。 */
export interface BannerInputValue {
  imageKey: string;
  linkType: BannerLinkType;
  /** `link_type !== 'none'` 时非空；否则可能是 null。 */
  linkId: string | null;
  sort: number;
  active: boolean;
  startsAtMs: number | null;
  endsAtMs: number | null;
}

/**
 * 解析一个可空的 date-time 字符串（null / undefined → null；非法 → 抛）。
 *
 * @why 走 `parseRfc3339Ms` 而不是 `Date.parse`（DOM3-03）：后者会把不带偏移的
 *      `"2026-10-01T00:00"` 按**本进程时区**解释（本机 JST / 生产 UTC 差 8 小时），
 *      运营排的"零点上线"在生产上变成早上 8 点；`"1"` 还会被当成 2001 年。
 *      契约两处写的是 `format: date-time`（偏移必填），入口就按它收。
 */
function parseAt(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new AppError(40001, { reason: `${field}_invalid` });
  const ms = tryParseRfc3339Ms(raw);
  if (ms === null) throw new AppError(40001, { reason: `${field}_invalid` });
  return ms;
}

/**
 * 校验并取出 Banner 输入（纯：不查库、不取时钟）。
 * @throws {AppError} 40001 形状 / 枚举 / 数值域 / 区间方向（见文件头 @why）
 */
export function parseBannerInput(body: unknown): BannerInputValue {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new AppError(40001, { reason: 'body_shape' });
  }

  const imageKey = typeof b['image_key'] === 'string' ? b['image_key'].trim() : '';
  if (imageKey === '') throw new AppError(40001, { reason: 'image_key_required' });

  const rawType = b['link_type'];
  const linkType =
    typeof rawType === 'string' && (BANNER_LINK_TYPES as readonly string[]).includes(rawType)
      ? (rawType as BannerLinkType)
      : rawType === undefined || rawType === null
        ? 'none'
        : (() => {
            throw new AppError(40001, { reason: 'link_type_invalid' });
          })();
  const rawLinkId = typeof b['link_id'] === 'string' ? b['link_id'].trim() : '';
  if (linkType !== 'none' && rawLinkId === '') {
    throw new AppError(40001, { reason: 'link_id_required' });
  }

  const sort = b['sort'] === undefined ? 0 : b['sort'];
  if (!Number.isInteger(sort) || (sort as number) < 0) {
    throw new AppError(40001, { reason: 'sort_invalid' });
  }

  const startsAtMs = parseAt(b['starts_at'], 'starts_at');
  const endsAtMs = parseAt(b['ends_at'], 'ends_at');
  // 🔴 区间方向：结束 ≤ 开始 = 永不命中，且不报错（@why）
  if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
    throw new AppError(40001, { reason: 'period_reversed' });
  }

  return {
    imageKey,
    linkType,
    linkId: rawLinkId === '' ? null : rawLinkId,
    sort: sort as number,
    // ⚠️ AJ-353：旧写法 `b['active'] !== false` 把 `"false"` / `0` 一律当成**启用**。
    //    运营想停用一个 banner 而传了字符串 "false"（CSV 导入 / 脚本改 banner 的常见形态），
    //    结果是它**照常出现在买家首页**——没有 4xx、没有日志，只有人眼看见才发现。
    active: optionalBool(b['active'], 'active', true, (reason) => {
      throw new AppError(40001, { reason });
    }),
    startsAtMs,
    endsAtMs,
  };
}
