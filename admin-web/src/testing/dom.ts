/**
 * 职责：管理端**组件**的最小测试宿主——在 jsdom 里把一个 React 组件真的挂起来、点它、填它、读它（AJ-229）。
 *
 * @why 管理端的页面逻辑（提交前的确认流程、提交失败后的处理、加载失败时哪些按钮可用）都写在 `.tsx` 里，
 *      而此前这一层**没有任何测试环境**：`view.ts` 的纯函数测得再全，组件不调它、调的时机不对、
 *      调了之后状态没复位，一条用例都不会红。09-29 全量审查与 09-30 复核里管理端的缺陷几乎全在这一层
 *      （汇率确认可被绕过、退款失败后页面不刷新、运费表加载失败时仍可整表替换）。
 *
 * @why 不引 @testing-library：它要的只是 `createRoot` + `act` + 原生事件，三十行就够；
 *      多一个依赖就多一份要跟版本的东西（本仓对新增第三方依赖的默认答案是不加）。
 *      用法：测试文件首行写 `// @vitest-environment jsdom`，用 `createElement` 建组件
 *      （测试文件是 `.unit.test.ts`，不写 JSX——vitest 的 unit 层只收这个后缀）。
 *
 * @limitation 一：jsdom 不做布局与样式计算；"看不看得见"只能靠"在不在 DOM 里"判断。
 * @limitation 二：`type()` 走的是 React 认的"原生 value setter + input 事件"这一条路；
 *              组件若监听 keydown / compositionend 之类，这里模拟不到。
 * @limitation 三：不拦网络——组件的 `api` 由用例注入假的；真发请求会被全局的外网闸门拦下。
 *
 * @why 默认包一层 `StrictMode`，与 `main.tsx` 生产装配一致（测试缺口复盘 2026-10-12）：
 *      StrictMode 会把每个 effect "挂载 → 卸载 → 再挂载"跑一遍；打印拣货单页的缺陷（卸载时把 live 置 false、
 *      再挂载时没置回 true，取数结果被吞，页面永远"加载中"）只在这种双跑下出现——测试不开它，就永远测不到。
 *      代价：用例里注入的 `api` 假实现在挂载时会被调用两次，按"调用次数"断言的用例要按生产口径计。
 *
 * @see docs/自主决策记录.md AJ-229；docs/全量逐行代码审查报告-2026-09-29.md 第七节机制 4
 */
import { act, createElement, StrictMode, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface Mounted {
  /** 组件挂载的容器；用 `el.querySelector` / `textContent` 读。 */
  el: HTMLElement;
  unmount(): Promise<void>;
}

/** 让 React 知道当前在测试里（否则 `act` 会告警且不冲刷更新）。 */
function enableAct(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/** 挂载组件，并等它的首轮 effect（含里面发起的异步加载）跑完。 */
export async function mount(element: ReactElement): Promise<Mounted> {
  enableAct();
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root: Root = createRoot(el);
  await act(async () => {
    root.render(createElement(StrictMode, null, element));
  });
  await flush();
  return {
    el,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      el.remove();
    },
  };
}

/** 把已经兑现的 promise 链与随之而来的状态更新冲刷干净。 */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** 点击，并等它引发的更新落地。 */
export async function click(target: Element | null | undefined): Promise<void> {
  if (target === null || target === undefined) throw new Error('click：目标元素不存在');
  await act(async () => {
    (target as HTMLElement).click();
  });
  await flush();
}

/**
 * 往受控输入框里"打字"（整体替换为 `value`）。
 * @why 直接 `input.value = x` 再派发事件对 React 无效：React 给 value 装了自己的 setter 来追踪变更，
 *      必须调**原型上的原生 setter** 才会被认成一次真实输入。
 */
export async function type(target: Element | null | undefined, value: string): Promise<void> {
  if (target === null || target === undefined) throw new Error('type：目标元素不存在');
  const proto =
    target instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter === undefined) throw new Error('type：取不到原生 value setter');
  await act(async () => {
    setter.call(target, value);
    const name = target instanceof HTMLSelectElement ? 'change' : 'input';
    target.dispatchEvent(new Event(name, { bubbles: true }));
  });
  await flush();
}

/** 按可见文字找按钮（完全相等；找不到返回 null，由调用方断言）。 */
export function button(root: Element, text: string): HTMLButtonElement | null {
  for (const b of root.querySelectorAll('button')) {
    if ((b.textContent ?? '').trim() === text) return b;
  }
  return null;
}
