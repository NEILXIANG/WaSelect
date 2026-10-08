// @vitest-environment jsdom
/**
 * 职责：抽屉表单回车约定（./keys.ts，AJ-410 / N19、N21）的边界：哪些回车会去点主按钮、哪些不会。
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../testing/dom.js';
import { pressEnter } from '../testing/keys.js';
import { blockEnter, enterClicksPrimary } from './keys.js';

let mounted: Mounted | undefined;
let clicks: number;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(disabled = false): Promise<HTMLElement> {
  clicks = 0;
  mounted = await mount(
    h(
      'div',
      { onKeyDown: enterClicksPrimary },
      h('input', { name: 'text' }),
      h('input', { name: 'box', type: 'checkbox' }),
      h('textarea', { name: 'area' }),
      h('div', { className: 'dialog' }, h('input', { name: 'in-dialog' })),
      h(
        'button',
        { type: 'button', 'data-primary-action': true, disabled, onClick: () => (clicks += 1) },
        '主按钮',
      ),
      h('button', { type: 'button', onKeyDown: blockEnter }, '确认'),
    ),
  );
  return mounted.el;
}

describe('enterClicksPrimary / blockEnter', () => {
  it('文本框里回车 → 点主按钮一次，并阻止默认动作', async () => {
    const el = await open();
    expect(await pressEnter(el.querySelector('input[name="text"]'))).toBe(true);
    expect(clicks).toBe(1);
  });

  it('复选框 / 多行文本框 / 确认弹层里的输入框按回车 → 不点主按钮', async () => {
    const el = await open();
    await pressEnter(el.querySelector('input[name="box"]'));
    await pressEnter(el.querySelector('textarea'));
    await pressEnter(el.querySelector('input[name="in-dialog"]'));
    expect(clicks).toBe(0);
  });

  it('主按钮禁用时回车不点它', async () => {
    const el = await open(true);
    await pressEnter(el.querySelector('input[name="text"]'));
    expect(clicks).toBe(0);
  });

  it('blockEnter：不可逆确认按钮上的回车被拦下（只能鼠标点）', async () => {
    const el = await open();
    const confirm = [...el.querySelectorAll('button')].find((b) => b.textContent === '确认');
    expect(await pressEnter(confirm)).toBe(true);
    expect(clicks).toBe(0);
  });
});
