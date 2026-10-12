/**
 * 部分退款的管理端纯函数层（AJ-383）。
 * @why 金额换算是这一页唯一会"差一个数量级"的地方：USD 10.00 必须提交 1000（分），JPY 1000 必须提交 1000（円）。
 */
import { describe, expect, it } from 'vitest';
import {
  partialSyncNotice,
  formatMinor,
  fullRefundConfirmBody,
  fullRefundAmountText,
  formatMinorCn,
  parseAmountToMinor,
  partialRefundErrorNotice,
  partialRefundGate,
  partialRefundInputCheck,
  partialRefundRows,
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
  // 两端输入测试 2026-10-12：提示写的是"JPY 没有小数 / USD 最多 2 位小数"——同一处的标签早已改写中文币种名（AJ-410）
  it('🔴 小数位超出的提示写中文币种名，不写币种代码', () => {
    expect(parseAmountToMinor('1200.5', 'JPY')).toEqual({ ok: false, reason: '日元没有小数' });
    expect(parseAmountToMinor('10.555', 'USD')).toEqual({ ok: false, reason: '美元最多 2 位小数' });
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

// AJ-437（联动走查·小白运营 2026-10-10）：日元金额带单位"円 / 日元"照收（"1,000" 早已收，"1000円"却被拒，同一个人两种写法两种结果）。
// "¥" 照旧拒：本项目口径 ¥ 是人民币（D-36），"¥1000" 是哪种钱有歧义——钱的输入宁拒不猜。
describe('parseAmountToMinor：日元带单位（AJ-437）', () => {
  it.each([
    ['1000円', 1000],
    ['1,000円', 1000],
    ['1000 円', 1000],
    [' 1000円 ', 1000],
    ['1000日元', 1000],
    ['2,500 日元', 2500],
  ])('🔴 JPY "%s" → %i', (raw, minor) => {
    expect(parseAmountToMinor(raw, 'JPY')).toEqual({ ok: true, minor });
  });

  it.each([
    ['¥1000', 'JPY'],
    ['1000¥', 'JPY'],
    ['円', 'JPY'],
    ['1000円円', 'JPY'],
    ['1000円日元', 'JPY'],
    ['円1000', 'JPY'],
    ['10.5円', 'JPY'],
    ['1000円', 'USD'],
    ['10日元', 'USD'],
    ['1,5円', 'JPY'],
  ])('拒 "%s"（%s）', (raw, currency) => {
    expect(parseAmountToMinor(raw, currency).ok).toBe(false);
  });

  it('带单位的 0 / 超大数照旧分开提示', () => {
    expect(parseAmountToMinor('0円', 'JPY')).toEqual({ ok: false, reason: '金额必须大于 0' });
    expect(parseAmountToMinor('99999999999999999999円', 'JPY')).toEqual({
      ok: false,
      reason: '金额太大，请检查是不是多打了几位',
    });
  });
});

// 严格检查 A-2（2026-10-10）：全额退款确认框原先固定写"合计 {total_jpy}"，而服务端实退 = 原币实收 − 已成功部分退款
// （server/src/domain/partial-refund.ts fullRefundAmount）。不可撤销的动作上，运营核对的必须是真正要退的那个数。
describe('fullRefundConfirmBody：确认框写实际要退的钱', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    order_no: '261009-9H4QTF',
    total_jpy: 18_550,
    payments: [{ status: 'succeeded', charge_currency: 'JPY', charge_amount: 18_550 }],
    partial_refunds: [],
    ...over,
  });

  it.each([
    [
      '没有部分退款（日元）',
      order(),
      '订单 261009-9H4QTF：将原路退回 18,550 日元。退款原因会记录下来。',
    ],
    [
      '已成功部分退 2,000 日元（sim 实例）',
      order({ partial_refunds: [{ status: 'succeeded', amount_minor: 2000 }] }),
      '订单 261009-9H4QTF：将原路退回 16,550 日元（实收 18,550 日元，已部分退 2,000 日元）。退款原因会记录下来。',
    ],
    [
      '在途的部分退款不扣（只扣已成功的，与服务端 fullRefundAmount 同口径；在途时服务端会直接拒全额退款）',
      order({
        partial_refunds: [
          { status: 'succeeded', amount_minor: 2000 },
          { status: 'initiated', amount_minor: 1000 },
        ],
      }),
      '订单 261009-9H4QTF：将原路退回 16,550 日元（实收 18,550 日元，已部分退 2,000 日元）。退款原因会记录下来。',
    ],
    [
      '失败的部分退款不扣',
      order({ partial_refunds: [{ status: 'failed', amount_minor: 5000 }] }),
      '订单 261009-9H4QTF：将原路退回 18,550 日元。退款原因会记录下来。',
    ],
    [
      '美元付款 → 按美元写，并说明按付款币种退',
      order({ payments: [{ status: 'succeeded', charge_currency: 'USD', charge_amount: 12_788 }] }),
      '订单 261009-9H4QTF：将原路退回 $127.88（按买家付款的币种退）。退款原因会记录下来。',
    ],
  ])('🔴 %s', (_name, o, text) => {
    expect(fullRefundConfirmBody(o)).toBe(text);
  });

  it('没有成功的支付记录 → 不编数字，写合计并说明以支付机构为准', () => {
    expect(fullRefundConfirmBody(order({ payments: [] }))).toBe(
      '订单 261009-9H4QTF：合计 18,550 日元（实际可退金额以支付机构为准）。退款原因会记录下来。',
    );
  });

  it('部分退款已退满 → 说"已无可退金额"（服务端会拒，确认框不该再写一个数）', () => {
    expect(
      fullRefundConfirmBody(
        order({ partial_refunds: [{ status: 'succeeded', amount_minor: 18_550 }] }),
      ),
    ).toBe('订单 261009-9H4QTF：部分退款已退满实收，已无可退金额。');
  });

  describe('S8（AJ-475）：金额输入对输入法常见形态宽容', () => {
    it('全角数字 / 前导点 / 尾随点都按数字解析', () => {
      expect(parseAmountToMinor('１０００', 'JPY')).toEqual({ ok: true, minor: 1000 });
      expect(parseAmountToMinor('.5', 'USD')).toEqual({ ok: true, minor: 50 });
      expect(parseAmountToMinor('1000.', 'JPY')).toEqual({ ok: true, minor: 1000 });
    });
  });
});

