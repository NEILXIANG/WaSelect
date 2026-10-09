/**
 * 职责：购物车 / 结算 / 订单详情的**主要动作固定在屏幕底部**（小程序 UI 交互评估 A2，AJ-416）。
 *
 * @why 三页的主按钮原先跟在长内容后面：结算页要滑过商品、地址、合计、邮箱、条款才看得到「提交订单」，
 *      购物车商品一多「去结算」就在屏幕外——主流电商（淘宝 / 京东 / 拼多多）都是底栏常驻"合计 + 主按钮"。
 * @limitation 只验结构（按钮在 `.ws-buybar` 里、页面根留了等高空白）；栏有没有挡住内容、
 *             安全区是否正确，薄壳测试看不到（mp-page @limitation 一），要在开发者工具 / 真机上看。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (page: string): string =>
  readFileSync(new URL(`./pages/${page}/index.wxml`, import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );

/** 从 `<view class="ws-buybar…">` 起到文件里它闭合为止的那一段（按 view 嵌套计数）。 */
function buybar(wxml: string): string {
  const start = wxml.search(/<view class="ws-buybar[\s"]/);
  if (start < 0) return '';
  let depth = 0;
  const re = /<view\b|<\/view>/g;
  re.lastIndex = start;
  for (let m = re.exec(wxml); m; m = re.exec(wxml)) {
    depth += m[0] === '</view>' ? -1 : 1;
    if (depth === 0) return wxml.slice(start, re.lastIndex);
  }
  return '';
}

describe('底部固定操作栏（A2）', () => {
  it('购物车：合计 + 「去结算」在底栏里，栏垫在 tabBar 上方；页面根留出 tabBar + 底栏的空白', () => {
    const wxml = read('cart');
    const bar = buybar(wxml);
    expect(bar).toContain('ws-buybar--over-tabbar');
    expect(bar).toMatch(/<ws-button[^>]*bindtap="onCheckout"/);
    expect(bar).toContain('bindtap="onToggleAll"'); // A3：全选在底栏
    expect(bar).toContain('<ws-price');
    expect(bar).toContain('{{gate.hint}}');
    expect(wxml).toContain('ws-page--with-tabbar-buybar');
  });

  it('结算页：合计 + 「提交订单」在底栏里，禁用原因紧挨按钮；页面根留出底栏空白', () => {
    const wxml = read('checkout');
    const bar = buybar(wxml);
    expect(bar).toMatch(/<ws-button[^>]*bindtap="onSubmit"/);
    expect(bar).toContain('<ws-price');
    expect(bar).toContain('{{gate.reason}}');
    expect(wxml).toContain('ws-page--with-buybar');
  });

  it('订单详情：继续支付 / 确认收货 / 取消订单都在底栏里；没有可做的动作时整条栏不出现', () => {
    const wxml = read('order-detail');
    const bar = buybar(wxml);
    for (const tap of ['onPay', 'onConfirmReceiptTap', 'onCancelTap', 'onBuyAgain']) {
      expect(bar).toMatch(new RegExp(`<ws-button[^>]*bindtap="${tap}"`));
    }
    expect(bar).toMatch(/^<view class="ws-buybar"[^>]*wx:if="\{\{view\.hasActions\}\}"/);
    expect(wxml).toContain("{{view.hasActions ? 'ws-page--with-buybar' : ''}}");
    // A7：放不进购物车的说明紧挨按钮；商品行可点进详情
    expect(bar).toContain('{{buyAgainNote}}');
    expect(wxml).toMatch(/class="item"[^>]*bindtap="onOpenItem"/);
  });
});
