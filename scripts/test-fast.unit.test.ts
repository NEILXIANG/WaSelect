/**
 * 职责：`scripts/test-fast.mjs` 的判定——哪些改动要跑全部 unit 用例。
 *
 * @why 4ef8991 只改了 app.css（写了 `3px`），`--changed` 按 import 关系找不到设计令牌用例，提交钩子全绿、main 上是红的
 *      （测试缺口复盘 2026-10-12）。这里钉住"改 css / wxss / wxml / md / json 就跑全部"。
 */
import { describe, expect, it } from 'vitest';
import { needsFullUnit } from './test-fast.mjs';

describe('needsFullUnit', () => {
  it.each([
    ['admin-web/src/app.css'],
    ['miniprogram/pages/cart/index.wxss'],
    ['miniprogram/pages/order-detail/index.wxml'],
    ['docs/测试缺口复盘-2026-10-12.md'],
    ['miniprogram/app.json'],
    ['contracts/api-contract.yaml'],
    ['migrations/040_x.sql'],
  ])('🔴 %s → 跑全部 unit（这类文件由单测按内容读取，不在 import 图里）', (f) => {
    expect(needsFullUnit(['server/src/x.ts', f])).toBe(true);
  });

  it('只改 ts / js / tsx → 只跑受影响的', () => {
    expect(
      needsFullUnit([
        'server/src/domain/address-input.ts',
        'miniprogram/utils/price-format.js',
        'admin-web/src/orders/OrdersPage.tsx',
      ]),
    ).toBe(false);
    expect(needsFullUnit([])).toBe(false);
  });
});
