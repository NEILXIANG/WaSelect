/**
 * 职责：枚举与展示映射的 L0 单测（10 态齐全 / 展示分组覆盖全部状态 / 常量与技术文档一致）。
 * @see 技术文档 v0.5 §1；docs/地基搭建清单.md F2
 */
import { describe, expect, it } from 'vitest';
import {
  COUNTRY,
  CURRENCY,
  ORDER_STATUS,
  ORDER_STATUS_DISPLAY,
  PAYMENT_CHANNEL,
} from './enums.js';

describe('订单状态', () => {
  it('恰好 10 个状态，与技术文档 §1 一致', () => {
    expect(ORDER_STATUS).toEqual([
      'created',
      'pending_payment',
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'expired',
      'refunding',
      'refunded',
    ]);
    expect(new Set(ORDER_STATUS).size).toBe(10);
  });

  it('每个状态都有前端展示文案', () => {
    for (const s of ORDER_STATUS) {
      expect(ORDER_STATUS_DISPLAY[s]).toBeTruthy();
    }
  });
});

describe('通道 / 币种 / 国家', () => {
  it('通道含 mock/wechat/stripe', () => {
    expect([...PAYMENT_CHANNEL]).toEqual(['mock', 'wechat', 'stripe']);
  });

  it('币种含 JPY/CNY/USD，且 JPY 在首位（唯一锚）', () => {
    expect(CURRENCY[0]).toBe('JPY');
    expect([...CURRENCY].sort()).toEqual(['CNY', 'JPY', 'USD']);
  });

  it('MVP 国家为 JP（原产）与 US（目的）', () => {
    expect([...COUNTRY]).toEqual(['JP', 'US']);
  });
});
