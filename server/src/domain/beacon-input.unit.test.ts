/**
 * `parseBeaconBatch`（M-21 / AJ-409）的边界表：白名单事件、逐事件 props 精确键集、批量上限、匿名 id 形状。
 *
 * @why PII 防线的第一层在这里：任何"多出来的键 / 不在白名单的值 / 形状外的 id"都整批 40001，
 *      且错误 data **只带 reason 与下标**，不回显客户端送来的值或键名（键名本身也可能是邮箱）。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { BEACON_MAX_EVENTS, parseBeaconBatch } from './beacon-input.js';

const ANON = 'an-0123456789ABCDEFGHJK';
const TS = Date.UTC(2026, 9, 8, 3, 0, 0);

function body(events: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { anon_id: ANON, events, ...extra };
}

function reasonOf(fn: () => unknown): { code: number; data: unknown } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return { code: e.code, data: e.details };
    throw e;
  }
  throw new Error('应当抛 AppError，却通过了');
}

describe('parseBeaconBatch：正常路径', () => {
  it('五种事件各一条：props 原样保留、client_ts 进 props', () => {
    const r = parseBeaconBatch(
      body([
        { name: 'page_view', ts: TS, props: { page: 'detail' } },
        { name: 'add_to_cart', ts: TS, props: { product_id: 'p-knife' } },
        { name: 'checkout_enter', ts: TS },
        { name: 'pay_start', ts: TS, props: { order_id: 'ord-1', channel: 'stripe' } },
        { name: 'pay_abandon', ts: TS, props: { order_id: 'ord-1', reason: 'cancel' } },
      ]),
    );
    expect(r.anonId).toBe(ANON);
    expect(r.events.map((e) => e.name)).toEqual([
      'page_view',
      'add_to_cart',
      'checkout_enter',
      'pay_start',
      'pay_abandon',
    ]);
    expect(r.events[0]?.props).toEqual({ page: 'detail', client_ts: TS });
    expect(r.events[2]?.props).toEqual({ client_ts: TS });
    expect(r.events[3]?.props).toEqual({ order_id: 'ord-1', channel: 'stripe', client_ts: TS });
  });

  it('checkout_enter 带空 props 也收；批量恰好上限 20 条收', () => {
    expect(
      parseBeaconBatch(body([{ name: 'checkout_enter', ts: TS, props: {} }])).events,
    ).toHaveLength(1);
    const twenty = Array.from({ length: BEACON_MAX_EVENTS }, () => ({
      name: 'checkout_enter',
      ts: TS,
    }));
    expect(parseBeaconBatch(body(twenty)).events).toHaveLength(20);
  });
});

describe('parseBeaconBatch：拒绝（整批 40001，data 只带 reason / index）', () => {
  const cases: [string, unknown, string][] = [
    ['body 不是对象', 'x', 'beacon_shape'],
    ['顶层多键', body([], { email: 'a@b.co' }), 'beacon_shape'],
    ['anon_id 是邮箱', { anon_id: 'jane.doe@example.com', events: [] }, 'anon_id_invalid'],
    ['anon_id 缺', { events: [] }, 'anon_id_invalid'],
    ['events 为空', body([]), 'events_shape'],
    ['events 不是数组', body({} as unknown as unknown[]), 'events_shape'],
    [
      '21 条超上限',
      body(
        Array.from({ length: BEACON_MAX_EVENTS + 1 }, () => ({ name: 'checkout_enter', ts: TS })),
      ),
      'events_too_many',
    ],
    ['事件名不在白名单', body([{ name: 'address_submit', ts: TS }]), 'event_name_invalid'],
    ['事件多键', body([{ name: 'checkout_enter', ts: TS, phone: '+14155550123' }]), 'event_shape'],
    ['ts 不是整数', body([{ name: 'checkout_enter', ts: 1.5 }]), 'event_ts_invalid'],
    [
      'ts 早于 2020',
      body([{ name: 'checkout_enter', ts: Date.UTC(2019, 11, 31) }]),
      'event_ts_invalid',
    ],
    ['ts 是字符串', body([{ name: 'checkout_enter', ts: String(TS) }]), 'event_ts_invalid'],
    [
      'props 多出 email',
      body([{ name: 'add_to_cart', ts: TS, props: { product_id: 'p-1', email: 'a@b.co' } }]),
      'event_props_invalid',
    ],
    [
      'props 缺必填',
      body([{ name: 'pay_start', ts: TS, props: { order_id: 'ord-1' } }]),
      'event_props_invalid',
    ],
    [
      'checkout_enter 带任意 props',
      body([{ name: 'checkout_enter', ts: TS, props: { x: '1' } }]),
      'event_props_invalid',
    ],
    [
      'page 不在白名单',
      body([{ name: 'page_view', ts: TS, props: { page: 'address' } }]),
      'event_props_invalid',
    ],
    [
      'product_id 是邮箱',
      body([{ name: 'add_to_cart', ts: TS, props: { product_id: 'jane@example.com' } }]),
      'event_props_invalid',
    ],
    [
      'product_id 是 E.164 电话',
      body([{ name: 'add_to_cart', ts: TS, props: { product_id: '+14155550123' } }]),
      'event_props_invalid',
    ],
    [
      'product_id 65 字',
      body([{ name: 'add_to_cart', ts: TS, props: { product_id: 'p'.repeat(65) } }]),
      'event_props_invalid',
    ],
    [
      'order_id 不是字符串',
      body([{ name: 'pay_abandon', ts: TS, props: { order_id: 1, reason: 'back' } }]),
      'event_props_invalid',
    ],
    [
      'channel 不在登记表',
      body([{ name: 'pay_start', ts: TS, props: { order_id: 'ord-1', channel: 'alipay' } }]),
      'event_props_invalid',
    ],
    [
      'reason 不在枚举',
      body([{ name: 'pay_abandon', ts: TS, props: { order_id: 'ord-1', reason: 'timeout' } }]),
      'event_props_invalid',
    ],
  ];
  it.each(cases)('%s → %s', (_t, input, reason) => {
    const r = reasonOf(() => parseBeaconBatch(input));
    expect(r.code).toBe(40001);
    expect((r.data as { reason: string }).reason).toBe(reason);
  });

  it('错误 data 不回显客户端的值与键名（只给 reason + index）', () => {
    const r = reasonOf(() =>
      parseBeaconBatch(
        body([
          { name: 'checkout_enter', ts: TS },
          { name: 'add_to_cart', ts: TS, props: { product_id: 'p-1', 'jane@example.com': '1' } },
        ]),
      ),
    );
    expect(r.data).toEqual({ reason: 'event_props_invalid', index: 1 });
    expect(JSON.stringify(r.data)).not.toContain('example.com');
  });
});
