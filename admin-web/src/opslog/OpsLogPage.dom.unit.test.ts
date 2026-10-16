// @vitest-environment jsdom
/**
 * 职责：运营日志页交互（剩余清单 3-2）——对账摘要、审计列表、过滤与翻页发出的请求。
 *
 * @why 外层套一个持有 `route` 的 Harness 而不是把 props 写死：体验审查 2026-10-15（P2-5）之后
 *      页码 / 每页条数 / 过滤条件都是**地址栏**派生的，翻页是"写地址栏 → 地址栏回来 → 重新取数"。
 *      不模拟这一段，翻页的用例就退化成"按钮有没有被点"，测不到真会发出请求。
 */
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { OpsLogPage } from './OpsLogPage.js';
import type { Route } from '../router.js';

let mounted: Mounted | undefined;
const paths: string[] = [];
/** 取数挂起（测 loading 态用）；null = 不挂起。 */
let hold: Promise<unknown> | null = null;
/** 审计接口失败（测页内失败标记用）。 */
let failAudit = false;

const RECON = {
  run: {
    ran_at: '2026-10-05T18:00:00.000Z',
    counts: { stuck_refunds: 1 },
    samples: { stuck_refunds: ['o-9'] },
  },
};

const AUDIT = (total: number) => ({
  total,
  items: [
    {
      id: 1,
      actor: 'admin:u-a',
      action: 'PUT /api/v1/admin/products/:id',
      target: 'p-1',
      status_code: 409,
      created_at: '2026-10-05T00:00:00.000Z',
    },
  ],
});

/** 持有地址的壳：翻页 / 查询在这里落地成"换 route"，与 App 里的 hash 路由同形。 */
function Harness({ total, query }: { total: number; query?: string }): React.JSX.Element {
  const [route, setRoute] = useState<Route>({
    page: 'opslog',
    id: '',
    query: new URLSearchParams(query ?? ''),
  });
  const api = (req: { path: string }): Promise<unknown> => {
    paths.push(req.path);
    if (req.path.includes('/reconciliation/latest')) return Promise.resolve(RECON);
    if (failAudit) return Promise.reject(new Error('网络请求失败'));
    if (hold !== null) return hold;
    return Promise.resolve(AUDIT(total));
  };
  return createElement(OpsLogPage, { api: api as never, route, onNavigate: setRoute });
}

/**
 * 打开本页。
 * @param pending 传一个未兑现的 promise 让审计取数**挂起**（测 loading 态）。
 * @param fail 让审计取数失败（测页内失败标记）。
 * @why 这两个开关必须在 `open()` 里落到模块变量上：Harness 的 api 是在**渲染时**读它们的，
 *      在 open 之前改会被 open 开头的复位抹掉（实测：两个用例都因此拿到"成功"的分支）。
 */
async function open(
  total = 120,
  query = '',
  pending: Promise<unknown> | null = null,
  fail = false,
): Promise<HTMLElement> {
  paths.length = 0;
  hold = pending;
  failAudit = fail;
  mounted = await mount(createElement(Harness, { total, query }));
  return mounted.el;
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  hold = null;
  failAudit = false;
});

describe('运营日志页（3-2）', () => {
  it('🔴 进页即显示对账异常摘要与审计第一页', async () => {
    const el = await open();
    expect(el.textContent).toContain('发现 1 类异常');
    expect(el.textContent).toContain('o-9');
    // 三端模拟测试 2026-10-11（用户截图）：异常看板——一类一行、说清谁处理、给「去处理」入口
    const row = [...el.querySelectorAll('.recon-table tbody tr')].map((r) => r.textContent ?? '');
    expect(row).toHaveLength(1);
    expect(row[0]).toContain('退款滞留超过 24 小时');
    expect(row[0]).toContain('运营');
    const go = [...el.querySelectorAll('.recon-table a')].find((a) =>
      a.textContent?.includes('去处理'),
    );
    expect(go?.getAttribute('href')).toBe('#/orders?status=refunding');
    expect(el.textContent).toContain('PUT /api/v1/admin/products/:id');
    expect(el.textContent).toContain('第 1 / 3 页 · 共 120 条');
    expect(paths.some((p) => p.startsWith('/api/v1/admin/audit?page=1&size=50'))).toBe(true);
  });

  it('填操作人点查询 → 带 actor 参数、回到第 1 页；下一页 → page=2', async () => {
    const el = await open();
    const input = el.querySelector('input[aria-label="操作人"]') as HTMLInputElement;
    await type(input, 'admin:u-a');
    await click(button(el, '查询'));
    expect(paths.at(-1)).toContain('actor=admin%3Au-a');
    await click(button(el, '下一页'));
    expect(paths.at(-1)).toContain('page=2');
  });

  // 两端输入测试 2026-10-12：筛选框原写"对象 id（订单 / 商品）"——内部 id 在界面上看不到；服务端现认订单号 / 商品名 / 邮箱
  it('🔴 对象筛选框说清能填什么（订单号 / 商品名 / 账号邮箱），填订单号带 target 参数', async () => {
    const el = await open();
    const input = el.querySelector('input[aria-label="对象"]') as HTMLInputElement;
    expect(input.placeholder).toBe('对象：订单号 / 商品名 / 账号邮箱');
    await type(input, '261009-F2Z45G');
    await click(button(el, '查询'));
    expect(paths.at(-1)).toContain('target=261009-F2Z45G');
  });
});

