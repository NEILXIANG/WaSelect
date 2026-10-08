/**
 * 职责：管理端主题（AJ-411）的对比度门禁——每一组"前景 / 背景"都按 WCAG 2.x 算一遍。
 *
 * @why 改色最常见的事故不是"难看"，是"看不清"：把 primary 调浅一档，白字主按钮就掉到 4.5 以下，
 *      而这在设计稿里毫无征兆。管理端的使用者里有不熟悉电脑的运营（AJ-410），看不清 = 用不了。
 * @limitation 只验清单里登记过的组合（ADMIN_CONTRAST_PAIRS）；页面里新写了一种组合却没登记，这里管不到——
 *             那属于 review 项（新组合要在清单里加一行）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_COLORS,
  ADMIN_CONTRAST_PAIRS,
  ADMIN_LEGACY_ALIASES,
  WS_COLORS,
  contrastRatio,
  mixWithWhite,
} from './design-tokens.js';

describe('contrastRatio / mixWithWhite（WCAG 公式自检）', () => {
  it('黑白 21:1、同色 1:1、与顺序无关', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#3451c7', '#ffffff')).toBe(contrastRatio('#ffffff', '#3451c7'));
  });

  it('已知值：#767676 对白约 4.54（WCAG 常用的"刚过线灰"）', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('简写 / 带透明度 / 非色值直接抛错（不猜形状）', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow('#rrggbb');
    expect(() => contrastRatio('#00000080', '#000000')).toThrow('#rrggbb');
    expect(() => contrastRatio('red', '#000000')).toThrow('#rrggbb');
  });

  it('mixWithWhite：0% = 白，100% = 原色，50% 落在中间', () => {
    expect(mixWithWhite('#000000', 0)).toBe('#ffffff');
    expect(mixWithWhite('#3451c7', 100)).toBe('#3451c7');
    expect(mixWithWhite('#000000', 50)).toBe('#808080');
  });
});

describe('管理端主题色板（AJ-411）', () => {
  it('每个色值都是 #rrggbb（生成器与对比度计算都只认这一种形状）', () => {
    for (const [role, hex] of Object.entries(ADMIN_COLORS)) {
      expect(hex, role).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('旧名映射覆盖 WS_COLORS 的每一个键，且都指向存在的角色', () => {
    expect(Object.keys(ADMIN_LEGACY_ALIASES).sort()).toEqual(Object.keys(WS_COLORS).sort());
    for (const role of Object.values(ADMIN_LEGACY_ALIASES)) {
      expect(ADMIN_COLORS[role], role).toBeDefined();
    }
  });

  it('🔴 每一组登记的前景 / 背景都达到最低对比度（正文 4.5 / 界面元素 3）', () => {
    const failing = ADMIN_CONTRAST_PAIRS.flatMap((p) => {
      const bg =
        typeof p.bg === 'string'
          ? ADMIN_COLORS[p.bg]
          : mixWithWhite(ADMIN_COLORS[p.bg.tint], p.bg.percent);
      const ratio = contrastRatio(ADMIN_COLORS[p.fg], bg);
      return ratio >= p.min
        ? []
        : [`${p.use}：${p.fg} on ${JSON.stringify(p.bg)} = ${ratio.toFixed(2)} < ${p.min}`];
    });
    expect(failing, failing.join('\n')).toEqual([]);
  });

  it('清单非空且覆盖主按钮、正文、次要文字、导航选中、占位符（空清单 = 假绿灯）', () => {
    const uses = ADMIN_CONTRAST_PAIRS.map((p) => p.use).join('|');
    for (const k of ['主按钮文字', '正文', '次要文字', '导航选中', '占位符', '焦点环']) {
      expect(uses, k).toContain(k);
    }
  });
});
