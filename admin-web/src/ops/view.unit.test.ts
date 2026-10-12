/**
 * 职责：`admin-web/src/ops/view.ts` 的单测（运费分档 + 展示汇率）。
 *
 * @why 这两张表的错误**不会报错**：运费档位填反了是"每单少收钱"（D-46），
 *      汇率填反了是"所有展示价偏了"。能拦的形状问题必须在保存前拦完。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toIsoJst } from '../format.js';
import {
  FX_QUOTES,
  currentFxRawRates,
  emptyFxForm,
  emptyRateRow,
  fxFormErrors,
  fxFormKey,
  fxPreview,
  fxRows,
  fxSaveStep,
  fxSavedText,
  rateDuplicates,
  rateErrors,
  rateRows,
  toFxBody,
  toRateBody,
} from './view.js';

/**
 * 三档示意运费表（重量上限是"含"的上限——D-46）。
 * ⚠️ 不是 §2.5 的真实分档（真实锚点 w=1850 → 4950 由服务端运费向量测试钉住）；这里只测表单与排序逻辑。
 * 复核 2026-10-06（AJ-185 登记的 TSB-13）：原注释写"2kg = 4,950"，与下面的数据（2000 → 4050）矛盾。
 */
const RATES = [
  { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2200, active: true },
  { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
  { carrier: 'placeholder', max_weight_g: 5000, price_jpy: 4950, active: true },
];

const formRow = (max: string, price: string, active = true): Record<string, unknown> => ({
  carrier: 'placeholder',
  maxWeightG: max,
  priceJpy: price,
  active,
});

describe('fxRows', () => {
  // 三端模拟测试 2026-10-11（运营看不懂的数）：缓冲写 0.03（设置页写 3%），汇率 0.050985 不说是"1 円 兑多少"
  it('🔴 映射出展示列：缓冲按百分比，另给"100 日元 ≈ …"的折算示例（生效时间是 JST）', () => {
    const [row] = fxRows([
      {
        quote: 'USD',
        rate: 0.0066,
        raw_rate: 0.0067,
        buffer: 0.01,
        effective_from: '2026-09-27T00:00:00Z',
      },
    ]);
    expect(row).toEqual({
      key: 'USD|2026-09-27T00:00:00Z|0.0067',
      quote: 'USD',
      rateText: '0.0066',
      rawRateText: '0.0067',
      bufferText: '1%',
      exampleText: '100 日元 ≈ $0.66',
      effectiveText: '2026-09-27 09:00',
      isCurrent: false,
    });
  });

  it('人民币示例写「元」（日元店里 ¥ 会被读成日元）；认不出的币种把代码写在后面', () => {
    const rows = fxRows([
      {
        quote: 'CNY',
        rate: 0.050985,
        raw_rate: 0.0495,
        buffer: 0.03,
        effective_from: '2026-09-27T00:00:00Z',
      },
      {
        quote: 'EUR',
        rate: 0.0061,
        raw_rate: 0.006,
        buffer: 0,
        effective_from: '2026-09-27T00:00:00Z',
      },
    ]);
    expect(rows.map((r) => [r.exampleText, r.bufferText])).toEqual([
      ['100 日元 ≈ 5.10 元', '3%'],
      ['100 日元 ≈ 0.61 EUR', '0%'],
    ]);
  });

  it('is_current 原样转述（服务端说当前生效就是当前生效，前端不重判）', () => {
    const rows = fxRows([
      { quote: 'USD', raw_rate: 0.0067, effective_from: '2099-01-01T00:00:00Z', is_current: true },
      { quote: 'USD', raw_rate: 0.67, effective_from: '2026-09-01T00:00:00Z', is_current: false },
    ]);
    expect(rows.map((r) => r.isCurrent)).toEqual([true, false]);
  });

  it('🔴 同一分钟的两行 key 必须不同（ADM3-04：effectiveText 只到分钟，不能拿它当 key）', () => {
    // 真实场景：留空生效时间 → 服务端按毫秒取当前时刻。同一分钟内录两次，两行展示文本完全相同。
    const rows = fxRows([
      {
        quote: 'USD',
        raw_rate: 0.0067,
        rate: 0.0069,
        buffer: 0.03,
        effective_from: '2026-10-01T03:10:41.900Z',
      },
      {
        quote: 'USD',
        raw_rate: 0.0068,
        rate: 0.007,
        buffer: 0.03,
        effective_from: '2026-10-01T03:10:12.100Z',
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.effectiveText).toBe(rows[1]?.effectiveText); // 展示文本确实撞了
    expect(rows[0]?.key).not.toBe(rows[1]?.key); // 但 key 不能撞
  });

  it('⚠️ 缺字段显示占位符而不是 "undefined"', () => {
    const [row] = fxRows([{ quote: 'CNY' }]);
    expect(row?.rateText).toBe('—');
    expect(row?.effectiveText).toBe('—');
  });

  it('非数组输入给空列表', () => {
    expect(fxRows(null)).toEqual([]);
  });
});

describe('fxFormErrors / toFxBody', () => {
  it('合法表单通过', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.0067' }).ok).toBe(true);
  });

  it('⚠️ 币种不在枚举内 → 拒（契约只认 CNY / USD）', () => {
    expect(fxFormErrors({ quote: 'EUR', rawRate: '1' }).first).toContain('CNY');
  });

  it('⚠️ raw_rate 为 0 / 负数 / 非数字 → 拒（展示价会变成 0 或 NaN）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'USD', rawRate: '-1' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'USD', rawRate: 'abc' }).ok).toBe(false);
  });

  it('⚠️ effective_from 为空则不带该字段（传空串会被当成非法 date-time）', () => {
    expect(toFxBody({ quote: 'USD', rawRate: ' 0.0067 ' })).toEqual({
      quote: 'USD',
      raw_rate: 0.0067,
    });
  });

  it('⚠️ 填了时间按 JST 转成带 +09:00 的 ISO（datetime-local 没有时区，直发会被当 UTC）', () => {
    expect(toFxBody({ quote: 'CNY', rawRate: '0.048', effectiveFrom: '2026-10-01T09:00' })).toEqual(
      {
        quote: 'CNY',
        raw_rate: 0.048,
        effective_from: '2026-10-01T09:00:00+09:00',
      },
    );
  });

  it('⚠️ 时间格式不对 → 校验先拦住（不让它变成空串发出去）', () => {
    expect(
      fxFormErrors({ quote: 'USD', rawRate: '0.0067', effectiveFrom: '2026/10/01' }).first,
    ).toBe('生效时间没填完整：日期和时刻都要选（留空表示立即生效）');
    expect(toIsoJst('2026/10/01')).toBe('');
    expect(toIsoJst('')).toBe('');
  });

  it('⚠️ 空表单（默认 quote）也要先填汇率才能过', () => {
    expect(fxFormErrors(emptyFxForm()).ok).toBe(false);
  });
});

describe('fxFormErrors 的量纲区间（AJ-297：与服务端同引 FX_RAW_RATE_BOUNDS）', () => {
  /**
   * @why 旧的 `MAX_RAW_RATE = 1000` 在前端与服务端**各写一份字面量**，注释自称"同源"，
   *      实际改一边忘一边**不会红**。现在两端都引 `packages/shared` 的同一个常量，
   *      这份漂移被消掉——本组用例钉住"前端的边界就是服务端那条边界"：
   *      只放行服务端也会放行的值，只拒服务端也会拒的值。
   * @why 顺带把"错一位"从"提交后才被服务端拒"提前到"输入时就报"：
   *      1000 挡不住 0.067（那正是最常发生的录入错误），per-quote 区间能挡。
   */
  it('每个币种：真实汇率放行，×10 / ÷10 都拒（10 倍不再是"提交才炸"）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.0067' }).ok).toBe(true);
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.067' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.00067' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'CNY', rawRate: '0.049' }).ok).toBe(true);
    expect(fxFormErrors({ quote: 'CNY', rawRate: '0.49' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'CNY', rawRate: '0.0049' }).ok).toBe(false);
  });

  it('边界含在内：min / max 本身放行（不能把极值本身拦掉）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.002' }).ok).toBe(true);
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.02' }).ok).toBe(true);
  });

  it('文案点明**币种与区间**，不是只说"太大"（运营要能自己对上是哪个币、差多少）', () => {
    const r = fxFormErrors({ quote: 'USD', rawRate: '0.067' });
    expect(r.ok).toBe(false);
    expect(r.first).toContain('USD');
    expect(r.first).toContain('0.002');
    expect(r.first).toContain('0.02');
    expect(r.first).toContain('0.067');
    expect(r.first).toContain('小数点');
  });

  it('🔴 同一个数字在两个币种下结论相反（区间必须 per-quote，不能共用一个范围）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.049' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'CNY', rawRate: '0.049' }).ok).toBe(true);
  });
});

