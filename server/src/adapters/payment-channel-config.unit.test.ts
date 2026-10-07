/**
 * `payment_channels` 读取口的**形状校验**（纯函数，不碰库——配置表被 resetTestDb 排除，写会污染别的文件）。
 *
 * @why 工程缺口第二轮复核 F2：原先只查"是数组、元素是字符串"，而 `[]` 与 `["us"]` 都能过——
 *      `matchesScope` 按大写码精确比对、空数组匹配不到任何市场，表现就是"通道在所有市场都不出现"，
 *      和 stringArray 自己注释里说要防的那一类失效一模一样。
 */
import { describe, expect, it } from 'vitest';
import { scopeArray } from './payment-channel-config.js';

describe('scopeArray（countries / currencies 列）', () => {
  it('合法：通配 * / 两位国家码 / 三位币种码', () => {
    expect(scopeArray(['*'], 'mock', 'countries')).toEqual(['*']);
    expect(scopeArray(['US', 'JP'], 'stripe', 'countries')).toEqual(['US', 'JP']);
    expect(scopeArray(['JPY', 'USD'], 'stripe', 'currencies')).toEqual(['JPY', 'USD']);
  });
  it('空数组 → 抛（等于"在所有市场都不出现"）', () => {
    expect(() => scopeArray([], 'mock', 'countries')).toThrow(/mock.*countries.*空/);
  });
  it('小写 / 长度不对 → 抛，消息里带出坏值', () => {
    expect(() => scopeArray(['us'], 'stripe', 'countries')).toThrow(/us/);
    expect(() => scopeArray(['USDX'], 'stripe', 'currencies')).toThrow(/USDX/);
    expect(() => scopeArray(['JP'], 'stripe', 'currencies')).toThrow(/JP/);
  });
  it('不是数组 / 含非字符串 → 抛（原有口径）', () => {
    expect(() => scopeArray('US', 'stripe', 'countries')).toThrow(/不是数组/);
    expect(() => scopeArray([1], 'stripe', 'countries')).toThrow(/非字符串/);
  });
});
