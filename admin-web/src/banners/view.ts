/**
 * 职责：首页 Banner 的**视图纯函数**（列表行 / 表单 / 校验 / 请求体）。
 *
 * @why Banner 的失效形态是"静默不显示"或"跳错地方"：
 *      `link_type=product` 却没填 `link_id`，小程序点了会跳到一个不存在的商品；
 *      起止时间填反了（结束早于开始），banner 会**永远不出现**且不报错。
 *      这两条都由本层在保存前拦。
 *
 * @limitation 一：`image_key` 是**上传后拿到的 key**（来自 `POST /admin/upload`），
 *              不是 URL——列表里显示用的 `image` 才是完整 URL（服务端拼的）。
 *              表单里不让填 URL：填了 URL 服务端存不下（列是 key），
 *              而报错会指向"图片字段"，运营看不出是"填错种类"而不是"图坏了"。
 * @limitation 二：`sort` 只校验"≥0 的整数"，**不校验唯一性**：
 *              重复排序值不是错误（服务端按 sort 再按创建时间排），
 *              前端若强行要求唯一，运营会被一个无意义的问题卡住。
 *
 * @see ../../../contracts/api-contract.yaml（BannerInput / Banner）；../format.ts
 */
import { SORT_MAX } from '@waselect/shared';
import { formatJst, halfWidth, toIsoJst } from '../format.js';

/** 契约 `BannerInput.link_type` 枚举（单测与契约双向比对）。 */
export const LINK_TYPES = ['none', 'product', 'category'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** 展示名（契约只给 key）。 */
export const LINK_LABELS: Readonly<Record<LinkType, string>> = {
  none: '不跳转',
  product: '商品',
  category: '分类',
};

/** Banner 表单（全字符串 + active 布尔）。 */
export interface BannerForm {
  imageKey: string;
  linkType: string;
  linkId: string;
  sort: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
}

export function emptyBannerForm(): BannerForm {
  return {
    imageKey: '',
    linkType: 'none',
    linkId: '',
    sort: '0',
    active: true,
    startsAt: '',
    endsAt: '',
  };
}

/** `Banner` → 表单（编辑态）。 */
export function bannerFormModel(banner: unknown): BannerForm {
  const b = (typeof banner === 'object' && banner !== null ? banner : {}) as Record<
    string,
    unknown
  >;
  const text = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');
  return {
    imageKey: text('image_key'),
    linkType: (LINK_TYPES as readonly string[]).includes(text('link_type'))
      ? text('link_type')
      : 'none',
    linkId: text('link_id'),
    sort: Number.isInteger(b['sort']) ? String(b['sort']) : '0',
    active: b['active'] !== false,
    startsAt: localOf(text('starts_at')),
    endsAt: localOf(text('ends_at')),
  };
}

/** ISO → `datetime-local` 能接受的形状（`'YYYY-MM-DDTHH:mm'`，按 JST）。 */
function localOf(iso: string): string {
  return iso === '' ? '' : formatJst(iso).replace(' ', 'T');
}

/** 列表行。 */
export interface BannerRow {
  id: string;
  imageUrl: string;
  linkText: string;
  sortText: string;
  active: boolean;
  periodText: string;
}

/** `Banner[]` → 列表行（按 sort 升序）。 */
/**
 * @param titleOf 商品 id → 商品名（三端联动 UI 模拟 2026-10-08：列表原先只显示 `商品：<长 id>`，运营认不出是哪件）；
 *        查不到时退回显示 id（商品被删 / 列表没取到），不编名字。
 */
export function bannerRows(
  items: unknown,
  titleOf: (productId: string) => string | undefined = () => undefined,
  // AJ-491：分类可配置，名称来自后台分类列表（../categories/），认不出原样显示键
  categoryNameOf: (key: string) => string = (k) => k,
): BannerRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => typeof b['id'] === 'string' && b['id'] !== '')
    .sort((a, b) => Number(a['sort'] ?? 0) - Number(b['sort'] ?? 0))
    .map((b) => {
      const type = typeof b['link_type'] === 'string' ? b['link_type'] : 'none';
      const id = typeof b['link_id'] === 'string' ? b['link_id'] : '';
      return {
        id: b['id'] as string,
        imageUrl: typeof b['image'] === 'string' ? b['image'] : '',
        linkText:
          type === 'none'
            ? LINK_LABELS.none
            : `${(LINK_LABELS as Record<string, string>)[type] ?? type}：${
                type === 'product'
                  ? (titleOf(id) ?? id)
                  : type === 'category'
                    ? categoryNameOf(id)
                    : id
              }`,
        sortText: Number.isInteger(b['sort']) ? String(b['sort']) : '0',
        active: b['active'] !== false,
        periodText: [formatJst(b['starts_at']), formatJst(b['ends_at'])]
          .filter((s) => s !== '—')
          .join(' → '),
      };
    });
}

/**
 * 任意形状 → 表单模型（**只按 BannerForm 的键名读**）。
 *
 * @why 与 `bannerFormModel` 分开，是踩过的坑的复发点（商品表单同一个坑，见 `products/view.ts` 的 `asForm`）：
 *      `bannerFormModel` 读的是**服务端 `Banner`** 的键名（`image_key` / `link_type`），
 *      而表单自己的键名是 `imageKey` / `linkType`。校验与组装若复用前者，
 *      每个字段都会**回落成默认值**——表现为"填了图片却提示图片必填"，
 *      而错误指向表单，排查方向完全错。
 */
