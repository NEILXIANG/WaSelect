/**
 * 职责：枚举与展示映射的 L0 单测（10 态齐全 / 展示分组覆盖全部状态 / 常量与技术文档一致）。
 * @see 技术文档 v0.5 §1；docs/地基搭建清单.md F2
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_COMPLIANCE_TAG,
  COMPLIANCE_TAG,
  COUNTRY,
  CURRENCY,
  ORDER_STATUS,
  ORDER_STATUS_DISPLAY,
  PAYMENT_CHANNEL,
  PRODUCT_CATEGORY,
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

  it('商品分类：与契约 `GET /products?category` 的 enum **双向集合相等**（I2 上架是第二个消费方）', () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, '../../../contracts/api-contract.yaml'),
      'utf8',
    );
    // 只抽方括号：整行剩余（schema / type 等词）会被一起抽进来导致集合比对假失败
    const m = /name: category, in: query[\s\S]{0,120}?enum: \[([^\]]+)\]/.exec(yaml);
    expect(m?.[1], '契约里找不到 /products?category 的 enum —— 锚点变了要同步改正则').toBeDefined();
    const contractValues = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    expect([...PRODUCT_CATEGORY].sort()).toEqual([...contractValues].sort());
    expect(contractValues.length, '契约 enum 不能为空（正则抽空会假绿）').toBeGreaterThan(0);
  });

  it('合规标签 11 个（与契约 ProductInput.compliance_tags 一致，由 check-contract 双向比对）；拦截 7 个是其子集', () => {
    expect(COMPLIANCE_TAG).toHaveLength(11);
    expect(BLOCKED_COMPLIANCE_TAG).toHaveLength(7);
    for (const t of BLOCKED_COMPLIANCE_TAG) expect(COMPLIANCE_TAG).toContain(t);
    // 只标记不拦截的四个（运输与申报属性，不是禁售）
    for (const t of ['liquid', 'battery', 'cosmetic', 'food']) {
      expect(BLOCKED_COMPLIANCE_TAG).not.toContain(t);
    }
  });
});
