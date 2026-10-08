/**
 * 职责：组件测试里"按回车"（AJ-410 / N19、N21）。
 * @why jsdom 不实现浏览器的回车默认动作（隐式提交 / 激活按钮），所以只能派发 keydown，
 *      再看业务代码有没有处理、有没有 `preventDefault`（返回值）。
 */
import { act } from 'react';
import { flush } from './dom.js';

/** 在目标上派发一次回车 keydown；返回是否被 `preventDefault`。 */
export async function pressEnter(target: Element | null | undefined): Promise<boolean> {
  if (target === null || target === undefined) throw new Error('pressEnter：目标元素不存在');
  let prevented = false;
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    prevented = ev.defaultPrevented;
  });
  await flush();
  return prevented;
}
