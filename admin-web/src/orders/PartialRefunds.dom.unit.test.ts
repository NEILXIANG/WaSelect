// @vitest-environment jsdom
/**
 * 部分退款面板（AJ-383）的渲染 + 交互：换算后的最小单位真的进了请求体、在途那一笔能同步。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { PartialRefunds } from './PartialRefunds.js';

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(
  partial: unknown[] = [],
): Promise<{ el: HTMLElement; calls: Call[]; done: { n: number } }> {
  const calls: Call[] = [];
  const done = { n: 0 };
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    return { refund: { id: 'rf-new', status: 'succeeded' } };
  };
  mounted = await mount(
    createElement(PartialRefunds, {
      api: api as never,
      orderId: 'o-1',
      order: {
        status: 'delivered',
        has_dispute: false,
        payments: [{ status: 'succeeded', charge_currency: 'USD', charge_amount: 8160 }],
        partial_refunds: partial,
      },
      onDone: () => {
        done.n += 1;
      },
      onError: () => undefined,
    }),
  );
  return { el: mounted.el, calls, done };
}

describe('PartialRefunds', () => {
  it('填 10.50 美元 + 原因 → 两步确认 → 请求体 amount_minor = 1050；完成后通知父组件刷新', async () => {
    const { el, calls, done } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '10.50');
    await type(el.querySelector('input[name="partial-reason"]'), '缺一件：抹茶粉');
    await click(button(el, '部分退款'));
    await click(button(el, '确认部分退款'));
    const post = calls.find((c) => c.path.endsWith('/partial-refunds'));
    expect(post?.body).toEqual({ amount_minor: 1050, reason: '缺一件：抹茶粉' });
    expect(done.n).toBe(1);
  });

  it('🔴 金额格式不对 → 不发请求', async () => {
    const { el, calls } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '10.555');
    await type(el.querySelector('input[name="partial-reason"]'), '原因');
    await click(button(el, '部分退款'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(el.textContent).toContain('最多 2 位小数');
  });

  it('结果未知的一笔显示「同步」，点了调 sync 接口', async () => {
    const { el, calls } = await open([
      {
        id: 'rf-u',
        status: 'unknown',
        currency: 'USD',
        amount_minor: 50,
        reason: '破损',
        created_at: '2026-10-06T04:00:00Z',
      },
    ]);
    expect(el.textContent).toContain('0.50 USD');
    await click(button(el, '同步'));
    expect(calls.some((c) => c.path.endsWith('/partial-refunds/rf-u/sync'))).toBe(true);
  });

  it('P2-49 发起出错 → 先刷新、再按新出现那一行的真实状态提示（failed / unknown 各一句）', async () => {
    for (const [rowStatus, expected] of [
      ['failed', '机构确认失败，额度已释放，可重新发起'],
      ['unknown', '结果未知，请点「同步」取回结果，不要去 Stripe 后台重复退'],
    ] as const) {
      const messages: string[] = [];
      const order = {
        status: 'delivered',
        has_dispute: false,
        payments: [{ status: 'succeeded', charge_currency: 'USD', charge_amount: 8160 }],
        partial_refunds: [] as unknown[],
      };
      const api = async (): Promise<unknown> => {
        throw new ApiError(50000, '服务器内部错误', 't');
      };
      mounted = await mount(
        createElement(PartialRefunds, {
          api: api as never,
          orderId: 'o-1',
          order,
          onDone: async () => ({
            ...order,
            partial_refunds: [
              { id: 'rf-1', status: rowStatus, currency: 'USD', amount_minor: 1050 },
            ],
          }),
          onError: (m: string) => messages.push(m),
          onNotice: (m: string) => messages.push(`notice:${m}`),
        }),
      );
      const el = mounted.el;
      await type(el.querySelector('input[name="partial-amount"]'), '10.50');
      await type(el.querySelector('input[name="partial-reason"]'), '缺一件');
      await click(button(el, '部分退款'));
      await click(button(el, '确认部分退款'));
      expect(messages).toEqual(['服务器内部错误', `notice:${expected}`]);
      await mounted.unmount();
      mounted = undefined;
    }
  });
});
