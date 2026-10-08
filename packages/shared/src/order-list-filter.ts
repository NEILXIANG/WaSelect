/**
 * 职责：管理端订单列表的筛选参数解析（AJ-400，契约 0.6.44）——多状态 `status`、JST 日期区间。
 * 边界：纯函数，零依赖（只用本包的 JST 偏移与状态枚举）。
 *
 * @why 放在 shared：服务端用它校验 `GET /admin/orders` 的查询参数（非法 → 40001），
 *      管理端用它在发请求前校验"自定义日期"输入框——同一套规则只写一份，
 *      否则会出现"前端放行、后端 40001"的提交才炸（同 limits.ts 文件头的理由）。
 * @why 日期用 **JST 日历日 `YYYY-MM-DD`、两端都含**，而不是让客户端传 ISO 时刻：
 *      运营说的是"10 月 1 日到 7 日"，换成时刻就要客户端自己算 JST 日界，
 *      两端各算一遍正是"差 9 小时、按日统计错一天"的来源（P2-46 / AJ-386 吃过一次）。
 *      日界只在这里算：`[from 当日 00:00 JST, to 次日 00:00 JST)`，与工作台 `jstDayWindow` 同一口径（左闭右开）。
 *
 * @limitation 一：不设区间跨度上限——列表是分页的，一年的区间也只取一页；
 *              将来若导出也接这组参数（导出不分页），再在导出侧加上限。
 * @limitation 二：年份只认 0001–9999（四位数字）；`0000` 不是公历合法年份，拒绝。
 * @tradeoff 状态列表**不 trim、不改大小写、空段即非法**：容错会让"前端拼接出错"
 *           （例如 `paid,`）被悄悄吃掉，表现为"筛出来的比预期少"，没人会怀疑参数。
 * @see ./businessDay.ts（jstDayWindow）；server/src/app/admin-order-routes.ts；admin-web/src/orders/list-filter.ts
 */
import { JST_OFFSET_MIN } from './businessDay.js';
import { ORDER_STATUS, type OrderStatus } from './enums.js';

/** `a,b,c` → 去重后的状态数组；空串、空段、任何一段不在 `ORDER_STATUS` 里 → null。 */
export function parseOrderStatusList(raw: string): OrderStatus[] | null {
  const out: OrderStatus[] = [];
  for (const part of raw.split(',')) {
    if (!(ORDER_STATUS as readonly string[]).includes(part)) return null;
    if (!out.includes(part as OrderStatus)) out.push(part as OrderStatus);
  }
  return out;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD`（JST 日历日）→ 该日 00:00 JST 对应的 UTC 时刻；格式错或日期不存在 → null。
 * @why 用 `Date.UTC` 构造后**回读**年月日比对：`Date.UTC(2026, 1, 29)` 会静默滚成 3 月 1 日，
 *      不回读的话 `2026-02-29` 会被当成合法输入、筛出 3 月 1 日的单。
 */
export function parseJstDate(ymd: string): Date | null {
  const m = YMD.exec(ymd);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return null;
  const utc = new Date(Date.UTC(y, mo - 1, d));
  // 0–99 年会被 Date.UTC 当成 1900+ 年；setUTCFullYear 把年份钉回原值
  utc.setUTCFullYear(y);
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    return null;
  }
  return new Date(utc.getTime() - JST_OFFSET_MIN * 60_000);
}

export type JstDateRangeResult =
  | { ok: true; from: Date | null; to: Date | null }
  | { ok: false; reason: 'created_from_invalid' | 'created_to_invalid' | 'created_range_invalid' };

/**
 * 两端都含的 JST 日期区间 → 左闭右开的 UTC 区间（`to` 已换成"终点次日 00:00 JST"）。
 * `undefined` = 没给（该端不限）；空串 = 给了但无效。
 */
export function parseJstDateRange(
  from: string | undefined,
  to: string | undefined,
): JstDateRangeResult {
  const f = from === undefined ? null : parseJstDate(from);
  if (from !== undefined && f === null) return { ok: false, reason: 'created_from_invalid' };
  const t = to === undefined ? null : parseJstDate(to);
  if (to !== undefined && t === null) return { ok: false, reason: 'created_to_invalid' };
  if (f !== null && t !== null && f.getTime() > t.getTime()) {
    return { ok: false, reason: 'created_range_invalid' };
  }
  return { ok: true, from: f, to: t === null ? null : new Date(t.getTime() + 86_400_000) };
}
