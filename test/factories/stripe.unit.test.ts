/**
 * 职责：Stripe 回调样本的测试（F9-d1）。
 *
 * @why 这批断言防的是"形状自洽但不符合官方"：
 *      比如把被签串写成 `${body}.${t}`（顺序反了），我们自己的签名与验签依然互相匹配，
 *      全绿；真 Stripe 打过来 100% 验不过。所以这里必须用**独立复算**交叉验证，
 *      而不是拿工厂的 sign 去验工厂的 verify。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STRIPE_EVENT_TYPES,
  checkoutSession,
  objectForEvent,
  paymentIntent,
  stripeEvent,
  signStripePayload,
  verifyStripeSignature,
} from './stripe.js';

const SECRET = 'whsec_test_secret_0000000000000000';

describe('事件形状', () => {
  it('顶层字段与官方一致（漏字段会让解析方取到 undefined）', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent());
    expect(Object.keys(e).sort()).toEqual(
      [
        'api_version',
        'created',
        'data',
        'id',
        'livemode',
        'object',
        'pending_webhooks',
        'request',
        'type',
      ].sort(),
    );
    expect(e.object).toBe('event');
    expect(e.data.object.object).toBe('payment_intent');
  });

  it('JPY 金额不做 /100：amount=12000 就是 12,000 円（跨境最常见的金额事故）', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent({ amount: 12_000, currency: 'jpy' }));
    expect(e.data.object.amount).toBe(12_000);
    expect(e.data.object.currency).toBe('jpy');
  });
});

describe('签名', () => {
  it('生成的头能被**独立复算**验过（不是拿自己的 sign 验自己的 verify）', () => {
    const body = JSON.stringify(stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent()));
    const header = signStripePayload(body, SECRET, 1_700_000_000);
    const t = 1_700_000_000;
    const expectDigest = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    expect(header).toBe(`t=${t},v1=${expectDigest}`);
  });

  it('被签串是「时间戳.报文」顺序——写反就 100% 验不过真环境', () => {
    const body = '{"id":"evt_1"}';
    const t = 1_700_000_000;
    const header = signStripePayload(body, SECRET, t);
    // 故意按反序复算出来的摘要，必须**不等于**头里的 v1
    const reversed = createHmac('sha256', SECRET).update(`${body}.${t}`).digest('hex');
    expect(header).not.toContain(reversed);
    expect(header).toContain(createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex'));
  });

  it('报文被改一个字节 → 验不过（防"解析后重排字段"这类改动）', () => {
    const body = JSON.stringify(stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent()));
    const header = signStripePayload(body, SECRET, Math.floor(Date.now() / 1000));
    const tampered = body.replace('"succeeded"', '"requires_payment_method"');
    expect(verifyStripeSignature(tampered, header, SECRET).ok).toBe(false);
  });

  it('验过签名但时间戳过期 → expired（防重放；与 bad_signature 分开报）', () => {
    const body = JSON.stringify(stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent()));
    const old = Math.floor(Date.now() / 1000) - 600; // 10 分钟前
    const header = signStripePayload(body, SECRET, old);
    const r = verifyStripeSignature(body, header, SECRET);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('密钥轮换：多个 v1 时任一命中即通过', () => {
    const body = JSON.stringify(stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent()));
    const now = Math.floor(Date.now() / 1000);
    const good = signStripePayload(body, SECRET, now).split(',')[1] ?? '';
    const stale = signStripePayload(body, 'whsec_old_secret', now).split(',')[1] ?? '';
    expect(verifyStripeSignature(body, `t=${now},${stale},${good}`, SECRET).ok).toBe(true);
  });

  it('测试模式多带的 v0 必须被忽略（v0 不是有效签名）', () => {
    const body = JSON.stringify(stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent()));
    const now = Math.floor(Date.now() / 1000);
    const v1 = signStripePayload(body, SECRET, now).split(',')[1] ?? '';
    expect(verifyStripeSignature(body, `t=${now},v0=deadbeef,${v1}`, SECRET).ok).toBe(true);
    // 只有 v0 没有 v1 → 拒
    expect(verifyStripeSignature(body, `t=${now},v0=deadbeef`, SECRET)).toEqual({
      ok: false,
      reason: 'no_v1',
    });
  });

  it('没有签名头 → no_header（不能当成"验不过"混为一谈）', () => {
    expect(verifyStripeSignature('{}', undefined, SECRET)).toEqual({
      ok: false,
      reason: 'no_header',
    });
  });

  /**
   * 覆盖项必须是**深合并**，不能整体替换 `data.object`（D30）。
   * @why 上一版把 `Partial<StripeEvent>` 直接铺在最末（`...overrides`），
   *      于是传 `{ data: { object: { id } } }` 会把合并好的内容**整体替换**，
   *      造出一条只有 id 的残缺回调；用它测出来的解析代码在真环境里一个字段都取不到。
   */
  it('dataObject 只覆盖指定字段，不整体替换 data.object', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.checkoutCompleted, checkoutSession(), {
      dataObject: { id: 'cs_custom' },
    });
    expect(e.data.object.id).toBe('cs_custom');
    // 默认字段必须还在（整体替换的话这两条就没了）
    expect(e.data.object.object).toBe('checkout.session');
    expect(e.data.object.payment_status).toBe('paid');
    expect(e.data.object.amount_total).toBe(12_000);
  });

  it('主事件形状是 checkout.session（D-49），不是 payment_intent', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.checkoutCompleted, checkoutSession());
    expect(e.data.object.object).toBe('checkout.session');
    expect(e.data.object.payment_intent).toBeTruthy();
    // 次路径仍然可用
    const pi = stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent());
    expect(pi.data.object.object).toBe('payment_intent');
  });

  it('objectForEvent 按事件类型给出正确形状（主路径不会错配成 payment_intent）', () => {
    expect(objectForEvent('checkout.session.completed').object).toBe('checkout.session');
    expect(objectForEvent('payment_intent.succeeded').object).toBe('payment_intent');
    expect(() => objectForEvent('unknown.event')).toThrow(/未知事件类型/);
  });

  /**
   * 覆盖项必须是**深合并**，不能整体替换 `data.object`（D30）。
   * @why 上一版把 `Partial<StripeEvent>` 直接铺在最末（`...overrides`），
   *      于是传 `{ data: { object: { id } } }` 会把合并好的内容**整体替换**，
   *      造出一条只有 id 的残缺回调；用它测出来的解析代码在真环境里一个字段都取不到。
   */
  it('dataObject 只覆盖指定字段，不整体替换 data.object', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.checkoutCompleted, checkoutSession(), {
      dataObject: { id: 'cs_custom' },
    });
    expect(e.data.object.id).toBe('cs_custom');
    // 默认字段必须还在（整体替换的话这两条就没了）
    expect(e.data.object.object).toBe('checkout.session');
    expect(e.data.object.payment_status).toBe('paid');
    expect(e.data.object.amount_total).toBe(12_000);
  });

  it('主事件形状是 checkout.session（D-49），不是 payment_intent', () => {
    const e = stripeEvent(STRIPE_EVENT_TYPES.checkoutCompleted, checkoutSession());
    expect(e.data.object.object).toBe('checkout.session');
    expect(e.data.object.payment_intent).toBeTruthy();
    // 次路径仍然可用
    const pi = stripeEvent(STRIPE_EVENT_TYPES.paySucceeded, paymentIntent());
    expect(pi.data.object.object).toBe('payment_intent');
  });

  it('objectForEvent 按事件类型给出正确形状（主路径不会错配成 payment_intent）', () => {
    expect(objectForEvent('checkout.session.completed').object).toBe('checkout.session');
    expect(objectForEvent('payment_intent.succeeded').object).toBe('payment_intent');
    expect(() => objectForEvent('unknown.event')).toThrow(/未知事件类型/);
  });

  /**
   * 源码级断言：**签名比较必须用 `timingSafeEqual`**。
   * @why 把 `timingSafeEqual` 换成 `===` 在功能上完全等价，任何行为测试都测不出差异
   *      （这是我注回该缺陷后确认的：9 条用例全绿）。但它是真实的时序侧信道缺陷，
   *      且代码审查时极容易漏。安全能力退化不能只靠人眼，用一条元测试钉住。
   * @limitation 扫源码字符串，不是行为断言：重命名或抽走实现会造成假红。
   *             假红的代价（改一行断言）远低于"验签悄悄变成非恒定时间比较"，故接受。
   */
  it('验签比较必须用恒定时间函数（时序安全测不出行为差异，只能扫源码）', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./stripe.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
  });
});