describe('fxPreview（A8：保存前的量级核对）', () => {
  /**
   * @why 2026-09-29 全量审查 A8：展示汇率**直接乘进真实扣款额**
   *      （`pay-intent.ts` 的 `resolveCharge`：USD 分支 `toMinor(total_jpy, rate)`）。
   *      而保存按钮是"一点即提交"，前端只查 >0，服务端上界 1000 只挡"多打好几个 0"，
   *      挡不住"反着填"（150）或"错一位"（0.067 / 0.00067）。
   *      录成 0.00067 之后每笔美元订单少收 90%；录成 150 多收两万倍，引来拒付。
   *      ⇒ **"错一位"这一半已由 `fxFormErrors` 的 per-quote 量纲区间接走**（AJ-297），
   *      面板上 0.067 根本走不到本函数。本函数剩下的是**区间之内**的可疑跳变。
   * @why 判据用**与当前生效值的倍数**而不是"这个数合不合理"。
   *      ⚠️ 原注释那句"绝对值没有合理范围（0.0067 和 0.049 都是对的）"**是错的**（AJ-297 更正）：
   *      0.0067 是 USD、0.049 是 CNY，差 7 倍恰恰因为它们是不同币种；
   *      它把"跨币种没有一个统一区间"当成了"每个币种都没有区间"。
   * @limitation 下面两条例外值（0.067 / 0.00067）在真实面板上会被量纲护栏先拦，
   *      这里仍按 `fxPreview` 自己的契约测——它是纯函数，不假设调用方已校验过。
   */
  it('与当前值相差不大 → 不标红（正常波动不该被拦成硬失败）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.0068', currentRate: 0.0067 });
    expect(p.risky).toBe(false);
    expect(p.ratio).toBeCloseTo(1.015, 3);
  });

  it('🔴 错一位（10 倍）→ 标红，并给出倍数与样例金额', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.067', currentRate: 0.0067 });
    expect(p.risky).toBe(true);
    expect(p.ratio).toBeCloseTo(10, 6);
    expect(p.reason).toContain('倍');
    expect(p.sampleText).toBe('10,000 日元 ≈ USD 670.00');
  });

  it('🔴 小数点错位（1/10）→ 同样标红（少收 90% 的方向更危险）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.00067', currentRate: 0.0067 });
    expect(p.risky).toBe(true);
    expect(p.ratio).toBeCloseTo(0.1, 6);
  });

  it('第一次配置（没有当前值）→ 不标红但也要给样例金额让人核对', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.0067', currentRate: null });
    expect(p.ratio).toBeNull();
    expect(p.risky).toBe(false);
    expect(p.sampleText).toBe('10,000 日元 ≈ USD 67.00');
  });

  it('填了非法值 → 给不出预览（由 fxFormErrors 负责报错，这里不重复造文案）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: 'abc', currentRate: 0.0067 });
    expect(p.risky).toBe(false);
    expect(p.sampleText).toBe('');
  });
});

