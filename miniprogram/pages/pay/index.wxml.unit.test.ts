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
      `type="{{channels.length > 0 || goHome || payUrl ? 'default' : 'primary'}}"`,
    );
  });
});
