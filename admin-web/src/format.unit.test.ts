/**
 * 职责：`admin-web/src/format.ts` 的单测（从 `orders/view.unit.test.ts` 迁出）。
 *
 * @why 这几个函数的失效形态是**"看起来没错"**：金额少一个千分位分隔符、时间差九小时，
 *      都不会报错，只是运营看到的值和真实值不一样——而这两处是客服对客户、对账用的。
 */
import { describe, expect, it } from 'vitest';
import { formatJst, moneyText, toIsoJst } from './format.js';

describe('moneyText', () => {
  it('千分位 + 円（不用 toLocaleString：它跟随浏览器语言区）', () => {
    expect(moneyText(12800)).toBe('12,800 円');
    expect(moneyText(1234567)).toBe('1,234,567 円');
    expect(moneyText(0)).toBe('0 円');
  });

  it('⚠️ 非整数金额显示占位符而不是 "NaN 円"', () => {
    expect(moneyText(null)).toBe('—');
    expect(moneyText(12.5)).toBe('—');
    expect(moneyText('12800')).toBe('—');
  });
});

describe('formatJst', () => {
  it('时间恒显 JST（UTC 04:05 → 13:05），不跟随机器时区', () => {
    expect(formatJst('2026-09-27T04:05:06Z')).toBe('2026-09-27 13:05');
  });

  it('⚠️ 跨日要整体进一天（UTC 23:30 → 次日 08:30），不是只加小时不管日期', () => {
    expect(formatJst('2026-09-27T23:30:00Z')).toBe('2026-09-28 08:30');
  });

  it('带偏移的 ISO 也能正确换算（+09:00 不再加第二次）', () => {
    expect(formatJst('2026-09-27T09:00:00+09:00')).toBe('2026-09-27 09:00');
  });

  it('非法 / 空值显示占位符（表格里出现 "Invalid Date" 比空着更吓人）', () => {
    expect(formatJst('')).toBe('—');
    expect(formatJst('not-a-date')).toBe('—');
    expect(formatJst(undefined)).toBe('—');
  });
});

describe('toIsoJst', () => {
  it('⚠️ datetime-local 的值钉成 JST（直发会被服务端当 UTC，差九小时）', () => {
    expect(toIsoJst('2026-10-01T09:00')).toBe('2026-10-01T09:00:00+09:00');
  });

  it('形状不符 → 空串（调用方先拦，这里是第二道防御）', () => {
    expect(toIsoJst('2026/10/01')).toBe('');
    expect(toIsoJst('')).toBe('');
  });
});
