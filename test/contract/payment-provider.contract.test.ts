/**
 * 职责：把**共用契约套件**跑在每个 Provider 上（F11）。
 *
 * @why 这个文件存在的意义是"**注册一个实现**"：新增支付方式时，
 *      唯一必须改的地方就是在这里加一个 `runProviderContract(...)`。
 *      如果哪天新增通道忘了加这一行，就等于这个通道没被同等强度检验过，
 *      而它自己那套测试很可能只测了成功路径。
 *
 * @limitation Mock 通道**没有**时间容差语义，所以重放场景对它不适用
 *            （套件里显式标注"未定义"，不伪装成通过）。
 *            Stripe 通道有（`Stripe-Signature` 带 `t=`），届时会真的验。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChannelConfig, HeaderBag } from '../../server/src/ports/payment.js';
import {
  createMockProvider,
  MOCK_SIGNATURE_HEADER,
} from '../../server/src/adapters/payment/mock.js';
import { systemClock } from '../../server/src/adapters/clock.js';
import { systemIdGen } from '../../server/src/adapters/ids.js';
import { createStripeCheckoutProvider } from '../../server/src/adapters/payment/stripe-checkout.js';
import { fixedClock } from '../helpers/fixed-clock.js';
import { createFakeStripeHttp } from '../helpers/fake-stripe-http.js';
import {
  checkoutSession,
  signStripePayload,
  stripeEvent,
  STRIPE_SIGNATURE_HEADER,
} from '../factories/stripe.js';
import {
  runProviderContract,
  type ProviderHarness,
  type SignedPayload,
  type SuccessEvent,
} from './payment-provider.contract.js';

const MOCK_SECRET = 'contract-mock-secret';

const mockConfig: ChannelConfig = {
  channel: 'mock',
  enabled: true,
  priority: 10,
  countries: ['*'],
  currencies: ['JPY'],
  label: '模拟支付',
  options: { secret: MOCK_SECRET },
};

/** 按骨架期约定的形状造报文（与 mock.ts 的 MockEventBody 同源）。 */
function mockBody(e: SuccessEvent): Buffer {
  return Buffer.from(
    JSON.stringify({
      event_id: 'evt-contract-1',
      type: 'payment.succeeded',
      order_id: e.orderId,
      provider_ref: e.providerRef,
      amount_minor: e.amountMinor,
      currency: 'JPY',
    }),
    'utf8',
  );
}

function sign(raw: Buffer, secret: string): HeaderBag {
  return {
    [MOCK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(raw).digest('hex'),
  };
}

function mockHarness(): ProviderHarness {
  const provider = createMockProvider(mockConfig, { clock: systemClock, idGen: systemIdGen });
  return {
    provider,
    signed: (e) => {
      const raw = mockBody(e);
      return { raw, headers: sign(raw, MOCK_SECRET) };
    },
    wrongSignature: (e) => {
      const raw = mockBody(e);
      return { raw, headers: sign(raw, 'another-secret') };
    },
    noSignature: (e) => ({ raw: mockBody(e), headers: {} }),
    unparsable: () => {
      const raw = Buffer.from('{ not json at all', 'utf8');
      return { raw, headers: sign(raw, MOCK_SECRET) };
    },
    // mock 没有时间戳容差语义 → 不造假场景（见文件头 @limitation）
    replayed: undefined,
  };
}

// ── 第二个实现：Stripe Checkout 托管页（D-49）─────────────────────────────
// @why 它存在的意义是**检验抽象**：与 mock 完全不同的一套报文与签名，
//      却能跑同一组契约测试——这才是"加支付方式不改业务代码"的证据。
const STRIPE_SECRET = 'whsec_contract_secret';
const STRIPE_NOW = fixedClock('2026-01-02T15:30:00.000Z');

const stripeConfig: ChannelConfig = {
  channel: 'stripe',
  enabled: true,
  priority: 20,
  countries: ['*'],
  currencies: ['JPY', 'USD'],
  label: '银行卡',
  options: {
    secretKey: 'sk_test_contract',
    webhookSecret: STRIPE_SECRET,
    successUrl: 'https://example.test/paid',
    cancelUrl: 'https://example.test/cancel',
    apiBase: 'https://api.stripe.test',
  },
};

function stripeHarness(): ProviderHarness {
  const http = createFakeStripeHttp();
  const provider = createStripeCheckoutProvider(stripeConfig, {
    http,
    clock: STRIPE_NOW,
    idGen: systemIdGen,
  });
  const nowSec = Math.floor(STRIPE_NOW.now().getTime() / 1000);
  /** 造一条 `checkout.session.completed`：形状来自官方样本工厂，不自己编。 */
  const bodyOf = (e: SuccessEvent): string =>
    JSON.stringify(
      stripeEvent(
        'checkout.session.completed',
        checkoutSession({
          id: e.providerRef,
          amountTotal: e.amountMinor,
          currency: 'jpy',
          metadata: { order_id: e.orderId },
        }),
      ),
    );
  const signedWith = (body: string, t: number, secret = STRIPE_SECRET): SignedPayload => ({
    raw: Buffer.from(body, 'utf8'),
    headers: { [STRIPE_SIGNATURE_HEADER]: signStripePayload(body, secret, t) },
  });

  return {
    provider,
    signed: (e) => signedWith(bodyOf(e), nowSec),
    wrongSignature: (e) => signedWith(bodyOf(e), nowSec, 'whsec_another'),
    noSignature: (e) => ({ raw: Buffer.from(bodyOf(e), 'utf8'), headers: {} }),
    unparsable: () => signedWith('{ not json at all', nowSec),
    // 真正的**重放**：签名正确，但时间戳在 5 分钟容差之外
    replayed: (e) => signedWith(bodyOf(e), nowSec - 400),
  };
}

describe('支付 Provider 契约套件', () => {
  runProviderContract('mock', mockHarness);
  runProviderContract('stripe-checkout', stripeHarness);

  // ⚠️ Mock 的**签名错误**场景要单独再验一次：套件里只测了"改字节"与"缺头"，
  //    而"签名头存在但值不对"是另一个分支（长度相等 vs 不等的比较路径不同）。
  it('mock：签名头存在但值错误 → 40103（长度相等的比较路径也要走到）', async () => {
    const h = mockHarness();
    const p: SignedPayload = h.wrongSignature({
      orderId: 'sk-1',
      providerRef: 'x',
      amountMinor: 100,
    });
    await h.provider.parseWebhook(p.raw, p.headers).then(
      () => expect.unreachable('应当抛 40103'),
      (e: unknown) => expect((e as { code?: number }).code).toBe(40103),
    );
  });
});
