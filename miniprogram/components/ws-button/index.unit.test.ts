/**
 * 职责：按钮组件的组件级测试（F14 第二个基础组件）——重点是"连点这道防线"。
 *
 * @why 这个组件存在的理由只有一条：**微信的 `loading` 只显示转圈，不阻止 `bindtap`**。
 *      于是"处理中还能再点一次"要每个页面各自记得挡（骨架页里就有一行手写守卫）。
 *      收进组件后这条规则只有一处——所以这里要钉的正是"loading 时点击真的被吞掉"，
 *      以及"loading 结束后又真的能点"（吞掉之后**没恢复**是同样致命的另一半）。
 *
 * @how tap 在 simulate 里不是 `dispatchEvent('tap')`——它是从 **touchstart + touchend**
 *      合成的（j-component 自己实现的 tap 判定），并且派发发生在**微任务**里，
 *      所以每次点击后必须 `await simulate.sleep(0)`，否则断言跑在事件之前。
 *      ⚠️ 这三条都是实测出来的，不是文档里写的（我第一次直接 dispatch 'tap'，什么也没发生）。
 *
 * @limitation 一：**`disabled` 的拦截测不了**——它依赖真机基础库的原生行为
 *              （原生 `disabled` 根本不触发 tap），simulate 不模拟它。
 *              所以这里只断言"disabled 真的传给了原生 button"，拦截本身留给 L4 样板页验收。
 * @limitation 二：`simulate.load` **只能调用一次**。@see ../ws-price/index.unit.test.ts @limitation 二
 * @limitation 三：类名在 simulate 里会被加 `main--` 前缀 → 断言用子串。
 *
 * @see ./index.js（守卫在 `onTap`）；../ws-price/index.unit.test.ts（同组组件测试）
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import simulate from 'miniprogram-simulate';

const root = resolve(import.meta.dirname, '../..');

/** jsdom 环境下的 document（根 tsconfig 的 lib 不含 DOM，这里只声明用到的那一点）。 */
declare const document: { body: unknown };

let loadedId = '';
function loadOnce(): string {
  if (loadedId === '') {
    loadedId = simulate.load(`${root}/components/ws-button/index`, { rootPath: root });
  }
  return loadedId;
}

/**
 * DOM 节点上我们真正用到的那一点。
 * @why 根 tsconfig 的 `lib` 不含 DOM，`Element` 这个类型**根本不存在**
 *      （`Event` / `CustomEvent` 有，是 @types/node 给的）。只声明用到的四个方法，
 *      不去给 tsconfig 加 `DOM`——加了之后服务端代码引用 `document` 也不报错。
 */
interface DomLike {
  textContent?: string | null;
  querySelector(selector: string): DomLike | null;
  dispatchEvent(event: Event): void;
  getAttribute(name: string): string | null;
}

/** 组件封装实例上我们真正用到的那一点 API（j-component 没给类型）。 */
interface CompLike {
  dom: DomLike;
  instance: { setData(data: Record<string, unknown>): void };
  addEventListener(name: string, fn: (e: unknown) => void): void;
}

function render(props: Record<string, unknown>): CompLike {
  const comp = simulate.render(loadOnce(), props);
  if (!comp) throw new Error('simulate.render 返回空——组件没被注册上（load 只应调用一次）');
  comp.attach(document.body);
  return comp as unknown as CompLike;
}

/**
 * 在组件上点一下（走 simulate 真实的 tap 合成路径）。
 * @why 不直接调 `instance.onTap()`：那样绕过了 `bindtap` 这条绑定，
 *      于是"wxml 忘了写 bindtap"这个失效形态永远测不出来。
 */
async function tap(comp: CompLike): Promise<unknown[]> {
  const seen: unknown[] = [];
  comp.addEventListener('tap', (e) => seen.push(e));

  const el = comp.dom.querySelector('wx-button') ?? comp.dom;
  const start = new CustomEvent('touchstart', { bubbles: true }) as unknown as {
    touches: unknown[];
  };
  start.touches = [{ pageX: 0, pageY: 0 }];
  const end = new CustomEvent('touchend', { bubbles: true }) as unknown as {
    touches: unknown[];
    changedTouches: unknown[];
  };
  end.touches = [];
  end.changedTouches = [{ pageX: 0, pageY: 0 }];
  el.dispatchEvent(start as unknown as Event);
  el.dispatchEvent(end as unknown as Event);

  // ⚠️ 必须等：j-component 在 `Promise.resolve().then()` 里才派发 exparser 事件
  await simulate.sleep(0);
  return seen;
}

