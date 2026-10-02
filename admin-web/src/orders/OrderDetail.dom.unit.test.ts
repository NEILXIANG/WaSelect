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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OrderDetail } from './OrderDetail.js';

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;
let calls: Call[];
/** 服务端此刻的订单状态（退款请求到达后由用例改写，模拟"第一段已提交"）。 */
let status: string;
/** 服务端此刻的拒付锁（解除请求到达后由用例改写）。 */
let hasDispute: boolean;
let refundBehaviour: () => unknown;
let releaseBehaviour: () => unknown;
let changed: number;
/** 服务端此刻的事件流（状态文案用例会往里塞伪状态）。 */
let events: Array<Record<string, unknown>>;

const order = () => ({
  order_id: 'o-1',
  order_no: 'W260930-ABC123',
  status,
  total_jpy: 9150,
  has_dispute: hasDispute,
  items: [],
  events,
});

async function open(): Promise<HTMLElement> {
  calls = [];
  changed = 0;
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.path.endsWith('/refund')) return refundBehaviour();
    if (req.path.endsWith('/dispute/release')) return releaseBehaviour();
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

/** 按 label 取 `.field` 里那一格的值（详情页是 `<span class="label">名</span><span>值</span>`）。 */
function fieldText(el: HTMLElement, label: string): string {
  const field = [...el.querySelectorAll('.field')].find(
    (f) => f.querySelector('.label')?.textContent?.trim() === label,
  );
  const spans = [...(field?.querySelectorAll(':scope > span') ?? [])];
  return (spans[1]?.textContent ?? '').trim();
}

beforeEach(() => {
  events = [];
});

