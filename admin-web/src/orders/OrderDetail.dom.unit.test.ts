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
import { OTHER_CARRIER } from './carrier.js';
import { saveLastCarrier } from './last-carrier.js';
import { pressEnter } from '../testing/keys.js';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { OrderDetail } from './OrderDetail.js';

/**
 * 承运商改成下拉（AJ-410 / N18，默认 Japan Post EMS）后，填别的承运商要先选「其他（手动填写）」再打字。
 */
async function chooseCarrier(el: Element, text: string): Promise<void> {
  await type(el.querySelector('.drawer select'), OTHER_CARRIER);
  await type(el.querySelector('input[aria-label="承运商名称"]'), text);
}

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
/** 服务端此刻的行项目（采购信息用例会往里塞 title_ja / jan_code / purchase_source）。 */
let items: Array<Record<string, unknown>>;

/** 用例可往里塞物流 / 金额拆分 / 改址历史等字段（A-9 / A-4，AJ-467）。 */
let extra: Record<string, unknown>;
const order = () => ({
  order_id: 'o-1',
  order_no: 'W260930-ABC123',
  status,
  total_jpy: 9150,
  has_dispute: hasDispute,
  items,
  events,
  ...extra,
});

async function open(): Promise<HTMLElement> {
  calls = [];
  changed = 0;
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.path.endsWith('/refund')) return refundBehaviour();
    if (req.path.endsWith('/dispute/release')) return releaseBehaviour();
    // 第一批⑤（AJ-396）：时间线自己取备注；本文件不测备注，回空列表
    if (req.path.endsWith('/notes')) return { items: [] };
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
  // AJ-473：单单发货也会记住上次的承运商（localStorage），用例之间不能互相带默认值
  globalThis.localStorage?.clear();
  events = [];
  items = [];
  extra = {};
});

async function submitRefund(el: HTMLElement): Promise<void> {
  // AJ-398：表单收进抽屉，先点操作条上的「全额退款…」打开它
  await click(button(el, '全额退款…'));
  await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设下拉
  // 第一批①：「退款」只打开确认弹层，「确认退款」在弹层里
  await click(button(el, '退款'));
  await click(button(el, '确认退款'));
}

/**
 * 失败提示的文本（第一批①：改走右下角 Toast，页面里不再有 `<p class="error">`）。
 * @why 只取 `.toast-error` 而不是整页 textContent：整页里还有"发货前改址"等常驻文案，
 *      用整页文本断言"显示了错误"会把常驻文案也算进去——那就是一条永远不会红的断言。
 */
function errorToastText(el: HTMLElement): string {
  return [...el.querySelectorAll('.toast-error')].map((t) => t.textContent ?? '').join('\n');
}

