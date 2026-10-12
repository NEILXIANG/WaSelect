/**
 * 职责：「我的」页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是两件**都不报错**的事：
 *      ① 登录态文案写反 / 把"正在登录"显示成"未登录" → 用户去找一个不存在的登录按钮；
 *      ② 入口清单加了一项却没接跳转 → 表现只是"点了没反应"，没有任何测试会红。
 *      第 ② 条是跨文件的一致性，所以最后一组去读 `index.js` 的跳转表。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_ROWS, ORDERS_ENTRY, loginRetryView, loginState, orderShortcuts } from './index.vm.js';

/** 全部入口：订单卡片的标题行 + 下方菜单（全入口点击测试 2026-10-11：「我的订单」由独立一行改为订单卡片的标题行）。 */
const ALL_ENTRIES = [ORDERS_ENTRY, ...MENU_ROWS];

describe('loginState（登录态文案）', () => {
  it('有 token → 已登录', () => {
    expect(loginState('eyJhbGciOi...')).toEqual({ logged: true, text: '已登录（微信）' });
  });

  it('⚠️ 无 token → "正在登录…" 而不是"未登录"（没有登录页，写了"未登录"用户会去找按钮）', () => {
    expect(loginState('')).toEqual({ logged: false, text: '正在登录…' });
    expect(loginState('   ')).toEqual({ logged: false, text: '正在登录…' });
  });

  it('脏输入（null / 数字 / 对象）→ 一律按未登录，不崩', () => {
    expect(loginState(null)).toEqual({ logged: false, text: '正在登录…' });
    expect(loginState(undefined)).toEqual({ logged: false, text: '正在登录…' });
    expect(loginState(123)).toEqual({ logged: false, text: '正在登录…' });
    expect(loginState({})).toEqual({ logged: false, text: '正在登录…' });
  });
});

describe('MENU_ROWS（入口清单）', () => {
  it('至少三个入口，且 key 唯一（重复 key 会让 wx:key 报重复、且其中一个永远跳不到）', () => {
    expect(ALL_ENTRIES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ALL_ENTRIES.map((r) => r.key)).size).toBe(ALL_ENTRIES.length);
  });

  it('🔴 「我的订单」不再在菜单里单列（它是订单卡片的标题行「我的订单 · 全部订单 ›」，单列就重复了）', () => {
    expect(MENU_ROWS.map((r) => r.key)).not.toContain('orders');
    expect(ORDERS_ENTRY).toEqual({ key: 'orders', label: '我的订单', actionText: '全部订单' });
  });

  it('每条的 key 与 label 都非空（空 label = 真机上一个空白的可点区块）', () => {
    for (const row of ALL_ENTRIES) {
      expect(row.key, '入口 key 为空').not.toBe('');
      expect(row.label, `${row.key} 的文案为空`).not.toBe('');
    }
  });
});

/**
 * ⚠️ 跨文件一致性：**每个入口都必须在 `index.js` 的跳转表里有一条路径**。
 *
 * @why 入口清单在 vm、跳转路径在页面 js，是两份真源——
 *      加了一个入口却忘了接跳转的表现是"点了没反应"：不报错、不崩溃，
 *      而且 vm 自己的测试全绿（它不知道页面那边有没有接上）。
 *      这类"两个文件各对一半"的失效，只能靠其中一个去读另一个才能发现。
 * @how 读 `index.js` 源码做形态匹配（与 `project-config` 同套路）。
 */
describe('MENU_ROWS 与 index.js 跳转表的双向比对', () => {
  const js = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
  const table = js.slice(js.indexOf('PAGE_BY_KEY'));
  const keys = [...table.matchAll(/^\s{2}([a-z_]+):\s*'\/pages\//gm)].map((m) => m[1] ?? '');

  it('抽到了跳转表（页面 js 改写法会失配 → 这条先红）', () => {
    expect(table).toContain('PAGE_BY_KEY');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('每个入口都有对应路径（缺一个 = 那个入口点了没反应）', () => {
    for (const row of ALL_ENTRIES) {
      expect(keys, `入口 ${row.key} 在 PAGE_BY_KEY 里没有路径`).toContain(row.key);
    }
  });

  it('跳转表里没有多余项（写了没人用的路径，改页面路径时那一处会被漏掉）', () => {
    expect([...keys].sort()).toEqual(ALL_ENTRIES.map((r) => r.key).sort());
  });
});

/** 启动自动登录失败后不能一直显示"正在登录…"（W-08）：那时其实没有在登录。 */
describe('loginState：自动登录失败（W-08）', () => {
  it('无 token 且启动登录已失败 → 不是"正在登录…"', () => {
    const s = loginState('', true);
    expect(s.logged).toBe(false);
    expect(s.text).not.toBe('正在登录…');
    expect(s.text).toContain('自动重试');
  });
  it('有 token 时忽略失败标记', () => {
    expect(loginState('tk', true)).toEqual({ logged: true, text: '已登录（微信）' });
  });
});

describe('loginRetryView（M-17「重新登录」按钮，AJ-406）', () => {
  const failed = { logged: false, failed: true, available: true };

  it('🔴 启动登录失败 + 可重试 → 显示"重新登录"、可点', () => {
    expect(loginRetryView(failed)).toEqual({
      show: true,
      text: '重新登录',
      disabled: false,
      note: '',
    });
  });

  it('重试在途 → 按钮禁用并改字（双击不发第二次）', () => {
    expect(loginRetryView({ ...failed, retrying: true })).toEqual({
      show: true,
      text: '正在重新登录…',
      disabled: true,
      note: '',
    });
  });

  it('重试又失败 → 按钮恢复可点，并说出"还是没成功"（不是点了没反应）', () => {
    const v = loginRetryView({ ...failed, retryFailed: true });
    expect(v.disabled).toBe(false);
    expect(v.note).toBe('还是没有登录成功，请检查网络后再试');
  });

  it('已登录 / 正在登录（未失败）/ 没有重试入口 / 脏输入 → 不显示', () => {
    for (const s of [
      { ...failed, logged: true },
      { ...failed, failed: false },
      { ...failed, available: false },
      null,
      undefined,
      {},
    ]) {
      expect(loginRetryView(s).show, JSON.stringify(s)).toBe(false);
    }
  });
});

describe('orderShortcuts（M-10 附，AJ-408：「我的」四个订单入口）', () => {
  it('四个入口 = 订单页除「全部」外的四个页签，顺序一致', () => {
    expect(orderShortcuts(undefined).map((r) => [r.key, r.label])).toEqual([
      ['unpaid', '待付款'],
      ['to_ship', '采购中'],
      ['shipped', '已发货'],
      ['after_sale', '售后·退款'],
    ]);
  });

  it('🔴 角标来自服务端计数 GET /orders/counts（S-7：列表分页后本地数不全）', () => {
    const rows = orderShortcuts({ unpaid: 1, to_ship: 2, shipped: 0, after_sale: 120 });
    expect(rows.map((r) => r.badge)).toEqual(['1', '2', '', '99+']);
  });

  it('计数里某一项缺失 / 不是整数 → 那一项不显示角标（不编一个 0）', () => {
    const rows = orderShortcuts({ unpaid: '3', to_ship: 1.5, shipped: null });
    expect(rows.map((r) => r.badge)).toEqual(['', '', '', '']);
  });

  it('⚠️ 取数失败（undefined）→ 入口照常显示、不带角标（不是"0"，也不隐藏入口）', () => {
    expect(orderShortcuts(undefined).map((r) => r.badge)).toEqual(['', '', '', '']);
  });
});
