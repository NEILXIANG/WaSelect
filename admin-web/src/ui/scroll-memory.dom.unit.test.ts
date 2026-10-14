// @vitest-environment jsdom
/**
 * 职责：滚动宿主的读写——**宽屏滚 `.main`、窄屏滚整个文档**（体验审查 2026-10-15，P1-3）。
 *
 * @why 这三个函数存在的全部理由就是"谁是滚动容器随断点变"，而这个事实在纯函数里看不见：
 *      只认 `.main.scrollTop` 的代码在两种布局下都**不报错**——宽屏好好用，窄屏恒为 0
 *      （换页不回顶、后退不回到原处）。能被机器钉住的正是"读的是真正在滚的那一侧"。
 * @limitation jsdom 不做布局：`scrollTop` / `scrollHeight` / `clientHeight` / `window.scrollY`
 *             都是用例自己钉上去的数字；真实布局（以及"两边是否真的只有一边会滚"）只能浏览器实测。
 * @see ./scroll-memory.ts（三个读写函数与其理由）；../../App.tsx（唯一调用方）
 */
import { describe, expect, it } from 'vitest';
import { maxScrollTop, readScrollTop, writeScrollTop } from './scroll-memory.js';

/** 造一个主区：位置与高度都由用例给（jsdom 没有布局，原型上的这几个量恒为 0）。 */
function fakeMain(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement('main');
  Object.defineProperty(el, 'scrollTop', {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  return el;
}

/**
 * 钉住文档与窗口那几个量，并**记录写到文档上的每一次滚动**
 * （`scrollingElement.scrollTop`，@see scroll-memory.js writeScrollTop 不用 window.scrollTo 的理由）。
 */
function stubWindow(scrollY: number, docScrollHeight: number, innerHeight: number): number[] {
  const writes: number[] = [];
  const root = document.documentElement;
  Object.defineProperty(root, 'scrollTop', {
    get: () => scrollY,
    set: (v: number) => writes.push(v),
    configurable: true,
  });
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  Object.defineProperty(root, 'scrollHeight', { value: docScrollHeight, configurable: true });
  return writes;
}

describe('滚动宿主：宽屏滚 .main（文档不动）', () => {
  it('🔴 读的是主区的位置，不是恒为 0 的文档', () => {
    stubWindow(0, 0, 0);
    expect(readScrollTop(fakeMain(800, 5000, 900))).toBe(800);
  });

  it('🔴 回顶写的是主区（文档那次是空操作，不改变语义）', () => {
    const scrolled = stubWindow(0, 0, 0);
    const el = fakeMain(800, 5000, 900);
    writeScrollTop(el, 0);
    expect(el.scrollTop).toBe(0);
    expect(scrolled).toEqual([0]);
  });

  it('🔴 可滚余量按主区算（列表还没撑开时用它夹住恢复目标）', () => {
    stubWindow(0, 0, 0);
    expect(maxScrollTop(fakeMain(0, 5000, 900))).toBe(4100);
  });
});

describe('滚动宿主：窄屏滚文档（.main 不滚）', () => {
  it('🔴 读的是文档的位置——原先只认 .main.scrollTop，窄屏恒为 0，位置一次都没记下', () => {
    stubWindow(1200, 3600, 900);
    expect(readScrollTop(fakeMain(0, 0, 0))).toBe(1200);
  });

  it('🔴 回顶滚的是文档——原先 `el.scrollTop = 0` 在这类布局下什么也没做', () => {
    const scrolled = stubWindow(1200, 3600, 900);
    writeScrollTop(fakeMain(0, 0, 0), 0);
    expect(scrolled).toEqual([0]);
  });

  it('🔴 可滚余量按文档算（主区不滚，它的余量是 0）', () => {
    stubWindow(1200, 3600, 900);
    expect(maxScrollTop(fakeMain(0, 0, 0))).toBe(2700);
  });
});

describe('两边都做：一侧是空操作，不互相干扰', () => {
  it('🔴 换页时两个宿主都被归零（窄屏靠 window、宽屏靠 .main，谁在滚谁生效）', () => {
    const scrolled = stubWindow(700, 2000, 800);
    const el = fakeMain(300, 4000, 800);
    writeScrollTop(el, 0);
    expect(el.scrollTop).toBe(0);
    expect(scrolled).toEqual([0]);
  });

  it('🔴 主区为 null（还没挂载）时不炸：只滚文档', () => {
    const scrolled = stubWindow(0, 2000, 800);
    writeScrollTop(null, 500);
    expect(scrolled).toEqual([500]);
    expect(readScrollTop(null)).toBe(0);
    expect(maxScrollTop(null)).toBe(1200);
  });
});
