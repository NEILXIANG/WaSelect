/**
 * 部分退款的管理端纯函数层（AJ-383）。
 * @why 金额换算是这一页唯一会"差一个数量级"的地方：USD 10.00 必须提交 1000（分），JPY 1000 必须提交 1000（円）。
 */
import { describe, expect, it } from 'vitest';
import {
  formatMinor,
  parseAmountToMinor,
  partialRefundGate,
  partialRefundInputCheck,
  partialRefundRows,
  partialRefundErrorNotice,
  refundableMinor,
} from './partial-refund-view.js';

const order = (over: Record<string, unknown> = {}) => ({
  status: 'delivered',
  has_dispute: false,
  payments: [{ status: 'succeeded', charge_currency: 'USD', charge_amount: 8160 }],
  partial_refunds: [] as unknown[],
  ...over,
});

describe('parseAmountToMinor', () => {
  it('USD：10 / 10.5 / 10.05 → 1000 / 1050 / 1005', () => {
    expect(parseAmountToMinor('10', 'USD')).toEqual({ ok: true, minor: 1000 });
    expect(parseAmountToMinor('10.5', 'USD')).toEqual({ ok: true, minor: 1050 });
    expect(parseAmountToMinor(' 10.05 ', 'USD')).toEqual({ ok: true, minor: 1005 });
  });
  it('JPY：1200 → 1200；1200.5 → 拒（円没有小数）', () => {
    expect(parseAmountToMinor('1200', 'JPY')).toEqual({ ok: true, minor: 1200 });
    expect(parseAmountToMinor('1200.5', 'JPY').ok).toBe(false);
  });
  it.each(['', '0', '0.00', '-1', 'abc', '1.234', '1e3', '0x10'])('🔴 %j → 拒', (raw) => {
    expect(parseAmountToMinor(raw, 'USD').ok).toBe(false);
  });
  it('不走浮点：0.29 → 29（浮点 0.29*100 = 28.999…）', () => {
    expect(parseAmountToMinor('0.29', 'USD')).toEqual({ ok: true, minor: 29 });
  });
});

describe('formatMinor', () => {
  it('USD 1005 → 10.05 USD；JPY 1200 → 1,200 JPY', () => {
    expect(formatMinor(1005, 'USD')).toBe('10.05 USD');
    expect(formatMinor(1200, 'JPY')).toBe('1,200 JPY');
  });
});

describe('refundableMinor', () => {
  it('实收 − 除 failed 外的部分退款', () => {
    expect(
      refundableMinor(
        order({
          partial_refunds: [
            { status: 'succeeded', amount_minor: 1000 },
            { status: 'failed', amount_minor: 500 },
            { status: 'unknown', amount_minor: 300 },
          ],
        }),
      ),
    ).toEqual({ currency: 'USD', minor: 6860 });
  });
  it('没有 succeeded 支付行 → null', () => {
    expect(refundableMinor(order({ payments: [] }))).toBeNull();
  });
});

