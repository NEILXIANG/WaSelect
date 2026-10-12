/**
 * 职责：异常态"失败"符号的形状（AJ-432，用户 2026-10-10 授权代决）。
 *
 * @why 原先是缺一角的圆（border 一边透明 + 旋转）——那正是最常见的"加载转圈"形状（微信原生 loading 也是），
 *      静止时也会被读成"还在加载"，用户就一直等。改为闭合的圆 + 中间一道短横（"停住了"），仍不用感叹号。
 * @limitation 只读样式文字，不验渲染；渲染效果以模拟器截图为准（AJ-432 下游）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wxss = readFileSync(resolve(import.meta.dirname, 'index.wxss'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string): string => {
  const i = wxss.indexOf(`${selector} {`);
  return i < 0 ? '' : wxss.slice(i, wxss.indexOf('}', i) + 1);
};

describe('ws-state-block：失败符号', () => {
  it('🔴 是闭合的圆（没有透明的一边、不旋转），中间有一道横', () => {
    const fail = rule('.ws-state__glyph--fail');
    expect(fail).toContain('border-radius: 50%');
    expect(fail).not.toMatch(/border-\w+-color:\s*transparent/);
    expect(fail).not.toContain('rotate(');
    expect(rule('.ws-state__glyph--fail::after')).toContain('content:');
  });
});

// 全入口点击测试 2026-10-11：空购物车的「去逛逛」是白底次要按钮、整块贴在页顶——空状态时它就是唯一该做的事
describe('空状态的行动按钮与位置', () => {
  const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  it('🔴 行动按钮在 empty 时是主按钮（实心），其它状态（重试等）保持次要', () => {
    const btn = /<ws-button\b[^>]*class="ws-state__action"[^>]*>/.exec(wxml)?.[0] ?? '';
    expect(btn).toContain("type=\"{{kind === 'empty' ? 'primary' : 'default'}}\"");
  });
  it('🔴 整页（非 compact）空状态上方留出更多空间，不贴页顶', () => {
    const css = readFileSync(new URL('./index.wxss', import.meta.url), 'utf8');
    const block = /\.ws-state\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/padding-top:\s*calc\(var\(--ws-space-section\)\s*\*\s*2/);
  });
});
