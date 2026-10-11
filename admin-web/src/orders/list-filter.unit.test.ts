/**
 * 职责：订单列表筛选纯函数（AJ-400）——页签 ↔ URL、日期预设的 JST 日界。
 * @see ./list-filter.ts
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import {
  defaultSortFor,
  STATUS_TABS,
  readStatusFilter,
  resolveDateRange,
  tabStatusParam,
} from './list-filter.js';

describe('状态页签', () => {
  it('除「全部」外的页签恰好覆盖十态各一次（不漏不重）', () => {
    const all = STATUS_TABS.flatMap((t) => t.statuses);
    expect([...all].sort()).toEqual([...ORDER_STATUS].sort());
  });

  it('页签 → URL → 页签 往返一致', () => {
    for (const tab of STATUS_TABS) {
      const raw = tab.key === 'all' ? null : tabStatusParam(tab);
      expect(readStatusFilter(raw).tabKey).toBe(tab.key);
    }
  });

  // AJ-410 / N27：行为变更——单状态链接属于某个页签时高亮那个页签（原为不高亮任何页签），并标 narrowed
  it('顺序不同的同一集合仍认作该页签；单状态链接（refunding / shipped）高亮所属页签并标"只显示一部分"', () => {
    expect(readStatusFilter('refunded,refunding')).toEqual({
      statuses: ['refunded', 'refunding'],
      tabKey: 'after_sale',
      narrowed: false,
    });
    expect(readStatusFilter('paid')).toEqual({
      statuses: ['paid'],
      tabKey: 'to_ship',
      narrowed: false,
    });
    expect(readStatusFilter('refunding')).toEqual({
      statuses: ['refunding'],
      tabKey: 'after_sale',
      narrowed: true,
    });
    expect(readStatusFilter('shipped')).toEqual({
      statuses: ['shipped'],
      tabKey: 'shipped',
      narrowed: true,
    });
    // 跨页签的集合仍不高亮任何页签
    expect(readStatusFilter('paid,shipped')).toEqual({
      statuses: ['paid', 'shipped'],
      tabKey: null,
      narrowed: false,
    });
  });

  it('认不出的 status 回落「全部」（不把坏值发给服务端）', () => {
    expect(readStatusFilter('foo')).toEqual({ statuses: [], tabKey: 'all', narrowed: false });
    expect(readStatusFilter('paid,')).toEqual({ statuses: [], tabKey: 'all', narrowed: false });
  });
});

describe('日期预设（JST 日界）', () => {
  // UTC 2026-10-07 15:30 = JST 10-08 00:30：刚过 JST 零点，"今天"必须是 10-08 而不是 UTC 的 10-07
  const now = new Date('2026-10-07T15:30:00Z');

  it('今天 / 近 7 天 / 近 30 天 都以 JST 当日为终点、含当日', () => {
    expect(resolveDateRange('today', '', '', now)).toEqual({
      createdFrom: '2026-10-08',
      createdTo: '2026-10-08',
    });
    expect(resolveDateRange('7d', '', '', now)).toEqual({
      createdFrom: '2026-10-02',
      createdTo: '2026-10-08',
    });
    expect(resolveDateRange('30d', '', '', now)).toEqual({
      createdFrom: '2026-09-09',
      createdTo: '2026-10-08',
    });
  });

  it('不选 / 认不出的预设 → 不限日期（预设名不看自定义框）', () => {
    expect(resolveDateRange('', '2026-10-01', '', now)).toEqual({});
    expect(resolveDateRange('yesterday', '', '', now)).toEqual({});
  });

  it('自定义：可只填一端；格式错或起点晚于终点 → 给出提示、不给参数', () => {
    expect(resolveDateRange('custom', '2026-10-01', '', now)).toEqual({
      createdFrom: '2026-10-01',
    });
    expect(resolveDateRange('custom', '', '', now)).toEqual({});
    expect(resolveDateRange('custom', '2026-10-08', '2026-10-01', now)).toEqual({
      error: '开始日期晚于结束日期',
    });
    expect(resolveDateRange('custom', '2026-02-30', '', now)).toEqual({ error: '日期格式不对' });
  });

  it('ADM-6（AJ-453）：「待发货」没有显式排序时默认按付款时间正序；其它页签沿用服务端默认', () => {
    expect(defaultSortFor('paid')).toBe('paid_at');
    expect(defaultSortFor('')).toBeNull();
    expect(defaultSortFor('refunding,refunded')).toBeNull();
  });
});
