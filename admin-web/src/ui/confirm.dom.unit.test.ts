// @vitest-environment jsdom
/**
 * 职责：统一确认弹层的**组件行为**用例（第一批①）。
 *
 * @why 必须走组件用例：弹层要守的是"**没有确认就绝对不会发生**"这类不变量，
 *      它住在 `.tsx` 的状态与事件里——纯函数测不到"点遮罩会不会顺手提交"、
 *      "提交中按 ESC 会不会让动作在飞而界面说没发生"。
 *      历史教训：管理端此前"汇率确认可被绕过"就是这一层的缺陷（09-29 全量审查）。
 *
 * @see ./confirm.tsx（@limitation 一/二/三）；../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1①
 */
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { ConfirmDialog, typedOk, type ConfirmSpec } from './confirm.js';

let mounted: Mounted | undefined;
let confirmed: number;
let cancelled: number;
/** 宿主把 busy 的控制权交出来（用例要在"提交中"这个状态下断言关闭出口）。 */
let setBusy: ((b: boolean) => void) | undefined;

const SPEC: ConfirmSpec = {
  title: '全额退款：原币退，不可撤销',
  body: '退款原因会进审计台账。',
  confirmText: '确认退款',
  danger: true,
};

function Host({ spec }: { spec: ConfirmSpec }): React.JSX.Element {
  const [busy, setB] = useState(false);
  setBusy = setB;
  return createElement(ConfirmDialog, {
    spec,
    busy,
    onConfirm: () => {
      confirmed += 1;
    },
    onCancel: () => {
      cancelled += 1;
    },
  });
}

async function open(spec: ConfirmSpec = SPEC): Promise<HTMLElement> {
  confirmed = 0;
  cancelled = 0;
  setBusy = undefined;
  mounted = await mount(createElement(Host, { spec }));
  return mounted.el;
}

const dialogText = (el: HTMLElement): string => el.querySelector('.dialog')?.textContent ?? '';

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('ConfirmDialog：没有确认就绝对不会发生', () => {
  it('刚打开 → 没执行、没取消', async () => {
    const el = await open();
    expect(confirmed).toBe(0);
    expect(cancelled).toBe(0);
    // 后果写在弹层里，且是**点之前**就看得见
    expect(dialogText(el)).toContain('不可撤销');
    expect(dialogText(el)).toContain('审计台账');
  });

  it('点「确认」→ 执行一次', async () => {
    const el = await open();
    await click(button(el, '确认退款'));
    expect(confirmed).toBe(1);
    expect(cancelled).toBe(0);
  });

  it('🔴 主按钮一次性：连点两次只执行一次（退款点两下 = 同一笔钱退两次）', async () => {
    const el = await open();
    await click(button(el, '确认退款'));
    await click(button(el, '确认退款'));
    await click(button(el, '确认退款'));
    expect(confirmed).toBe(1);
    // 缺陷注入点：去掉 `sent` 这把锁，这里会变成 3
  });
});

