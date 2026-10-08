// @vitest-environment jsdom
/**
 * 职责：抽屉"提交中锁关闭"——表单内部的 busy 经 `useDrawerBusy` 上报后，ESC / 遮罩 / 「关闭」全部失效。
 *
 * @why 改址 / 部分退款 / 订单修正的提交中状态在组件内部，此前抽屉看不见：
 *      提交中关抽屉会卸载表单，请求照样完成，运营却看不到结果（AJ-398 @limitation 一）。
 * @see ./drawer.tsx
 */
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type Mounted } from '../testing/dom.js';
import { ActionDrawer, useDrawerBusy } from './drawer.js';

let mounted: Mounted | undefined;
let closed = 0;
let setBusy: (b: boolean) => void = () => undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** 模拟"组件内部自己管 busy"的表单（改址 / 部分退款 / 订单修正的形状）。 */
function InnerForm(): null {
  const [busy, sb] = useState(false);
  setBusy = sb;
  useDrawerBusy(busy);
  return null;
}

const pressEscape = async (): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
};

describe('ActionDrawer：表单上报提交中 → 关闭出口全部失效', () => {
  it('提交中 ESC / 遮罩 / 「关闭」都不关；提交结束后恢复', async () => {
    closed = 0;
    mounted = await mount(
      createElement(ActionDrawer, {
        title: '改址',
        onClose: () => {
          closed += 1;
        },
        children: createElement(InnerForm),
      }),
    );
    const el = mounted.el;

    await act(async () => setBusy(true));
    await pressEscape();
    await click(el.querySelector('.modal-backdrop'));
    await click(button(el, '关闭'));
    expect(closed, '提交中不应被关掉').toBe(0);

    await act(async () => setBusy(false));
    await pressEscape();
    expect(closed).toBe(1);
  });
});
