// @vitest-environment jsdom
/**
 * 职责：工作台页的**组件行为**用例（AJ-393，管理后台对标分析第一批③）。
 *
 * @why 走组件用例而不是只测 `api.ts` 的形状校验：这一页要守的是"**数字怎么呈现**"——
 *      客单价为 null 时显示什么、没有汇率时那一行为什么不该出现、
 *      取不到数据时为什么不能显示 0。这些全是组件层的判断，
 *      纯函数层全绿也照样会显示成"今天一分钱没卖出去"。
 *
 * @why 特别盯"取不到 ≠ 0"：工作台是**经营判断的入口**（§8-2 定円为主正是为了这个判断），
 *      把"接口挂了"显示成 0 円，运营会据此以为今天没生意；
 *      而它和"今天真的没生意"在界面上必须能一眼区分。
 *
 * @see ./DashboardPage.tsx；./api.ts；../../../../server/src/adapters/dashboard.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type Mounted } from '../testing/dom.js';
import { DashboardPage } from './DashboardPage.js';
import type { Route } from '../router.js';

let mounted: Mounted | undefined;
let navigated: Route[];
let impl: (path: string) => Promise<unknown>;

const WINDOW = {
  from: '2026-10-07T15:00:00.000Z',
  to: '2026-10-08T15:00:00.000Z',
  orders: 3,
  paid_orders: 2,
  sales_jpy: 16_800,
  avg_jpy: 8400,
  received: [{ currency: 'USD', amount: 4612 }],
  refunded: [{ currency: 'JPY', amount: 1200 }],
  disputed: [],
};

/** 待办计数的假响应（TodoBar 走列表接口，`size=1`）。 */
const TODO_TOTALS: Record<string, number> = { paid: 0, refunding: 0, pending_payment: 0 };

async function open(body: unknown = { today: WINDOW, last7: WINDOW }): Promise<HTMLElement> {
  navigated = [];
  impl = async (path: string) => {
    if (path.includes('/admin/dashboard/sales')) {
      if (body instanceof Error) throw body;
      return body;
    }
    // TodoBar：按 status 回一个 total
    const status = new URL(path, 'http://x').searchParams.get('status') ?? '';
    return { items: [], total: TODO_TOTALS[status] ?? 0 };
  };
  mounted = await mount(
    createElement(DashboardPage, {
      api: ((req: { path: string }) => impl(req.path)) as never,
      onNavigate: (next: Route) => navigated.push(next),
    }),
  );
  return mounted.el;
}

/**
 * 某个 section 下某张卡片的值。
 * @why 标题用**完全相等**而不是 `includes`：`今日待办` 也含"今日"，
 *      用 includes 会取到待办那一屏（它根本没有卡片）——
 *      表现为断言拿到空串，而空串看起来像"卡片没渲染"，排查方向整个反掉。
 */
function panelByTitle(el: HTMLElement, title: string): Element | null {
  return (
    [...el.querySelectorAll('.panel')].find(
      (n) => (n.querySelector('.title')?.textContent ?? '').trim() === title,
    ) ?? null
  );
}

function cardValue(el: HTMLElement, section: string, label: string): string {
  const p = panelByTitle(el, section);
  if (p === null) return '';
  const card = [...p.querySelectorAll('.stat-card')].find(
    (c) => (c.querySelector('.stat-label')?.textContent ?? '') === label,
  );
  return (card?.querySelector('.stat-value')?.textContent ?? '').trim();
}

function cardSub(el: HTMLElement, section: string, label: string): string | null {
  const p = panelByTitle(el, section);
  const card = [...(p?.querySelectorAll('.stat-card') ?? [])].find(
    (c) => (c.querySelector('.stat-label')?.textContent ?? '') === label,
  );
  const sub = card?.querySelector('.stat-sub');
  return sub === undefined || sub === null ? null : (sub.textContent ?? '').trim();
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('工作台：今日数据', () => {
  it('销售额以円为主，灰字辅显 ≈USD（§8-2）', async () => {
    const el = await open({
      today: WINDOW,
      last7: WINDOW,
      fx: { usd_rate: 0.0067, usd_effective_from: '2026-10-07T00:00:00Z' },
    });
    expect(cardValue(el, '今日数据', '销售额')).toBe('16,800 円');
    // 16800 × 0.0067 = 112.56 USD（最小单位 11256 分）
    expect(cardSub(el, '今日数据', '销售额')).toBe('≈ $112.56');
  });

  it('🔴 没有汇率时不显示 ≈ 那一行（不是显示 ≈ $0.00）', async () => {
    const el = await open();
    expect(cardValue(el, '今日数据', '销售额')).toBe('16,800 円');
    expect(cardSub(el, '今日数据', '销售额')).toBeNull();
  });

  it('🔴 客单价为 null（窗口内零收款订单）显示「—」而不是 0 円', async () => {
    const el = await open({
      today: { ...WINDOW, paid_orders: 0, sales_jpy: 0, avg_jpy: null },
      last7: WINDOW,
    });
    expect(cardValue(el, '今日数据', '客单价')).toBe('—');
    expect(cardValue(el, '今日数据', '销售额')).toBe('0 円'); // 反过来：真的 0 就是 0
  });

  it('🔴 加载失败显示「—」并出错误 Toast，不显示 0（"取不到"≠"没生意"）', async () => {
    const el = await open(new Error('网络异常'));
    expect(cardValue(el, '今日数据', '销售额')).toBe('—');
    expect(cardValue(el, '近 7 天', '销售额')).toBe('—');
    // 反馈走 Toast（第一批①定的统一出口），不是页面内红字
    expect(el.querySelector('.toast-error')?.textContent ?? '').toContain('网络异常');
    expect(el.querySelector('.panel .error')).toBeNull();
  });
});

describe('工作台：实收 / 已退 / 拒付', () => {
  it('按扣款币种原样分行显示，不折算、不加总', async () => {
    const el = await open({
      today: {
        ...WINDOW,
        received: [
          { currency: 'JPY', amount: 10_000 },
          { currency: 'USD', amount: 4612 },
        ],
        refunded: [{ currency: 'USD', amount: 2000 }],
        disputed: [{ currency: 'USD', amount: 8100 }],
      },
      last7: WINDOW,
    });
    const text = el.textContent ?? '';
    expect(text).toContain('10,000 円');
    expect(text).toContain('$46.12');
    expect(text).toContain('$20.00');
    expect(text).toContain('$81.00');
  });

  it('没有退款 / 拒付时显示「无」（空数组不是"0 円"）', async () => {
    const el = await open();
    const text = el.textContent ?? '';
    expect(text).toContain('拒付：无');
  });
});

describe('工作台：待办点即跳到筛好的列表', () => {
  it('🔴 点「待发货」→ 跳到 `#/orders?status=paid`（附件 §3.1：待办每一项都可点直达）', async () => {
    const el = await open();
    await click(button(el, '待发货 0'));
    expect(navigated).toHaveLength(1);
    expect(navigated[0]?.page).toBe('orders');
    expect(navigated[0]?.id).toBe('');
    expect(navigated[0]?.query.get('status')).toBe('paid');
  });
});
