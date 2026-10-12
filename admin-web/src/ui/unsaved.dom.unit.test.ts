// @vitest-environment jsdom
/**
 * 职责：未保存提醒的**登记簿**行为（第一批⑥ 补齐到订单页）。
 *
 * @why 订单详情一页挂着发货 / 退款 / 改址 / 备注多份表单。脏态原先是一个布尔：
 *      B 恢复干净或卸载时写 false，会把"A 还脏着"一并抹掉——提醒在最该弹的时候不弹。
 *      这里钉住"任意一份脏 = 整页脏"。
 * @see ./unsaved.tsx（useDirtyRegistry / useFormDirty）
 */
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, mount, type, type Mounted } from '../testing/dom.js';
import { OrderTimeline } from '../orders/OrderTimeline.js';
import { UnsavedProvider, useDirtyRegistry, useFormDirty, useUnsaved } from './unsaved.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Probe(): React.JSX.Element {
  const { dirty } = useUnsaved();
  return createElement('span', { 'data-testid': 'dirty' }, dirty ? 'yes' : 'no');
}

function Form({ value }: { value: string }): null {
  useFormDirty(value, '');
  return null;
}

let setA: (v: string) => void = () => undefined;
let setB: (v: string) => void = () => undefined;
let setShowB: (v: boolean) => void = () => undefined;

function Host(): React.JSX.Element {
  const reg = useDirtyRegistry();
  const [a, sa] = useState('');
  const [b, sb] = useState('');
  const [showB, ssb] = useState(true);
  setA = sa;
  setB = sb;
  setShowB = ssb;
  return createElement(
    UnsavedProvider,
    { dirty: reg.dirty, markDirty: reg.markDirty },
    createElement(Probe),
    createElement(Form, { value: a }),
    showB ? createElement(Form, { value: b }) : null,
  );
}

const dirtyText = (el: HTMLElement): string =>
  el.querySelector('[data-testid=dirty]')?.textContent ?? '';

describe('useDirtyRegistry：多份表单各记各的', () => {
  it('A 脏着时，B 恢复干净或卸载都不会把整页标成干净', async () => {
    mounted = await mount(createElement(Host));
    const el = mounted.el;
    expect(dirtyText(el)).toBe('no');

    await act(async () => {
      setA('改了一半');
      setB('也改了');
    });
    expect(dirtyText(el)).toBe('yes');

    await act(async () => setB(''));
    expect(dirtyText(el)).toBe('yes'); // 单布尔实现下这里会变 no

    await act(async () => setShowB(false));
    expect(dirtyText(el)).toBe('yes');

    await act(async () => setA(''));
    expect(dirtyText(el)).toBe('no');
  });
});

describe('订单备注草稿进入脏态', () => {
  function TimelineHost(): React.JSX.Element {
    const reg = useDirtyRegistry();
    const api = (async () => ({ items: [] })) as never;
    return createElement(
      UnsavedProvider,
      { dirty: reg.dirty, markDirty: reg.markDirty },
      createElement(Probe),
      createElement(OrderTimeline, {
        api,
        orderId: 'ord-1',
        events: [],
        onError: () => undefined,
        onSuccess: () => undefined,
      } as never),
    );
  }

  it('只填空格不算草稿；有字才算', async () => {
    mounted = await mount(createElement(TimelineHost));
    await flush();
    const el = mounted.el;
    const box = el.querySelector('textarea');
    expect(box).not.toBeNull();

    await type(box, '   ');
    expect(dirtyText(el)).toBe('no');

    await type(box, '买家说周五后再发');
    expect(dirtyText(el)).toBe('yes');
  });
});

// 规律排查 2026-10-12：离开提醒写"先回去点「保存」"——发货、退款、改址、汇率、售后等表单都没有叫「保存」的按钮
describe('离开提醒的文案', () => {
  it('🔴 不点名一个多数表单没有的「保存」按钮', async () => {
    const { LEAVE_UNSAVED_SPEC } = await import('./leave-spec.js');
    expect(LEAVE_UNSAVED_SPEC.body).not.toContain('「保存」');
  });
});
