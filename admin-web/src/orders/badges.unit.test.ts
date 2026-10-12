/**
 * 职责：订单徽章口径（AJ-400）——列表一枚、详情"支付 + 履约 + 标记"。
 * @see ./badges.ts
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import { detailBadges, flagBadges, statusBadge } from './badges.js';

describe('statusBadge（列表）', () => {
  /**
   * 🔴 十态**逐一精确断言文案 + 色调**，不只测"不是未知状态"。
   * @why 只测 `.text !== '未知状态'` 挡不住"文案/色调错位"：把 shipped 错映射成"已退款"、
   *      把 refunded 错映射成 warn，这行循环照样绿，而列表页那一列显示成错误状态。
   *      精确断言让"任何一态的文案或色调写错"都直接红。
   */
  it('十态文案与色调逐一精确（对 ORDER_STATUS_LABELS / TONE）', () => {
    const expected: Readonly<Record<string, { text: string; tone: string }>> = {
      created: { text: '已下单，等待买家付款', tone: 'neutral' },
      pending_payment: { text: '买家正在付款', tone: 'neutral' },
      paid: { text: '待发货', tone: 'warn' },
      shipped: { text: '已发货', tone: 'info' },
      delivered: { text: '已签收', tone: 'info' },
      completed: { text: '已完成', tone: 'success' },
      cancelled: { text: '已取消', tone: 'muted' },
      expired: { text: '超时关闭', tone: 'muted' }, // 与买家端「已超时关闭」同一说法（业务旅程测试 2026-10-12）
      refunding: { text: '退款中', tone: 'warn' },
      refunded: { text: '已退款', tone: 'muted' },
    };
    for (const s of ORDER_STATUS) {
      expect(statusBadge({ status: s }), `状态 ${s} 的徽章错`).toEqual(expected[s]);
    }
  });
  it('认不出的状态 → 未知状态（不抛）', () => {
    expect(statusBadge({ status: 'weird' })).toEqual({ text: '未知状态', tone: 'neutral' });
    expect(statusBadge(null)).toEqual({ text: '未知状态', tone: 'neutral' });
  });
});

describe('flagBadges（标记，列表与详情共用）', () => {
  it('脏输入 / 无标记 → 空数组', () => {
    expect(flagBadges(null)).toEqual([]);
    expect(flagBadges(undefined)).toEqual([]);
    expect(flagBadges({})).toEqual([]);
  });
  it('测试单 → muted 标记', () => {
    expect(flagBadges({ is_test: true })).toEqual([{ text: '测试单', tone: 'muted' }]);
  });
});

describe('detailBadges（详情页头）', () => {
  const texts = (o: unknown): string[] => detailBadges(o).map((b) => b.text);
  it('已付款的单出"支付 + 履约"两枚', () => {
    expect(texts({ status: 'paid' })).toEqual(['已付款', '待发货']);
    expect(texts({ status: 'completed' })).toEqual(['已付款', '已完成']);
  });
  it('未付 / 退款 / 关闭的单只有支付侧一枚', () => {
    expect(texts({ status: 'pending_payment' })).toEqual(['未付款']);
    expect(texts({ status: 'refunding' })).toEqual(['退款中']);
    expect(texts({ status: 'expired' })).toEqual(['超时关闭']);
    expect(texts({ status: 'nope' })).toEqual(['未知状态']);
  });
  it('拒付 = danger、测试单 = muted，追加在后', () => {
    // 列表行没有时间线：只知道"有拒付限制"，不知道是进行中还是已败诉 → 写"拒付锁定"（两种都对）
    expect(detailBadges({ status: 'shipped', has_dispute: true, is_test: true })).toEqual([
      { text: '已付款', tone: 'success' },
      { text: '已发货', tone: 'info' },
      { text: '拒付锁定', tone: 'danger' },
      { text: '测试单', tone: 'muted' },
    ]);
  });
  // 规律排查 2026-10-12：has_dispute 的含义是"有未解除的拒付限制（进行中，或已败诉）"（mark-disputed.ts），
  //   原先一律写"拒付中"——已败诉的单也显示拒付中，运营去风控页"处理"，发现早已结案
  it('🔴 有时间线时分清进行中 / 已败诉', () => {
    const opened = { status: 'dispute_opened', note: 'dp_1', at: '2026-10-01T00:00:00Z' };
    const lost = { status: 'dispute_closed', note: 'dp_1:lost', at: '2026-10-08T00:00:00Z' };
    const flag = (events: unknown[]): string | undefined =>
      texts({ status: 'paid', has_dispute: true, events }).find((t) => t.startsWith('拒付'));
    expect(flag([opened])).toBe('拒付中');
    expect(flag([opened, lost])).toBe('拒付已败诉');
    // 败诉后又开了一单新的拒付
    expect(flag([opened, lost, { ...opened, note: 'dp_2' }])).toBe('拒付中');
    expect(flag([])).toBe('拒付锁定');
  });

  it('🔴 服务端给了 payment_dispute（列表行也有）→ 以它为准，不靠时间线', () => {
    const f = (pd: string): string | undefined =>
      texts({ status: 'paid', has_dispute: true, payment_dispute: pd }).find((t) =>
        t.startsWith('拒付'),
      );
    expect(f('open')).toBe('拒付中');
    expect(f('lost')).toBe('拒付已败诉');
  });
});