describe('ConfirmDialog：三个关闭出口', () => {
  it('点「取消」→ 不执行', async () => {
    const el = await open();
    await click(button(el, '取消'));
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it('按 ESC → 不执行（手滑点开危险操作时的第一反应）', async () => {
    const el = await open();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
    expect(el).toBeDefined();
  });

  it('点遮罩 → 不执行', async () => {
    const el = await open();
    await click(el.querySelector('.modal-backdrop'));
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
  });

  it('🔴 提交中：ESC / 遮罩 / 取消**全部失效**（动作在飞而界面说没发生 = 运营再点一次）', async () => {
    const el = await open();
    await click(button(el, '确认退款'));
    expect(confirmed).toBe(1);
    await act(async () => {
      setBusy?.(true);
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await click(el.querySelector('.modal-backdrop'));
    await click(button(el, '取消'));
    // ❗ 三个出口都不能走通：cancelled 仍为 0
    expect(cancelled, '提交中被关闭了 → 运营会以为没提交而再点一次').toBe(0);
    // 按钮本身也要禁用（jsdom 里 click() 对 disabled 按钮不触发 onClick，这里显式断言形状）
    expect(button(el, '取消')?.disabled).toBe(true);
  });
});

describe('ConfirmDialog：要求逐字输入（typeToConfirm）', () => {
  const TYPED: ConfirmSpec = {
    ...SPEC,
    title: '发货后不能再改址',
    confirmText: '确认发货',
    typeToConfirm: 'EJ123456789JP',
    typeLabel: '请再输入一次运单号',
  };

  it('🔴 没输入 → 主按钮禁用（运单号是从邮件里复制来的，看一遍看不出首尾错字）', async () => {
    const el = await open(TYPED);
    expect(button(el, '确认发货')?.disabled).toBe(true);
    await click(button(el, '确认发货'));
    expect(confirmed).toBe(0);
    // 缺陷注入点：把主按钮的 disabled 去掉，这条必须红
  });

  it('输入不一致（差一个字符）→ 仍禁用，且给出提示', async () => {
    const el = await open(TYPED);
    await type(el.querySelector('.dialog input'), 'EJ123456789J');
    expect(button(el, '确认发货')?.disabled).toBe(true);
    expect(dialogText(el)).toContain('与上面不一致');
    await click(button(el, '确认发货'));
    expect(confirmed).toBe(0);
  });

  it('逐字一致 → 放行', async () => {
    const el = await open(TYPED);
    await type(el.querySelector('.dialog input'), 'EJ123456789JP');
    expect(button(el, '确认发货')?.disabled).toBe(false);
    await click(button(el, '确认发货'));
    expect(confirmed).toBe(1);
  });

  it('🔴 typeToConfirm 是空串 → 按"不要求输入"处理（要求输入空串等于人人都能过）', async () => {
    const el = await open({ ...SPEC, typeToConfirm: '' });
    expect(el.querySelector('.dialog input')).toBeNull();
    expect(button(el, '确认退款')?.disabled).toBe(false);
    // 缺陷注入点：把 `want.trim() === ''` 这个早退去掉，这里会渲染出一个输入框且按钮禁用
  });

  it('typedOk：空白串按不要求处理；比对前两端 trim', () => {
    expect(typedOk(SPEC, '')).toBe(true);
    expect(typedOk({ ...SPEC, typeToConfirm: '  ' }, '')).toBe(true);
    expect(typedOk({ ...SPEC, typeToConfirm: 'AB-1' }, ' AB-1 ')).toBe(true);
    expect(typedOk({ ...SPEC, typeToConfirm: 'AB-1' }, 'AB-2')).toBe(false);
  });

  /**
   * 🔴 typedOk 空串早退的**直接**红灯证据。
   * @why 组件里这条分支走不到（`needsType` 先滤掉了空串），所以只能这样测；
   *      没有这一条，"删掉早退"不会让任何用例变红——那就是一段没人守的死代码。
   */
  it('typedOk：空串 = 不要求输入（给了非空输入也算达标）', () => {
    expect(typedOk({ ...SPEC, typeToConfirm: '' }, '随便打点什么')).toBe(true);
    expect(typedOk({ ...SPEC, typeToConfirm: '   ' }, '随便打点什么')).toBe(true);
  });
});

describe('ConfirmDialog：危险度是业务判断，不是排版偏好', () => {
  it('danger → 主按钮是错误色；不给 danger → 普通按钮', async () => {
    const el = await open({ ...SPEC, danger: true });
    expect(el.querySelector('.dialog .btn-danger')).not.toBeNull();

    await mounted?.unmount();
    mounted = await mount(createElement(Host, { spec: { ...SPEC, danger: false } }));
    expect(mounted.el.querySelector('.dialog .btn-danger')).toBeNull();
  });

  it('danger 标题也标红（颜色是第二信号，标题本身已说清后果）', async () => {
    const el = await open({ ...SPEC, danger: true });
    expect(el.querySelector('.dialog-title')?.className ?? '').toContain('error');
  });
});
