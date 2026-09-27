/**
 * 职责：支付**装配层**的 L0 用例（F11 第三单元）——**配置 → 注册表**这一段。
 *
 * @why 这一段看着只是"把几条配置塞进注册表"，却是 F11 里**唯一一处"通道会不会出现"
 *       由代码决定**的地方：`channels.ts` 少注册一个工厂，该通道就永远不出现在
 *       `GET /pay/channels` 里，而**没有任何报错**（这是它自己的 @limitation 二，有意为之）。
 *       静默消失 = 前端没有支付入口 = 转化率掉到 0，且日志里一切正常。
 *       所以这里逐条钉住"什么情况该注册、什么情况不该"。
 *
 * @why 用**真实 `loadConfig`** 造配置，而不是手搓对象字面量：
 *       装配层的输入就是配置层的输出，用真的才能测到"配置里没配某字段时装配层怎么兜"
 *       （例如 `MOCK_CALLBACK_SECRET` 缺失 → 开发占位值）。手搓字面量会让这类兜底分支
 *       永远走不到，覆盖率上表现为一条没人踩的分支——那正是我们要防的东西。
 *
 * @limitation 不验 Stripe 的通信行为（建会话、验签、退款）——那些在共用契约套件里
 *             （`test/contract/payment-provider.contract.test.ts`）。这里只验
 *             "它有没有被装配进来"，也就是**装配层自己的职责边界**。
 *
 * @see adapters/payment/channels.ts（被测）；docs/地基搭建清单.md F11
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../config.js';
import type { HttpClient } from '../../ports/http-client.js';
import type { ChannelQuery, PaymentProvider, ProviderEvent } from '../../ports/payment.js';
import { fixedClock } from '../../../../test/helpers/fixed-clock.js';
import { stubIdGen } from '../../../../test/helpers/stub-id-gen.js';
import { createFakeStripeHttp } from '../../../../test/helpers/fake-stripe-http.js';
import { buildPaymentRegistry, describeChannels, type ChannelAssemblyDeps } from './channels.js';
import { MOCK_SIGNATURE_HEADER } from './mock.js';

/** 与 config.unit.test.ts 同一套最小可启动环境（共用口径，避免两处各写一份必填项）。 */
const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop',
  JWT_SECRET: 'a'.repeat(32),
  TERMS_VERSION: 'TOS-2026-09-20',
  PAYMENT_CHANNELS: 'mock',
};

const US_JPY: ChannelQuery = { destCountry: 'US', amountJpy: 10_000, currency: 'JPY' };
const US_USD: ChannelQuery = { destCountry: 'US', amountJpy: 10_000, currency: 'USD' };

function deps(http: HttpClient = createFakeStripeHttp()): ChannelAssemblyDeps {
  return {
    http,
    clock: fixedClock('2026-01-02T00:00:00.000Z'),
    idGen: stubIdGen('K7Q2MN', '00000000-0000-4000-8000-000000000001'),
  };
}

/** 与 channels.ts 里 mock 的回落值保持一致（改一处必须改两处，见下面那条用例的 @why）。 */
const DEV_MOCK_SECRET = 'dev-mock-callback-secret-do-not-use-in-prod';

function signMock(raw: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

/** 发一条"支付成功"的 mock 回调报文，用给定密钥签名。 */
function succeedRaw(): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'payment.succeeded',
      event_id: 'evt-1',
      order_id: 'sk-1',
      provider_ref: 'ref-1',
    }),
  );
}

/**
 * 断言通道不可用，并核对 reason（与 registry.unit.test.ts 同一套口径）。
 *
 * @why 同步版：`get()` 是**同步抛**（注册表不做 IO），包一层 Promise 反而会把
 *      抛点挪到"调用处"，报错栈指向 helper 而不是被测的那一行。
 */
function expectChannelError(fn: () => void, reason: string): void {
  try {
    fn();
    expect.unreachable(`应当抛错（reason=${reason}）`);
  } catch (e) {
    const err = e as { code?: number; details?: { reason?: string } };
    expect(err.code, `错误码应为 40001（收到 ${JSON.stringify(err.details)}）`).toBe(40_001);
    expect(err.details?.reason).toBe(reason);
  }
}

