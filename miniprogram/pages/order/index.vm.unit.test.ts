/**
 * 职责：订单列表页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是"状态显示错"这类**不报错**的事：
 *      ① 状态词表与契约 enum 漂移 → 新增状态后前端静默显示"状态未知"；
 *      ② 能付的状态与可取消的状态不一致 → "能付但取消不了"的半开状态；
 *      ③ 请求失败时说"还没有订单" → 用户以为订单丢了。
 *
 * ⚠️ 状态词表与可付态已下沉 `utils/order-status.js`（U-H3），词表本身的断言
 *    （含与契约的双向比对）**跟着真源一起搬走了**——这里只剩列表行的集成断言，
 *    不重复测词表本身（只搬代码不搬测试 = 守护静默消失；搬了就只留一份）。
 */
import { describe, expect, it } from 'vitest';
import { STATUS_LABELS, buyerStatus } from '../../utils/order-status.js';
import { emptyState, orderRows, tabsView } from './index.vm.js';
import { PLACEHOLDER_IMAGE } from '../../utils/placeholder.js';

const ORDERS = [
  {
    order_id: 'o-1',
    order_no: 'WS-20260927-0001',
    total_jpy: 9150,
    display: { USD: 6220, CNY: 44800 },
    status: 'created',
    created_at: '2026-09-27T00:00:00Z',
  },
  {
    order_id: 'o-2',
    order_no: 'WS-20260927-0002',
    total_jpy: 4200,
    display: { USD: 2850, CNY: 20500 },
    status: 'paid',
    created_at: '2026-09-26T00:00:00Z',
  },
];

describe('orderRows（列表行）', () => {
  it('字段透传 + 金额三币 + 状态中文', () => {
    const [row] = orderRows(ORDERS);
    expect(row).toEqual({
      orderId: 'o-1',
      orderNo: 'WS-20260927-0001',
      totalJpy: 9150,
      totalText: '9,150 円',
      totalSub: '≈ $62.20 · ≈ ¥448.00',
      statusText: '待付款',
      nextText: buyerStatus('created').next,
      canPay: true,
      // 测试改动（AJ-408 M-11）：列表行新增下单时间 / 缩略图 / 件数三字段（已批准的新行为），toEqual 整体比对随之补齐
      createdText: '2026-09-27 09:00（日本时间）',
      thumb: PLACEHOLDER_IMAGE,
      itemCountText: '',
    });
  });

  it('🔴 M-06：已付款行用代购视角文案 + 下一步；列表不知道有没有留邮箱 → 不承诺"会发邮件"', () => {
    const [row] = orderRows([{ order_id: 'p', status: 'paid' }]);
    expect(row?.statusText).toBe('已付款 · 日本采购中');
    expect(row?.nextText).toBe(buyerStatus('paid').next);
    expect(row?.nextText).not.toContain('邮件');
  });

  it('⚠️ 只有 created / pending_payment 能继续付（与可取消态一致）', () => {
    const rows = orderRows([
      { order_id: 'a', status: 'created' },
      { order_id: 'b', status: 'pending_payment' },
      { order_id: 'c', status: 'paid' },
      { order_id: 'd', status: 'shipped' },
      { order_id: 'e', status: 'cancelled' },
    ]);
    expect(rows.map((r) => r.canPay)).toEqual([true, true, false, false, false]);
  });

  it('⚠️ 不在词表里的状态 → "状态未知"（不是空串：空白标签和渲染错无法区分）', () => {
    expect(orderRows([{ order_id: 'x', status: 'brand_new' }])[0]?.statusText).toBe('状态未知');
    expect(orderRows([{ order_id: 'x' }])[0]?.statusText).toBe('状态未知');
  });

  it('⚠️ 合计缺失 → totalJpy 是 **null 不是 0**（0 会被读成"这单不要钱"）', () => {
    expect(orderRows([{ order_id: 'x', status: 'paid' }])[0]?.totalJpy).toBeNull();
    expect(orderRows([{ order_id: 'x', status: 'paid' }])[0]?.totalText).toBe('');
    expect(orderRows([{ order_id: 'x', total_jpy: 9150.5 }])[0]?.totalJpy).toBeNull();
  });

  it('脏输入：非数组 → 空；没 order_id 的行丢掉', () => {
    expect(orderRows(null)).toEqual([]);
    expect(orderRows([{ status: 'paid' }, ...ORDERS])).toHaveLength(2);
  });
});

describe('emptyState（空态）', () => {
  it('⚠️ 请求失败时不说"还没有订单"（用户会以为订单丢了）', () => {
    expect(emptyState([], '网络请求失败').showEmpty).toBe(false);
    expect(emptyState([], '').showEmpty).toBe(true);
    expect(emptyState(orderRows(ORDERS), '').showEmpty).toBe(false);
  });
});

