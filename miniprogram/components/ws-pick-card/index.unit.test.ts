// @vitest-environment jsdom
/**
 * 职责：`ws-pick-card` 点一下只向页面发出**一次** tap（W-01）。
 *
 * @why 卡片内部原来用 `bindtap`：内部原生 tap 冒出组件边界到达页面的 `bindtap`，
 *      组件自己又 `triggerEvent('tap')` 一次——页面收到两次，`navigateTo` 被调两次，
 *      首页点一下商品卡要按两次返回才回得来。ws-button 早就为同一个现象改成了 `catchtap`。
 * @how 与 ws-button 的单测同一套 simulate tap 合成（touchstart + touchend，派发在微任务里）。
 * @see ./index.js；../ws-button/index.unit.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import simulate from 'miniprogram-simulate';

const root = resolve(import.meta.dirname, '../..');
declare const document: { body: unknown };

interface DomLike {
  querySelector(selector: string): DomLike | null;
  dispatchEvent(event: Event): void;
}
interface CompLike {
  dom: DomLike & { textContent: string | null };
  attach(parent: unknown): void;
  addEventListener(name: string, fn: (e: unknown) => void): void;
}

/** 组件 id —— 只 load 一次（simulate 重复 load 后 render 返回 undefined，见 ws-price 单测文件头）。 */
let loadedId = '';
function loadOnce(): string {
  if (loadedId === '') {
    loadedId = simulate.load(`${root}/components/ws-pick-card/index`, { rootPath: root });
  }
  return loadedId;
}

describe('ws-pick-card：点击事件', () => {
  it('🔴 点一下，页面只收到 1 次 tap', async () => {
    const comp = simulate.render(loadOnce(), {
      name: '南部鉄器 急須',
      why: '一生用',
      priceJpy: 8800,
    }) as unknown as CompLike;
    comp.attach(document.body);
    const seen: unknown[] = [];
    comp.addEventListener('tap', (e) => seen.push(e));
    const el = comp.dom.querySelector('wx-view') ?? comp.dom;
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
    await simulate.sleep(0);
    expect(seen).toHaveLength(1);
  });

  it('wxml 用 catchtap（不让内部原生 tap 冒出组件）', () => {
    const wxml = readFileSync(resolve(root, 'components/ws-pick-card/index.wxml'), 'utf8');
    expect(wxml).toContain('catchtap="onTap"');
  });
});

describe('ws-pick-card：缺价格不能显示 0 日元（P1-6）', () => {
  /**
   * @why `priceJpy` 曾声明为 `{ type: Number, value: 0 }`：列表接口漏了 `price_jpy` 时
   *      卡片照样渲染 `0 円`，用户读成"免费"。改成 `type: null` 后漏传是 null，
   *      ws-price 走它自己的响亮失败（空白 + 控制台报错）。
   */
  it('不传 priceJpy → 卡上没有 "0 日元"，控制台有报错', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = simulate.render(loadOnce(), {
        name: '南部鉄器 急須',
        why: '一生用',
      }) as unknown as CompLike;
      comp.attach(document.body);
      expect(comp.dom.textContent ?? '').not.toContain('0 日元');
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('传了 priceJpy → 正常显示千分位价格', () => {
    const comp = simulate.render(loadOnce(), {
      name: '南部鉄器 急須',
      why: '一生用',
      priceJpy: 8800,
    }) as unknown as CompLike;
    comp.attach(document.body);
    expect(comp.dom.textContent ?? '').toContain('8,800 日元');
  });
});

describe('ws-pick-card：图片加载失败（审计 UX-01）', () => {
  it('🔴 binderror → 收起 <image>，不留破图', () => {
    const comp = simulate.render(loadOnce(), {
      name: '南部鉄器 急須',
      why: '一生用',
      priceJpy: 8800,
      image: 'https://img.test/missing.webp',
    }) as unknown as CompLike & { instance: { onImgError: () => void } };
    comp.attach(document.body);
    expect(comp.dom.querySelector('wx-image')).not.toBeNull();
    comp.instance.onImgError();
    expect(comp.dom.querySelector('wx-image')).toBeNull();
  });
});

describe('ws-pick-card：内嵌价格不报空金额（三端联动走查 2026-10-08）', () => {
  it('🔴 传了 priceJpy 渲染后控制台没有"金额必须是整数日元"——空金额只该在真漏传时出现', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = simulate.render(loadOnce(), {
        name: '南部鉄器 急須',
        why: '一生用',
        priceJpy: 12800,
      }) as unknown as CompLike;
      comp.attach(document.body);
      expect(comp.dom.textContent).toContain('12,800');
      const logged = spy.mock.calls
        .flat()
        .map((c) => String(c))
        .join('\n');
      expect(logged).not.toMatch(/金额必须是整数日元/);
    } finally {
      spy.mockRestore();
    }
  });
});
