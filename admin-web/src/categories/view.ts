/**
 * 职责：商品分类的纯视图函数（AJ-491）——分类名查找、下拉选项、表单预检、服务端原因翻人话。
 *
 * @why 分类改为后台可配置后，商品表单 / 商品列表 / Banner 都从同一份列表取名称与选项（原先各自引 shared 的写死四类）。
 * @why 预检规则与服务端 domain/category-input.ts 同口径（键形状、名称 1–10 字、不收网页代码），先在本地报出来；服务端兜底。
 */
import { SORT_MAX } from '@waselect/shared';
import type { AdminCategory } from './api.js';

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/;

/** 键 → 名称；认不出的原样返回键（看得见，不编名字）。 */
export function categoryName(list: readonly AdminCategory[], key: string): string {
  return list.find((c) => c.key === key)?.name ?? key;
}

/**
 * 商品表单的分类下拉：启用的分类按排序；当前值若是已停用 / 已不存在的分类，也保留一项并标注，
 * 否则受控 select 的 value 不在选项里，浏览器会显示第一项而 state 里仍是旧值（ADM3-08 同一个坑）。
 */
export function categoryOptions(
  list: readonly AdminCategory[],
  current: string,
): Array<{ value: string; label: string }> {
  const opts = list.filter((c) => c.active).map((c) => ({ value: c.key, label: c.name }));
  if (current !== '' && !opts.some((o) => o.value === current)) {
    const hit = list.find((c) => c.key === current);
    opts.push({
      value: current,
      label: hit === undefined ? `${current}（已删除）` : `${hit.name}（已停用）`,
    });
  }
  return opts;
}

export interface CategoryDraft {
  key: string;
  name: string;
  sort: string;
}

/** 新建 / 修改的本地预检；返回 {字段: 人话}，空对象 = 通过。`isNew` 为 false 时不查键（键不能改）。 */
export function categoryDraftErrors(d: CategoryDraft, isNew: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (isNew && !KEY.test(d.key.trim()))
    e['key'] = '分类代码用小写英文字母开头，2–32 位，只能有小写字母、数字、下划线（如 baby_care）';
  const name = d.name.trim();
  if (name === '') e['name'] = '请填写分类名称';
  else if ([...name].length > 10) e['name'] = '分类名称最多 10 个字（小程序分类栏放不下更长的）';
  else if (HTML_TAG.test(name)) e['name'] = '分类名称里不能有网页代码（如 <b>）';
  const sort = d.sort.trim();
  if (!/^\d{1,4}$/.test(sort)) e['sort'] = '排序填 0–9999 的整数，越小越靠前';
  return e;
}

const REASONS: Readonly<Record<string, string>> = {
  key_invalid: '分类代码格式不对：小写英文字母开头，2–32 位，只能有小写字母、数字、下划线',
  name_required: '请填写分类名称',
  name_too_long: '分类名称最多 10 个字',
  html_not_allowed: '分类名称里不能有网页代码（如 <b>）',
  sort_invalid: `排序填 0–${String(SORT_MAX)} 的整数`,
};

/** 服务端 40001 的 data → {字段, 人话}；重复单独说清是哪一项。null = 没有可用的 data。 */
export function categoryServerError(data: unknown): { field: string; text: string } | null {
  const d = data as { field?: unknown; reason?: unknown } | null | undefined;
  if (d === null || d === undefined || typeof d.field !== 'string' || typeof d.reason !== 'string')
    return null;
  if (d.reason === 'duplicate')
    return {
      field: d.field,
      text: d.field === 'key' ? '这个分类代码已经有了，换一个' : '已经有同名的分类了，换一个名称',
    };
  return { field: d.field, text: REASONS[d.reason] ?? '填写不符合要求，请检查后再保存' };
}
