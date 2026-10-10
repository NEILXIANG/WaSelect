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
