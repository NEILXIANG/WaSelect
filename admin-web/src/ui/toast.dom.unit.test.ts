// @vitest-environment jsdom
/**
 * 职责：统一 Toast 的**组件行为**用例（第一批①）。
 *
 * @why 必须走组件用例：`useToasts` 的堆叠规则与"自动消失"是**跨渲染的时序行为**，
 *      纯函数测不出来——尤其两条最容易 silently 失效的：
 *      ① 父组件一重渲染就让定时器重置（提示永远不消失，退化成行内残留，正是本组件要消灭的毛病）；
 *      ② 错误提示自动消失（运营来不及读"下一步怎么办"、来不及复制报障码）。
 *
 * @why 用假定时器：真等 3 秒的用例既慢又不稳；而"到点消失"这件事必须被断言，
 *      不能因为"看不见"就跳过——跳过它等于宣布"成功提示可以一直留着"。
 *
 * @see ./toast.tsx（@limitation 二 堆叠规则）；../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1①
 */
import { TRACE_HINT } from './trace.js';
import { act, createElement, Fragment, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type Mounted } from '../testing/dom.js';
import {
  TOAST_AUTO_DISMISS_MS,
  ToastStack,
  toastError,
  useToasts,
  type ToastSink,
} from './toast.js';

let mounted: Mounted | undefined;
/** 宿主的 sink（用例借它直接 push，模拟页面里各处的调用点）。 */
let sink: ToastSink | undefined;

/**
 * 测试宿主：三个触发按钮 + 一个"重渲染"按钮。
 * @why 必须有"重渲染"这个按钮：父组件重渲染是常态（列表自己在轮询、别的 state 变了），
 *      而"重渲染导致提示永不消失"是本组件最容易退化回去的那条路。
 */
function Host(): React.JSX.Element {
  const s = useToasts();
  sink = s;
  const [, setTick] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement('button', { onClick: () => s.success('保存成功') }, 'ok'),
    createElement('button', { onClick: () => s.info('订单保持在退款中') }, 'info'),
    createElement(
      'button',
      { onClick: () => s.info('处理中，勿重复提交', { sticky: true }) },
      'sticky',
    ),
    createElement(
      'button',
      { onClick: () => s.error('服务器内部错误', { traceId: 'tr-42' }) },
      'bad',
    ),
    createElement('button', { onClick: () => setTick((t) => t + 1) }, 'rerender'),
    /*
      ⚠️ `onDismiss` 刻意写成**内联箭头函数**——调用方在页面里几乎必然这么写。
      @why 这不是随手写的：缺陷注入时发现，若这里传 `s.dismiss`（一个稳定的 useCallback），
           "把 onDismiss 写进 useEffect 依赖数组"这个注入**一条用例都不会红**——
           稳定引用不会触发 effect 重跑，于是那条防御看起来有测试、实际没人守。
           真实调用方给的是每次渲染都新建的函数，测试就必须还原这一点。
    */
    createElement(ToastStack, { toasts: s.toasts, onDismiss: (id) => s.dismiss(id) }),
  );
}

async function open(): Promise<HTMLElement> {
  mounted = await mount(createElement(Host));
  return mounted.el;
}