describe('运营日志：按日期范围查（评估 P2，2026-10-09）', () => {
  it('🔴 选了开始 / 结束日期点查询 → 请求带 created_from / created_to（日本时间日历日）', async () => {
    const el = await open();
    const set = async (label: string, v: string) => {
      await type(el.querySelector(`input[aria-label="${label}"]`), v);
    };
    await set('开始日期（日本时间）', '2026-10-02');
    await set('结束日期（日本时间）', '2026-10-03');
    await click(button(el, '查询'));
    const last = paths.filter((p) => p.includes('/admin/audit')).at(-1) ?? '';
    expect(last).toContain('created_from=2026-10-02');
    expect(last).toContain('created_to=2026-10-03');
  });

  it('🔴 开始晚于结束 → 不发请求，提示"开始日期不能晚于结束日期"', async () => {
    const el = await open();
    await type(el.querySelector('input[aria-label="开始日期（日本时间）"]'), '2026-10-05');
    await type(el.querySelector('input[aria-label="结束日期（日本时间）"]'), '2026-10-01');
    const before = paths.length;
    await click(button(el, '查询'));
    expect(paths.length).toBe(before);
    expect(el.querySelector('.toast[data-kind="error"]')?.textContent).toContain(
      '开始日期不能晚于结束日期',
    );
  });
});

// 体验审查 2026-10-15（P2-3）：原先这一页 grep `loading` 零命中——点「下一页」后 0.3~2 秒纹丝不动，
//   运营连点一次跳过多页（中途还会被 seq 判成过期响应丢掉），日志页漏看记录等于白查。
describe('运营日志：取数在途要有 loading 态（P2-3）', () => {
  it('🔴 在途时显示「加载中…」，且两个翻页按钮都禁用（连点不会一次跳过多页）', async () => {
    let release: (v: unknown) => void = () => undefined;
    const el = await open(
      120,
      '',
      new Promise((r) => {
        release = r;
      }),
    );
    expect(el.textContent).toContain('加载中…');
    expect((button(el, '下一页') as HTMLButtonElement).disabled).toBe(true);
    expect((button(el, '上一页') as HTMLButtonElement).disabled).toBe(true);
    release(AUDIT(120));
    await flush();
    expect(el.textContent).not.toContain('加载中…');
    expect((button(el, '下一页') as HTMLButtonElement).disabled).toBe(false);
  });
});

// 体验审查 2026-10-15（P2-4）：失败时列表保留上一次结果，只靠右下角 Toast 说不清"这份不是最新的"。
describe('运营日志：取数失败要在页内说出来（P2-4）', () => {
  it('🔴 首次取数就失败（下面没有旧数据）→ 说"没能加载"，不说"下面是上一次成功的结果"（四天提交复查 2026-10-16）', async () => {
    const el = await open(120, '', null, true);
    const t = el.querySelector('p.error')?.textContent ?? '';
    expect(t).toContain('操作记录没能加载');
    expect(t).not.toContain('上一次成功加载');
    expect(t).toContain('请点「查询」重试');
  });

  it('🔴 失败后条件没变直接点「查询」→ 真的重新取数，成功后红字消失（四天提交复查 2026-10-16）', async () => {
    const el = await open(120, '', null, true);
    // 先点一次（仍失败）：把 page=1 等参数写进地址栏——之后再点，写回的是同一串参数
    (button(el, '查询') as HTMLButtonElement).click();
    await flush();
    failAudit = false;
    const before = paths.filter((p) => p.includes('/admin/audit')).length;
    (button(el, '查询') as HTMLButtonElement).click();
    await flush();
    expect(paths.filter((p) => p.includes('/admin/audit')).length).toBe(before + 1);
    expect(el.querySelector('p.error')).toBeNull();
  });
});

// 体验审查 2026-10-15（P2-5）：分页器原先是 `row2` + `link` 文字链、且页码只在本地 state。
describe('运营日志：分页与其它三个列表页同形（P2-5）', () => {
  it('🔴 用 footer.pager + 次级按钮，并给了每页条数选择', async () => {
    const el = await open();
    const pager = el.querySelector('footer.pager');
    expect(pager).not.toBeNull();
    expect(pager?.querySelectorAll('button.btn-secondary')).toHaveLength(2);
    const size = pager?.querySelector('select[aria-label="每页显示条数"]') as HTMLSelectElement;
    expect(size).not.toBeNull();
    expect(size.value).toBe('50');
  });

  it('🔴 改每页条数 → 回到第 1 页并带上 size', async () => {
    const el = await open();
    const size = el.querySelector('select[aria-label="每页显示条数"]') as HTMLSelectElement;
    // type() 对 select 走原生 value setter + change 事件（@see testing/dom.js）
    await type(size, '100');
    expect(paths.at(-1)).toContain('size=100');
    expect(paths.at(-1)).toContain('page=1');
  });

  it('🔴 页码在地址栏里：带着 page=2 打开就取第 2 页（刷新 / 分享 / 后退都能回到这一屏）', async () => {
    const el = await open(120, 'page=2');
    expect(paths.some((p) => p.includes('page=2'))).toBe(true);
    expect(el.textContent).toContain('第 2 / 3 页');
  });
});
