/**
 * 职责：Mock 通道**专属**用例（契约套件覆盖不到的部分）。
 *
 * @why 契约套件验的是"它像个合格的 Provider"，这里验的是"它自己的那些判断对不对"：
 *      缺密钥要炸、回调缺单号要炸、事件 id 缺失要兜底——
 *      这三条都是**只在 mock 这种"自造协议"的通道上才会出现**的问题，而且都不会自己报错：
 *      "回调里没有 order_id"的表现是订单永远等不到支付，而不是任何一条红。
 *
 * @limitation Mock 是审核期/测试的假通道，**不要**在这里测业务规则（那属于 domain）。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChannelConfig } from '../../ports/payment.js';
import { systemClock } from '../clock.js';
import { systemIdGen } from '../ids.js';
import { createMockProvider, MOCK_MAX_SESSIONS, MOCK_SIGNATURE_HEADER } from './mock.js';
import { fixedClock } from '../../../../test/helpers/fixed-clock.js';

const SECRET = 'mock-unit-secret';

function config(over: Partial<ChannelConfig['options']> = {}): ChannelConfig {
  return {
    channel: 'mock',
    enabled: true,
    priority: 10,
    countries: ['*'],
    currencies: ['JPY'],
    label: '模拟支付',
    options: { secret: SECRET, ...over },
  };
}

function provider(cfg: ChannelConfig = config()) {
  return createMockProvider(cfg, {
    clock: fixedClock('2026-01-02T15:30:00.000Z'),
    idGen: systemIdGen,
  });
}

function sign(body: unknown, secret = SECRET): { raw: Buffer; headers: Record<string, string> } {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    raw,
    headers: { [MOCK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(raw).digest('hex') },
  };
}

describe('mock 通道', () => {
  it('缺 options.secret → **构造时**抛（不配密钥等于任何人都能伪造回调）', () => {
    expect(() => provider(config({ secret: '' }))).toThrow(/options.secret/);
    expect(() => provider({ ...config(), options: {} })).toThrow(/options.secret/);
  });

  it('create 返回 in_app 入口，且 params 里不含任何密钥', async () => {
    const s = await provider().create({
      orderId: 'sk-1',
      orderNo: '260103-K7Q2MN',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      destCountry: 'US',
      idempotencyKey: 'idem-1',
    });
    expect(s.entry.mode).toBe('in_app');
    if (s.entry.mode !== 'in_app') throw new Error('unreachable');
    expect(s.entry.params).toEqual({
      // 未开自动确认（非审核模式）→ auto=false：前端不能显示"支付已完成"（AJ-179）
      auto: false,
      orderId: 'sk-1',
      amountJpy: 12_000,
      currency: 'JPY',
    });
    expect(JSON.stringify(s.entry.params)).not.toContain('secret');
    // 到期时间来自**注入的**时钟（不是 new Date()）
    expect(s.expiresAt).toBe(
      new Date(Date.parse('2026-01-02T15:30:00.000Z') + 30 * 60_000).toISOString(),
    );
  });

  it('自动确认（审核模式，AJ-179）：未开 → 无 selfConfirmation；开了 → auto=true，自签报文能过自己的验签、事件 id 确定', async () => {
    expect(provider().selfConfirmation).toBeUndefined();

    const p = provider(config({ autoConfirm: true }));
    const s = await p.create({
      orderId: 'sk-1',
      orderNo: '260103-K7Q2MN',
      amountJpy: 3_200,
      currency: 'JPY',
      amountMinor: 3_200,
      destCountry: 'US',
      idempotencyKey: 'idem-auto',
    });
    if (s.entry.mode !== 'in_app') throw new Error('unreachable');
    expect(s.entry.params['auto']).toBe(true);

    const msg = p.selfConfirmation?.({
      orderId: 'sk-1',
      providerRef: s.providerRef,
      amountMinor: 3_200,
      currency: 'JPY',
    });
    if (msg === undefined) throw new Error('开了自动确认必须提供 selfConfirmation');
    const ev = await p.parseWebhook(msg.raw, msg.headers);
    expect(ev).toMatchObject({
      eventId: `auto:${s.providerRef}`,
      outcome: 'succeeded',
      orderId: 'sk-1',
      providerRef: s.providerRef,
      amountMinor: 3_200,
      currency: 'JPY',
    });
    // 同一意图再造一次 → 同一个事件 id（管线据此去重，重复确认不会重复落账）
    const again = p.selfConfirmation?.({
      orderId: 'sk-1',
      providerRef: s.providerRef,
      amountMinor: 3_200,
      currency: 'JPY',
    });
    expect(again?.raw.equals(msg.raw)).toBe(true);
  });

  it('autoConfirm 只认布尔 true（字符串 "true" 不算：配置漂移不能悄悄打开"假付款"）', () => {
    expect(provider(config({ autoConfirm: 'true' })).selfConfirmation).toBeUndefined();
  });

  it('回调缺 order_id → 抛（这是**我们**的缺陷，不是坏报文，所以不当 4xx）', async () => {
    const p = sign({ event_id: 'evt-1', type: 'payment.succeeded', provider_ref: 'ref-1' });
    await expect(provider().parseWebhook(p.raw, p.headers)).rejects.toThrow(/缺少 order_id/);
  });

  it('回调缺 event_id → 用报文摘要兜底（机构没给 id 时也要能去重）', async () => {
    const p = sign({ type: 'payment.succeeded', order_id: 'sk-1', provider_ref: 'ref-1' });
    const ev = await provider().parseWebhook(p.raw, p.headers);
    expect(ev.eventId.startsWith('sha256:')).toBe(true);
    // ⚠️ 长度必须留在列宽内：曾经二次 hex 编码成 135 字符，真库里直接 500
    expect(ev.eventId.length).toBeLessThanOrEqual(128);
    expect(ev.outcome).toBe('succeeded');
  });

  it('字段缺失时走兜底而不是产出半截事件（rawType/providerRef 都有缺省）', async () => {
    const p = sign({ order_id: 'sk-1' });
    const ev = await provider().parseWebhook(p.raw, p.headers);
    expect(ev.rawType).toBe('unknown');
    expect(ev.outcome).toBe('unknown');
    expect(ev.providerRef).toBe('');
    expect(ev.orderId).toBe('sk-1');
  });

  it('未登记的事件类型 → unknown（不猜，交业务决定）', async () => {
    const p = sign({ type: 'we.dont.know', order_id: 'sk-1', provider_ref: 'ref-1' });
    const ev = await provider().parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.rawType).toBe('we.dont.know');
  });

  it('退款返回 refundRef（形状必须是真的，否则"退款成功"分支永远没被走过）', async () => {
    const p = provider();
    const r = await p.refund?.({
      orderId: 'sk-1',
      providerRef: 'ref-1',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: '缺货',
    });
    expect(r?.refundRef.startsWith('mock_re_')).toBe(true);
    expect(r?.outcome).toBe('succeeded');
  });

  it('refundStatus：自己发出的退款单号 → succeeded（mock 退款同步完成）；认不出的单号 → 抛（不猜）', async () => {
    const p = provider();
    const r = await p.refund?.({
      orderId: 'sk-1',
      providerRef: 'ref-1',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: '缺货',
    });
    await expect(p.refundStatus?.(r?.refundRef ?? '')).resolves.toBe('succeeded');
    await expect(p.refundStatus?.('re_not_mine')).rejects.toThrow(/不是 mock 发出的退款单号/);
  });

  it('能力声明与实现一致（注册表会校验，这里再钉一次便于单独定位）', () => {
    const p = provider();
    expect(p.capabilities.supportsRefund).toBe(true);
    expect(p.refund).toBeDefined();
    expect(p.refundStatus).toBeDefined();
    expect(p.channel).toBe('mock');
  });

  it('声明不支持拒付 → 拒付报文不产出 disputed（一致性审计 C11 / AJ-176：声明与映射曾互相矛盾）', async () => {
    const p = provider();
    expect(p.capabilities.supportsDispute).toBe(false);
    for (const type of ['charge.dispute.created', 'charge.dispute.closed']) {
      const s = sign({ type, order_id: 'sk-1', provider_ref: 'ref-1' });
      const ev = await p.parseWebhook(s.raw, s.headers);
      expect(ev.outcome, type).toBe('unknown');
    }
  });

  it('注入的时钟真的被用上（换一个时钟，到期时间跟着变）', async () => {
    const late = createMockProvider(config(), { clock: systemClock, idGen: systemIdGen });
    const s = await late.create({
      orderId: 'sk-2',
      orderNo: '260103-K7Q2MN',
      amountJpy: 100,
      currency: 'JPY',
      amountMinor: 100,
      destCountry: 'US',
      idempotencyKey: 'idem-2',
    });
    // 真实时钟下：到期时间必须晚于"现在"，且不是固定时钟那个值
    expect(Date.parse(s.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('🔴 S-10（AJ-462）：会话缓存有上限（MOCK_MAX_SESSIONS）：超出后最老的键被逐出，再用它 create 会得到新会话', async () => {
    const p = provider();
    const first = await p.create({
      orderId: 'o-0',
      orderNo: 'N',
      amountJpy: 1,
      currency: 'JPY',
      amountMinor: 1,
      destCountry: 'US',
      idempotencyKey: 'k-0',
    });
    for (let i = 1; i <= MOCK_MAX_SESSIONS; i += 1) {
      await p.create({
        orderId: `o-${String(i)}`,
        orderNo: 'N',
        amountJpy: 1,
        currency: 'JPY',
        amountMinor: 1,
        destCountry: 'US',
        idempotencyKey: `k-${String(i)}`,
      });
    }
    const again = await p.create({
      orderId: 'o-0',
      orderNo: 'N',
      amountJpy: 1,
      currency: 'JPY',
      amountMinor: 1,
      destCountry: 'US',
      idempotencyKey: 'k-0',
    });
    expect(again.providerRef).not.toBe(first.providerRef);
    // 没被逐出的最新键仍幂等
    const last = await p.create({
      orderId: 'o-x',
      orderNo: 'N',
      amountJpy: 1,
      currency: 'JPY',
      amountMinor: 1,
      destCountry: 'US',
      idempotencyKey: `k-${String(MOCK_MAX_SESSIONS)}`,
    });
    expect(last.providerRef).toBeDefined();
  });
});