describe('describeChannels（启动日志用）', () => {
  it('原样列出配置里的通道，不增删、不排序', () => {
    const c = loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'mock,stripe' });
    // ⚠️ 刻意断言**顺序**：它是配置的原序，不是优先级序——
    //    启动日志里看到的顺序应当与配置文件里写的一致，否则排障时会误读成"优先级"。
    expect(describeChannels(c)).toEqual(['mock', 'stripe']);
  });

  it('registered 清单如实反映"配置 ∩ 可构造"：差集就是静默跳过的通道', () => {
    // @why 启动日志的检测能力全押在这两个清单的**对照**上：
    //      只打 configured（曾经的形态）时，stripe 密钥缺失在日志里也是"一切正常"。
    const partial = loadConfig({
      ...baseEnv,
      PAYMENT_CHANNELS: 'mock,stripe,wechat',
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      // 缺 CHECKOUT_BASE_URL：stripe 不注册；wechat 未实现也不注册
    });
    const a1 = buildPaymentRegistry(partial, deps());
    expect(describeChannels(partial)).toEqual(['mock', 'stripe', 'wechat']);
    expect(a1.registered).toEqual(['mock']);

    const full = loadConfig({
      ...baseEnv,
      PAYMENT_CHANNELS: 'mock,stripe',
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
    });
    const a2 = buildPaymentRegistry(full, deps());
    expect(a2.registered).toEqual(['mock', 'stripe']);
  });
});

describe('buildPaymentRegistry：mock 通道', () => {
  it('未配 MOCK_CALLBACK_SECRET → 回落到开发占位密钥，且该密钥**真的能验过签**', async () => {
    const c = loadConfig(baseEnv);
    expect(c.MOCK_CALLBACK_SECRET).toBeUndefined();
    const { registry } = buildPaymentRegistry(c, deps());

    const provider = registry.get('mock');
    const raw = succeedRaw();
    const event = await provider.parseWebhook(raw, {
      [MOCK_SIGNATURE_HEADER]: signMock(raw, DEV_MOCK_SECRET),
    });
    expect(event.outcome).toBe('succeeded');

    /**
     * @why 这条断言同时是一张**契约**：占位值写在 channels.ts 里，而 e2e 测试
     *      都依赖它——改了 channels.ts 的占位值而没改这里，这条会红。
     * @limitation 它只保证"开发/测试环境能跑"，**不是**"生产可以没有密钥"：
     *      生产启用 mock 必须显式配置，由 config.ts 的跨字段规则拦（不是这里拦）。
     */
  });

  it('配了显式密钥 → 用它验签；占位密钥验不过（40103，不是静默收下）', async () => {
    const c = loadConfig({ ...baseEnv, MOCK_CALLBACK_SECRET: 'explicit-secret' });
    const { registry } = buildPaymentRegistry(c, deps());
    const provider = registry.get('mock');

    const raw = succeedRaw();
    await expect(
      provider.parseWebhook(raw, { [MOCK_SIGNATURE_HEADER]: signMock(raw, 'explicit-secret') }),
    ).resolves.toMatchObject({ outcome: 'succeeded' });

    await expect(
      provider.parseWebhook(raw, { [MOCK_SIGNATURE_HEADER]: signMock(raw, DEV_MOCK_SECRET) }),
    ).rejects.toMatchObject({ code: 40_103 });
  });
});

