/**
 * 职责：商品分类的输入校验（AJ-491，分类改为后台可配置）——纯函数，零依赖。
 *
 * @why 键的形状与迁移 039 的 CHECK 同口径（`^[a-z][a-z0-9_]{1,31}$`）：应用层先拦、给运营说人话，库的 CHECK 是兜底。
 *      键会进网址（`?category=`）、Banner 的 link_id、埋点，所以只收小写字母 / 数字 / 下划线。
 * @why 名称 1–10 字：小程序分类栏是横向标签，过长会挤成一长条；与库 CHECK（btrim 后 1–10）一致。按码位数，表情算一个。
 * @why 名称不收网页代码（与商品文字同一条规则 HTML_TAG，AJ-490）：买家会原样看到。
 * @limitation 键建好后不能改（patch 里给了 key 就拒）：商品外键、Banner、埋点都存键。
 */
import { HTML_TAG } from './product-input.js';

export interface FieldError {
  field: string;
  reason: string;
}

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const DEFAULT_SORT = 100;

function nameErrors(raw: unknown, errors: FieldError[]): string | undefined {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') errors.push({ field: 'name', reason: 'name_required' });
  else if ([...name].length > 10) errors.push({ field: 'name', reason: 'name_too_long' });
  else if (HTML_TAG.test(name)) errors.push({ field: 'name', reason: 'html_not_allowed' });
  return name;
}

function sortOk(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999;
}

export function validateCategoryCreate(
  raw: unknown,
):
  | { ok: true; value: { key: string; name: string; sort: number } }
  | { ok: false; errors: FieldError[] } {
  if (raw === null || typeof raw !== 'object')
    return { ok: false, errors: [{ field: 'body', reason: 'not_object' }] };
  const b = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  const key = typeof b['key'] === 'string' ? b['key'] : '';
  if (!KEY.test(key)) errors.push({ field: 'key', reason: 'key_invalid' });
  const name = nameErrors(b['name'], errors);
  const sort = b['sort'] === undefined ? DEFAULT_SORT : b['sort'];
  if (!sortOk(sort)) errors.push({ field: 'sort', reason: 'sort_invalid' });
  if (errors.length > 0 || name === undefined || !sortOk(sort)) return { ok: false, errors };
  return { ok: true, value: { key, name, sort } };
}

export function validateCategoryPatch(
  raw: unknown,
):
  | { ok: true; value: { name?: string; sort?: number; active?: boolean } }
  | { ok: false; errors: FieldError[] } {
  if (raw === null || typeof raw !== 'object')
    return { ok: false, errors: [{ field: 'body', reason: 'not_object' }] };
  const b = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (b['key'] !== undefined) errors.push({ field: 'key', reason: 'key_immutable' });
  const value: { name?: string; sort?: number; active?: boolean } = {};
  if (b['name'] !== undefined) {
    const name = nameErrors(b['name'], errors);
    if (name !== undefined) value.name = name;
  }
  if (b['sort'] !== undefined) {
    if (sortOk(b['sort'])) value.sort = b['sort'];
    else errors.push({ field: 'sort', reason: 'sort_invalid' });
  }
  if (b['active'] !== undefined) {
    if (typeof b['active'] === 'boolean') value.active = b['active'];
    else errors.push({ field: 'active', reason: 'active_invalid' });
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(value).length === 0)
    return { ok: false, errors: [{ field: 'body', reason: 'empty_patch' }] };
  return { ok: true, value };
}
