/**
 * 职责：`readable.ts`（"看得懂"不变量）自身的用例——每条规则都要能拦住它声称拦的东西，且不误伤正常文案。
 *
 * @why 判据错了，所有用它的旅程测试都会"假绿"：规则写漏一个，内部码就能一路进到界面。
 *      反例取自这两天真实界面上的原文（测试缺口复盘 2026-10-12）。
 */
import { describe, expect, it } from 'vitest';
import { unreadable, visibleTexts } from './readable.js';

describe('unreadable：真实出现过的内部码一律拦下', () => {
  it.each([
    ['只看这位客户 3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718', '36 位内部 id'],
    ['内部编号 ord-52673684-5517', '内部订单编号（ord-…）'],
    ['待发货 · 支付机构 mock', '支付通道代号'],
    ['状态：paid', '英文状态代号'],
    ['停售人 admin:u-admin', '内部账号（admin:… 这类）'],
    ['出错了（40400）', '裸错误码（4xxxx / 5xxxx）'],
    ['服务器开小差了 50000', '裸错误码（4xxxx / 5xxxx）'],
    ['合计 undefined', '程序占位值'],
    ['NaN 日元', '程序占位值'],
    ['330 円', '「円」（中文读者认不得，D-82）'],
  ])('%s → %s', (text, why) => {
    expect(unreadable({ text }).map((f) => f.why)).toContain(why);
  });
});

describe('unreadable：正常文案不误伤', () => {
  it.each([
    '39,600 日元',
    '已付款 · 日本采购中',
    '下单 2026-10-12 17:19（日本时间）',
    '≈ $265.32 · ≈ 人民币 ¥1,940.40',
    '运单号 EJ123456789JP',
    '库存只剩 2 件，已改为 2 件',
    '订单号 261012-EPT8V3',
    '付款成功（待发货） · 支付机构 模拟支付',
    '45,000 日元', // 千分位里的 45000 不是错误码
  ])('%s', (text) => {
    expect(unreadable({ text })).toEqual([]);
  });
});

describe('visibleTexts：给程序用的键不算展示文字', () => {
  it('跳过 id / orderId / 图片 / 链接 / 跳转意图 / 原始金额；递归进数组与对象', () => {
    const v = {
      orderId: 'ord-52673684-5517-4f6b-a920-4c62e4f45498',
      productId: '3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718',
      image: '/assets/placeholder.png',
      trackingUrl: 'https://example.test/?id=1',
      targetHref: '#/orders/ord-52673684-5517-4f6b-a920-4c62e4f45498',
      go: 'detail',
      totalJpy: 39600,
      status: 'paid',
      items: [{ title: '南部铁器 铁壶', unitPriceText: '16,500 日元' }],
    };
    expect(visibleTexts(v).map((t) => t.text)).toEqual(['南部铁器 铁壶', '16,500 日元']);
    expect(unreadable(v)).toEqual([]);
  });

  it('同样的内部码放进展示字段就会被拦（键名决定是否上屏）', () => {
    expect(unreadable({ recipientText: '3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718' })).toHaveLength(1);
  });
});