describe('buildPaymentRegistry：stripe 通道（三要素齐全才注册）', () => {
  it('三要素不全 → 不注册；但**不拖垮**其它通道的列表', async () => {
    // 故意只配两个密钥、缺 CHECKOUT_BASE_URL：这是"本地开发还没接 Stripe"的真实形态
    const c = loadConfig({
      ...baseEnv,
      PAYMENT_CHANNELS: 'mock,stripe',
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
    });
    const { registry } = buildPaymentRegistry(c, deps());

    // ① stripe 没被装配进来
    expectChannelError(() => registry.get('stripe'), 'channel_not_registered');
    // ② 但 `/pay/channels` 照常返回 mock——一个坏通道不能让整个支付入口 500
    expect(registry.listAvailable(US_JPY).map((x) => x.channel)).toEqual(['mock']);
  });

  it('只启用 stripe 且三个密钥全无 → 不注册、不报错（本地/未接入 Stripe 的默认形态）', () => {
    /**
     * @why 这条是**最常见的真实形态**（仓库 clone 下来还没配 Stripe），也是
     *      "配置比代码先行"的兑现：配置里写了 stripe，代码没密钥 → 静默不开放，
     *      而不是启动崩溃。同时它覆盖 `optionsFor('stripe')` 的三条回落分支
     *      （密钥缺失时给空串而不是 `undefined`，让"构造失败"发生在工厂里、原因明确）。
     * @limitation 空列表**不等于**"支付不可用"的告警：启动日志靠
     *             `describeChannels` + 实际注册清单对照才能看出来（@limitation 二）。
     */
    const c = loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'stripe' });
    const { registry } = buildPaymentRegistry(c, deps());
    expect(registry.listAvailable(US_USD)).toEqual([]);
    expect(registry.listAvailable(US_JPY)).toEqual([]);
  });

  it('三要素齐全 → 注册成功，按 priority 排在 mock 前面', () => {
    const c = loadConfig({
      ...baseEnv,
      PAYMENT_CHANNELS: 'mock,stripe',
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
    });
    const { registry } = buildPaymentRegistry(c, deps());

    /**
     * ⚠️ **配置 ∩ 能力**，两者都要过，所以两个币种各只剩一个通道：
     *  · stripe 的配置只开了 USD（CHANNEL_DEFAULTS），虽然它的能力声明支持 JPY+USD；
     *  · mock 的能力只声明 JPY，虽然它的配置写的是 JPY。
     *  这不是 bug，正是 ADR-28 要的两层开关——**"我们在这个市场开不开"与"机构做不做得到"分开**。
     *  写成一层就会出现"上线美国要同时改配置和发版"。
     */
    expect(registry.listAvailable(US_USD).map((x) => x.channel)).toEqual(['stripe']);
    expect(registry.listAvailable(US_USD)[0]?.entryMode).toBe('copylink');
    expect(registry.listAvailable(US_JPY).map((x) => x.channel)).toEqual(['mock']);
    expect(registry.listAvailable(US_JPY)[0]?.entryMode).toBe('in_app');
  });
});

describe('buildPaymentRegistry：通道下线语义（二次审查 P1-NEW-1）', () => {
  const stripeKeys = {
    STRIPE_SECRET_KEY: 'sk_test_1',
    STRIPE_WEBHOOK_SECRET: 'whsec_1',
    CHECKOUT_BASE_URL: 'https://checkout.example.com',
  };

  it('stripe 从 PAYMENT_CHANNELS 移除但凭据还在 → 已下线（不接新单）但在途回调/退款不受影响', () => {
    /**
     * @why 这是"禁用不拦回调"设计承诺的兑现形态（AJ 口径：下线 = 停新单，不是让在途订单失联）。
     *      旧形态：删配置 → 配置条目整个消失 → 在途回调在验签前被 40001 拒、webhook_events 零留痕。
     *      曾经 `enabled` 恒 true（configs 只从 PAYMENT_CHANNELS 生成），这个语义根本无法触发。
     */
    const c = loadConfig({ ...baseEnv, ...stripeKeys, PAYMENT_CHANNELS: 'mock' });
    const { registry, registered, offline } = buildPaymentRegistry(c, deps());

    expect(registered).toEqual(['mock', 'stripe']);
    expect(offline).toEqual(['stripe']);

    // ① 新单被拦：channel_disabled（不是 channel_not_configured——它"存在"，只是下线了）
    expectChannelError(() => registry.get('stripe'), 'channel_disabled');
    // ② 支付入口列表不含它
    expect(registry.listAvailable(US_USD).map((x) => x.channel)).toEqual([]);
    // ③ 在途订单的回调照常（这是 getForCallback 不判 enabled 的存在意义）
    expect(registry.getForCallback('stripe').channel).toBe('stripe');
    // ④ 老单退款照常
    expect(registry.getForRefund('stripe').channel).toBe('stripe');
  });

  it('mock 未列出但显式配了密钥 → 同样保留下线能力；未列出且只占位密钥 → 不注册（公开值不能开门）', () => {
    /**
     * @why 两条要一起看：mock 的占位密钥是仓库里的公开值——"未列出也注册"在 mock 身上
     *      等于给任何人开"伪造回调置 paid"的门（P3-7 同源）；显式密钥则表明运营有意保留。
     */
    const explicit = loadConfig({
      ...baseEnv,
      PAYMENT_CHANNELS: 'wechat',
      MOCK_CALLBACK_SECRET: 'explicit-secret',
    });
    const a1 = buildPaymentRegistry(explicit, deps());
    expect(a1.registered).toEqual(['mock']);
    expect(a1.offline).toEqual(['mock']);
    expectChannelError(() => a1.registry.get('mock'), 'channel_disabled');
    expect(a1.registry.getForCallback('mock').channel).toBe('mock');

    const noSecret = loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'wechat' });
    const a2 = buildPaymentRegistry(noSecret, deps());
    expect(a2.registered).toEqual([]);
    expect(a2.offline).toEqual([]);
    expectChannelError(() => a2.registry.getForCallback('mock'), 'channel_not_configured');
  });
});

