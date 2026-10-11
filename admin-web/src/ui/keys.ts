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

/** 弹层里可被 Tab 走到的元素（禁用的与 tabindex=-1 的不算）。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 把 Tab / Shift+Tab 关在弹层里（代理 S9，第二轮审计 2026-10-11）：挂在弹层面板的 `onKeyDown` 上。
 * @why 弹层（确认框、抽屉）是模态的，背后的页面按钮仍在 Tab 顺序里。键盘用户在"全额退款"确认框里按几下 Tab
 *      就到了背后的按钮，再按回车 / 空格是背后页面的动作——确认框挡住的东西从键盘侧漏了出去。
 *      到最后一个再按 Tab 回到第一个，Shift+Tab 反过来；焦点不在面板里时按 Tab 也拉回面板。
 * @why `stopPropagation`：抽屉里套着确认框时，Tab 只归最里层（与 ESC 归里层同一口径），外层抽屉不再改焦点。
 * @limitation 只管键盘 Tab；鼠标点背后的遮罩由各弹层自己的关闭规则处理。动态出现 / 消失的元素按按键当下的 DOM 算。
 */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  e.stopPropagation();
  const box = e.currentTarget;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  const inside = active instanceof Node && box.contains(active) && active !== box;
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}