/** 推进假定时器（要包在 act 里，否则 React 不冲刷随之而来的状态更新）。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const toasts = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.toast')].map((t) => t.textContent ?? '');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  sink = undefined;
  vi.useRealTimers();
});

describe('Toast：消失时机（三类不是三种颜色，是三种处置）', () => {
  it('成功 → 到点自动消失', async () => {
    const el = await open();
    await click(button(el, 'ok'));
    expect(toasts(el)).toHaveLength(1);

    await advance(TOAST_AUTO_DISMISS_MS - 1);
    expect(toasts(el), '差一毫秒就不该消失（否则"3 秒"是个近似值）').toHaveLength(1);

    await advance(1);
    expect(toasts(el)).toHaveLength(0);
  });

  it('🔴 错误**不**自动消失（要读完、要复制报障码）', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    await advance(TOAST_AUTO_DISMISS_MS * 10);
    expect(toasts(el)).toHaveLength(1);
    // 缺陷注入点：把 `kind === 'error'` 那个早退删掉，这条必须红
  });

  it('信息默认会消失；声明 sticky 的**必须**停留（退款 pending 那一档写着"下一步怎么办"）', async () => {
    const el = await open();
    await click(button(el, 'info'));
    await advance(TOAST_AUTO_DISMISS_MS);
    expect(toasts(el)).toHaveLength(0);

    await click(button(el, 'sticky'));
    await advance(TOAST_AUTO_DISMISS_MS * 10);
    expect(toasts(el)).toHaveLength(1);
  });

  it('🔴 父组件在等待期间重渲染 → 提示**照样**到点消失（定时器不被重置）', async () => {
    const el = await open();
    await click(button(el, 'ok'));
    await advance(1000);
    await click(button(el, 'rerender')); // 父组件重渲染
    await advance(1000);
    await click(button(el, 'rerender'));
    await advance(TOAST_AUTO_DISMISS_MS - 2000 + 1);
    // ❗ 若把 onDismiss 写进 useEffect 依赖数组，这里会是 1——提示永远不消失
    expect(toasts(el), '重渲染重置了定时器 → 成功提示永远不消失').toHaveLength(0);
  });
});

describe('Toast：报障码与手动关闭', () => {
  it('错误带上 traceId（报障时能按它检索日志，N8）', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    expect(el.querySelector('.toast-error')?.textContent ?? '').toContain('tr-42');
    // AJ-410 / N5：报障码单独一行、说清用途（原为 `.toast-trace` 里的「报障码 …」）
    expect(el.querySelector('.trace-line .selectable')?.textContent ?? '').toBe('tr-42');
    expect(el.querySelector('.trace-line')?.textContent ?? '').toContain(TRACE_HINT);
  });

  it('没有提示时不渲染浮层（空浮层会挡住页面右下角的按钮）', async () => {
    const el = await open();
    expect(el.querySelector('.toast-stack')).toBeNull();
    await click(button(el, 'ok'));
    expect(el.querySelector('.toast-stack')).not.toBeNull();
  });

  it('每条都能手动关闭', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    await click(el.querySelector('.toast-close'));
    expect(toasts(el)).toHaveLength(0);
  });
});

describe('Toast：堆叠规则（@see toast.tsx @limitation 二）', () => {
  it('同一 kind 只留最新一条（上一次失败的红字不该一直挂着）', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    await act(async () => {
      sink?.error('第二次失败', { traceId: 'tr-43' });
    });
    expect(toasts(el)).toHaveLength(1);
    expect(toasts(el)[0]).toContain('第二次失败');
  });

  it('🔴 错误与信息**跨 kind 并存**（B41：退款失败时这两条是同一件事的两半）', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    await click(button(el, 'sticky'));
    expect(toasts(el)).toHaveLength(2);
    // 缺陷注入点：把堆叠规则写成"任何提示都清屏"，这条必须红
  });

  it('🔴 成功会清掉此前的错误（"已拉黑"和"请求超时"同屏会让人以为没成功）', async () => {
    const el = await open();
    await click(button(el, 'bad'));
    await click(button(el, 'ok'));
    expect(toasts(el)).toHaveLength(1);
    expect(toasts(el)[0]).toContain('保存成功');
  });
});

describe('toastError：把抛出的东西转成错误态', () => {
  it('ApiError → 带出 message 与 traceId', () => {
    expect(toastError(new ApiError(50000, '服务器内部错误', 'tr-9'))).toEqual({
      text: '服务器内部错误',
      traceId: 'tr-9',
    });
  });

  it('空 message / 非 Error → 退回兜底文案，traceId 为 undefined', () => {
    expect(toastError(new ApiError(50000, '', 'tr-9'), '取详情失败')).toEqual({
      text: '取详情失败',
      traceId: 'tr-9',
    });
    expect(toastError('boom').traceId).toBeUndefined();
    expect(toastError(new Error('')).text).toBe('操作失败');
  });
});
