/**
 * 职责：价格组件的组件级测试（F14）——用官方 `miniprogram-simulate` 在 Vitest 内渲染**真实组件文件**。
 *
 * @why 只测 `price-format.js` 是不完整的：它证明不了"组件真的把它接上了"。
 *      组件这一层有它自己的失效形态，而且**都不报错**：
 *        ① **忘了接格式化**：wxml 里直接写 `¥{{jpy}}` → 没有千分位，看起来"也还行"；
 *        ② **加了兜底**：漏传价格时显示 `¥0` → 用户以为免费；
 *        ③ **属性名漂移**：页面传 `price` 而组件收 `jpy` → 一直是空，且不报错。
 *      这三条只有"渲染真组件 + 断言真实 DOM"能抓到。
 *
 * @how `simulate.load(绝对路径, { rootPath })` 读真文件（.json/.wxml/.wxss/.js），
 *      再由 `simulate.render(id, props)` 渲染；断言走 `comp.dom`。
 *      ⚠️ 必须是 **jsdom** 环境（文件头那行 `@vitest-environment`）——simulate 需要一个 DOM。
 *
 * @limitation 一：**这是"组件层"，不是真机**。simulate 用纯 JS 模拟双线程，
 *              它不覆盖真机基础库的差异（如 `wx-` 标签的真实布局、WXSS 的部分属性）。
 *              所以组件的**视觉**仍要 L4 人工验收（样板页），这里只钉**结构与文案**。
 * @limitation 二：`simulate.load` **只能调用一次**（实测：第二次之后 `render` 返回 `undefined`，
 *              症状是"第一条用例绿、后面全崩在 attach"，看着像 DOM 问题其实是加载问题）。
 * @limitation 三：类名在 simulate 里会被加上 `main--` 前缀（它的样式隔离实现，真机没有），
 *              所以断言类名一律用**子串**，不要断言完整值——否则测的是 simulate 的实现细节。
 * @limitation 四：组件 js 由 Node 的 `require` 执行，因此它 import 的模块必须是**真实存在的 `.js`**
 *              ——引 `.ts` 会 `Cannot find module`（已实测，见 `index.js` @limitation 三）。
 *
 * @see ../../utils/price-format.js（格式化真源，17 条单测）；docs/地基搭建清单.md F14
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import simulate from 'miniprogram-simulate';
import { formatJpy } from '../../utils/price-format.js';

const root = resolve(import.meta.dirname, '../..');

/**
 * jsdom 环境下的 `document`。
 * @why 根 tsconfig 的 `lib` 只有 ES2022（**不含 DOM**），而本文件跑在 jsdom 下。
 *      这里只声明用到的这一个值，而不是给 tsconfig 加 `DOM`——
 *      加了之后**服务端代码引用 `document` 也不会报错**，那正是我们不想放开的东西。
 *      ⚠️ 是 `declare const` 而不是 `const`：本文件是模块作用域，不会污染其它文件。
 */
declare const document: { body: unknown };

/**
 * 组件 id —— **只 load 一次**并缓存。@see 文件头 @limitation 二
 */
let loadedId = '';
function loadOnce(): string {
  if (loadedId === '') {
    loadedId = simulate.load(`${root}/components/ws-price/index`, { rootPath: root });
  }
  return loadedId;
}

/** 渲染一个 ws-price。 */
function render(props: Record<string, unknown>) {
  const comp = simulate.render(loadOnce(), props);
  if (!comp) throw new Error('simulate.render 返回空——组件没被注册上（load 只应调用一次）');
  comp.attach(document.body);
  return comp;
}

/** 渲染出来的那个 `wx-text` 的 class。@see 文件头 @limitation 三（前缀是 simulate 加的） */
function renderedClass(comp: ReturnType<typeof render>): string {
  const el = comp.dom.querySelector('wx-text');
  return el === null ? '' : (el.getAttribute('class') ?? '');
}