describe('与共享状态词表的接线（词表本身在 utils/order-status 测，这里只测列表行真的用上了它）', () => {
  it('⚠️ 词表里每一个状态都能被列表行翻出来（接线断了 = 全部显示"状态未知"）', () => {
    // M-06（AJ-405）：列表行的状态改用买家视角词表 buyerStatus（原断言比对 statusText，口径已按 AJ-402 Q4 改）
    for (const status of Object.keys(STATUS_LABELS)) {
      const [row] = orderRows([{ order_id: 'x', status }]);
      expect(row?.statusText).toBe(buyerStatus(status).title);
      expect(row?.nextText).toBe(buyerStatus(status).next);
    }
  });
});

describe('M-11（AJ-408）：列表行的下单时间、缩略图、件数', () => {
  it('🔴 下单时间按 JST 显示并标注时区（同详情页 MP3-02 口径；换算在 jst-text 纯函数里）', () => {
    const [row] = orderRows([
      { order_id: 'x', status: 'paid', created_at: '2026-10-07T15:30:00.000Z' },
    ]);
    expect(row?.createdText).toBe('2026-10-08 00:30（日本时间）');
  });

  it('⚠️ created_at 缺失 / 带偏移（解析不了）→ 空串（不显示一个错 9 小时的时间）', () => {
    expect(orderRows([{ order_id: 'x' }])[0]?.createdText).toBe('');
    expect(
      orderRows([{ order_id: 'x', created_at: '2026-10-08T00:30:00+09:00' }])[0]?.createdText,
    ).toBe('');
  });

  it('🔴 缩略图优先取 thumb 档（列表图小，取 card / detail 是白下大图）', () => {
    const [row] = orderRows([
      {
        order_id: 'x',
        first_image: {
          thumb: 'https://img/t.webp',
          card: 'https://img/c.webp',
          detail: 'https://img/d.webp',
        },
      },
    ]);
    expect(row?.thumb).toBe('https://img/t.webp');
    expect(
      orderRows([{ order_id: 'x', first_image: { card: 'https://img/c.webp' } }])[0]?.thumb,
    ).toBe('https://img/c.webp');
  });

  it('⚠️ 没有首图 / 脏值 → 占位图（不留空白方块，也不把 "[object Object]" 当地址）', () => {
    expect(orderRows([{ order_id: 'x' }])[0]?.thumb).toBe(PLACEHOLDER_IMAGE);
    expect(orderRows([{ order_id: 'x', first_image: {} }])[0]?.thumb).toBe(PLACEHOLDER_IMAGE);
    expect(orderRows([{ order_id: 'x', first_image: 42 }])[0]?.thumb).toBe(PLACEHOLDER_IMAGE);
  });

  it('件数："共 N 件"；缺失 / 0 / 非整数 → 不显示', () => {
    expect(orderRows([{ order_id: 'x', item_count: 3 }])[0]?.itemCountText).toBe('共 3 件');
    expect(orderRows([{ order_id: 'x', item_count: 0 }])[0]?.itemCountText).toBe('');
    expect(orderRows([{ order_id: 'x', item_count: 2.5 }])[0]?.itemCountText).toBe('');
    expect(orderRows([{ order_id: 'x', item_count: '3' }])[0]?.itemCountText).toBe('');
  });
});

describe('M-10（AJ-408）：页签视图与分页签空态', () => {
  it('五个页签，当前的那个 active；认不出的 key 回落「全部」', () => {
    expect(tabsView('to_ship').map((t) => [t.key, t.label, t.active])).toEqual([
      ['all', '全部', false],
      ['unpaid', '待付款', false],
      ['to_ship', '采购中', true],
      ['shipped', '已发货', false],
      ['after_sale', '售后·退款', false],
    ]);
    expect(tabsView('bogus').find((t) => t.active)?.key).toBe('all');
  });

  it('🔴 空态文案分页签：「全部」说"还没有订单"；其它页签说"这里暂时没有订单"（不暗示一单都没有）', () => {
    expect(emptyState([], '', 'all')).toEqual({ showEmpty: true, text: '还没有订单' });
    expect(emptyState([], '', 'unpaid')).toEqual({
      showEmpty: true,
      text: '「待付款」里暂时没有订单',
    });
    expect(emptyState([], '')).toEqual({ showEmpty: true, text: '还没有订单' });
    expect(emptyState([], '网络请求失败', 'unpaid').showEmpty).toBe(false);
  });
});
