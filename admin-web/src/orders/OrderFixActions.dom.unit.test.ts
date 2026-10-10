// @vitest-environment jsdom
/**
 * 订单修正（AJ-386）：取消未付单 / 改运单号——两步确认后请求体正确，运单号认不出时给核对提示。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OrderFixActions } from './OrderFixActions.js';

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

async function open(order: unknown, resp: unknown = {}) {
  const calls: Call[] = [];
  const notices: string[] = [];
  const done = { n: 0 };
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    return resp;
  };
  mounted = await mount(
    createElement(OrderFixActions, {
      api: api as never,
      orderId: 'o-1',
      order,
      onDone: () => {
        done.n += 1;
      },
      onError: () => undefined,
      onNotice: (m: string) => notices.push(m),
    }),
  );
  return { el: mounted.el, calls, notices, done };
}

describe('OrderFixActions', () => {
  it('已付款 / 已签收的单：整块不渲染', async () => {
    const { el } = await open({ status: 'paid' });
    expect(el.textContent).toBe('');
  });

  it('🔴 未付单取消：原因必填 → 二次确认 → POST /cancel {reason}，刷新详情', async () => {
    const { el, calls, notices, done } = await open({ status: 'pending_payment' });
    await click(button(el, '取消订单（未付款）'));
    await click(button(el, '取消这张订单'));
    expect(el.textContent).toContain('取消原因必填');
    expect(calls).toHaveLength(0);
    await type(el.querySelector('input'), '价格录错');
    await click(button(el, '取消这张订单'));
    await click(button(el, '确认'));
    expect(calls[0]).toMatchObject({
      path: '/api/v1/admin/orders/o-1/cancel',
      method: 'POST',
      body: { reason: '价格录错' },
    });
    expect(done.n).toBe(1);
    expect(notices.at(-1)).toContain('已取消');
    expect(notices[0]).toBe(''); // 提交前先清掉上一个动作的提示
  });

  it('🔴 改运单号：预填现值 → PATCH /shipment；服务端认不出形状 → 提示核对', async () => {
    const { el, calls, notices } = await open(
      { status: 'shipped', carrier: 'EMS', tracking_no: 'EM12345678JP' },
      { tracking_recognized: false },
    );
    await click(button(el, '修改运单号'));
    const inputs = el.querySelectorAll('input');
    expect((inputs[1] as HTMLInputElement).value).toBe('EM12345678JP');
    await type(inputs[1], 'EM123456789JP');
    await type(inputs[2], '少录一位');
    await click(button(el, '保存运单号'));
    await click(button(el, '确认'));
    expect(calls[0]).toMatchObject({
      path: '/api/v1/admin/orders/o-1/shipment',
      method: 'PATCH',
      body: { carrier: 'EMS', tracking_no: 'EM123456789JP', reason: '少录一位' },
    });
    expect(notices.at(-1)).toContain('核对');
    // 确认那一步就提示形状认不出（发邮件之前）
    expect(el.textContent).not.toContain('形状认不出'); // 已提交后确认区收起
  });

  it('🔴 撤销发货（AJ-440）：原因必填 → 二次确认写明会发更正邮件 → POST /shipment/revert {reason}', async () => {
    const { el, calls, notices, done } = await open({
      status: 'shipped',
      carrier: 'EMS',
      tracking_no: 'EM123456789JP',
      shipped_at: new Date(Date.now() - 3_600_000).toISOString(),
      after_sales: [],
    });
    await click(button(el, '撤销发货'));
    await click(button(el, '撤销这次发货'));
    expect(el.textContent).toContain('撤销原因必填');
    expect(calls).toHaveLength(0);
    await type(el.querySelector('input'), '点错单，还没打包');
    await click(button(el, '撤销这次发货'));
    expect(el.textContent).toContain('更正邮件');
    await click(button(el, '确认'));
    expect(calls[0]).toMatchObject({
      path: '/api/v1/admin/orders/o-1/shipment/revert',
      method: 'POST',
      body: { reason: '点错单，还没打包' },
    });
    expect(done.n).toBe(1);
    expect(notices.at(-1)).toContain('已撤销发货');
  });

  it('撤销发货超过 72 小时：按钮禁用并写明原因，引导去改运单号', async () => {
    const { el } = await open({
      status: 'shipped',
      carrier: 'EMS',
      tracking_no: 'EM123456789JP',
      shipped_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
    });
    const b = button(el, '撤销发货') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(el.textContent).toContain('72 小时');
  });
});