describe('ws-button：渲染', () => {
  it('文案与 type 档位都渲染出来', () => {
    const comp = render({ text: '提交订单', type: 'default' });
    expect(comp.dom.textContent?.trim()).toBe('提交订单');
    const cls = comp.dom.querySelector('wx-button')?.getAttribute('class') ?? '';
    expect(cls).toContain('ws-button--default');
  });

  it('type 默认 primary', () => {
    const comp = render({ text: 'x' });
    const cls = comp.dom.querySelector('wx-button')?.getAttribute('class') ?? '';
    expect(cls).toContain('ws-button--primary');
  });

  /**
   * ⚠️ 这一条只能做**结构断言**（读 wxml 源码），不能做 DOM 断言：
   *    实测 simulate 的内置 `wx-button` 不把 `disabled` 渲染成属性（也不模拟"原生 disabled 不触发 tap"），
   *    于是"disabled 到底接没接到原生 button 上"在 DOM 上**看不出来**。
   *    而它一旦被删掉，按钮就永远不会真的禁用——连点防线少一半，且没有任何报错。
   */
  it('`disabled` 必须接到原生 button 上（simulate 渲染不出来，只能查 wxml）', () => {
    const wxml = readFileSync(join(root, 'components/ws-button/index.wxml'), 'utf8');
    expect(wxml).toMatch(/disabled="{{disabled}}"/);
    expect(wxml).toMatch(/catchtap="onTap"/);
  });
});

describe('ws-button：非法类型档位不能静默回退（与 ws-price 同一原则）', () => {
  /**
   * @why `type` 直接插 class 名时，传 `xl` 的表现是"没有档位样式命中 → 悄悄落回基础样式"：
   *      按钮长得不对且不报错。与 ws-price 非法档位是同一种失效形态，
   *      走同一条响亮失败通道（safeCallback → 渲染保持初始空态 + 控制台明确报错）。
   */
  it('⚠️ 传不存在的档位（xl）→ 报错且不产出档位 class', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = render({ text: 'x', type: 'xl' });
      const logged = spy.mock.calls
        .flat()
        .map((c) => String(c))
        .join('\n');
      expect(logged).toMatch(/type 必须是 primary \/ default 之一/);
      // 初始 typeClass 是 primary：observer 抛错后停在前态，绝不出现 ws-button--xl
      const cls = comp.dom.querySelector('wx-button')?.getAttribute('class') ?? '';
      expect(cls).not.toContain('ws-button--xl');
    } finally {
      spy.mockRestore();
    }
  });

  it('wxml 不直接消费 `type` 属性（档位 class 只能来自校验过的 typeClass）', () => {
    // 渲染层测不出绑定方式（`ws-button--{{type}}` 与 `{{typeClass}}` 在合法档位下产物一样），
    // 所以直接读 wxml 源文件钉住（与 ws-price 读 wxml 钉 sizeClass 同款做法）
    const wxml = readFileSync(join(root, 'components/ws-button/index.wxml'), 'utf8');
    expect(wxml).toContain('{{typeClass}}');
    expect(wxml).not.toMatch(/ws-button--\{\{type\}\}/);
  });
});

describe('ws-button：连点防线（本组件存在的理由）', () => {
  it('正常状态：点一下 → 页面收到一次 tap', async () => {
    const seen = await tap(render({ text: 'x' }));
    expect(seen).toHaveLength(1);
  });

  it('⚠️ `loading` 时点击被吞掉（官方 loading 不阻止 bindtap，只能自己挡）', async () => {
    const seen = await tap(render({ text: 'x', loading: true }));
    expect(seen).toHaveLength(0);
  });

  it('⚠️ `loading` 结束后**必须又能点**（吞掉之后没恢复，是同样致命的另一半）', async () => {
    const comp = render({ text: 'x', loading: true });
    expect(await tap(comp)).toHaveLength(0);
    comp.instance.setData({ loading: false });
    expect(await tap(comp)).toHaveLength(1);
  });

  it('loading 期间的点击**不通知页面**（既不 emit 也不报错）', async () => {
    // @see index.js @limitation 三：通知了也没有正确动作，只会被人拿去弹无意义的提示
    const seen = await tap(render({ text: 'x', loading: true }));
    expect(seen).toEqual([]);
  });
});
