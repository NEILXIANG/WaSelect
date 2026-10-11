// @vitest-environment jsdom
/**
 * 职责：风控页「拉黑**串单**」的组件用例（ADM3-01）。
 *
 * @why 这是管理端唯一一处**没有解除接口**的操作（契约只有 block、没有 unblock，
 *      见 `risk/api.ts` @limitation 二）。
 *      ⚠️ 曾经写成"唯一一处**不可逆**且没有解除接口"——"不可逆"不是它独有的：
 *      运费整表替换与 Banner 删除同样"改前值就没了"（三处都因此取改前值），
 *      区别是那两处**可以重录**，拉黑重录不出来。这里要"页面显示哪一单必须准"的理由
 *      是后者（落在错误的用户身上**收不回来**），不是前者。
 *      对这种操作，"页面显示的是哪一单"不是显示问题，
 *      而是"对谁执行"的问题：拉黑会在同一事务里取消该用户所有未付款订单、回补库存、
 *      作废机构会话——**落在错误的用户身上收不回来**。
 * @why 必须用组件用例而不是纯函数用例：缺陷在 `.tsx` 的**状态时序**里
 *      （取详情失败时不清上一次的待确认状态），`view.ts` 的纯函数再全也测不到。
 *
 * @see ./RiskPage.tsx（`prepare` 开头的清空）；./view.ts（`orderIdOf`）；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { RiskPage } from './RiskPage.js';

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

let mounted: Mounted | undefined;

/** 两单拒付：order_no 与 order_id **故意不同**（UUID 与订单号），面板该显示前者。 */
const ROWS = [
  {
    order_id: 'ord-A',
    order_no: 'A-1001',
    dispute_id: 'du-a',
    dispute_status: 'open',
    dispute_amount: 3350,
    charge_currency: 'USD',
    opened_at: '2026-09-01T00:00:00.000Z',
  },
  {
    order_id: 'ord-B',
    order_no: 'B-2002',
    dispute_id: 'du-b',
    dispute_status: 'open',
    dispute_amount: 1200,
    charge_currency: 'USD',
    opened_at: '2026-09-02T00:00:00.000Z',
  },
];

const calls: Call[] = [];

/** 挂载页面；`failOrderIds` 里的订单取详情时抛"超时"（模拟 5xx / 网络错）。 */
async function open(failOrderIds: string[] = []): Promise<HTMLElement> {
  calls.length = 0;
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    if (req.method === 'POST') return {};
    if (req.path.includes('/admin/disputes')) return ROWS;
    const m = /\/api\/v1\/admin\/orders\/([^/?]+)/.exec(req.path);
    if (m !== null) {
      const id = decodeURIComponent(m[1]!);
      if (failOrderIds.includes(id)) throw new ApiError(-1, '请求超时（10000ms）', '');
      return { order_id: id, user_id: id === 'ord-A' ? 'user-A' : 'user-B' };
    }
    return {};
  };
  mounted = await mount(createElement(RiskPage, { api: api as never }));
  return mounted.el;
}

/** 第 i 行的"处理"按钮（每次重新查：点完会重渲染）。 */
function handle(el: HTMLElement, i: number): HTMLButtonElement | null {
  const list = [...el.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === '处理',
  );
  return (list[i] as HTMLButtonElement | undefined) ?? null;
}

