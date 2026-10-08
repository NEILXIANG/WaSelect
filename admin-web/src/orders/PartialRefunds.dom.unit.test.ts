// @vitest-environment jsdom
/**
 * 部分退款面板（AJ-383）的渲染 + 交互：换算后的最小单位真的进了请求体、在途那一笔能同步。
 */
import { pressEnter } from '../testing/keys.js';
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
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
    await type(el.querySelector('input[name="partial-reason"]'), '缺一件：抹茶粉');
    await click(button(el, '部分退款'));
    await click(button(el, '确认部分退款'));
    const post = calls.find((c) => c.path.endsWith('/partial-refunds'));
    expect(post?.body).toEqual({ amount_minor: 1050, reason: '缺货：缺一件：抹茶粉' });
    expect(done.n).toBe(1);
  });

  it('🔴 金额格式不对 → 不发请求', async () => {
    const { el, calls } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '10.555');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
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

  /**
   * 超额必须在前端拦。@why 修订前 `ask()` 完全不比对可退额度：
   * 填 999999 会真的发出去，服务端只回通用「参数缺失或格式错误」，
   * 运营看不出那是额度问题（三端联动模拟 2026-10-08 实测）。
   */
  it('🔴 超过可退额度 → 不发请求，且提示写明"最多可退"多少', async () => {
    const { el, calls } = await open(); // 可退 81.60 USD
    await type(el.querySelector('input[name="partial-amount"]'), '999999');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
    await type(el.querySelector('input[name="partial-reason"]'), '整车退款');
    await click(button(el, '部分退款'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    /*
     * ⚠️ 必须断言 `p.error`（行内提示），不能只断言 textContent 含"最多可退"——
     *    准入通过的常态文案里也有这五个字（gate.reason 常驻显示），
     *    写成后者的话，把额度校验整段删掉测试照样全绿（缺陷注入已验证）。
     *    真正的行为差别是：**没有进入两步确认**，也就是「确认部分退款」按钮不该出现。
     */
    // AJ-410 / N29：文案改为「最多还能退 … 美元」（原「最多可退 … USD」）
    expect(el.querySelector('p.error')?.textContent).toContain('最多还能退');
    expect(el.querySelector('p.error')?.textContent).toContain('81.60 美元');
    expect(button(el, '确认部分退款')).toBeNull();
  });

  it('刚好等于额度放行；多一分都要拦', async () => {
    const { el, calls } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '81.60');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
    await type(el.querySelector('input[name="partial-reason"]'), '全部余款');
    await click(button(el, '部分退款'));
    await click(button(el, '确认部分退款'));
    expect(calls.find((c) => c.path.endsWith('/partial-refunds'))?.body).toEqual({
      amount_minor: 8160,
      reason: '缺货：全部余款',
    });
    const over = await open();
    await type(over.el.querySelector('input[name="partial-amount"]'), '81.61');
    await type(over.el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
    await type(over.el.querySelector('input[name="partial-reason"]'), '全部余款');
    await click(button(over.el, '部分退款'));
    expect(over.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(button(over.el, '确认部分退款')).toBeNull();
  });

  /**
   * 成功必须走自己的出口。
   * @why Toast 的清屏挂在 kind === 'success' 上：成功话走 info 通道时，
   *      上一次失败的红条会一直挂着，屏幕上红绿各一条，运营分不清这次成没成。
   */
  it('🔴 成功提示走 onSuccess 出口（能触发清屏），不再走 onNotice（info 通道）', async () => {
    const got: string[] = [];
    const order = {
      status: 'delivered',
      has_dispute: false,
      payments: [{ status: 'succeeded', charge_currency: 'USD', charge_amount: 8160 }],
      partial_refunds: [],
    };
    mounted = await mount(
      createElement(PartialRefunds, {
        api: (async () => ({ refund: { id: 'rf-new', status: 'succeeded' } })) as never,
        orderId: 'o-1',
        order,
        onDone: () => undefined,
        onError: (m: string) => got.push(`error:${m}`),
        onNotice: (m: string) => got.push(`info:${m}`),
        onSuccess: (m: string) => got.push(`success:${m}`),
      }),
    );
    const el = mounted.el;
    await type(el.querySelector('input[name="partial-amount"]'), '10.00');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
    await type(el.querySelector('input[name="partial-reason"]'), '缺一件');
    await click(button(el, '部分退款'));
    await click(button(el, '确认部分退款'));
    expect(got.some((m) => m.startsWith('success:'))).toBe(true);
    expect(got.filter((m) => m.startsWith('info:')).filter((m) => m !== 'info:')).toHaveLength(0);
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
      await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设必选
      await type(el.querySelector('input[name="partial-reason"]'), '缺一件');
      await click(button(el, '部分退款'));
      await click(button(el, '确认部分退款'));
      expect(messages).toEqual(['notice:', '服务器内部错误', `notice:${expected}`]); // 先清上一个动作的提示
      await mounted.unmount();
      mounted = undefined;
    }
  });
});

describe('PartialRefunds：退款原因预设（AJ-400）', () => {
  it('选「其它」不写说明 → 提示且不进确认；补上说明后请求体是「其它：说明」', async () => {
    const { el, calls } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '1.00');
    await type(el.querySelector('select[aria-label="退款原因"]'), '其它');
    await click(button(el, '部分退款'));
    expect(el.querySelector('p.error')?.textContent).toContain('选「其它」时请写明原因');
    expect(button(el, '确认部分退款')).toBeNull();
    await type(el.querySelector('input[name="partial-reason"]'), '海关退运');
    await click(button(el, '部分退款'));
    await click(button(el, '确认部分退款'));
    expect(calls.find((c) => c.path.endsWith('/partial-refunds'))?.body).toEqual({
      amount_minor: 100,
      reason: '其它：海关退运',
    });
  });
});

/** AJ-410 / N28～N30：新手可用性。 */
describe('PartialRefunds：金额标签、可退额度、过期红字（AJ-410）', () => {
  it('一打开就显示"最多还能退 81.60 美元"；金额标签写中文币种，不写 USD', async () => {
    const { el } = await open();
    expect(el.textContent).toContain('最多还能退 81.60 美元');
    expect(el.textContent).toContain('金额（美元，最多两位小数）');
    expect(el.textContent).not.toContain('进审计台账');
  });

  it('🔴 选了退款原因后，旧的「请选择退款原因」立刻消失（N30）', async () => {
    const { el } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '10.50');
    await click(button(el, '部分退款'));
    expect(el.querySelector('p.error')?.textContent).toBe('请选择退款原因');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货');
    expect(el.querySelector('p.error')).toBeNull();
  });

  it('🔴 在金额框按回车 = 点「部分退款」（打开确认）；确认按钮上按回车不提交（N19 / N21）', async () => {
    const { el, calls } = await open();
    await type(el.querySelector('input[name="partial-amount"]'), '10.50');
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货');
    await pressEnter(el.querySelector('input[name="partial-amount"]'));
    const confirm = button(el, '确认部分退款');
    expect(confirm).not.toBeNull();
    expect(el.textContent).toContain('请用鼠标点击「确认部分退款」按钮');
    const prevented = await pressEnter(confirm);
    expect(prevented).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
