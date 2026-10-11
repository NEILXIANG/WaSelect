/**
 * 职责：`utils/quote-view.js` 的单测（从 `pages/cart/index.vm.unit.test.ts` 迁来的报价区部分）。
 *
 * @why 钉的是"报价区说假话"：
 *      ① 关税在估值都没有时显示 → 用户读成"不收关税"（契约：信息字段，D-32）；
 *      ② 合计缺字段却把 null 塞给 ws-price → 它对非整数**响亮失败**（空白 + 控制台报错）；
 *      ③ 免邮/拆单提示在不该出现时出现。
 *
 * @why 单独成文件而不是留在购物车页 vm 的测试里：报价区是**共享视图**
 *      （确认订单页渲染同一块），它的守卫不该挂在一个页面的配套测试上——
 *      否则"改了共享层、购物车页没动"会出现"改的人不知道自己动了共享代码"。
 */
import { describe, expect, it } from 'vitest';
import { quoteView } from './quote-view.js';

const QUOTE = {
  items_jpy: 7200,
  shipping_jpy: 1950,
  duty_jpy: 936,
  duty_estimate: true,
  total_jpy: 9150,
  weight_g: 1850,
  display: { USD: 6220, CNY: 44800 },
  free_shipping_remaining_jpy: 0,
  split_hint: false,
};

describe('quoteView（报价区）', () => {
  it('完整报价：商品合计 + 运费两行 + 合计（三币）；关税在合计下方的说明里（MP-11）', () => {
    const v = quoteView(QUOTE);
    expect(v.lines).toEqual([
      { label: '商品合计', value: '7,200 円' },
      { label: '运费', value: '1,950 円' },
    ]);
    expect(v.totalText).toBe('9,150 円');
    expect(v.hasTotal).toBe(true);
    expect(v.totalJpy).toBe(9150);
    expect(v.totalSub).toBe('≈ $62.20 · ≈ ¥448.00');
    // MP-11（第二轮审计 2026-10-11）：关税并列成第三行时三行相加 ≠ 合计，买家会以为算错；改为合计下方一句说明
    expect(v.hints).toEqual(['其中预估关税 936 円（已含在商品价内）']);
  });

  it('⚠️ duty_estimate=false（或 duty_jpy=null）→ **不显示关税行**', () => {
    // @why 契约明说 duty 是信息字段；估值都没有时显示"关税：—"，
    //      用户会读成"没算关税 = 不收关税"——那是两种完全不同的事。
    // MP-11 起关税不在 lines 里，改查 hints（说明行）
    const dutyHint = (q: Record<string, unknown>) =>
      quoteView(q).hints.some((h: string) => h.includes('关税'));
    expect(dutyHint({ ...QUOTE, duty_estimate: false, duty_jpy: null })).toBe(false);
    expect(dutyHint({ ...QUOTE, duty_estimate: true, duty_jpy: null })).toBe(false);
    // ⚠️ 上面两条**同时**把 duty_jpy 也改成了 null，只覆盖了"数字都没有"这一种；
    //    "duty_jpy 有数字但不是估值"才是真正会骗人的那一档（有数所以敢显示）——
    //    缺陷注入（去掉 duty_estimate===true 判断）曾因这两条而**未变红**，故补此行。
    expect(dutyHint({ ...QUOTE, duty_estimate: false, duty_jpy: 936 })).toBe(false);
    expect(dutyHint(QUOTE)).toBe(true);
    for (const q of [QUOTE, { ...QUOTE, duty_estimate: false, duty_jpy: 936 }]) {
      expect(quoteView(q).lines.some((l: { label: string }) => l.label.includes('关税'))).toBe(
        false,
      );
    }
  });

  it('免邮差额 > 0 → 提示"再买 X 免运费"；split_hint → 拆单提示', () => {
    const v = quoteView({ ...QUOTE, free_shipping_remaining_jpy: 1200, split_hint: true });
    expect(v.hints).toEqual([
      '其中预估关税 936 円（已含在商品价内）',
      '再买 1,200 円 免运费',
      '已超过单笔上限，请分两单下单',
    ]);
  });

  describe('split_hint（B38 / AJ-221：它是"已超过"，不是"接近"）', () => {
    it('文案必须说"已超过"，且不许再出现"接近"', () => {
      // @why 服务端 `splitHint = total > maxOrderJpy`——已经超了。
      //      "接近上限，建议拆单"把既成事实写成提醒，页面还放行提交，
      //      于是用户提交必然吃 40906（看起来像系统问题）。
      const v = quoteView({ ...QUOTE, split_hint: true });
      // MP-11：QUOTE 带关税估值，说明行第一句是关税（与本条无关，照实列出以保持精确相等）
      expect(v.hints).toEqual([
        '其中预估关税 936 円（已含在商品价内）',
        '已超过单笔上限，请分两单下单',
      ]);
      expect(v.hints.join('')).not.toContain('接近');
    });

    it('⚠️ 不提"申报"：为规避申报而拆单的措辞有审核与合规敏感性', () => {
      const v = quoteView({ ...QUOTE, split_hint: true });
      expect(v.hints.join('')).not.toContain('申报');
    });

    it('splitRequired 与 split_hint 同步（闸门的输入，不是只给一句话）', () => {
      expect(quoteView({ ...QUOTE, split_hint: true }).splitRequired).toBe(true);
      expect(quoteView({ ...QUOTE, split_hint: false }).splitRequired).toBe(false);
      expect(quoteView({}).splitRequired).toBe(false);
      // 形态不对也不该变成 true（"undefined === true"永远假，但字符串 'true' 不能算数）
      expect(quoteView({ split_hint: 'true' }).splitRequired).toBe(false);
    });
  });

  it('⚠️ 缺字段降级：只缺运费 → 其余行还在（不让整个报价区消失）', () => {
    const v = quoteView({ items_jpy: 7200 });
    expect(v.lines).toEqual([{ label: '商品合计', value: '7,200 円' }]);
    expect(v.hasTotal).toBe(false);
    expect(v.totalJpy).toBeNull();
    expect(v.totalText).toBe('');
    expect(v.totalSub).toBe('');
  });

  it('⚠️ 合计缺失时 hasTotal=false——wxml 据此不渲染 ws-price（它对非整数响亮失败）', () => {
    const v = quoteView({ items_jpy: 7200, shipping_jpy: 1950 });
    expect(v.hasTotal).toBe(false);
    expect(v.totalJpy).toBeNull();
  });

  it('脏输入：null / 非对象 → 全空壳，不抛', () => {
    expect(quoteView(null)).toMatchObject({ lines: [], hasTotal: false, totalText: '' });
    expect(quoteView('x')).toMatchObject({ lines: [], hasTotal: false, totalText: '' });
  });
});