/** 全部提示的文本（含成功 / 信息）。 */
function toastText(el: HTMLElement): string {
  return [...el.querySelectorAll('.toast')].map((t) => t.textContent ?? '').join('\n');
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
    expect(button(el, '解除拒付限制…')).toBeNull();
    expect(button(el, RELEASE_BTN)).toBeNull();
  });

  it('🔴 锁着的订单：填理由 → 两步确认 → 打到 /dispute/release 且带 reason', async () => {
    status = 'paid';
    hasDispute = true;
    const el = await open();
    await click(button(el, '解除拒付限制…'));
    expect(button(el, RELEASE_BTN)).not.toBeNull();

    await type(el.querySelector('input[name="release-reason"]'), '机构已结案但漏发事件');
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
    await click(button(el, '解除拒付限制…'));
    // 第一批①：校验不过就**进不去弹层**——连"确认解除"这个按钮都不会出现
    await click(button(el, RELEASE_BTN));
    expect(button(el, '确认解除（不可撤销）')).toBeNull();
    expect(calls.filter((c) => c.path.endsWith('/dispute/release'))).toHaveLength(0);
    expect(errorToastText(el)).toContain('解除理由必填');
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
    await click(button(el, '解除拒付限制…'));
    await type(el.querySelector('input[name="release-reason"]'), '已与买家协商和好');
    await click(button(el, RELEASE_BTN));
    await click(button(el, '确认解除（不可撤销）'));

    expect(detailFetches()).toBe(before + 1);
    expect(changed).toBe(1);
    expect(el.textContent).toContain('没有结案');
    expect(el.textContent).toContain('不要因为按钮亮了就发');
    // 锁已解开 → 抽屉收起、操作条上的入口也消失，不留一个还能再点的按钮
    expect(button(el, RELEASE_BTN)).toBeNull();
    expect(button(el, '解除拒付限制…')).toBeNull();
  });

  it('🔴 服务端 40902（本来就没锁）→ 显示服务端的话，**不**显示成功提示', async () => {
    status = 'paid';
    hasDispute = true;
    releaseBehaviour = () => {
      throw new ApiError(40902, '订单状态不允许此操作', 't-3');
    };
    const el = await open();
    await click(button(el, '解除拒付限制…'));
    await type(el.querySelector('input[name="release-reason"]'), '链断了');
    await click(button(el, RELEASE_BTN));
    await click(button(el, '确认解除（不可撤销）'));
    expect(errorToastText(el)).toContain('不允许此操作');
    expect(toastText(el)).not.toContain('没有结案');
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
    // P2-49：刷新后是「退款中」且没有"机构确认失败"事件 → 按"结果未知"说，指明不要去 Stripe 后台重复退
    expect(el.textContent).toContain('结果未知');
    expect(el.textContent).toContain('不要去 Stripe 后台重复退');
    // 错误本身仍要显示（带出服务端的话），且弹层已关闭——不留一个还能再点的"确认退款"
    expect(errorToastText(el)).toContain('服务器内部错误');
    expect(button(el, '确认退款')).toBeNull();
    // 第一批①：错误 Toast 还带着报障码（traceId），报障时能按它检索日志
    expect(errorToastText(el)).toContain('t-1');
  });

  it('P2-49 刷新后发现机构已确认失败（refund_failed provider_failed:…）→ 说可重新发起', async () => {
    status = 'paid';
    refundBehaviour = () => {
      status = 'refunding';
      events = [
        { status: 'refund_failed', note: 'provider_failed:re_3Q', at: '2026-10-06T01:00:00Z' },
      ];
      throw new ApiError(50000, '服务器内部错误', 't-3');
    };
    const el = await open();
    await submitRefund(el);
    expect(el.textContent).toContain('机构确认失败');
    expect(el.textContent).not.toContain('不要去 Stripe 后台重复退');
  });

  it('P2-49 50300（熔断，请求未发出）→ 带 retry_after_ms 的秒数', async () => {
    status = 'paid';
    refundBehaviour = () => {
      throw new ApiError(50300, '服务暂时不可用', 't-4', { data: { retry_after_ms: 8000 } });
    };
    const el = await open();
    await submitRefund(el);
    expect(el.textContent).toContain('上游暂时不可用，请求未发出，约 8 秒后可重试');
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
    expect(errorToastText(el)).toContain('拒付');
    expect(toastText(el)).not.toContain('不要去机构后台手工退款');
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
    expect(toastText(el)).toContain('处理中');
    expect(el.querySelector('.toast-error')).toBeNull();
    // 第一批①：pending 这一档带 sticky（写的是"下一步怎么办"，不能 3 秒就消失）
    expect(el.querySelector('.toast-info')).not.toBeNull();
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

  it('🔴 已发货一态翻中文（待付款见下一条；原标题写"两态"却只测这一态，2026-10-09 审计改名）', async () => {
    status = 'shipped';
    expect(fieldText(await open(), '状态')).toBe('已发货');
  });

  it('🔴 待付款一态也翻中文（与上一条合起来覆盖原先声称的两态）', async () => {
    status = 'pending_payment';
    const el = await open();
    expect(fieldText(el, '状态')).toBe('买家正在付款');
    expect(fieldText(el, '状态')).not.toBe('pending_payment');
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
    // AJ-410 / N15：文案改白话；全入口点击测试 2026-10-11 起时间线用事件词（状态格仍是状态词）
    expect(text).toContain('下单（等待买家付款）');
    expect(text).toContain('发起付款');
    expect(text).not.toContain('买家发起付款'); // 操作人列已写「买家」
    expect(text).toContain('付款成功（待发货）');
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

/**
 * 商品行的**采购信息**（D-39 待采购清单 / 迁移 021）。
 *
 * @why 必须走组件用例：`view.ts` 的 `purchaseLine` 只能证明"文案拼得对"，
 *      证明不了它**被挂到了详情页的商品表格上**。
 *      而这条欠账的形态正是"数据有了、UI 没接"——纯函数全绿、页面上一个字都没有。
 */
describe('订单详情：商品行显示采购信息（D-39）', () => {
  beforeEach(() => {
    status = 'paid';
    hasDispute = false;
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  it('🔴 三样齐全 → 页面上真能看到日文原名 / JAN / 采购来源', async () => {
    items = [
      {
        product_id: 'p-1',
        title: '南部鉄器 急須',
        qty: 2,
        unit_price_jpy: 8800,
        title_ja: '南部鉄器 急須 0.6L',
        jan_code: '4901234567890',
        purchase_source: '楽天 南部鉄器本店',
      },
    ];
    const el = await open();
    const row = el.querySelector('.row-sub');
    expect(row?.textContent ?? '').toContain('南部鉄器 急須 0.6L');
    expect(row?.textContent ?? '').toContain('4901234567890');
    expect(row?.textContent ?? '').toContain('楽天 南部鉄器本店');
  });

  it('🔴 长商品名最多两行（clamp-2），悬停看全文（全入口点击测试 2026-10-12）', async () => {
    const long =
      '北海道限定 富良野薰衣草 十胜红豆 夕张蜜瓜 白色恋人 六花亭 ROYCE 生巧 综合伴手礼 超大礼盒'.repeat(
        3,
      );
    items = [{ product_id: 'p-1', title: long, qty: 1, unit_price_jpy: 6800 }];
    const el = await open();
    const name = el.querySelector('.item-name');
    expect(name?.className).toContain('clamp-2');
    expect(name?.getAttribute('title')).toBe(long);
    expect(name?.textContent).toBe(long);
  });

  it('🔴 历史订单（三样都没有）→ 说清"建于采购信息录入之前"，而不是留白', async () => {
    items = [{ product_id: 'p-1', title: '南部鉄器 急須', qty: 1, unit_price_jpy: 8800 }];
    const el = await open();
    const row = el.querySelector('.row-sub');
    expect(row?.textContent ?? '').toContain('未记录采购信息');
    expect(row?.textContent ?? '').toContain('建于采购信息录入之前');
  });

  it('每一行商品都有自己那一行采购信息（行数对得上，不会串行）', async () => {
    items = [
      { product_id: 'p-1', title: 'A', qty: 1, unit_price_jpy: 100, jan_code: '1111111111111' },
      { product_id: 'p-2', title: 'B', qty: 2, unit_price_jpy: 200, jan_code: '2222222222222' },
    ];
    const el = await open();
    const rows = [...el.querySelectorAll('.row-sub')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent ?? '').toContain('1111111111111');
    expect(rows[1]?.textContent ?? '').toContain('2222222222222');
  });
});

/**
 * 从列表点进详情时改址表单要预填当前地址（A-02）。
 * @why 详情先用列表快照（没有 address 字段）渲染一帧，改址表单的 useState 只在首次挂载取值，
 *      详情回来后不会重新预填——7 格全空，只改电话也得重打整个地址。
 */
describe('订单详情：改址表单预填（A-02）', () => {
  it('🔴 source 是列表形状（无地址）→ 详情回来后表单预填详情里的地址', async () => {
    status = 'paid';
    hasDispute = false;
    const address = {
      recipient: 'Jane Doe',
      phone: '+14155550123',
      line1: '1 Main St',
      line2: '',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94105',
      country: 'US',
    };
    const api = async (): Promise<unknown> => ({ ...order(), address });
    mounted = await mount(
      createElement(OrderDetail, {
        api: api as never,
        id: 'o-1',
        source: { order_id: 'o-1', order_no: 'W260930-ABC123', status: 'paid', total_jpy: 9150 },
        onBack: () => undefined,
        onChanged: () => undefined,
      }),
    );
    await flush();
    // 两端逐页走查 2026-10-12：右栏的收货地址按美国写法，另有收件人电话（原先没有，贴面单要去别处找）
    expect(mounted.el.textContent).toContain('Jane Doe, 1 Main St, San Francisco, CA 94105');
    expect(mounted.el.textContent).toContain('收件人电话+1 (415) 555-0123');
    await click(button(mounted.el, '改址…'));
    const values = [...mounted.el.querySelectorAll('input')].map((i) => i.value);
    expect(values).toContain('Jane Doe');
    expect(values).toContain('1 Main St');
  });
});

describe('订单详情：发货两步确认（P2-51）', () => {
  beforeEach(() => {
    hasDispute = false;
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  const shipPosts = (): Call[] => calls.filter((c) => c.path.endsWith('/ship'));

  it('🔴 点「发货」只打开确认弹层、不发请求；弹层里必须重打运单号才发', async () => {
    status = 'paid';
    const el = await open();
    await click(button(el, '发货…'));
    await chooseCarrier(el, 'Japan Post');
    await type(el.querySelector('input[name="tracking_no"]'), 'EJ123456789JP');
    await click(button(el, '发货'));
    expect(shipPosts()).toHaveLength(0);

    // 第一批①：核对内容搬进弹层（此前是页面内一行「核对：…」）
    const dialogText = el.querySelector('.dialog')?.textContent ?? '';
    expect(dialogText).toContain('Japan Post');
    expect(dialogText).toContain('EJ123456789JP');

    // ❗ 关键不变量：**不重打运单号就发不出去**（运单号是从邮件里复制来的，看一遍看不出首尾错字）
    expect(button(el, '确认发货')?.disabled, '没重打运单号时主按钮必须是禁用的').toBe(true);
    // 打错一个字同样不放行（否则"重打"形同虚设）
    await type(el.querySelector('.dialog input'), 'EJ123456789J');
    expect(button(el, '确认发货')?.disabled).toBe(true);
    expect(shipPosts()).toHaveLength(0);

    await type(el.querySelector('.dialog input'), 'EJ123456789JP');
    await click(button(el, '确认发货'));
    expect(shipPosts()).toHaveLength(1);
    expect(shipPosts()[0]?.body).toEqual({ carrier: 'Japan Post', tracking_no: 'EJ123456789JP' });
  });

  /** @why 服务端按归一值落库（AJ-410 / N20a）：确认框按同一口径比，并把"会保存成什么"显示出来。 */
  it('🔴 重打运单号按归一后比对：表单里写 `em 123456789 jp`、确认框打 `em123456789JP` 也放行', async () => {
    status = 'paid';
    const el = await open();
    await click(button(el, '发货…'));
    await chooseCarrier(el, 'Japan Post');
    await type(el.querySelector('input[name="tracking_no"]'), 'em 123456789 jp');
    await click(button(el, '发货'));
    expect(el.querySelector('.dialog')?.textContent ?? '').toContain('EM123456789JP');
    await type(el.querySelector('.dialog input'), 'em123456789JP');
    expect(button(el, '确认发货')?.disabled).toBe(false);
  });

  it('🔴 运单号形状认不出时，**确认之前**就提示（发货邮件随确认发出，事后提示已晚；三端联动模拟 2026-10-08）', async () => {
    status = 'paid';
    const el = await open();
    await click(button(el, '发货…'));
    await chooseCarrier(el, 'Japan Post EMS');
    await type(el.querySelector('input[name="tracking_no"]'), 'EM12345678JP'); // 少一位
    // 第一批①：警告在**表单里**就显示，不必先点「发货」（点发货会打开弹层，那时才提示已晚）
    expect(el.textContent).toContain('形状认不出');
    await click(button(el, '发货'));
    expect(el.textContent).toContain('形状认不出');
    expect(shipPosts()).toHaveLength(0);
    await type(el.querySelector('input[name="tracking_no"]'), 'EM123456789JP');
    expect(el.textContent).not.toContain('形状认不出');
  });
});

/**
 * 第一批④：**双栏**布局（对标报告 §4.2 的 P0）。
 *
 * @why 这两条断言守的是"读"与"写"分家：所有写操作必须活在 `.detail-actions` 里，
 *      商品表必须活在 `.detail-main` 里。一旦有人把发货表单挪回主区那一列，
 *      布局变了但没有任何已有用例会响——规格就只剩下口头约定。
 */
describe('订单详情双栏（第一批④）', () => {
  it('🔴 商品表在主区、写操作按钮在操作区，两个容器分开存在', async () => {
    items = [{ title: '越光米 5kg', qty: 1, unit_price_jpy: 2980 }];
    const el = await open();
    const main = el.querySelector('.detail-main');
    const aside = el.querySelector('.detail-actions');
    expect(main, '缺少主区容器 .detail-main').not.toBeNull();
    expect(aside, '缺少操作区容器 .detail-actions').not.toBeNull();
    // 商品表在主区（联读的地方）
    expect(main?.querySelector('table.table')).not.toBeNull();
    // 操作区里至少有一个写操作按钮
    expect(aside?.querySelectorAll('button').length ?? 0).toBeGreaterThan(0);
  });

  it('🔴 操作区**不**嵌在主区里（嵌套等于没分栏）', async () => {
    const el = await open();
    expect(el.querySelector('.detail-main .detail-actions')).toBeNull();
    expect(el.querySelector('.detail-actions .detail-main')).toBeNull();
  });
});

/**
 * AJ-398：写操作收进抽屉。
 * @why 守"抽屉成功后关上"与"有内容时关抽屉要先问"两件事——前者不守，发货成功后抽屉里还摆着一个空表单；
 *      后者不守，误点遮罩就把填好的运单号丢了。
 */
describe('订单详情：操作抽屉（AJ-398）', () => {
  beforeEach(() => {
    status = 'paid';
    hasDispute = false;
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  it('打开「发货…」抽屉 → 填写 → 确认 → 发出请求，抽屉关闭', async () => {
    const el = await open();
    expect(el.querySelector('.drawer'), '未点之前不该有抽屉').toBeNull();
    await click(button(el, '发货…'));
    expect(el.querySelector('.drawer')).not.toBeNull();
    // AJ-410 / N18：承运商是下拉、默认 Japan Post EMS——不动它直接填运单号（原为手填 'Japan Post'）
    await type(el.querySelector('.drawer input[name="tracking_no"]'), 'EJ123456789JP');
    await click(button(el, '发货'));
    await type(el.querySelector('.dialog input'), 'EJ123456789JP');
    await click(button(el, '确认发货'));
    const posts = calls.filter((c) => c.path.endsWith('/ship'));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ carrier: 'Japan Post EMS', tracking_no: 'EJ123456789JP' });
    expect(el.querySelector('.drawer'), '成功后抽屉应关闭').toBeNull();
    expect(toastText(el)).toContain('已发货');
  });

  // 全入口点击测试 2026-10-11：订单修正抽屉原标题"取消订单 / 修改运单号 / 撤销发货"——已发货的单只有后两项，标题许诺了做不到的；
  // 且标题太长把「关闭」挤到下一行。改为"订单修正"，里面按单子状态列出能做的
  it('🔴 已发货的单打开「订单修正…」→ 抽屉标题是"订单修正"，不再列出做不到的"取消订单"', async () => {
    status = 'shipped';
    const el = await open();
    await click(button(el, '订单修正…'));
    expect(el.querySelector('.drawer-wrap')?.getAttribute('aria-label')).toBe('订单修正');
  });

  // 两端逐页走查第三轮 2026-10-12（造了待付款单才走到）：操作区说"未付款，请取消订单而不是退款"，
  //   取消却藏在「订单修正…」里——未付款的单里那个抽屉只有"取消订单"一项
  it('🔴 未付款的单：按钮直接叫「取消订单…」、抽屉标题"取消订单"；没有「订单修正…」', async () => {
    status = 'created';
    const el = await open();
    expect(button(el, '订单修正…')).toBeNull();
    await click(button(el, '取消订单…'));
    expect(el.querySelector('.drawer-wrap')?.getAttribute('aria-label')).toBe('取消订单');
  });

  // 全入口点击测试 2026-10-11：抽屉里先写要退多少（原先只有原因与按钮，金额要回页面找）
  it('🔴 打开全额退款抽屉 → 先看到「退款金额」', async () => {
    const el = await open();
    await click(button(el, '全额退款…'));
    expect(el.querySelector('.drawer .refund-amount')?.textContent).toMatch(/^退款金额：/);
  });

  it('填了内容再点「关闭」→ 先问「放弃修改」；确认后才关', async () => {
    const el = await open();
    await click(button(el, '全额退款…'));
    await type(el.querySelector('select[aria-label="退款原因"]'), '缺货'); // AJ-400：预设下拉
    await click(button(el, '关闭'));
    expect(el.querySelector('.drawer'), '有内容时不能直接关').not.toBeNull();
    await click(button(el, '放弃修改'));
    expect(el.querySelector('.drawer')).toBeNull();
  });

  // AJ-427：服务端对「缺货」不回补库存——运营在点之前就要知道，补货了得自己去商品管理改
  it('🔴 退款原因选「缺货」→ 抽屉里说明"不会把库存加回去"；换成「破损」→ 说明消失', async () => {
    const el = await open();
    await click(button(el, '全额退款…'));
    const select = el.querySelector('select[aria-label="退款原因"]');
    await type(select, '缺货');
    expect(el.querySelector('.drawer')?.textContent).toContain('不会把库存加回去');
    await type(select, '破损');
    expect(el.querySelector('.drawer')?.textContent).not.toContain('不会把库存加回去');
  });
});

describe('详情页头的状态徽章（AJ-400）', () => {
  it('待发货 + 拒付中：页头出「已付款」「待发货」「拒付中」三枚，色调各自对应', async () => {
    status = 'paid';
    hasDispute = true;
    const el = await open();
    const badges = [...el.querySelectorAll('[aria-label="订单状态徽章"] .badge')].map((b) => [
      b.textContent,
      b.className,
    ]);
    expect(badges).toEqual([
      ['已付款', 'badge badge-success'],
      ['待发货', 'badge badge-warn'],
      ['拒付中', 'badge badge-danger'],
    ]);
  });
});

describe('订单详情操作条：主按钮每屏只留一个（对标 §238，验收 2026-10-08）', () => {
  const solid = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('.action-bar .btn')]
      .filter((b) => !/btn-secondary|btn-danger-outline/.test(b.className))
      .map((b) => (b.textContent ?? '').trim());

  beforeEach(() => {
    hasDispute = false;
    events = [];
    items = [];
    refundBehaviour = () => ({ order_id: 'o-1', outcome: 'succeeded' });
    releaseBehaviour = () => ({ order_id: 'o-1', has_dispute: false });
  });

  it('待发货：只有「发货…」实心；全额退款是红色描边，不是实心红', async () => {
    status = 'paid';
    const el = await open();
    expect(solid(el)).toEqual(['发货…']);
    expect(button(el, '全额退款…')?.className).toBe('btn btn-danger-outline');
    expect(el.querySelector('.action-bar .btn-danger')).toBeNull();
  });

  it('已发货：没有往前推的动作 → 操作条上没有实心按钮', async () => {
    status = 'shipped';
    const el = await open();
    expect(el.querySelectorAll('.action-bar .btn').length).toBeGreaterThan(0);
    expect(solid(el)).toEqual([]);
  });

  // 三端模拟测试 2026-10-11：已签收的拒付单，操作区写着"发货：有拒付进行中，先处理拒付再发货"——货早发了，这句只会让人困惑
  it('🔴 只有待发货的单才解释"为什么不能发货"；已发出 / 已关的单不出这行', async () => {
    status = 'delivered';
    hasDispute = true;
    const el = await open();
    expect(el.textContent).not.toContain('发货：');
    await mounted?.unmount();
    mounted = undefined;
    status = 'paid';
    hasDispute = true;
    const el2 = await open();
    expect(el2.textContent).toContain('发货：有拒付进行中');
  });
});

/** AJ-410（新手走查）：发货抽屉的标签 / 焦点 / 回车，确认框的回车，技术编号的位置，改址红字。 */
describe('订单详情：新手可用性（AJ-410）', () => {
  beforeEach(() => {
    hasDispute = false;
    status = 'paid';
  });

  it('发货抽屉：输入框上方有真标签；打开即聚焦承运商下拉，默认 Japan Post EMS（日本邮政）；运单号下有找单号的说明', async () => {
    const el = await open();
    await click(button(el, '发货…'));
    const drawer = el.querySelector('.drawer') as HTMLElement;
    const labels = [...drawer.querySelectorAll('label.label')].map((l) => l.textContent);
    expect(labels).toEqual(['承运商（快递公司）', '运单号']);
    const select = drawer.querySelector('select') as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    expect(select.selectedOptions[0]?.textContent).toBe('Japan Post EMS（日本邮政）');
    expect([...select.options].map((o) => o.textContent)).toContain('其他（手动填写）');
    expect(drawer.textContent).toContain('在邮局给的单据上，例：EM123456789JP');
  });

  it('🔴 运单号框里按回车 = 点「发货」：只打开确认框、不发请求；确认框里按回车不确认，并提示用鼠标点', async () => {
    const el = await open();
    await click(button(el, '发货…'));
    const tracking = el.querySelector('.drawer input[name="tracking_no"]');
    await type(tracking, 'EM123456789JP');
    await pressEnter(tracking);
    expect(el.querySelector('.dialog')).not.toBeNull();
    expect(calls.filter((c) => c.path.endsWith('/ship'))).toHaveLength(0);
    // 确认框：先把运单号重打对（让主按钮可点），再按回车——仍不应发货
    const confirmInput = el.querySelector('.dialog input');
    await type(confirmInput, 'EM123456789JP');
    expect(button(el, '确认发货')?.disabled).toBe(false);
    expect(await pressEnter(confirmInput)).toBe(true);
    expect(await pressEnter(button(el, '确认发货'))).toBe(true);
    expect(calls.filter((c) => c.path.endsWith('/ship'))).toHaveLength(0);
    expect(el.querySelector('.dialog')?.textContent).toContain(
      '请用鼠标点击「确认发货」按钮（按回车不会确认）',
    );
  });

  it('内部编号不在订单号旁边，而在页底折叠的「技术信息」里（N14）', async () => {
    const el = await open();
    const labels = [...el.querySelectorAll('.detail-main .label')].map((l) => l.textContent);
    expect(labels.some((t) => (t ?? '').includes('内部'))).toBe(false);
    const tech = el.querySelector('details.tech-info');
    expect(tech?.querySelector('summary')?.textContent).toBe('技术信息（排查问题时给技术人员看）');
    expect(tech?.textContent).toContain('o-1');
  });

  it('🔴 改址：点保存报了"必填"后，改那一格红字立刻消失（N30）', async () => {
    const el = await open();
    await click(button(el, '改址…'));
    const recipient = el.querySelector('#addr-recipient');
    await type(recipient, '');
    await click(button(el, '保存新地址'));
    const field = recipient?.closest('.field');
    expect(field?.querySelector('.error')).not.toBeNull();
    await type(recipient, 'Jane Doe');
    expect(field?.querySelector('.error')).toBeNull();
  });

  describe('A-9 / A-4（AJ-467）：详情页物流块、金额拆分、改址历史；找不到的单给空态', () => {
    it('🔴 已发货的单：物流块显示承运商 / 运单号 / 发货时间与查件链接；金额拆成商品 / 运费 / 关税 / 实付', async () => {
      status = 'shipped';
      extra = {
        carrier: 'Japan Post EMS',
        tracking_no: 'EJ123456789JP',
        tracking_url: 'https://trackings.post.japanpost.jp/x',
        shipped_at: '2026-10-09T01:00:00Z',
        items_jpy: 8000,
        shipping_jpy: 1150,
        duty_jpy: 600,
        payment: { channel: 'stripe', charge_currency: 'USD', charge_amount: 6120 },
      };
      const el = await open();
      expect(fieldText(el, '物流')).toContain('EJ123456789JP');
      expect(fieldText(el, '物流')).toContain('Japan Post EMS');
      expect(el.querySelector('a[href="https://trackings.post.japanpost.jp/x"]')).not.toBeNull();
      expect(fieldText(el, '商品合计')).toBe('8,000 日元');
      expect(fieldText(el, '运费')).toBe('1,150 日元');
      // MP-11 同口径（第二轮审计浏览器验收）：关税挂在商品合计下面说"其中"，不与运费并列成第三笔
      expect(fieldText(el, '其中预估关税（含在商品价内）')).toBe('600 日元');
      expect(fieldText(el, '买家实付')).toContain('$61.20');
      const labels = [...el.querySelectorAll('.row2 .field .label')].map((n) => n.textContent);
      expect(labels.indexOf('其中预估关税（含在商品价内）')).toBe(labels.indexOf('商品合计') + 1);
    });

    it('🔴 改过地址：显示改址历史（改前收件人与地址、谁、何时）；没改过不显示该块', async () => {
      extra = {
        address_history: [
          {
            id: 7,
            snapshot: {
              recipient: 'Jane Doe',
              line1: '1 Infinite Loop',
              city: 'Cupertino',
              state: 'CA',
              postal_code: '95014',
              country: 'US',
            },
            actor: 'admin:u-1',
            at: '2026-10-09T02:00:00Z',
          },
        ],
      };
      const el = await open();
      expect(el.textContent).toContain('改址历史');
      expect(el.textContent).toContain('Jane Doe');
      expect(el.textContent).toContain('1 Infinite Loop');
      await mounted?.unmount();
      extra = { address_history: [] };
      const el2 = await open();
      expect(el2.textContent).not.toContain('改址历史');
    });

    it('🔴 G7：订单不存在（40400）→ 页面给"找不到这张订单"空态与返回入口，不是一片空白', async () => {
      calls = [];
      const api = async (req: Call): Promise<unknown> => {
        calls.push(req);
        if (req.path.endsWith('/notes')) return { items: [] };
        throw new ApiError(40400, '请求的资源不存在', 'tr-404');
      };
      mounted = await mount(
        createElement(OrderDetail, {
          api: api as never,
          id: 'o-ghost',
          source: null,
          onBack: () => undefined,
          onChanged: () => undefined,
        }),
      );
      await flush();
      expect(mounted.el.textContent).toContain('找不到这张订单');
    });
  });

  describe('S2（AJ-473）：单单发货记住上次用的承运商', () => {
    it('上次批量 / 单单发货选过的承运商 → 这次打开发货抽屉默认就是它', async () => {
      saveLastCarrier('Yamato');
      status = 'paid';
      const el = await open();
      await click(button(el, '发货…'));
      expect((el.querySelector('.drawer select') as HTMLSelectElement | null)?.value).toBe(
        OTHER_CARRIER,
      );
      expect(
        (el.querySelector('input[aria-label="承运商名称"]') as HTMLInputElement | null)?.value,
      ).toBe('Yamato');
    });
  });
});
