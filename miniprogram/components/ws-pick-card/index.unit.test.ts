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
import { describe, expect, it } from 'vitest';
import simulate from 'miniprogram-simulate';

const root = resolve(import.meta.dirname, '../..');
declare const document: { body: unknown };

interface DomLike {
  querySelector(selector: string): DomLike | null;
  dispatchEvent(event: Event): void;
}
interface CompLike {
  dom: DomLike;
  attach(parent: unknown): void;
  addEventListener(name: string, fn: (e: unknown) => void): void;
}

describe('ws-pick-card：点击事件', () => {
  it('🔴 点一下，页面只收到 1 次 tap', async () => {
    const id = simulate.load(`${root}/components/ws-pick-card/index`, { rootPath: root });
    const comp = simulate.render(id, {
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