describe('partialRefundGate（与服务端 partialRefundGuard 同口径）', () => {
  it.each(['paid', 'shipped', 'delivered', 'completed'])('%s → 可退', (status) => {
    expect(partialRefundGate(order({ status })).ok).toBe(true);
  });
  it('🔴 refunding / refunded / cancelled → 不可', () => {
    for (const status of ['refunding', 'refunded', 'cancelled']) {
      expect(partialRefundGate(order({ status })).ok).toBe(false);
    }
  });
  it('🔴 拒付中 → 不可；有在途的一笔 → 不可（先同步它）', () => {
    expect(partialRefundGate(order({ has_dispute: true })).ok).toBe(false);
    const g = partialRefundGate(
      order({ partial_refunds: [{ status: 'pending', amount_minor: 1 }] }),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('同步');
  });
  it('🔴 额度已用完 → 不可', () => {
    expect(
      partialRefundGate(order({ partial_refunds: [{ status: 'succeeded', amount_minor: 8160 }] }))
        .ok,
    ).toBe(false);
  });
});

describe('partialRefundInputCheck', () => {
  it('🔴 没有已成功的支付（币种解析为空）→ 直说"没有已成功的支付记录"，不报金额格式错误', () => {
    const r = partialRefundInputCheck({
      amount: 'abc',
      reason: '',
      order: order({ payments: [] }),
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('没有已成功的支付记录');
  });
});

describe('partialRefundRows', () => {
  it('每行：金额文本、中文状态、在途才可同步', () => {
    const rows = partialRefundRows(
      order({
        partial_refunds: [
          {
            id: 'rf-1',
            status: 'succeeded',
            currency: 'USD',
            amount_minor: 1000,
            reason: '缺一件',
            created_at: '2026-10-06T03:00:00Z',
          },
          {
            id: 'rf-2',
            status: 'unknown',
            currency: 'USD',
            amount_minor: 50,
            reason: '破损',
            created_at: '2026-10-06T04:00:00Z',
          },
        ],
      }),
    );
    // 2026-10-09 浏览器复验（AJ-410 N28 补漏）：记录行也写中文币种名，新手不认识 USD / JPY
    expect(rows.map((r) => [r.id, r.amount, r.statusText, r.canSync])).toEqual([
      ['rf-1', '10.00 美元', '已退款', false],
      ['rf-2', '0.50 美元', '结果未知（点同步取回）', true],
    ]);
  });
});

describe('partialRefundErrorNotice（P2-49）', () => {
  const order = (rows: unknown[]): unknown => ({ partial_refunds: rows });
  it('同步某一行：按那一行的状态说；发起：取新出现的那行；4xx 找不到新行 → 空', () => {
    expect(
      partialRefundErrorNotice({
        code: 50000,
        order: order([{ id: 'a', status: 'failed' }]),
        refundId: 'a',
      }),
    ).toContain('额度已释放');
    expect(
      partialRefundErrorNotice({
        code: 50000,
        order: order([
          { id: 'old', status: 'failed' },
          { id: 'new', status: 'initiated' },
        ]),
        knownIds: ['old'],
      }),
    ).toContain('结果未知');
    expect(
      partialRefundErrorNotice({ code: 40001, order: order([{ id: 'old' }]), knownIds: ['old'] }),
    ).toBe('');
  });
  it('50300 → 请求未发出 + 秒数', () => {
    expect(partialRefundErrorNotice({ code: 50300, retryAfterSec: 2, order: null })).toContain(
      '约 2 秒后可重试',
    );
  });
});

describe('parseAmountToMinor：超大数与 0 分开提示（模拟走查 2026-10-09）', () => {
  it('🔴 18 位数字 → "金额太大"；0 → "必须大于 0"', () => {
    expect(parseAmountToMinor('999999999999999999', 'JPY')).toEqual({
      ok: false,
      reason: '金额太大，请检查是不是多打了几位',
    });
    expect(parseAmountToMinor('0', 'JPY')).toEqual({ ok: false, reason: '金额必须大于 0' });
  });
});

describe('parseAmountToMinor：运营的常见写法（三端联动走查 2026-10-08）', () => {
  it('🔴 千分位逗号照收（"2,000" 是运营最自然的写法）：位置对的才收', () => {
    expect(parseAmountToMinor('2,000', 'JPY')).toEqual({ ok: true, minor: 2000 });
    expect(parseAmountToMinor('12,345.67', 'USD')).toEqual({ ok: true, minor: 1234567 });
    expect(parseAmountToMinor('1,234,567', 'JPY')).toEqual({ ok: true, minor: 1234567 });
    // 位置不对的逗号不猜：可能是欧式小数点（1,5 = 1.5），猜成 15 就是多退十倍
    expect(parseAmountToMinor('1,5', 'JPY').ok).toBe(false);
    expect(parseAmountToMinor('20,00', 'USD').ok).toBe(false);
    expect(parseAmountToMinor(',200', 'JPY').ok).toBe(false);
  });

  it('🔴 格式错的提示按币种举例：日元说"例如 2000"，不再拿 10.50 当日元的例子（标签写着"整数"）', () => {
    expect(parseAmountToMinor('两千', 'JPY')).toEqual({
      ok: false,
      reason: '金额只能是数字，例如 2000',
    });
    expect(parseAmountToMinor('ten', 'USD')).toEqual({
      ok: false,
      reason: '金额只能是数字，例如 10.50',
    });
  });
});