describe('buildPaymentRegistry：生产环境的 mock 门（三审 S1）', () => {
  /**
   * 第二道防线：config 规则 1b 已拒绝"生产残留 mock 密钥"，但装配层不能只信配置层——
   * 若将来有人放宽规则 1b（例如为了"保留审核期在途订单"），mock 在生产也**绝不能**因为
   * 密钥存在就注册。生产只有"列出 + REVIEW_MODE=on"这一条路（规则 1 保证）。
   */
  it('生产 + 未列出 mock + 残留密钥 → 不注册 mock（不靠配置层单点）', () => {
    const c = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app@db.internal:5432/japan_shop',
      PAYMENT_CHANNELS: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
      CORS_ORIGINS: 'https://admin.example.com',
    });
    // 绕过配置层（模拟规则 1b 被放宽）：直接注入残留密钥
    const a = buildPaymentRegistry({ ...c, MOCK_CALLBACK_SECRET: 'left-over' }, deps());
    expect(a.registered).toEqual(['stripe']);
    expect(a.offline).toEqual([]);
    expectChannelError(() => a.registry.getForCallback('mock'), 'channel_not_configured');
  });
});

describe('buildPaymentRegistry：未实现的通道与未知通道', () => {
  it('wechat 配置了但没有工厂 → 静默跳过（@limitation 二），其它通道不受影响', async () => {
    const c = loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'mock,wechat' });
    const { registry } = buildPaymentRegistry(c, deps());

    expectChannelError(() => registry.get('wechat'), 'channel_not_registered');
    // ⚠️ 关键：wechat 没实现 ≠ 支付入口没了
    expect(registry.listAvailable(US_JPY).map((x) => x.channel)).toEqual(['mock']);
  });

  it('默认表里没登记的通道 → 走兜底（priority 100 / 展示名"其他支付方式"），排最后', () => {
    /**
     * @why 用类型断言造一个"配置里有、默认表里没有"的通道：
     *      这是**真实会发生的过渡态**——新增支付方式要先往 shared 枚举里加名字，
     *      而 CHANNEL_DEFAULTS 是内置表（@limitation 一），很容易晚一步才补。
     *      那时若没有兜底，新通道会因为"没登记展示名"而**从列表里消失**；
     *      有兜底则至少能出现，只是长得朴素——后者明显更安全。
     * @limitation 断言绕过了 `PAYMENT_CHANNELS` 的枚举校验（直接改数组），
     *      所以这条用例测的是**装配层对未知 key 的行为**，不是配置层放不放行。
     */
    const c = {
      ...loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'mock' }),
      PAYMENT_CHANNELS: ['mock', 'futurepay'],
    } as unknown as AppConfig;
    const { registry } = buildPaymentRegistry(c, deps());

    // 兜底配置本身不带工厂，这里补一个最小实现，只为"看得见它"
    registry.register('futurepay', (cfg) => minimalProvider(cfg.channel));

    const items = registry.listAvailable(US_JPY);
    expect(items.map((x) => x.channel)).toEqual(['mock', 'futurepay']);
    expect(items[1]?.label).toBe('其他支付方式');
    expect(items[1]?.icon).toBeUndefined();
  });
});

/** 只满足注册表一致性校验的最小 Provider（不支持退款，就不声明支持）。 */
function minimalProvider(channel: string): PaymentProvider {
  return {
    channel,
    capabilities: {
      currencies: ['*'],
      countries: ['*'],
      entryMode: 'redirect',
      supportsRefund: false,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: true,
    },
    create: async () => ({
      providerRef: 'ref-1',
      entry: { mode: 'redirect', url: 'https://example.test/go' },
    }),
    parseWebhook: async (): Promise<ProviderEvent> => ({
      eventId: 'evt-1',
      rawType: 'x',
      outcome: 'succeeded',
      orderId: 'sk-1',
      providerRef: 'ref-1',
    }),
  };
}
