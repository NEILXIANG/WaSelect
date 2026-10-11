// @vitest-environment jsdom
/**
 * 职责：批量发货 / CSV 导入（AJ-401）的**组件接线**用例——勾选 → 抽屉 → 确认（输入单数）→ 请求体 → 逐行结果。
 *
 * @why 纯函数（ship-batch.unit.test.ts）全绿也可能接错线：勾了 A 发的是 B、确认框没拦、
 *      请求体用了 order_no 而不是 order_id——这些只在组件层看得见。
 * @see ./OrdersPage.tsx；./ShipBatchDrawer.tsx；./CsvShipImport.tsx；./BatchSubmit.tsx
 */
import { OTHER_CARRIER } from './carrier.js';
import { createElement, useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { OrdersPage } from './OrdersPage.js';
import { parseHash, type Route } from '../router.js';

/**
 * 承运商改成下拉（AJ-410 / N18）后，填"别的承运商"要先选「其他（手动填写）」再打字。
 * @param selectId 下拉的 id（批量：batch-carrier；导入：csv-carrier）
 */
async function chooseCarrier(el: Element, selectId: string, text: string): Promise<void> {
  await type(el.querySelector(`#${selectId}`), OTHER_CARRIER);
  await type(el.querySelector('input[aria-label="承运商名称"]'), text);
}

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;
let calls: Call[];
/** 设了就让按单号的查询挂起，直到它 resolve（模拟预检在飞）。 */
let hold: Promise<void> | null = null;
/** 设了就让批量发货整次失败（模拟 400 / 断网）。 */
let failBatch = false;

const ORDERS = [
  {
    order_id: 'ord_a',
    order_no: '261007-7K3QXA',
    status: 'paid',
    total_jpy: 13750,
    created_at: '2026-10-07T01:00:00Z',
  },
  {
    order_id: 'ord_b',
    order_no: '261007-8M2WRD',
    status: 'paid',
    total_jpy: 13750,
    created_at: '2026-10-07T01:00:00Z',
  },
  {
    order_id: 'ord_c',
    order_no: '261007-9P4TZE',
    status: 'paid',
    has_dispute: true,
    total_jpy: 13750,
    created_at: '2026-10-07T01:00:00Z',
  },
];

function Harness({ initial }: { initial: Route }): React.JSX.Element {
  const [route, setRoute] = useState<Route>(initial);
  const onNavigate = useCallback((next: Route) => setRoute(next), []);
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.method === 'POST' && req.path.endsWith('/ship-batch')) {
      if (failBatch) throw new Error('一次最多 50 单');
      const items = (req.body as { items: Array<{ order_id: string }> }).items;
      const results = items.map((it, i) =>
        i === 0
          ? { order_id: it.order_id, ok: true, tracking_recognized: true }
          : { order_id: it.order_id, ok: false, code: 40909, reason: 'dispute_open', message: 'x' },
      );
      return { results, succeeded: 1, failed: results.length - 1 };
    }
    if (req.method === 'POST' && /\/orders\/[^/]+\/ship$/.test(req.path)) {
      // 行内「发货」（AJ-410 / N12）走单单发货接口
      const body = req.body as { carrier: string; tracking_no: string };
      return {
        order_id: req.path.split('/').at(-2),
        status: 'shipped',
        ...body,
        tracking_recognized: true,
      };
    }
    const m = /keyword=([^&]+)/.exec(req.path);
    if (m !== null && hold !== null) await hold;
    const kw = m?.[1] === undefined ? undefined : decodeURIComponent(m[1]);
    const items = kw === undefined ? ORDERS : ORDERS.filter((o) => o.order_no === kw);
    return { items, total: items.length };
  };
  return createElement(OrdersPage, { api: api as never, route, onNavigate });
}

async function open(hash: string): Promise<HTMLElement> {
  calls = [];
  mounted = await mount(createElement(Harness, { initial: parseHash(hash) }));
  return mounted.el;
}

afterEach(async () => {
  // AJ-473：单单发货也会记住上次的承运商（localStorage），用例之间不能互相带默认值
  globalThis.localStorage?.clear();
  hold = null;
  failBatch = false;
  await mounted?.unmount();
  mounted = undefined;
});

const posts = (): Call[] => calls.filter((c) => c.method === 'POST');

