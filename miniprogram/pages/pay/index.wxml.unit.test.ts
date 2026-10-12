/**
 * 职责：支付页模板的按钮档位（AJ-431，用户 2026-10-10 授权代决）——每屏只留一个实心主按钮。
 *
 * @why 档位写在模板里（vm 管不到 wxml 表达式），只能读模板钉住：
 *      ① 支付方式走 `ws-button`、档位取 vm 的 `buttonType`（第一个实心）——原先是卡片里的一行字，看不出能点；
 *      ② 「查看订单」只在页面上**没有更该做的事**时才是实心：有支付方式 / 重新下单 / 复制链接时降为描边。
 *      原先它恒为实心，与"去首页重新下单""复制链接"同屏两个主按钮，可付款时更是唯一的实心按钮。
 * @limitation 只验模板文字，不验渲染；真实效果以模拟器截图为准（AJ-431 下游里记了实测）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync(resolve(import.meta.dirname, 'index.wxml'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
);
/** 取出包含某段文字的那个 `<ws-button …/>` 标签（按 `/>` 收尾：属性表达式里会有 `>`）。 */
const buttonWith = (needle: string): string =>
  (wxml.match(/<ws-button\b[\s\S]*?\/>/g) ?? []).find((t) => t.includes(needle)) ?? '';

describe('支付页按钮档位（AJ-431）', () => {
  it('🔴 支付方式是 ws-button：档位取 buttonType、带通道、点击走 onPay；不再是可点的 view', () => {
    const pay = buttonWith('item.buttonText');
    expect(pay).toContain('type="{{item.buttonType}}"');
    expect(pay).toContain('data-channel="{{item.channel}}"');
    expect(pay).toContain('bindtap="onPay"');
    expect(wxml).not.toMatch(/<view\b[^>]*bindtap="onPay"/);
  });

  it('🔴 「查看订单」有支付方式 / 重新下单 / 复制链接时描边，否则实心', () => {
    const view = buttonWith('text="查看订单"');
    expect(view).not.toContain('type="primary"');
    expect(view).toContain(
      `type="{{channels.length > 0 || goHome || payUrl || contactSupport ? 'default' : 'primary'}}"`,
    );
  });
});

describe('账号被拉黑的关闭屏（联动走查·跨角色 2026-10-10）', () => {
  it('🔴 关闭屏里有「联系客服」主按钮，只在 contactSupport 时出现，点击走 onContact', () => {
    const contact = buttonWith('text="联系客服"');
    expect(contact).toContain('type="primary"');
    expect(contact).toContain('bindtap="onContact"');
    expect(wxml).toMatch(/wx:if="\{\{contactSupport\}\}"[\s\S]{0,200}text="联系客服"/);
  });
});

/**
 * AJ-489（用户 2026-10-11 授权代决）：倒计时原是页顶一行灰色小字，离金额和支付按钮都远（三端模拟测试报告 §7-4）；
 * 成熟商城把"还剩多久"贴着应付金额放。
 */
describe('支付页：倒计时的位置（AJ-489）', () => {
  it('🔴 倒计时在金额卡里、ws-price 之后；页面上只出现一次', () => {
    const price = wxml.indexOf('<ws-price jpy="{{totalJpy}}"');
    const countdown = wxml.indexOf('{{countdown}}</text>');
    const notice = wxml.indexOf('notice.length > 0');
    expect(price).toBeGreaterThan(0);
    expect(countdown).toBeGreaterThan(price);
    expect(countdown).toBeLessThan(notice);
    expect(wxml.match(/\{\{countdown\}\}<\/text>/g)).toHaveLength(1);
  });
});

describe('错误块标题（规律排查 2026-10-12）', () => {
  it('🔴 标题取 errorTitle，缺省才是"支付页没能打开"', () => {
    expect(wxml).toContain("(errorTitle || '支付页没能打开')");
  });
});
