/**
 * 职责：`GET /admin/customers` 查询参数（分页 + 关键字）的判定——纯函数，无外部依赖（AJ-404）。
 *
 * @why 分页口径与 `/admin/orders` 相同（page 默认 1，size 默认 20、最大 100）：
 *      两张管理端列表一个能翻 100 条一个只能翻 50，运营只会觉得"有一页坏了"。
 * @why 关键字长度上限复用 shared `SEARCH_KEYWORD_MAX_LENGTH`，量的是**原始输入**（trim 之前），
 *      与 `/admin/orders` 同一条理由（AJ-360）：上限要框住"客户端能送进来多少"。
 * @why 非字符串（`?keyword=a&keyword=b` 被 Express 解析成数组）→ `keyword_invalid`，
 *      不去猜"拼起来 / 取第一个"：猜错了运营看到的是"搜不到"，而真因是参数形状。
 * @limitation 关键字只做"去空白 + 转小写"的归一；不做全角半角、空格合并——
 *             收件人是 ASCII（addresses_recipient CHECK），邮箱大小写不敏感，单号是 ASCII，三者都够用。
 */
import { SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';

export const CUSTOMER_PAGE_SIZE_DEFAULT = 20;
export const CUSTOMER_PAGE_SIZE_MAX = 100;

export type CustomerListQuery =
  | { ok: true; page: number; size: number; keyword: string | null }
  | { ok: false; reason: 'page_size_invalid' | 'keyword_too_long' | 'keyword_invalid' };

/** 缺省 → 默认值；其余必须是正整数的十进制串（数组 / 空串 / 小数 → NaN 或非整数）。 */
function intParam(v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || v.trim() === '') return Number.NaN;
  return Number(v);
}

export function parseCustomerListQuery(q: Record<string, unknown>): CustomerListQuery {
  const page = intParam(q['page'], 1);
  const size = intParam(q['size'], CUSTOMER_PAGE_SIZE_DEFAULT);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > CUSTOMER_PAGE_SIZE_MAX
  ) {
    return { ok: false, reason: 'page_size_invalid' };
  }
  const raw = q['keyword'];
  if (raw === undefined) return { ok: true, page, size, keyword: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'keyword_invalid' };
  if (raw.length > SEARCH_KEYWORD_MAX_LENGTH) return { ok: false, reason: 'keyword_too_long' };
  const k = raw.trim().toLowerCase();
  return { ok: true, page, size, keyword: k === '' ? null : k };
}