async function confirmWith(el: HTMLElement, count: string): Promise<void> {
  const dialog = el.querySelector('.dialog') as HTMLElement;
  await type(dialog.querySelector('input'), count);
  await click(button(dialog, '确认批量发货'));
}

describe('订单列表「待发货」：勾选批量发货', () => {
  // 测试改动（AJ-407，已批准的行为变更）：原断言"非待发货页签没有勾选列"——AJ-407 起所有页签都可勾选（用于导出所选 / 打印），
  // 改为断言"勾得了、但没有批量发货与 CSV 导入"，且拒付单在非待发货页签可勾（只导出 / 打印，不发货）。
  it('非待发货页签：可勾选（导出 / 打印用），但没有批量发货与导入运单号', async () => {
    const el = await open('#/orders');
    const dispute = el.querySelector('input[aria-label="选择 261007-9P4TZE"]') as HTMLInputElement;
    expect(dispute.disabled).toBe(false);
    await click(el.querySelector('input[aria-label="选择 261007-7K3QXA"]'));
    expect(el.textContent).toContain('已选 1 单');
    expect(button(el, '批量发货（1）')).toBeNull();
    expect(button(el, '导入运单号（Excel/表格文件）')).toBeNull();
  });

  it('🔴 拒付单不能勾；勾两单 → 抽屉每单一行 → 输入单数确认 → 请求体是 order_id，结果按行显示', async () => {
    const el = await open('#/orders?status=paid');
    const box = (no: string) =>
      el.querySelector(`input[aria-label="选择 ${no}"]`) as HTMLInputElement;
    expect(box('261007-9P4TZE').disabled).toBe(true);
    await click(box('261007-7K3QXA'));
    await click(box('261007-8M2WRD'));
    await click(button(el, '批量发货（2）'));
    await chooseCarrier(el, 'batch-carrier', 'Japan Post');
    await type(el.querySelector('input[aria-label="261007-7K3QXA 运单号"]'), 'EJ123456789JP');
    // 第二单不填运单号、也没动过它 → 先不红（验收 2026-10-08：没碰过的行不该一打开就满屏红字）
    expect(el.textContent).not.toContain('运单号必填');
    expect(button(el, '批量发货 1 单')).not.toBeNull();
    // 点一次提交：先亮出问题、不弹确认；再点才进确认（单数仍只算干净的那一行）
    await click(button(el, '批量发货 1 单'));
    expect(el.textContent).toContain('运单号必填');
    expect(el.textContent).toContain('有 1 行有问题');
    expect(el.querySelector('.dialog')).toBeNull();
    await type(el.querySelector('input[aria-label="261007-8M2WRD 运单号"]'), 'ABC');
    // 日本邮便却不是 S10 → 黄色提示，不拦
    expect(el.querySelector('.warn')?.textContent).toContain('形状认不出');
    await click(button(el, '批量发货 2 单'));
    // 确认框：单数不对不放行
    const dialog = el.querySelector('.dialog') as HTMLElement;
    await type(dialog.querySelector('input'), '1');
    expect(button(dialog, '确认批量发货')?.disabled).toBe(true);
    await confirmWith(el, '2');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({
      items: [
        { order_id: 'ord_a', carrier: 'Japan Post', tracking_no: 'EJ123456789JP' },
        { order_id: 'ord_b', carrier: 'Japan Post', tracking_no: 'ABC' },
      ],
    });
    const result = el.querySelector('[aria-label="批量发货结果"]')?.textContent ?? '';
    expect(result).toContain('成功 1 单，失败 1 单');
    expect(result).toContain('261007-8M2WRD');
    expect(result).toContain('拒付');
  });
});