describe('detailBadges：详情页也要有「用户已拉黑 / 售后中」（三端联动模拟 2026-10-10）', () => {
  // 详情接口（AdminOrder）没有列表的 user_blocked / after_sale_open 两个布尔，信息在 customer.blocked 与 after_sales 里。
  // 原先详情页头只认列表字段 → 加载完两枚徽章消失；运营从「待发货」点进拉黑用户的单，页头看不出，照常发了货
  const texts = (o: unknown): string[] => detailBadges(o).map((b) => b.text);
  it('🔴 customer.blocked → 用户已拉黑', () => {
    expect(texts({ status: 'paid', customer: { user_id: 'u-1', blocked: true } })).toEqual([
      '已付款',
      '待发货',
      '用户已拉黑',
    ]);
    expect(texts({ status: 'paid', customer: { user_id: 'u-1', blocked: false } })).toEqual([
      '已付款',
      '待发货',
    ]);
  });
  it('🔴 after_sales 里有 open / processing → 售后中；只有已结案的 → 不出', () => {
    const as = (status: string) => ({ id: 'a', status });
    expect(texts({ status: 'delivered', after_sales: [as('resolved'), as('processing')] })).toEqual(
      ['已付款', '已签收', '售后中'],
    );
    expect(texts({ status: 'delivered', after_sales: [as('open')] })).toContain('售后中');
    expect(texts({ status: 'delivered', after_sales: [as('rejected')] })).not.toContain('售后中');
    expect(texts({ status: 'delivered', after_sales: 'bad' })).not.toContain('售后中');
  });
  it('列表行形状（布尔字段）照旧生效，且同一枚不重复出两次', () => {
    expect(
      texts({
        status: 'paid',
        user_blocked: true,
        customer: { blocked: true },
        after_sale_open: true,
        after_sales: [{ status: 'open' }],
      }),
    ).toEqual(['已付款', '待发货', '售后中', '用户已拉黑']);
  });
});

describe('flagBadges：待处理标记（AJ-425）', () => {
  it('🔴 有进行中售后 → 售后中；下单人已拉黑 → 用户已拉黑；都没有 → 不出', () => {
    expect(flagBadges({ after_sale_open: true }).map((b) => b.text)).toEqual(['售后中']);
    expect(flagBadges({ user_blocked: true }).map((b) => [b.text, b.tone])).toEqual([
      ['用户已拉黑', 'danger'],
    ]);
    expect(flagBadges({ after_sale_open: false, user_blocked: false })).toEqual([]);
  });
});

describe('迟到付款标记（三端模拟测试 2026-10-11）', () => {
  it('🔴 已过期 / 已取消且收到迟到付款 → 「迟到付款待退」（原先只写"已过期"，要读到时间线最后一行才知道钱到了）', () => {
    for (const status of ['expired', 'cancelled']) {
      expect(flagBadges({ status, late_paid: true }), status).toContainEqual({
        text: '迟到付款待退',
        tone: 'danger',
      });
    }
  });

  it('已退款 / 退款中 / 没有迟到付款 → 不显示', () => {
    for (const o of [
      { status: 'refunded', late_paid: true },
      { status: 'refunding', late_paid: true },
      { status: 'expired', late_paid: false },
      { status: 'expired' },
    ]) {
      expect(
        flagBadges(o).map((b) => b.text),
        JSON.stringify(o),
      ).not.toContain('迟到付款待退');
    }
  });
});

describe('超时未发货标记（AJ-484）', () => {
  it('🔴 ship_overdue=true → 「超时未发货」（红）；false / 缺省 → 不显示', () => {
    expect(flagBadges({ status: 'paid', ship_overdue: true })).toContainEqual({
      text: '超时未发货',
      tone: 'danger',
    });
    for (const o of [{ status: 'paid', ship_overdue: false }, { status: 'paid' }]) {
      expect(flagBadges(o).map((b) => b.text)).not.toContain('超时未发货');
    }
  });
});
