// @vitest-environment jsdom
/**
 * 职责：订单时间线（事件 + 内部备注混排、追加备注）的组件用例（第一批⑤，AJ-396）。
 *
 * @why 必须走组件用例：`notes-view.ts` 的纯函数只能证明"混排算得对"，
 *      证明不了组件真的取了备注、真的把新追加的那条并进列表、取失败时主区没被挡住。
 */
import { TRACE_HINT } from '../ui/trace.js';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OrderTimeline } from './OrderTimeline.js';

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;
let calls: Call[];
let listBehaviour: () => unknown;
let errors: Array<[string, string | undefined]>;
let successes: string[];

const events = [
  { status: 'paid', at: '2026-10-08T01:00:00Z' },
  { status: 'shipped', at: '2026-10-08T03:00:00Z' },
];

async function open(evts: ReadonlyArray<Record<string, string>> = events): Promise<HTMLElement> {
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.method === 'POST') {
      return {
        note: {
          id: '9',
          author: 'admin:u-1',
          author_email: 'ops@example.com',
          body: (req.body as { body: string }).body,
          created_at: '2026-10-08T04:00:00Z',
        },
      };
    }
    return listBehaviour();
  };
  mounted = await mount(
    createElement(OrderTimeline, {
      api: api as never,
      orderId: 'o-1',
      events: evts,
      onError: (t, id) => errors.push([t, id]),
      onSuccess: (t) => successes.push(t),
    }),
  );
  return mounted.el;
}

beforeEach(() => {
  calls = [];
  errors = [];
  successes = [];
  listBehaviour = () => ({
    items: [
      {
        id: '1',
        author: 'admin:u-old',
        body: '买家微信说周五后再发',
        created_at: '2026-10-08T02:00:00Z',
      },
    ],
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('订单时间线（AJ-396）', () => {
  it('🔴 部分退款事件显示人话金额（500 日元 / $12.34），退款编号不进正文、只在悬停里（验收 2026-10-08）', async () => {
    const el = await open([
      { status: 'partial_refunded', note: 'rf-32d94f7e-1a2b:JPY:500', at: '2026-10-08T01:00:00Z' },
      { status: 'partial_refunded', note: 'rf-77aa:USD:1234', at: '2026-10-08T02:00:00Z' },
      { status: 'partial_failed', note: 'rf-88bb:provider_failed', at: '2026-10-08T03:00:00Z' },
    ]);
    const text = el.textContent ?? '';
    expect(text).toContain('部分退款成功 500 日元');
    expect(text).toContain('部分退款成功 $12.34');
    expect(text).toContain('部分退款失败 支付机构确认失败');
    expect(text).not.toContain('rf-');
    expect(text).not.toContain('JPY:500');
    const titles = [...el.querySelectorAll('[title]')].map((n) => n.getAttribute('title'));
    expect(titles).toContain('退款编号 rf-32d94f7e-1a2b');
  });

  it('🔴 事件与备注按时间混排；备注显示作者（无邮箱时显示 admin:<id>）', async () => {
    const el = await open();
    const text = el.textContent ?? '';
    const iPaid = text.indexOf('待发货');
    const iNote = text.indexOf('买家微信说周五后再发');
    const iShip = text.indexOf('已发货');
    expect(iPaid).toBeGreaterThanOrEqual(0);
    expect(iPaid).toBeLessThan(iNote);
    expect(iNote).toBeLessThan(iShip);
    expect(text).toContain('内部备注 · admin:u-old');
    expect(calls[0]?.path).toBe('/api/v1/admin/orders/o-1/notes');
  });

  it('🔴 追加备注：POST 去首尾空白的正文，新条目并进时间线（显示作者邮箱），草稿清空，不重取列表', async () => {
    const el = await open();
    const area = el.querySelector('textarea');
    await type(area, '  地址先不改\n等买家确认  ');
    await click(button(el, '添加备注'));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ body: '地址先不改\n等买家确认' });
    expect(el.textContent).toContain('内部备注 · ops@example.com');
    expect(el.textContent).toContain('等买家确认');
    expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(successes).toEqual(['备注已添加']);
    expect(calls.filter((c) => c.method !== 'POST')).toHaveLength(1);
  });

  it('只有空白时按钮不可点（不发请求）', async () => {
    const el = await open();
    await type(el.querySelector('textarea'), ' \u3000 ');
    expect(button(el, '添加备注')?.disabled).toBe(true);
  });

  it('🔴 取备注失败：时间线里行内报错带报障码，系统事件照常显示', async () => {
    listBehaviour = () => {
      throw new ApiError(50000, '服务器内部错误', 'trace-abc');
    };
    const el = await open();
    // AJ-410 / N5：报障码不再拼进红字，单独一行说明用途
    expect(el.querySelector('.error')?.textContent).toBe('服务器内部错误');
    expect(el.querySelector('.trace-line')?.textContent).toBe(`${TRACE_HINT}trace-abc`);
    expect(el.textContent).toContain('已发货');
  });

  it('🔴 ADM-1（AJ-466）：事件行显示操作者——管理员显示邮箱（没有邮箱时显示 admin:<id>）、支付机构 / 系统各有中文', async () => {
    const el = await open([
      { status: 'paid', at: '2026-10-08T01:00:00Z', actor: 'provider:stripe' },
      {
        status: 'shipped',
        at: '2026-10-08T03:00:00Z',
        actor: 'admin:u-1',
        actor_email: 'ops@example.com',
      },
      { status: 'shipment_fixed', at: '2026-10-08T04:00:00Z', actor: 'admin:u-2' },
      { status: 'expired', at: '2026-10-08T05:00:00Z', actor: 'job:expire-orders' },
    ]);
    const text = el.textContent ?? '';
    expect(text).toContain('ops@example.com');
    expect(text).toContain('admin:u-2');
    expect(text).toContain('支付机构');
    expect(text).toContain('系统');
  });
});