async function submitRefund(el: HTMLElement): Promise<void> {
  await type(el.querySelector('input[placeholder^="退款原因"]'), '缺货');
  await click(button(el, '退款'));
  await click(button(el, '确认退款'));
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/**
 * 「人工解除拒付限制」的组件行为（B1b / AJ-194 的前端落地，AJ-291）。
 *
 * @why 必须走组件用例：`view.ts` 的纯函数只能证明"闸门判得对"，
 *      证明不了"按钮挂上去了、点了真的打这个接口、成功之后真的刷新了"。
 *      而 AJ-194 这条欠账的**全部内容**就是"接口在、UI 不在"——
 *      只有组件级才守得住"将来有人把它摘掉"。
 */
describe('订单详情：人工解除拒付限制（AJ-291）', () => {
  const RELEASE_BTN = '人工解除拒付限制';

  beforeEach(() => {
    hasDispute = false;
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  it('🔴 没锁的订单**不出现**这个按钮（不可逆动作不能当试错）', async () => {
    status = 'paid';
    hasDispute = false;
    const el = await open();
    expect(button(el, RELEASE_BTN)).toBeNull();
  });

  it('🔴 锁着的订单：填理由 → 两步确认 → 打到 /dispute/release 且带 reason', async () => {
    status = 'paid';
    hasDispute = true;
    const el = await open();
    expect(button(el, RELEASE_BTN)).not.toBeNull();

    await type(el.querySelector('input[placeholder^="解除理由"]'), '机构已结案但漏发事件');
    await click(button(el, RELEASE_BTN));
    expect(button(el, '确认解除（不可撤销）'), '必须有第二步').not.toBeNull();
    // 第一步只是进入确认态，**不能**发出请求
    expect(calls.filter((c) => c.path.endsWith('/dispute/release'))).toHaveLength(0);

    await click(button(el, '确认解除（不可撤销）'));
    const posted = calls.filter((c) => c.path.endsWith('/dispute/release'));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toEqual({ reason: '机构已结案但漏发事件' });
  });

  it('🔴 理由为空 → 不发请求，只报错（无理由的解锁在审计里是一条说不清的记录）', async () => {
    status = 'paid';
    hasDispute = true;
    const el = await open();
    await click(button(el, RELEASE_BTN));
    await click(button(el, '确认解除（不可撤销）'));
    expect(calls.filter((c) => c.path.endsWith('/dispute/release'))).toHaveLength(0);
    expect(el.querySelector('.error')?.textContent).toContain('解除理由必填');
  });

  it('🔴 成功 → 刷新详情与列表，并明说"拒付没有结案"（否则运营会以为处理完就发货）', async () => {
    status = 'paid';
    hasDispute = true;
    releaseBehaviour = () => {
      hasDispute = false; // 服务端真的解开了
      return { order_id: 'o-1', has_dispute: false };
    };
    const el = await open();
    const before = detailFetches();
    await type(el.querySelector('input[placeholder^="解除理由"]'), '已与买家协商和好');
    await click(button(el, RELEASE_BTN));
    await click(button(el, '确认解除（不可撤销）'));

    expect(detailFetches()).toBe(before + 1);
    expect(changed).toBe(1);
    expect(el.textContent).toContain('没有结案');
    expect(el.textContent).toContain('不要因为按钮亮了就发');
    // 锁已解开 → 面板收起，不留一个还能再点的按钮
    expect(button(el, RELEASE_BTN)).toBeNull();
  });

  it('🔴 服务端 40902（本来就没锁）→ 显示服务端的话，**不**显示成功提示', async () => {
    status = 'paid';
    hasDispute = true;
    releaseBehaviour = () => {
      throw new ApiError(40902, '订单状态不允许此操作', 't-3');
    };
    const el = await open();
    await type(el.querySelector('input[placeholder^="解除理由"]'), '链断了');
    await click(button(el, RELEASE_BTN));
    await click(button(el, '确认解除（不可撤销）'));
    expect(el.querySelector('.error')?.textContent).toContain('不允许此操作');
    expect(el.textContent).not.toContain('没有结案');
  });
});

describe('订单详情：退款提交出错之后（B41 残留 / AJ-230）', () => {
  it('🔴 机构超时（5xx）而订单已进入退款中：页面必须重新取详情，并明说"不要去机构后台手工退"', async () => {
    status = 'paid';
    hasDispute = false;
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

/**
 * 🔴 回归：详情页的**中文化**（L4 浏览器验收 2026-10-02 发现）。
 *
 * @why 必须走组件用例：`view.unit.test.ts` 只能证明 `statusText` / `eventStatusText`
 *      两个纯函数算得对，证明不了**详情页真的调了它们**——
 *      而缺陷恰恰在 `.tsx` 里（模板直接写 `{order.status}`、`{e.status}`）。
 *      少这一层，"函数对但没被用上"会一直绿下去，正是 L4 抓到的那个形态。
 */
describe('订单详情：状态与事件流显示中文（管理端只需要中文）', () => {
  beforeEach(() => {
    hasDispute = false;
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  it('🔴 「状态」那一格显示中文，不显示服务端原文（缺陷注入点：改回 order.status 即红）', async () => {
    status = 'paid';
    const el = await open();
    expect(fieldText(el, '状态')).toBe('待发货');
    expect(fieldText(el, '状态')).not.toBe('paid');
  });

  it('🔴 已发货 / 待付款两态同样翻中文（同一个字段，同一条路径）', async () => {
    status = 'shipped';
    expect(fieldText(await opened(), '状态')).toBe('已发货');
  });

  it('🔴 事件流：订单状态值翻中文（缺陷注入点：改回 e.status 即红）', async () => {
    status = 'paid';
    events = [
      { status: 'created', at: '2026-10-01T00:00:00Z' },
      { status: 'pending_payment', at: '2026-10-01T00:01:00Z' },
      { status: 'paid', at: '2026-10-01T00:03:00Z' },
    ];
    const el = await open();
    const text = el.textContent ?? '';
    expect(text).toContain('待付款（未发起）');
    expect(text).toContain('待付款（支付中）');
    expect(text).toContain('待发货');
    // 原文不该再出现（"paid" 会混在别处吗？订单号/地址里没有它，所以这条站得住）
    expect(text).not.toContain('pending_payment');
  });

  it('🔴 事件流：管理事件伪状态翻中文（改址 / 拒付开案 / 退款失败）', async () => {
    status = 'paid';
    events = [
      {
        status: 'address_changed',
        note: '改址：改前地址已归档（#12）',
        at: '2026-10-01T01:00:00Z',
      },
      { status: 'dispute_opened', note: 'dp_1', at: '2026-10-01T02:00:00Z' },
      { status: 'refund_failed', note: 'provider_error', at: '2026-10-01T03:00:00Z' },
    ];
    const el = await open();
    const text = el.textContent ?? '';
    expect(text).toContain('改址');
    expect(text).toContain('拒付开案');
    expect(text).toContain('退款失败');
    // 认不出的才原样保留；这三个都在词表里，不该出现英文
    expect(text).not.toContain('address_changed');
    expect(text).not.toContain('dispute_opened');
    expect(text).not.toContain('refund_failed');
  });

  it('⚠️ 认不出的事件状态原样保留（"发生过什么事"这层信息不能被吃掉）', async () => {
    status = 'paid';
    events = [{ status: 'some_future_event', note: 'x', at: '2026-10-01T04:00:00Z' }];
    const el = await open();
    expect(el.textContent).toContain('some_future_event');
    expect(el.textContent).not.toContain('未知状态');
  });
});

/** `open()` 后直接拿到根元素（供单行断言用）。 */
async function opened(): Promise<HTMLElement> {
  return open();
}