function asForm(value: unknown): BannerForm {
  const base = emptyBannerForm();
  const f = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const str = (k: string, fallback: string): string =>
    typeof f[k] === 'string' ? (f[k] as string) : fallback;
  return {
    imageKey: str('imageKey', base.imageKey),
    linkType: str('linkType', base.linkType),
    linkId: str('linkId', base.linkId),
    sort: str('sort', base.sort),
    active: typeof f['active'] === 'boolean' ? (f['active'] as boolean) : base.active,
    startsAt: str('startsAt', base.startsAt),
    endsAt: str('endsAt', base.endsAt),
  };
}

/**
 * 表单校验（入参是 `BannerForm`，不读服务端键名，@see asForm）。
 * @why **起止时间必须判"开始早于结束"**：填反了的表现是 banner 永远不展示，
 *      而没有任何一方会报错——前端不报（契约只说 date-time）、服务端不报（区间校验是业务规则）。
 */
export function bannerFormErrors(form: unknown): {
  ok: boolean;
  errors: Record<string, string>;
  first: string;
} {
  const f = asForm(form);
  const errors: Record<string, string> = {};
  // 提示一律人话（全入口点击测试 2026-10-12：原写"拿到 image_key""必须填目标 id""YYYY-MM-DDTHH:mm"——字段名与格式串运营看不懂）
  if (f.imageKey.trim() === '') errors['imageKey'] = '请先上传一张 Banner 图片';
  if (!(LINK_TYPES as readonly string[]).includes(f.linkType))
    errors['linkType'] = '跳转类型不对，请从下拉里重新选一个';
  if (f.linkType !== 'none' && f.linkId.trim() === '')
    errors['linkId'] =
      f.linkType === 'category'
        ? '选了跳转到分类，请在下拉里选一个分类（否则买家点了会跳到不存在的页面）'
        : '选了跳转到商品，请在下拉里选一件商品（否则买家点了会跳到不存在的页面）';
  // 只认纯数字串：`Number('')` 是 0、`Number('1e2')` 是 100，都会静默改值（审查 2026-10-09 #6；商品页同口径）
  const sortText = halfWidth(f.sort); // 全角先转半角（两端输入测试 2026-10-12）
  const sort = /^\d+$/.test(sortText) ? Number(sortText) : Number.NaN;
  // 上界 SORT_MAX 与服务端、分类排序同源（两端输入测试 2026-10-12：填 99999999999 原先放行、服务端 500）
  if (!Number.isInteger(sort) || sort < 0 || sort > SORT_MAX)
    errors['sort'] = `排序填 0–${String(SORT_MAX)} 的整数`;
  if (f.startsAt !== '' && toIsoJst(f.startsAt) === '')
    errors['startsAt'] = '开始时间没填完整：日期和时刻都要选';
  if (f.endsAt !== '' && toIsoJst(f.endsAt) === '')
    errors['endsAt'] = '结束时间没填完整：日期和时刻都要选';
  if (
    errors['startsAt'] === undefined &&
    errors['endsAt'] === undefined &&
    f.startsAt !== '' &&
    f.endsAt !== '' &&
    toIsoJst(f.startsAt) >= toIsoJst(f.endsAt)
  ) {
    errors['endsAt'] = '结束时间必须晚于开始时间（填反了 banner 永远不会展示）';
  }
  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/**
 * 表单 → 契约 `BannerInput`。
 * @why 时间为空时**不带该字段**（契约可选项）：传空串是非法 date-time，
 *      而"不传"的语义是"不限时间"，正是运营的意图。
 */
export function toBannerInput(form: unknown): Record<string, unknown> {
  const f = asForm(form);
  const starts = toIsoJst(f.startsAt);
  const ends = toIsoJst(f.endsAt);
  return {
    image_key: f.imageKey.trim(),
    link_type: f.linkType,
    ...(f.linkType === 'none' ? {} : { link_id: f.linkId.trim() }),
    sort: Number(halfWidth(f.sort)),
    active: f.active,
    ...(starts === '' ? {} : { starts_at: starts }),
    ...(ends === '' ? {} : { ends_at: ends }),
  };
}

/** 冲突对照的一行（与商品表单同形，P2-44）。 */
export interface BannerConflictRow {
  label: string;
  mine: string;
  latest: string;
  differs: boolean;
}

/**
 * 40914 后的对照表：表单当前值 vs 服务端最新一版（P2-44）。
 * @why 原文案让运营"取消编辑后重新打开"——取消就丢了表单（含刚上传的图）。现在表单原地保留，最新值只读对照。
 */
export function bannerConflictRows(form: BannerForm, latest: unknown): BannerConflictRow[] {
  const theirs = bannerFormModel(latest);
  const link = (f: BannerForm): string =>
    f.linkType === 'none'
      ? LINK_LABELS.none
      : `${(LINK_LABELS as Record<string, string>)[f.linkType] ?? f.linkType}：${f.linkId}`;
  const pairs: Array<[string, string, string]> = [
    ['图片', form.imageKey, theirs.imageKey],
    ['跳转', link(form), link(theirs)],
    ['排序', form.sort, theirs.sort],
    ['启用', form.active ? '启用' : '停用', theirs.active ? '启用' : '停用'],
    ['开始（日本时间）', form.startsAt, theirs.startsAt],
    ['结束（日本时间）', form.endsAt, theirs.endsAt],
  ];
  return pairs.map(([label, mine, l]) => ({ label, mine, latest: l, differs: mine !== l }));
}