describe('ws-price：渲染真实组件文件', () => {
  it('传 jpy → DOM 里是格式化后的文案（千分位真的接上了）', () => {
    // @why 断言"等于 formatJpy 的结果"而不是硬写 '¥1,234'：
    //      硬写等于把格式抄第二遍，改格式时要改两个地方；用真函数对照则只钉"组件接上了格式化"。
    const comp = render({ jpy: 1234 });
    expect(comp.dom.textContent).toBe(formatJpy(1234));
    expect(comp.dom.textContent).toBe('¥1,234');
  });

  it('wxml 里**没有**自己拼货币符号（组件不得绕过格式化）', () => {
    const comp = render({ jpy: 1234 });
    // 若 wxml 写成 `¥{{jpy}}`，数值不会被格式化，也不会带千分位
    expect(comp.dom.textContent).not.toBe('¥1234');
  });

  it('尺寸档位反映到 class 上（不是行内样式）', () => {
    expect(renderedClass(render({ jpy: 1 }))).toContain('ws-price--md');
    expect(renderedClass(render({ jpy: 1, size: 'lg' }))).toContain('ws-price--lg');
    expect(renderedClass(render({ jpy: 1, size: 'sm' }))).toContain('ws-price--sm');
  });

  it('size 默认 md（页面不传也能用）', () => {
    expect(renderedClass(render({ jpy: 1 }))).toContain('ws-price--md');
  });

  it('属性变化后文案跟着变（observers 真的接上了）', () => {
    const comp = render({ jpy: 1 });
    expect(comp.dom.textContent).toBe('¥1');
    comp.instance.setData({ jpy: 98765 });
    expect(comp.dom.textContent).toBe('¥98,765');
  });

  it('负数（退款 / 折扣）也正常渲染', () => {
    expect(render({ jpy: -1234 }).dom.textContent).toBe('-¥1,234');
  });
});

describe('ws-price：漏传价格不能显示 ¥0', () => {
  /**
   * @why 生命周期里的异常会被小程序框架的 `safeCallback` 捕获并打到控制台，
   *      **不会**冒泡到调用方。所以"响亮失败"的可断言形态是
   *      「渲染空白 + 控制台一条明确报错」，而不是"抛异常"。
   *      ⚠️ 这一点是实测出来的（我第一版断言 `render()` 抛错，全红）。
   */
  it('⚠️ 不传 jpy → 渲染**空白**，且控制台有明确报错（不是 ¥0）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = render({});
      // 这一条是本组件最贵的性质：`¥0` 会被用户读成"免费"
      expect(comp.dom.textContent).toBe('');
      const logged = spy.mock.calls
        .flat()
        .map((c) => String(c))
        .join('\n');
      expect(logged).toMatch(/金额必须是有限数/);
    } finally {
      spy.mockRestore();
    }
  });

  it('传了坏数据（NaN / 字符串）→ 同样空白 + 报错，不兜底', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(render({ jpy: Number.NaN }).dom.textContent).toBe('');
      expect(render({ jpy: '1234' }).dom.textContent).toBe('');
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ws-price：非法尺寸档位不能静默回退', () => {
  /**
   * @why `size` 直接插 class 名时，传 `xl` 的表现是"没有档位样式命中 → 悄悄落回基础字号"：
   *      版式散掉且不报错。与漏传价格显示 `¥0` 是同一种失效形态，走同一条响亮失败通道
   *      （safeCallback → 渲染保持初始空态 + 控制台明确报错）。
   */
  it('⚠️ 传不存在的档位（xl）→ 报错且不产出档位 class', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = render({ jpy: 1, size: 'xl' });
      const logged = spy.mock.calls
        .flat()
        .map((c) => String(c))
        .join('\n');
      expect(logged).toMatch(/size 必须是 sm \/ md \/ lg 之一/);
      // 初始 sizeClass 是 md：update 抛错后**停在前态**，绝不出现 ws-price--xl
      expect(renderedClass(comp)).not.toContain('ws-price--xl');
    } finally {
      spy.mockRestore();
    }
  });

  it('wxml 不直接消费 `size` 属性（档位 class 只能来自校验过的 sizeClass）', () => {
    // 渲染层测不出绑定方式（`ws-price--{{size}}` 与 `{{sizeClass}}` 在合法档位下产物一样），
    // 所以直接读 wxml 源文件钉住：插值必须是 sizeClass，不得回退成 size
    // （与 ws-button 测试读 wxml 断言 catchtap 同款做法）
    const wxml = readFileSync(`${root}/components/ws-price/index.wxml`, 'utf8');
    expect(wxml).toContain('{{sizeClass}}');
    expect(wxml).not.toMatch(/\{\{size\}\}/);
  });
});