const blocks = (): Call[] => calls.filter((c) => c.path.includes('/block'));

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('风控页：拉黑串单（ADM3-01）', () => {
  it('处理 A 成功 → 再处理 B 且 B 取详情失败 → 确认面板消失（不能停在 A 上）', async () => {
    const el = await open(['ord-B']);
    expect(handle(el, 0)).not.toBeNull();
    expect(handle(el, 1)).not.toBeNull();

    await click(handle(el, 0)); // A：成功
    expect(button(el, '拉黑用户'), 'A 取详情成功后应出现确认面板').not.toBeNull();

    await click(handle(el, 1)); // B：失败
    // ❗ 修复前这里不为 null（面板仍是 A 的，点下去拉黑 user-A）
    expect(button(el, '拉黑用户'), 'B 取详情失败后，面板必须消失').toBeNull();
    // 失败要有话说，且不能发出任何拉黑请求
    expect(el.textContent).toContain('请求超时');
    expect(blocks()).toEqual([]);
  });

  it('面板显示 order_no（运营认单用的订单号），不是 order_id 那个 UUID', async () => {
    const el = await open();
    await click(handle(el, 0));
    expect(el.textContent).toContain('A-1001');
    // UUID 出现在面板里会让运营无法把它和列表里的哪一行对起来
    const panel = el.querySelector('.form');
    expect(panel?.textContent ?? '').not.toContain('ord-A');
  });

  it('A 成功 → 点确认拉黑 → 打的是 user-A，且成功后面板收起、不留上一次的红字', async () => {
    const el = await open(['ord-B']);
    await click(handle(el, 0)); // A 成功
    await click(handle(el, 1)); // B 失败：页面留下红字
    expect(el.textContent).toContain('请求超时');

    // 从 A 重新进入（B 的失败没有留下可点的面板）
    await click(handle(el, 0));
    const blockedLoads = (): number => calls.filter((c) => c.path.includes('blocked=true')).length;
    const before = blockedLoads();
    // 第一批①：面板上只有「拉黑用户」，后果与「确认拉黑」在弹层里
    // AJ-449：原因必填——不填直接点，不弹层也不发请求
    await click(button(el, '拉黑用户'));
    expect(button(el, '确认拉黑')).toBeNull();
    await type(el.querySelector('input[name="block-reason"]'), '同一张卡 3 次拒付');
    await click(button(el, '拉黑用户'));
    await click(button(el, '确认拉黑'));
    // P2-47：拉黑成功后「已拉黑用户」重新取数（新拉黑的人立刻出现）
    expect(blockedLoads()).toBe(before + 1);

    // 带 order_id：服务端据此核对"这张单属于这个人"（ADM3-01 纵深防御 / AJ-290）。
    // ❗ 少了 body 这一项，"页面真的把凭据发出去了"就没人守——服务端那条校验会永远拿不到调用。
    expect(blocks()).toEqual([
      {
        path: '/api/v1/admin/users/user-A/block',
        method: 'POST',
        body: { reason: '同一张卡 3 次拒付', order_id: 'ord-A' },
      },
    ]);
    expect(el.textContent).toContain('已拉黑');
    // 上一次失败留下的红字必须被清掉（"已拉黑"和"请求超时"同屏会让人以为没成功）。
    // ⚠️ 第一批① 之前这条靠"成功时清空 error state"成立；改走 Toast 后它是**跨 kind 并存**，
    //    于是这里真的红了——修法是给 Toast 定"成功即清屏"的规则（@see ui/toast.tsx @limitation 二）。
    expect(el.textContent).not.toContain('请求超时');
    expect(button(el, '拉黑用户')).toBeNull();
  });
});

/**
 * 🔴 回归：确认面板必须把"连带取消未付款订单"显示出来（L4 浏览器验收 2026-10-02）。
 *
 * @why 必须走组件用例：`view.unit.test.ts` 只能证明 `BLOCK_CONFIRM_TEXT` 这串常量里
 *      有那几个词，证明不了**面板渲染了它**——而缺陷正是"运营在点之前看不到这一条"。
 *      少这一层，常量改了不挂上去也会一直绿。
 */
describe('风控页：确认弹层说清全部后果', () => {
  it('🔴 点确认之前看得到"连带取消未付款订单"（缺陷注入点：弹层 body 换回旧文案即红）', async () => {
    const el = await open();
    await click(handle(el, 0));
    await type(el.querySelector('input[name="block-reason"]'), '三次拒付');
    await click(button(el, '拉黑用户'));
    // 第一批①：后果从"面板里的一行红字"搬进了弹层——断言也跟着搬，
    // 仍守同一件事：**点下去之前**要看得见（而不是成功之后才知道）。
    const dialog = el.querySelector('.dialog');
    const text = dialog?.textContent ?? '';
    expect(text).toContain('未付款');
    expect(text).toContain('取消');
    expect(text).toContain('不会恢复');
    // 弹层主按钮必须是危险色：拉黑与"保存商品"不该长得一样
    expect(el.querySelector('.dialog .btn-danger')).not.toBeNull();
  });

  it('🔴 拉黑成功后的提示同样提到"已一并取消"（结果不是只有"不能下单"这一件事）', async () => {
    const el = await open();
    await click(handle(el, 0));
    await type(el.querySelector('input[name="block-reason"]'), '三次拒付');
    await click(button(el, '拉黑用户'));
    await click(button(el, '确认拉黑'));
    expect(el.textContent).toContain('未付款订单已一并取消');
  });
});
