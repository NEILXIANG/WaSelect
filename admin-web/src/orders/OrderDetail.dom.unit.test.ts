// @vitest-environment jsdom
/**
 * 职责：订单详情的**组件行为**用例——退款提交**出错**之后页面怎么办（B41 残留 / AJ-230）。
 *
 * @why B41（AJ-215）把 202 的三种 outcome 说清楚了，但"机构确认失败"与"结果未知"走的不是 202：
 *      服务端先把订单提交为 `refunding`、再调机构，机构超时或报错时返回的是 5xx。
 *      前端落进 catch，只显示一句"服务器内部错误"，**不刷新详情**——
 *      页面仍显示"已付款"、发货按钮还能点，而库里这张单已经是"退款中"。
 *      运营看到的是"退款失败、订单没变"，最自然的下一步是去机构后台手工退——
 *      这正是 B41 要防的那件事，只是换了一条路径到达。
 *
 * @see ./OrderDetail.tsx；./view.ts（`refundFailureNotice`）；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OrderDetail } from './OrderDetail.js';

interface Call {
  path: string;
  method?: string;
}

let mounted: Mounted | undefined;
let calls: Call[];
/** 服务端此刻的订单状态（退款请求到达后由用例改写，模拟"第一段已提交"）。 */
let status: string;
let refundBehaviour: () => unknown;
let changed: number;

const order = () => ({
  order_id: 'o-1',
  order_no: 'W260930-ABC123',
  status,
  total_jpy: 9150,
  has_dispute: false,
  items: [],
  events: [],
});

async function open(): Promise<HTMLElement> {
  calls = [];
  changed = 0;
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.path.endsWith('/refund')) return refundBehaviour();
    return order();
  };
  mounted = await mount(
    createElement(OrderDetail, {
      api: api as never,
      id: 'o-1',
      source: null,
      onBack: () => undefined,
      onChanged: () => {
        changed += 1;
      },
    }),
  );
  return mounted.el;
}

const detailFetches = (): number =>
  calls.filter((c) => c.method !== 'POST' && c.path.endsWith('/orders/o-1')).length;

async function submitRefund(el: HTMLElement): Promise<void> {
  await type(el.querySelector('input[placeholder^="退款原因"]'), '缺货');
  await click(button(el, '退款'));
  await click(button(el, '确认退款'));
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('订单详情：退款提交出错之后（B41 残留 / AJ-230）', () => {
  it('🔴 机构超时（5xx）而订单已进入退款中：页面必须重新取详情，并明说"不要去机构后台手工退"', async () => {
    status = 'paid';
    refundBehaviour = () => {
      status = 'refunding'; // 第一段已提交
      throw new ApiError(50000, '服务器内部错误', 't-1');
    };
    const el = await open();
    const before = detailFetches();
    await submitRefund(el);

    expect(detailFetches()).toBe(before + 1); // 重新取了详情
    expect(changed).toBe(1); // 通知了列表
    expect(el.textContent).toContain('退款中');
    expect(el.textContent).toContain('不要去机构后台手工退款');
    // 错误本身仍要显示（带出服务端的话），且确认态已退出——不留一个还能再点的"确认退款"
    expect(el.querySelector('.error')?.textContent).toContain('服务器内部错误');
    expect(button(el, '确认退款')).toBeNull();
  });

  it('🔴 网络错误（结果未知）：同样重新取详情并给出同一条提醒', async () => {
    status = 'paid';
    refundBehaviour = () => {
      throw new ApiError(-1, '请求超时（15000ms）', '');
    };
    const el = await open();
    const before = detailFetches();
    await submitRefund(el);
    expect(detailFetches()).toBe(before + 1);
    expect(el.textContent).toContain('不要去机构后台手工退款');
  });

  it('业务性拒绝（4xx，如拒付中 40907）：订单没有被改动，不给"结果未知"的提醒，只显示原因', async () => {
    status = 'paid';
    refundBehaviour = () => {
      throw new ApiError(40907, '订单存在进行中的拒付，暂不可退款', 't-2');
    };
    const el = await open();
    await submitRefund(el);
    expect(el.querySelector('.error')?.textContent).toContain('拒付');
    expect(el.textContent).not.toContain('不要去机构后台手工退款');
  });

  it('成功（202 pending）：原有行为不变——提示"处理中"，刷新详情', async () => {
    status = 'paid';
    refundBehaviour = () => {
      status = 'refunding';
      return { order_id: 'o-1', outcome: 'pending' };
    };
    const el = await open();
    const before = detailFetches();
    await submitRefund(el);
    expect(detailFetches()).toBe(before + 1);
    expect(el.textContent).toContain('处理中');
    expect(el.querySelector('.error')).toBeNull();
  });
});
