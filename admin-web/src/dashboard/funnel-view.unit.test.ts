/** 职责：转化漏斗的展示口径（第 25 项，AJ-438）。 */
import { describe, expect, it } from 'vitest';
import { funnelRows, FUNNEL_LABELS } from './funnel-view.js';

const steps = (n: number[]) =>
  ['visit', 'view_item', 'intent', 'checkout', 'pay_start', 'paid'].map((key, i) => ({
    key,
    visitors: n[i],
  }));

describe('funnelRows', () => {
  it('🔴 六行：中文标签、人数、条长（相对第 1 步）、"比上一步 xx%"（第 1 步不给比例）', () => {
    const rows = funnelRows(steps([200, 120, 60, 45, 30, 24]));
    expect(rows.map((r) => r.label)).toEqual([
      FUNNEL_LABELS.visit,
      FUNNEL_LABELS.view_item,
      FUNNEL_LABELS.intent,
      FUNNEL_LABELS.checkout,
      FUNNEL_LABELS.pay_start,
      FUNNEL_LABELS.paid,
    ]);
    expect(rows.map((r) => r.visitors)).toEqual([200, 120, 60, 45, 30, 24]);
    expect(rows.map((r) => r.widthPct)).toEqual([100, 60, 30, 23, 15, 12]);
    expect(rows.map((r) => r.rateText)).toEqual([
      '',
      '比上一步 60%',
      '比上一步 50%',
      '比上一步 75%',
      '比上一步 67%',
      '比上一步 80%',
    ]);
    expect(FUNNEL_LABELS.intent).toBe('有购买意向（加购或立即购买）');
  });

  it('上一步是 0 → 比例写"—"（不编 0% 也不出 NaN）；全 0 → 条长全 0', () => {
    const rows = funnelRows(steps([0, 0, 0, 0, 0, 0]));
    expect(rows.map((r) => r.widthPct)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rows[1]?.rateText).toBe('比上一步 —');
  });

  it('有人数但很小：条长至少 1%（有人就不该看起来是空的）', () => {
    expect(funnelRows(steps([1000, 3, 0, 0, 0, 0]))[1]?.widthPct).toBe(1);
  });

  it('脏响应：缺步 / 顺序乱 / 非整数 → 按固定六步顺序、缺的当 0、不认的键丢掉', () => {
    const rows = funnelRows([
      { key: 'paid', visitors: 2 },
      { key: 'visit', visitors: 10 },
      { key: 'weird', visitors: 99 },
      { key: 'view_item', visitors: 'x' },
    ]);
    expect(rows.map((r) => [r.key, r.visitors])).toEqual([
      ['visit', 10],
      ['view_item', 0],
      ['intent', 0],
      ['checkout', 0],
      ['pay_start', 0],
      ['paid', 2],
    ]);
    expect(funnelRows(null)).toHaveLength(6);
  });
});