describe('rateRows', () => {
  it('⚠️ 按重量上限升序展示（乱序输入也要排好，否则看不出"比上一档还小"）', () => {
    const rows = rateRows([RATES[2], RATES[0], RATES[1]]);
    expect(rows.map((r) => r.maxWeightText)).toEqual(['500 g', '2000 g', '5000 g']);
  });

  it('价格走千分位，启用态原样带出', () => {
    const rows = rateRows(RATES);
    expect(rows[2]?.priceText).toBe('4,950 日元');
    expect(rows[2]?.active).toBe(true);
  });

  it('⚠️ 同一承运商同一上限出现两次 → **两条都标** duplicate（只标后一条的话，运营看不出它跟谁撞了）', () => {
    const rows = rateRows([...RATES, { ...RATES[1] }]);
    expect(rows.filter((r) => r.duplicate)).toHaveLength(2);
    expect(rows.filter((r) => r.duplicate).map((r) => r.maxWeightText)).toEqual([
      '2000 g',
      '2000 g',
    ]);
  });
});

describe('rateErrors（整表校验）', () => {
  // 两端输入测试 2026-10-12：承运商名超过 32 字前端放行，服务端拒成泛化的"参数缺失或格式错误"
  it('🔴 承运商名超过 32 字 → 报错并标红那一格', () => {
    const r = rateErrors([{ ...formRow('500', '2200'), carrier: 'J'.repeat(33) }]);
    expect(r.errors).toContain('第 1 档：承运商名最多 32 个字');
    expect(r.cells).toContain('0:carrier');
    expect(rateErrors([{ ...formRow('500', '2200'), carrier: 'J'.repeat(32) }]).ok).toBe(true);
  });

  it('一张合法表全过', () => {
    expect(rateErrors([formRow('500', '2200'), formRow('2000', '4050')]).ok).toBe(true);
    expect(rateErrors([formRow('500', '2200')]).cells).toEqual([]);
  });

  // 全入口点击测试 2026-10-12：错误清单写"第 10 档：重量上限必填"，但表里哪一格没标出来——档位多了要自己数行
  it('🔴 cells 指出出错的格子（行下标:字段），供表格标红', () => {
    const r = rateErrors([
      formRow('500', '2200'),
      { ...formRow('', ''), carrier: '' },
      formRow('99999', '1400'),
      formRow('2000', '999999'),
    ]);
    expect(r.cells).toEqual([
      '1:carrier',
      '1:maxWeightG',
      '1:priceJpy',
      '2:maxWeightG',
      '3:priceJpy',
    ]);
  });

  it('⚠️ 空表 → 拒（空表 = 所有订单无法报价）', () => {
    const r = rateErrors([]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('至少');
  });

  it('⚠️ 重复档位 → 拒（报的是"与前面某一档重复"，不是 DB 错误）', () => {
    const r = rateErrors([formRow('2000', '4050'), formRow('2000', '4950')]);
    expect(r.errors.some((e) => e.includes('重复'))).toBe(true);
  });

  it('🔴 重量**都没填**的两行：只报"必填"，不报"重复"（ADM3-06：两处口径必须一致）', () => {
    // 场景：连点两次"新增一档"，重量都留空。旧实现用 `${carrier}|${String(max)}` 判重，
    // String(null) === 'null' → 两行被判成同一档，错误区出现一条根本不存在的"重复"。
    const r = rateErrors([
      { carrier: 'yamato', maxWeightG: '', priceJpy: '2200', active: true },
      { carrier: 'yamato', maxWeightG: '', priceJpy: '4050', active: true },
    ]);
    expect(r.errors.some((e) => e.includes('重复'))).toBe(false);
    expect(r.errors.filter((e) => e.includes('重量上限必填'))).toHaveLength(2);
    // 行上的"档位重复"标记（rateDuplicates）同样是 false——两边同口径
    expect(
      rateDuplicates([
        { carrier: 'yamato', maxWeightG: '' },
        { carrier: 'yamato', maxWeightG: '' },
      ]),
    ).toEqual([false, false]);
  });

  it('🔴 判重与 rateDuplicates 同口径：同一档填了两个不同运费 → 两边都说是重复', () => {
    const rows = [formRow('2000', '4050'), formRow('2000', '4950')];
    expect(rateErrors(rows).errors.some((e) => e.includes('重复'))).toBe(true);
    // 重复组里的**每一行**都会被标（不是只标后出现的那行）
    expect(rateDuplicates(rows)).toEqual([true, true]);
  });

  it('⚠️ 上限非整数 / 小于 1 → 拒', () => {
    expect(rateErrors([formRow('0', '100')]).errors[0]).toContain('重量上限');
    expect(rateErrors([formRow('2.5', '100')]).errors[0]).toContain('重量上限');
  });

  it('⚠️ 运费负数 → 拒', () => {
    expect(rateErrors([formRow('500', '-1')]).errors[0]).toContain('运费');
  });

  it('P2-42 启用档位跨两家承运商 → 拒，并点名是哪几家（服务端 carrier_not_single 只回泛化 40001）', () => {
    const r = rateErrors([
      { carrier: 'yamato', maxWeightG: '500', priceJpy: '2200', active: true },
      { carrier: 'japanpost', maxWeightG: '2000', priceJpy: '4050', active: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('同一家承运商') && e.includes('japanpost'))).toBe(true);
    // 另一家的档位停用后就合法（停用的档位不参与取档）
    expect(
      rateErrors([
        { carrier: 'yamato', maxWeightG: '500', priceJpy: '2200', active: true },
        { carrier: 'japanpost', maxWeightG: '2000', priceJpy: '4050', active: false },
      ]).ok,
    ).toBe(true);
  });

  it('P2-42 重量 / 运费超过 SHIPPING_RATE_BOUNDS → 拒（边界值本身放行）', () => {
    expect(rateErrors([formRow('30000', '100000')]).ok).toBe(true);
    expect(rateErrors([formRow('30001', '2200')]).first).toContain('不能超过 30000 克');
    expect(rateErrors([formRow('500', '100001')]).first).toContain('不能超过 100000 日元');
  });

  it('⚠️ 全部停用 → 拒（没有启用档 = 没有运费可算）', () => {
    const r = rateErrors([formRow('500', '2200', false)]);
    expect(r.first).toContain('启用');
  });

  it('⚠️ 承运商为空 → 拒', () => {
    const r = rateErrors([{ carrier: '', maxWeightG: '500', priceJpy: '2200', active: true }]);
    expect(r.first).toContain('承运商');
  });

  it('多个问题一起返回（整表替换一次提交，逐条报要提交很多次）', () => {
    const r = rateErrors([formRow('x', 'y'), formRow('0', '-1')]);
    expect(r.errors.length).toBeGreaterThan(2);
  });

  it('🔴 运费留空 → 必须拒（A7：`Number(\'\')` = 0 曾让空值通过"≥0 的整数"）', () => {
    /**
     * @why 2026-09-29 全量审查 A7：旧实现用 `Number(priceJpy)`，而 `Number('')` 等于 **0**，
     *      "≥0 的整数"这道校验**放行空值**，提交时又把空值转成 `price_jpy: 0`。
     *      服务端把 0 円视为合法的"手动包邮"，于是运营"新增一档"只填了重量上限、
     *      没填运费（或清空后忘了重填），确认之后**这个重量段的所有订单运费都是 0**，
     *      不报任何错——正是本文件头引用的 D-46 那类"每单少收钱且静默"。
     *      重量上限因为要求 ≥1，空值会被拦下；**运费没有同等拦截**，不对称正是漏洞所在。
     */
    const r = rateErrors([formRow('2000', '')]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('运费必填');
  });

  it('🔴 运费只有空格 → 同样拒（trim 之后才算空）', () => {
    const r = rateErrors([formRow('2000', '   ')]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('运费必填');
  });

  it('🔴 重量上限留空 → 拒，且报的是"必填"而不是"必须是整数"（没填 ≠ 填错）', () => {
    const r = rateErrors([formRow('', '2200')]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('重量上限必填'))).toBe(true);
  });

  it('⚠️ 运费填 0 → 放行（包邮是合法意图，必须显式填）', () => {
    // @why 这条是上一条的对照组：拦的是"没填"，不是"填了 0"。
    //      把 0 也拦掉会让"包邮档"无法表达，于是有人会去改校验本身。
    expect(rateErrors([formRow('2000', '0')]).ok).toBe(true);
  });

  it('🔴 `1e3` / `0x10` → 拒（`Number()` 会把它们读成 1000 / 16）', () => {
    // @why 表单输入是字符串，`Number('1e3')` = 1000、`Number('0x10')` = 16，
    //      两者在旧实现里都"看着通过了校验"，实际写进库的是运营没打算写的数。
    expect(rateErrors([formRow('2000', '1e3')]).ok).toBe(false);
    expect(rateErrors([formRow('2000', '0x10')]).ok).toBe(false);
  });
});

describe('toRateBody', () => {
  it('⚠️ 换成服务端键名（maxWeightG → max_weight_g）', () => {
    expect(toRateBody([formRow('2000', '4050')])).toEqual([
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
    ]);
  });

  it('也能吃服务端形状的行（页面取回来直接改时传的是同一份）', () => {
    expect(toRateBody([RATES[1]])).toEqual([
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
    ]);
  });

  it('非数组 → 空数组（不是抛，也不是 [undefined]）', () => {
    expect(toRateBody(null)).toEqual([]);
  });

  it('新增档位默认值：上限留空（逼运营填，而不是继承上一档）', () => {
    expect(emptyRateRow('placeholder')).toEqual({
      carrier: 'placeholder',
      maxWeightG: '',
      priceJpy: '',
      active: true,
    });
  });

  it('🔴 运费留空 → **抛错**而不是发 `price_jpy: 0`（A7 纵深防御）', () => {
    /**
     * @why 校验（rateErrors）是主防线，但它只在 `RatesPanel.save` 里被调一次。
     *      组装（toRateBody）若自己回落成 0，就等于"主防线一旦被绕过，后果仍是静默少收钱"。
     *      走到这里还解析不出 = 校验与组装的口径已经漂移，那是一个**必须响亮失败**的
     *      内部不一致；抛错至少让这次提交停在原地，而不是把 0 円写进全站运费表。
     */
    expect(() => toRateBody([formRow('2000', '')])).toThrow(/无法解析|运费/);
    expect(() => toRateBody([formRow('2000', '1e3')])).toThrow(/无法解析|运费/);
  });
});

/**
 * ⚠️ 与契约的双向比对：quote 枚举必须**恰好等于** `POST /admin/fx` 的 enum。
 * @why 少了会"配不了某个币种的展示价"，多了会提交一个服务端必拒的值。
 */
describe('FX_QUOTES 与契约的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('quote: {type: string, enum:')) ?? '';

  it('抽到了 quote 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('quote');
    expect(line).toContain('enum');
  });

  it('两边集合相等', () => {
    const contract = (line.slice(line.indexOf('enum:')).match(/[A-Z]{3}/g) ?? []).sort();
    expect([...FX_QUOTES].sort()).toEqual(contract);
  });
});

describe('currentFxRawRates：保存前核对用的基准（A8 残留 / AJ-229 / ADM3-05）', () => {
  /** 服务端行：`cur` = 服务端判定的"当前已生效"。 */
  const row = (quote: string, raw: number, at: string, cur = false) => ({
    quote,
    raw_rate: raw,
    rate: raw * 1.03,
    buffer: 0.03,
    effective_from: at,
    is_current: cur,
  });

  it('🔴 基准取**服务端标的**那一行——即使它的生效时间晚于本机时钟（电脑慢了）', () => {
    // 电脑慢：本机以为是 2026-09-30，服务端已把 2099 那行判为当前生效（真实场景是"慢几分钟"）
    const list = [
      row('USD', 0.0067, '2099-01-01T00:00:00.000Z', true),
      row('USD', 0.67, '2026-09-01T00:00:00.000Z'), // 录错后被更正的那条：不是基准
    ];
    expect(currentFxRawRates(list)).toEqual({ USD: 0.0067 });
  });

  it('🔴 生效时间更早但服务端**没标**的行不作基准（电脑快了：预约行不能被当成当前）', () => {
    const list = [
      row('USD', 0.0071, '2099-01-01T00:00:00.000Z'), // 预约行：本机时钟快的话会被误当当前
      row('USD', 0.0067, '2026-09-20T00:00:00.000Z', true),
    ];
    expect(currentFxRawRates(list)).toEqual({ USD: 0.0067 });
  });

  it('每个币种各自取自己的当前行（多币种互不干扰）', () => {
    const list = [
      row('USD', 0.0071, '2099-01-01T00:00:00.000Z'),
      row('USD', 0.0067, '2026-09-20T00:00:00.000Z', true),
      row('CNY', 0.048, '2026-09-20T00:00:00.000Z', true),
    ];
    expect(currentFxRawRates(list)).toEqual({ USD: 0.0067, CNY: 0.048 });
  });

  it('取的是 raw_rate 而不是含缓冲的 rate（否则倍数恒偏 1/(1+buffer)）', () => {
    expect(currentFxRawRates([row('CNY', 0.048, '2026-09-01T00:00:00.000Z', true)])).toEqual({
      CNY: 0.048,
    });
  });

  it('🔴 服务端没下发 is_current → **不猜**：该币种不出现（= 没有基准 → 要求勾选）', () => {
    // 老包新包混部时最危险的是"拿本机时钟猜出一个基准、算出不可疑"——那是一键写库。
    expect(currentFxRawRates([row('USD', 0.0067, '2026-09-01T00:00:00.000Z')])).toEqual({});
    expect(currentFxRawRates([{ quote: 'USD', raw_rate: 0.0067, is_current: 'true' }])).toEqual({});
  });

  it('同币种两行都标 true（口径异常）：取列表里第一条（倒序 = 最新的），不随遍历顺序漂移', () => {
    const list = [
      row('USD', 0.0067, '2026-09-20T00:00:00.000Z', true),
      row('USD', 0.67, '2026-09-01T00:00:00.000Z', true),
    ];
    expect(currentFxRawRates(list)).toEqual({ USD: 0.0067 });
  });

  it('脏数据逐行跳过：非数组 / 缺字段 / 非正数', () => {
    expect(currentFxRawRates(null)).toEqual({});
    expect(
      currentFxRawRates([
        null,
        { quote: 'USD', is_current: true },
        { quote: 'USD', raw_rate: 0, is_current: true },
        { quote: '', raw_rate: 0.0067, is_current: true },
      ]),
    ).toEqual({});
  });
});

describe('fxPreview 的阈值边界与无基准（AJ-229）', () => {
  it('倍数恰为 1.5 / 0.67 标可疑；1.49 / 0.68 不标（把阈值改成别的数这条必须红）', () => {
    const at = (raw: string) => fxPreview({ quote: 'USD', rawRate: raw, currentRate: 1 });
    expect(at('1.5').risky).toBe(true);
    expect(at('1.49').risky).toBe(false);
    expect(at('0.67').risky).toBe(true);
    expect(at('0.68').risky).toBe(false);
  });

  it('🔴 没有基准：noBaseline 为真并给出理由（不是"不可疑"）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '150', currentRate: null });
    expect(p.noBaseline).toBe(true);
    expect(p.risky).toBe(false);
    expect(p.reason).toContain('没有可比对');
    expect(p.sampleText).toContain('USD 1500000.00');
  });

  it('有基准时 noBaseline 为假；非法输入时也为假（那是 fxFormErrors 的事）', () => {
    expect(fxPreview({ quote: 'USD', rawRate: '0.0068', currentRate: 0.0067 }).noBaseline).toBe(
      false,
    );
    expect(fxPreview({ quote: 'USD', rawRate: 'abc', currentRate: null }).noBaseline).toBe(false);
  });
});

describe('fxSaveStep：保存闸门（AJ-229）', () => {
  const form = { quote: 'USD', rawRate: '0.0068', effectiveFrom: '' };
  const key = fxFormKey(form);

  it('形状不合法 → invalid，带 fxFormErrors 的文案', () => {
    const s = fxSaveStep({
      form: { ...form, rawRate: '1001' },
      currentRate: 0.0067,
      confirmKey: null,
      ackKey: null,
    });
    expect(s.kind).toBe('invalid');
  });

  it('🔴 第一次点保存：一律进确认（哪怕倍数很正常）；不可疑则不要求勾选', () => {
    expect(fxSaveStep({ form, currentRate: 0.0067, confirmKey: null, ackKey: null })).toEqual({
      kind: 'confirm',
      requireAck: false,
    });
  });

  it('不可疑 + 已确认过**这份**表单 → save（requireAck=false 也要带上：面板靠它决定要不要渲染复选框）', () => {
    expect(fxSaveStep({ form, currentRate: 0.0067, confirmKey: key, ackKey: null })).toEqual({
      kind: 'save',
      requireAck: false,
    });
  });

  it('🔴 可疑：确认了但没勾选 → 仍是 confirm；勾的是别的表单也不算', () => {
    // ⚠️ risky 值必须**仍在量纲区间内**（USD [0.002, 0.02]）：0.67 这类过去用来当"可疑值"的
    //    数现在会被 `fxFormErrors` 的量纲护栏先拒掉（返回 invalid），根本走不到本闸门。
    //    所以这里取 0.0134 —— 是 0.0067 的 2 倍（≥1.5 ⇒ 可疑），但仍在区间内。
    const risky = { ...form, rawRate: '0.0134' };
    const k = fxFormKey(risky);
    const base = { form: risky, currentRate: 0.0067 };
    expect(fxSaveStep({ ...base, confirmKey: k, ackKey: null })).toEqual({
      kind: 'confirm',
      requireAck: true,
    });
    expect(fxSaveStep({ ...base, confirmKey: k, ackKey: key })).toEqual({
      kind: 'confirm',
      requireAck: true,
    });
    // ⚠️ save 分支**必须**带 requireAck=true（ADM3-03）：面板据此让复选框在勾选后继续留在屏幕上
    expect(fxSaveStep({ ...base, confirmKey: k, ackKey: k })).toEqual({
      kind: 'save',
      requireAck: true,
    });
  });

  it('🔴 确认的是旧表单（之后改了值）→ 回到 confirm，不会直接 save', () => {
    // 同上：改用区间内的值，否则量纲护栏会先把它判成 invalid，测不到"确认作废"这条闸门
    const changed = { ...form, rawRate: '0.0134' };
    expect(
      fxSaveStep({ form: changed, currentRate: 0.0067, confirmKey: key, ackKey: key }).kind,
    ).toBe('confirm');
  });

  it('🔴 没有基准 → 要求勾选（算不出倍数不等于安全）', () => {
    const k = fxFormKey(form);
    expect(fxSaveStep({ form, currentRate: null, confirmKey: k, ackKey: null })).toEqual({
      kind: 'confirm',
      requireAck: true,
    });
  });

  it('fxFormKey：三项任一变化都变；首尾空白不算变化', () => {
    expect(fxFormKey({ ...form, rawRate: ' 0.0068 ' })).toBe(key);
    expect(fxFormKey({ ...form, quote: 'CNY' })).not.toBe(key);
    expect(fxFormKey({ ...form, rawRate: '0.0069' })).not.toBe(key);
    expect(fxFormKey({ ...form, effectiveFrom: '2026-10-01T09:00' })).not.toBe(key);
    expect(fxFormKey(null)).toBe('||');
  });

  it('fxSavedText：填了生效时间就不说"立即"', () => {
    expect(fxSavedText(form)).toContain('立即');
    expect(fxSavedText({ ...form, effectiveFrom: '2026-10-01T09:00' })).not.toContain('立即');
    expect(fxSavedText(null)).toContain('立即');
  });
});

describe('rateDuplicates：按表单行原顺序标重复（AJ-232）', () => {
  const r = (carrier: string, maxWeightG: string) => ({
    carrier,
    maxWeightG,
    priceJpy: '1',
    active: true,
  });

  it('🔴 返回与入参等长、同序——不是按重量排序后的顺序', () => {
    expect(rateDuplicates([r('EMS', '2000'), r('EMS', '500'), r('EMS', '500')])).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('按数值比重量：`500`、` 500 `、`0500` 是同一档；不同承运商不算重复', () => {
    expect(rateDuplicates([r('EMS', '500'), r('EMS', ' 500 '), r('EMS', '0500')])).toEqual([
      true,
      true,
      true,
    ]);
    expect(rateDuplicates([r('EMS', '500'), r('DHL', '500')])).toEqual([false, false]);
  });

  it('认不出数值的行（空 / 非数字）不参与判重；非数组 → []', () => {
    expect(rateDuplicates([r('EMS', ''), r('EMS', ''), r('EMS', 'abc')])).toEqual([
      false,
      false,
      false,
    ]);
    expect(rateDuplicates(null)).toEqual([]);
  });
});