// 全入口点击测试 2026-10-11：全额退款抽屉原先不显示要退多少（要回页面去找；确认框里才有）——抽屉里先写一句，与确认框同一口径
describe('fullRefundAmountText（抽屉里写要退多少）', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    order_no: '261009-9H4QTF',
    total_jpy: 18_550,
    payments: [{ status: 'succeeded', charge_currency: 'JPY', charge_amount: 18_550 }],
    partial_refunds: [],
    ...over,
  });
  it('🔴 与确认框同一个数（去掉单号与结尾那句）', () => {
    expect(fullRefundAmountText(order())).toBe('将原路退回 18,550 日元');
    expect(
      fullRefundAmountText(
        order({ partial_refunds: [{ status: 'succeeded', amount_minor: 2000 }] }),
      ),
    ).toBe('将原路退回 16,550 日元（实收 18,550 日元，已部分退 2,000 日元）');
    expect(fullRefundAmountText(order({ payments: [] }))).toBe(
      '合计 18,550 日元（实际可退金额以支付机构为准）',
    );
  });
});

// 日元与后台其它金额同一写法"5,350 日元"（2026-10-12 后台不再写「円」）；其它币种照旧写中文名
describe('formatMinorCn：日元写「日元」', () => {
  it('🔴 JPY → "5,350 日元"；USD → "81.60 美元"', () => {
    expect(formatMinorCn(5350, 'JPY')).toBe('5,350 日元');
    expect(formatMinorCn(8160, 'USD')).toBe('81.60 美元');
  });
});

// 两端逐页走查第三轮 2026-10-12：点「同步」后提示写"部分退款已提交"——那是新建时的话，同步要说结果
describe('partialSyncNotice', () => {
  const order = {
    partial_refunds: [
      { id: 'rf-1', status: 'succeeded', currency: 'JPY', amount_minor: 1200, reason: '外箱压坏' },
      { id: 'rf-2', status: 'pending', currency: 'JPY', amount_minor: 800, reason: '少发' },
    ],
  };
  it('🔴 按刷新后那一笔的状态说结果；找不到就说去看记录', () => {
    expect(partialSyncNotice(order, 'rf-1')).toBe('已同步：1,200 日元这笔已退款');
    expect(partialSyncNotice(order, 'rf-2')).toBe(
      '已同步：800 日元这笔仍在机构处理中，稍后再点「同步」',
    );
    expect(partialSyncNotice(null, 'rf-9')).toBe('已同步，结果以上方记录为准');
  });
});