describe('批量发货：行内错误的显示时机（验收 2026-10-08）', () => {
  // 上一条用例成功提交后会记住承运商（last-carrier.ts）；本组要从"承运商也空着"开始
  beforeEach(() => globalThis.localStorage?.removeItem('ws.admin.lastCarrier'));
  it('🔴 刚打开不显示必填错误；0 单时按钮可点，点了才亮出错误并置灰；编辑过的行立刻显示自己的错误', async () => {
    const el = await open('#/orders?status=paid');
    await click(el.querySelector('input[aria-label="选择 261007-7K3QXA"]'));
    await click(el.querySelector('input[aria-label="选择 261007-8M2WRD"]'));
    await click(button(el, '批量发货（2）'));
    // AJ-410 / N18：承运商默认 EMS；本组要"承运商也空着"——选「其他」且不填，与原起点一致
    await type(el.querySelector('#batch-carrier'), OTHER_CARRIER);
    expect(el.textContent).not.toContain('必填');
    expect(el.textContent).not.toContain('行有问题');
    // 编辑第一行的运单号 → 只有这一行亮出自己的问题（承运商没填）
    await type(el.querySelector('input[aria-label="261007-7K3QXA 运单号"]'), 'EJ123456789JP');
    expect(el.querySelectorAll('td .error')).toHaveLength(1);
    const submit = button(el, '批量发货 0 单');
    expect(submit?.disabled).toBe(false);
    await click(submit);
    expect(el.querySelector('.dialog')).toBeNull();
    expect(el.textContent).toContain('运单号必填');
    expect(el.textContent).toContain('有 2 行有问题');
    expect(button(el, '批量发货 0 单')?.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('关抽屉：填了运单号未提交 → 问「放弃修改」', async () => {
    const el = await open('#/orders?status=paid');
    await click(el.querySelector('input[aria-label="选择 261007-7K3QXA"]'));
    await click(button(el, '批量发货（1）'));
    await type(el.querySelector('input[aria-label="261007-7K3QXA 运单号"]'), 'EJ123456789JP');
    await click(button(el.querySelector('.drawer') as HTMLElement, '关闭'));
    expect(button(el, '放弃修改')).not.toBeNull();
  });
});

describe('批量发货整次失败', () => {
  it('整次失败 → 走页面 Toast（不在抽屉里写行内错误），抽屉不关、可重试', async () => {
    failBatch = true;
    const el = await open('#/orders?status=paid');
    await click(el.querySelector('input[aria-label="选择 261007-7K3QXA"]'));
    await click(button(el, '批量发货（1）'));
    await chooseCarrier(el, 'batch-carrier', 'Japan Post');
    await type(el.querySelector('input[aria-label="261007-7K3QXA 运单号"]'), 'EJ123456789JP');
    await click(button(el, '批量发货 1 单'));
    await confirmWith(el, '1');
    await flush();
    expect(el.querySelector('.toast-stack')?.textContent).toContain('一次最多 50 单');
    expect(button(el, '批量发货 1 单')).not.toBeNull();
  });
});

describe('导入运单号（Excel/表格文件）', () => {
  it('🔴 粘贴 → 预检（按单号查）→ 不存在 / 拒付 / 重复标出 → 只提交干净行', async () => {
    const el = await open('#/orders?status=paid');
    await click(button(el, '导入运单号（Excel/表格文件）'));
    await chooseCarrier(el, 'csv-carrier', 'EMS');
    await type(
      el.querySelector('textarea[aria-label="CSV 内容"]'),
      '\uFEFF注文番号,追跡番号\r\n261007-7K3QXA,EJ123456789JP\r\n261007-9P4TZE,EJ000000003JP\r\n261007-ZZZZZZ,EJ1\r\n261007-8M2WRD,EJ2\r\n261007-8M2WRD,EJ3\r\n',
    );
    await click(button(el, '预检'));
    await flush();
    const table = el.querySelector('table[aria-label="预检结果"]')?.textContent ?? '';
    expect(table).toContain('找不到这个订单号');
    expect(table).toContain('拒付');
    expect(table).toContain('同一单号重复出现');
    // 只有第一行干净
    await click(button(el, '批量发货 1 单'));
    await confirmWith(el, '1');
    expect(posts()[0]?.body).toEqual({
      items: [{ order_id: 'ord_a', carrier: 'EMS', tracking_no: 'EJ123456789JP' }],
    });
  });

  it('🔴 粘贴了内容未提交就关 → 问「放弃修改」（验收 2026-10-08：原先直接关掉、内容丢失）；空着关直接关', async () => {
    const el = await open('#/orders?status=paid');
    await click(button(el, '导入运单号（Excel/表格文件）'));
    const drawer = (): HTMLElement => el.querySelector('.drawer') as HTMLElement;
    await type(el.querySelector('textarea[aria-label="CSV 内容"]'), 'order_no,tracking_no\n');
    await click(button(drawer(), '关闭'));
    expect(button(el, '放弃修改')).not.toBeNull();
    await click(button(el, '放弃修改'));
    expect(el.querySelector('.drawer')).toBeNull();
    // 对照组：没填任何内容 → 不问，直接关
    await click(button(el, '导入运单号（Excel/表格文件）'));
    await click(button(drawer(), '关闭'));
    expect(el.querySelector('.drawer')).toBeNull();
  });

  it('表头认不出 → 文件级错误，不发任何查询', async () => {
    const el = await open('#/orders?status=paid');
    await click(button(el, '导入运单号（Excel/表格文件）'));
    const before = calls.length;
    await type(el.querySelector('textarea[aria-label="CSV 内容"]'), '收件人,电话\nA,1\n');
    await click(button(el, '预检'));
    expect(el.textContent).toContain('表头缺少列');
    expect(calls.slice(before).filter((c) => c.path.includes('keyword='))).toHaveLength(0);
  });

  it('改了文本，旧预检作废（必须重新预检才能提交）', async () => {
    const el = await open('#/orders?status=paid');
    await click(button(el, '导入运单号（Excel/表格文件）'));
    const ta = el.querySelector('textarea[aria-label="CSV 内容"]');
    await type(ta, 'order_no,carrier,tracking_no\n261007-7K3QXA,EMS,EJ123456789JP\n');
    await click(button(el, '预检'));
    expect(button(el, '批量发货 1 单')).not.toBeNull();
    await type(ta, 'order_no,carrier,tracking_no\n261007-8M2WRD,EMS,EJ123456789JP\n');
    expect(button(el, '批量发货 1 单')).toBeNull();
  });

  it('🔴 预检在飞时改了文本：旧预检回来后被丢弃（不把旧文本的结果填回来）', async () => {
    const el = await open('#/orders?status=paid');
    await click(button(el, '导入运单号（Excel/表格文件）'));
    const ta = el.querySelector('textarea[aria-label="CSV 内容"]');
    await type(ta, 'order_no,carrier,tracking_no\n261007-7K3QXA,EMS,EJ123456789JP\n');
    let release = (): void => undefined;
    hold = new Promise<void>((r) => {
      release = r;
    });
    await click(button(el, '预检'));
    await type(ta, 'order_no,carrier,tracking_no\n261007-8M2WRD,EMS,EJ123456789JP\n');
    release();
    await flush();
    await flush();
    expect(el.querySelector('table[aria-label="预检结果"]')).toBeNull();
    expect(button(el, '批量发货 1 单')).toBeNull();
  });
});

/** AJ-410（新手走查）：待发货页签的行内发货、灰按钮提示、导入入口的说明。 */
describe('订单列表「待发货」：新手可用性（AJ-410）', () => {
  it('批量发货灰着时说清怎么让它能点（N11）', async () => {
    const el = await open('#/orders?status=paid');
    const batch = button(el, '批量发货（0）');
    expect(batch?.disabled).toBe(true);
    expect(batch?.title).toContain('先勾选左边方框');
    expect(el.textContent).toContain('先勾选左边方框');
    expect(el.textContent).toContain('另存为 CSV');
    expect(el.textContent).toContain('时间均为日本时间');
  });

  it('🔴 每行「发货」打开同一张发货表单（N12）：拒付单没有这颗按钮；填运单号 → 确认 → 发单单发货请求', async () => {
    const el = await open('#/orders?status=paid');
    const rowButtons = [...el.querySelectorAll('tbody button')].filter(
      (b) => (b.textContent ?? '').trim() === '发货',
    );
    expect(rowButtons).toHaveLength(2); // ord_c 有拒付，不给
    await click(rowButtons[0]);
    const drawer = el.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent).toContain('261007-7K3QXA');
    await type(drawer.querySelector('input[name="tracking_no"]'), 'em 123456789 jp');
    await click(button(drawer, '发货'));
    await type(el.querySelector('.dialog input'), 'EM123456789JP');
    await click(button(el, '确认发货'));
    const ship = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/ship'));
    expect(ship).toHaveLength(1);
    expect(ship[0]?.path).toContain('/ord_a/ship');
    expect(ship[0]?.body).toEqual({ carrier: 'Japan Post EMS', tracking_no: 'em 123456789 jp' });
    expect(el.querySelector('.drawer'), '成功后抽屉关闭').toBeNull();
  });
});
