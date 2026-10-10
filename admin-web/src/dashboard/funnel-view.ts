/**
 * 职责：工作台转化漏斗的**展示口径**（第 25 项，AJ-438）——六步的中文标签、条长、"比上一步 xx%"。纯函数。
 *
 * @why 标签在前端而不是服务端下发：服务端只承诺键与人数（契约 AdminFunnel），措辞属于界面，改字不该动接口。
 * @why 比例写"比上一步"而不是"占第一步"：运营要找的是**卡在哪一步**（哪两步之间掉得最多），逐步比例直接回答这个问题；
 *      条长另按第 1 步画，看整体缩水。两种信息各有一处，不在同一个数上混。
 * @why 上一步是 0 → "—"：0 / 0 不是 0%，也不该出 NaN；有人数但很小 → 条长至少 1%（有人就不该看起来是空的）。
 * @limitation 响应形状不对（缺步、乱序、非整数）时按固定六步顺序补 0、丢掉不认的键——宁可显示 0，不让整块崩掉；
 *             形状本身的校验在 api.ts（不是数组就抛）。
 * @see ../../../server/src/adapters/funnel.ts（口径）；./FunnelCard.tsx
 */

export const FUNNEL_KEYS = [
  'visit',
  'view_item',
  'intent',
  'checkout',
  'pay_start',
  'paid',
] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];

/** 六步的中文名（新手能看懂的说法）。 */
export const FUNNEL_LABELS: Readonly<Record<FunnelKey, string>> = {
  visit: '进店（看过任意页面）',
  view_item: '看过商品详情',
  intent: '有购买意向（加购或立即购买）',
  checkout: '进入结算页',
  pay_start: '点了付款',
  paid: '付款成功',
};

export interface FunnelRow {
  key: FunnelKey;
  label: string;
  visitors: number;
  /** 条长（相对第 1 步的百分比，0–100 整数）。 */
  widthPct: number;
  /** "比上一步 60%"；第 1 步为空串。 */
  rateText: string;
}

export function funnelRows(steps: unknown): FunnelRow[] {
  const byKey = new Map<string, number>();
  for (const s of Array.isArray(steps) ? steps : []) {
    const o = s as { key?: unknown; visitors?: unknown } | null;
    if (typeof o?.key === 'string' && Number.isInteger(o.visitors))
      byKey.set(o.key, o.visitors as number);
  }
  const counts = FUNNEL_KEYS.map((k) => Math.max(0, byKey.get(k) ?? 0));
  const first = counts[0] ?? 0;
  return FUNNEL_KEYS.map((key, i) => {
    const n = counts[i] ?? 0;
    const prev = i === 0 ? null : (counts[i - 1] ?? 0);
    const width = first === 0 ? 0 : Math.round((n / first) * 100);
    return {
      key,
      label: FUNNEL_LABELS[key],
      visitors: n,
      widthPct: n > 0 ? Math.max(1, width) : 0,
      rateText:
        prev === null
          ? ''
          : prev === 0
            ? '比上一步 —'
            : `比上一步 ${String(Math.round((n / prev) * 100))}%`,
    };
  });
}
