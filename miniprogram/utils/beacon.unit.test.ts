/**
 * `utils/beacon.js`（M-21 / AJ-409）：白名单与服务端同源、队列封顶、按批冲刷、失败即丢、匿名 id 形状。
 */
import { describe, expect, it, vi } from 'vitest';
import { BEACON_ABANDON_REASON, BEACON_EVENT, BEACON_PAGE } from '@waselect/shared';
import {
  BEACON_ABANDON_REASONS,
  BEACON_EVENTS,
  BEACON_PAGES,
  MAX_BATCH,
  MAX_QUEUE,
  beaconHeaders,
  createBeacon,
  ensureAnonId,
  toEvent,
  track,
} from './beacon.js';

const ANON = 'an-0123456789ABCDEFGHJK';

function setup(over: Record<string, unknown> = {}) {
  const sent: { anon_id: string; events: unknown[] }[] = [];
  let t = 1_760_000_000_000;
  const b = createBeacon({
    anonId: ANON,
    now: () => (t += 1),
    send: (p: { anon_id: string; events: unknown[] }) => sent.push(p),
    ...over,
  });
  return { b, sent };
}

describe('白名单与服务端（shared）同源', () => {
  it('事件名 / 页面键 / 放弃原因三张表与 shared 逐字一致', () => {
    expect([...BEACON_EVENTS]).toEqual([...BEACON_EVENT]);
    expect([...BEACON_PAGES]).toEqual([...BEACON_PAGE]);
    expect([...BEACON_ABANDON_REASONS]).toEqual([...BEACON_ABANDON_REASON]);
  });
});

describe('toEvent：只留白名单键，形状不对就不入队（不让一个页面 bug 拖垮整批 40001）', () => {
  it('多余键被剥掉', () => {
    expect(toEvent('add_to_cart', { product_id: 'p-1', title: '包丁', qty: 1 }, 5)).toEqual({
      name: 'add_to_cart',
      ts: 5,
      props: { product_id: 'p-1' },
    });
    expect(toEvent('checkout_enter', { any: 'x' }, 5)).toEqual({ name: 'checkout_enter', ts: 5 });
  });
  it.each([
    ['未知事件', 'address_submit', {}],
    ['缺必填', 'pay_start', { order_id: 'o-1' }],
    ['页面键不在表内', 'page_view', { page: 'address' }],
    ['原因不在表内', 'pay_abandon', { order_id: 'o-1', reason: 'timeout' }],
    ['id 是邮箱', 'add_to_cart', { product_id: 'a@b.co' }],
    ['id 非字符串', 'add_to_cart', { product_id: 12 }],
  ])('%s → null', (_t, name, props) => {
    expect(toEvent(name, props, 5)).toBeNull();
  });
});

describe('createBeacon：队列与冲刷', () => {
  it('track 入队、flush 一次发一批并清空；空队列 flush 不发', () => {
    const { b, sent } = setup();
    expect(b.track('page_view', { page: 'home' })).toBe(true);
    expect(b.track('checkout_enter')).toBe(true);
    expect(b.flush()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.anon_id).toBe(ANON);
    expect(sent[0]?.events).toHaveLength(2);
    expect(b.flush()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('攒满一批（20）立即冲刷，不等定时器', () => {
    const { b, sent } = setup();
    for (let i = 0; i < MAX_BATCH; i += 1) b.track('checkout_enter');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(MAX_BATCH);
    expect(b.size()).toBe(0);
  });

  it('队列封顶：超过上限的新事件丢弃并计数（发送一直失败也不会无限涨）', () => {
    const { b } = setup({ maxBatch: 1000, send: () => {} });
    for (let i = 0; i < MAX_QUEUE + 5; i += 1) b.track('checkout_enter');
    expect(b.size()).toBe(MAX_QUEUE);
    expect(b.dropped()).toBe(5);
  });

  it('send 抛错：这一批丢弃、不重试、不向调用方抛，交给 onError', () => {
    const onError = vi.fn();
    const { b } = setup({
      send: () => {
        throw new Error('boom');
      },
      onError,
    });
    b.track('checkout_enter');
    expect(() => b.flush()).not.toThrow();
    expect(b.size()).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('flushAll 分批发完（每批 ≤ 20）', () => {
    const { b, sent } = setup({ maxBatch: 1000 });
    for (let i = 0; i < 45; i += 1) b.track('checkout_enter');
    b.flushAll();
    expect(sent.map((s) => s.events.length)).toEqual([20, 20, 5]);
  });
});

describe('ensureAnonId / beaconHeaders / track', () => {
  function mem(init: Record<string, string> = {}) {
    const m = { ...init };
    return {
      m,
      getString: (k: string) => m[k] ?? '',
      setString: (k: string, v: string) => {
        m[k] = v;
      },
    };
  }
  it('已有合法 id 沿用；没有或形状不对就新建并存下（an- + 20 位 Base32）', () => {
    expect(ensureAnonId(mem({ anon_id: ANON }))).toBe(ANON);
    const s = mem({ anon_id: 'jane@example.com' });
    const id = ensureAnonId(s);
    expect(id).toMatch(/^an-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(s.m.anon_id).toBe(id);
  });
  it('存储写失败也给出 id（只是下次冷启动换新），不抛', () => {
    const s = {
      getString: () => '',
      setString: () => {
        throw new Error('quota');
      },
    };
    expect(ensureAnonId(s)).toMatch(/^an-/);
  });
  it('有 token 带 Bearer，没有就不带；trace 头必带', () => {
    expect(beaconHeaders('tok', 'mp-ABCDEFGH')).toEqual({
      'content-type': 'application/json',
      'x-trace-id': 'mp-ABCDEFGH',
      authorization: 'Bearer tok',
    });
    expect(beaconHeaders('', 'mp-ABCDEFGH')).not.toHaveProperty('authorization');
  });
  it('track(app, …)：没装 beacon（未配置地址 / 测试宿主）时静默无事', () => {
    expect(() => track(undefined, 'checkout_enter')).not.toThrow();
    expect(() => track({ globalData: {} }, 'checkout_enter')).not.toThrow();
    const calls: unknown[] = [];
    track({ globalData: { beacon: { track: (...a: unknown[]) => calls.push(a) } } }, 'page_view', {
      page: 'home',
    });
    expect(calls).toEqual([['page_view', { page: 'home' }]]);
  });
});
