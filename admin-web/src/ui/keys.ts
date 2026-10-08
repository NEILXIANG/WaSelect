/**
 * 职责：抽屉表单里的**回车键约定**（AJ-410 / N19、N21）——回车 = 点这张表单的主按钮（只会打开确认，不会直接执行）。
 *
 * @why 新手运营填完最后一格习惯按回车，原先什么也不发生，以为"没提交上"。主按钮在本仓库的写操作里
 *      一律只负责"打开确认"（发货 / 退款 / 改址 / 解除拒付 / 订单修正 / 批量发货），所以回车最多把确认框打开，
 *      真正不可逆的那一下仍要鼠标点（确认框里回车不放行，见 ./confirm.tsx）。
 * @why 用 `data-primary-action` 标出主按钮、由本函数去点它，而不是依赖浏览器的"隐式提交"：
 *      隐式提交要求有 submit 按钮，且单输入框表单与多输入框表单行为不同；jsdom 也不实现它——
 *      显式写出来，行为在每张表单上一致，且组件测试测得到。
 * @limitation 只认文本类 `<input>`：多行文本框里回车是换行（备注、CSV 粘贴框），下拉框里回车是展开选项。
 * @limitation 输入法合成中的回车是在选字（`isComposing`），不当提交。确认弹层里的输入框不归这里管。
 */
import type { KeyboardEvent } from 'react';

const NON_TEXT = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset']);

/** 挂在表单容器的 `onKeyDown` 上：在文本框里按回车 → 点容器内的 `[data-primary-action]` 按钮（禁用时不点）。 */
export function enterClicksPrimary(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement) || NON_TEXT.has(t.type)) return;
  if (t.closest('.dialog') !== null) return;
  const btn = e.currentTarget.querySelector<HTMLButtonElement>('button[data-primary-action]');
  if (btn === null || btn.disabled) return;
  e.preventDefault();
  btn.click();
}

/** 挂在"不可逆的确认按钮"上：回车不触发它（只能鼠标点 / 空格）。 */
export function blockEnter(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === 'Enter') e.preventDefault();
}
