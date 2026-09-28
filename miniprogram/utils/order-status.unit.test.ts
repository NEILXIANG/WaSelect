/**
 * 职责：订单状态文案（共享层）的单测。
 *
 * @why 这组断言是从 `pages/order/index.vm.unit.test.ts` **连测试一起搬过来的**（§2 第 50 条同族：
 *      只搬代码不搬测试 = 原模块守护静默消失）。钉的是两件**都不报错**的事：
 *      ① 状态词表与契约 enum 漂移 → 新增状态后前端静默显示"状态未知"；
 *      ② 能付的状态与可取消的状态不一致 → "能付但取消不了"的半开状态。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAYABLE, STATUS_LABELS, canPay, statusText } from './order-status.js';

describe('statusText（状态文案）', () => {
  it('词表内 → 中文', () => {
    expect(statusText('created')).toBe('待付款');
    expect(statusText('refunded')).toBe('已退款');
  });

  it('⚠️ 不在词表 / 脏输入 → "状态未知"（不是空串：空白标签和渲染错无法区分）', () => {
    expect(statusText('brand_new')).toBe('状态未知');
    expect(statusText('')).toBe('状态未知');
    expect(statusText(null)).toBe('状态未知');
    expect(statusText(123)).toBe('状态未知');
  });
});

describe('canPay（能否继续支付）', () => {
  it('⚠️ 只有 created / pending_payment（与可取消态一致）', () => {
    expect(PAYABLE).toEqual(['created', 'pending_payment']);
    expect(canPay('created')).toBe(true);
    expect(canPay('pending_payment')).toBe(true);
    for (const s of [
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'expired',
      'refunding',
      'refunded',
    ]) {
      expect(canPay(s), `${s} 不该可付`).toBe(false);
    }
    expect(canPay(null)).toBe(false);
  });
});

/**
 * ⚠️ 与契约的双向比对：词表的键必须**恰好等于** `OrderStatus` 的 enum。
 * @why 服务端新增一个状态而前端没跟进的表现是：订单上这一列显示"状态未知"——
 *      不报错、不崩溃，只是用户看不懂自己的订单怎么了。
 */
describe('STATUS_LABELS 与契约 OrderStatus 的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('OrderStatus: {')) ?? '';
  const enumLine = line.slice(line.indexOf('enum:'));
  const contractStatuses = (enumLine.match(/[a-z_]+/g) ?? []).filter((w) => w !== 'enum');

  it('抽到了 OrderStatus 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('OrderStatus');
    expect(contractStatuses.length).toBeGreaterThan(0);
  });

  it('两边集合相等：契约有而词表没有 → 静默显示"状态未知"', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...contractStatuses].sort());
  });

  it('每条文案都非空（空串 = 真机上一个空白标签）', () => {
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      expect(label, `${status} 的文案为空`).not.toBe('');
    }
  });
});
