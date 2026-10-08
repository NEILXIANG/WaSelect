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
import { emptyState, orderRows } from './index.vm.js';

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
