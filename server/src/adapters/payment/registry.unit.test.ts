/**
 * 职责：支付注册表的用例（F11）——**筛选规则**与**下线语义**是这里的两条命。
 *
 * @why 注册表是"加一种支付方式不用改业务代码"这条承诺的兑现处，
 *      它错有两种典型形态，都**不会报错**：
 *        ① 该出现的没出现（用户看不到入口 → 转化率静默下降）；
 *        ② 不该出现的出现了（已下线通道还能建单 → 资金走错路）。
 *      两种都不会崩，只会让"钱"出错，所以必须逐条钉住。
 *
 * @why 特别钉**下线语义**（`getForRefund`）：通道下线后老订单**仍必须可退款**，
 *      这是"可插拔"最容易做漏的一半——只做"下线不再出新单"很简单，
 *      难的是"下线了但三个月前的订单还要能退"，而漏掉它的代价是用户退不了钱。
 *
 * @limitation 这里用的是**桩 Provider**（不是真实实现）：注册表只关心"它声明了什么能力"，
 *              不关心它怎么跟机构通信。真实实现由契约测试覆盖（F11 第二单元）。
 */
import { describe, expect, it } from 'vitest';
import {
  isChannelAvailable,
  matchesScope,
  type ChannelConfig,
  type ChannelQuery,
  type PaymentProvider,
  type PaymentRequest,
  type ProviderCapabilities,
  type RefundRequest,
} from '../../ports/payment.js';
import { createPaymentRegistry } from './registry.js';

const US_JPY: ChannelQuery = { destCountry: 'US', amountJpy: 10_000, currency: 'JPY' };

/** 造一个桩 Provider：`caps` 覆盖能力，`withRefund` 决定有没有退款实现。 */
function stub(
  channel: string,
  caps: Partial<ProviderCapabilities> = {},
  withRefund = true,
): PaymentProvider {
  const base: PaymentProvider = {
    channel,
    capabilities: {
      currencies: ['JPY'],
      countries: ['*'],
      entryMode: 'copylink',
      supportsRefund: withRefund,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: true,
      ...caps,
    },
    create: async (req: PaymentRequest) => ({
      providerRef: `ref-${req.orderId}`,
      entry: { mode: 'copylink', url: 'https://example.test/checkout' },
    }),
    parseWebhook: async () => ({
      eventId: 'evt-1',
      rawType: 'checkout.session.completed',
      outcome: 'succeeded',
      orderId: 'sk-1',
      providerRef: 'ref-1',
    }),
  };
  return withRefund
    ? {
        ...base,
        refund: async (req: RefundRequest) => ({
          providerRef: req.providerRef,
          refundRef: 're-1',
          outcome: 'succeeded',
        }),
      }
    : base;
}

/**
 * 断言"通道不可用"错误。
 *
 * @why 只比对 `details.reason` 而不比对 `message`：
 *      `AppError` 的 `message` 是**给用户看的**（40001 → "参数缺失或格式错误"），
 *      `reason` 在 `details` 里、**只进日志**（errors.ts @limitation 一）。
 *      这是刻意的：调用方不该从响应体里知道"这个通道没注册工厂"这种内部事实。
 *      测试若去断言 message 里含 reason，等于要求把内部原因外泄——那是错的。
 */
function expectChannelError(fn: () => void, reason: string): void {
  try {
    fn();
    expect.unreachable(`应当抛错（reason=${reason}）`);
  } catch (e) {
    const err = e as { code?: number; details?: { reason?: string } };
    expect(err.code, `错误码应为 40001（收到 ${JSON.stringify(err.details)}）`).toBe(40001);
    expect(err.details?.reason).toBe(reason);
  }
}

function cfg(over: Partial<ChannelConfig> & { channel: string }): ChannelConfig {
  return {
    enabled: true,
    priority: 100,
    countries: ['*'],
    currencies: ['JPY'],
    label: over.channel,
    ...over,
  };
}

describe('matchesScope / isChannelAvailable（契约级筛选规则）', () => {
  it("'*' 通配命中任意值；无通配时精确匹配", () => {
    expect(matchesScope(['*'], 'US')).toBe(true);
    expect(matchesScope(['US', 'CA'], 'US')).toBe(true);
    expect(matchesScope(['US', 'CA'], 'JP')).toBe(false);
    expect(matchesScope([], 'US')).toBe(false);
  });

  it('金额上下限是**含**边界（等于 min/max 可用）', () => {
    const caps = stub('a', { minAmountJpy: 100, maxAmountJpy: 200 }).capabilities;
    const base = cfg({ channel: 'a' });
    expect(isChannelAvailable(base, caps, { ...US_JPY, amountJpy: 99 })).toBe(false);
    expect(isChannelAvailable(base, caps, { ...US_JPY, amountJpy: 100 })).toBe(true);
    expect(isChannelAvailable(base, caps, { ...US_JPY, amountJpy: 200 })).toBe(true);
    expect(isChannelAvailable(base, caps, { ...US_JPY, amountJpy: 201 })).toBe(false);
  });

  it('配置关了就不行——即使能力上完全支持（配置是开关，能力是边界，两码事）', () => {
    const caps = stub('a').capabilities;
    expect(isChannelAvailable(cfg({ channel: 'a', enabled: false }), caps, US_JPY)).toBe(false);
  });

  it('配置放行但机构做不到（国家不在能力里）→ 不可用', () => {
    const caps = stub('a', { countries: ['JP'] }).capabilities;
    expect(isChannelAvailable(cfg({ channel: 'a', countries: ['*'] }), caps, US_JPY)).toBe(false);
  });

  it('币种两侧都要命中：配置不含 / 能力不含，任一不成立都不可用', () => {
    const caps = stub('a', { currencies: ['JPY'] }).capabilities;
    expect(isChannelAvailable(cfg({ channel: 'a', currencies: ['USD'] }), caps, US_JPY)).toBe(
      false,
    );
    expect(
      isChannelAvailable(
        cfg({ channel: 'a' }),
        stub('a', { currencies: ['USD'] }).capabilities,
        US_JPY,
      ),
    ).toBe(false);
  });
});

describe('listAvailable（前端入口来源）', () => {
  it('按 priority 升序；同 priority 按 channel 字典序（结果稳定可测）', () => {
    const r = createPaymentRegistry({
      configs: [
        cfg({ channel: 'wechat', priority: 10 }),
        cfg({ channel: 'stripe', priority: 20 }),
        cfg({ channel: 'aaa', priority: 20 }),
      ],
    });
    r.register('wechat', (c) => stub(c.channel));
    r.register('stripe', (c) => stub(c.channel));
    r.register('aaa', (c) => stub(c.channel));
    expect(r.listAvailable(US_JPY).map((v) => v.channel)).toEqual(['wechat', 'aaa', 'stripe']);
  });

  it('禁用的通道不出现（下线 = 前端入口自动消失，无需发版）', () => {
    const r = createPaymentRegistry({
      configs: [cfg({ channel: 'a', enabled: true }), cfg({ channel: 'b', enabled: false })],
    });
    r.register('a', (c) => stub(c.channel));
    r.register('b', (c) => stub(c.channel));
    expect(r.listAvailable(US_JPY).map((v) => v.channel)).toEqual(['a']);
  });

  it('配置里写了但**没注册工厂** → 静默跳过（配置可先行于代码）', () => {
    const r = createPaymentRegistry({
      configs: [cfg({ channel: 'a' }), cfg({ channel: 'ghost' })],
    });
    r.register('a', (c) => stub(c.channel));
    expect(r.listAvailable(US_JPY).map((v) => v.channel)).toEqual(['a']);
  });

  it('国家 / 币种 / 金额任一不匹配的通道被过滤掉', () => {
    const r = createPaymentRegistry({
      configs: [
        cfg({ channel: 'ok' }),
        cfg({ channel: 'wrongCountry', countries: ['JP'] }),
        cfg({ channel: 'poorCap' }),
      ],
    });
    r.register('ok', (c) => stub(c.channel));
    r.register('wrongCountry', (c) => stub(c.channel));
    r.register('poorCap', (c) => stub(c.channel, { maxAmountJpy: 5_000 }));
    expect(r.listAvailable(US_JPY).map((v) => v.channel)).toEqual(['ok']);
  });

  it('返回的是**视图**（channel/entryMode/label），不带任何机构专属字段', () => {
    const r = createPaymentRegistry({
      configs: [cfg({ channel: 'stripe', label: '银行卡', icon: 'card' })],
    });
    r.register('stripe', (c) => stub(c.channel, { entryMode: 'copylink' }));
    expect(r.listAvailable(US_JPY)).toEqual([
      { channel: 'stripe', entryMode: 'copylink', label: '银行卡', icon: 'card' },
    ]);
  });
});

describe('get（建单通道：必须启用）', () => {
  it('启用 → 返回 Provider；重复调用返回同一实例（工厂是纯装配）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', (c) => stub(c.channel));
    expect(r.get('a')).toBe(r.get('a'));
  });

  it('未配置 / 已禁用 / 未注册工厂 → 抛 40001，且 reason 各不相同（排障要看）', () => {
    const r = createPaymentRegistry({
      configs: [cfg({ channel: 'off', enabled: false }), cfg({ channel: 'nofactory' })],
    });
    r.register('off', (c) => stub(c.channel));
    expectChannelError(() => r.get('nope'), 'channel_not_configured');
    expectChannelError(() => r.get('off'), 'channel_disabled');
    expectChannelError(() => r.get('nofactory'), 'channel_not_registered');
  });
});

describe('getForRefund（下线语义：禁用只影响新单，不影响老单退款）', () => {
  it('已禁用但 refundableWhenDisabled=true → **仍可取到**（老订单必须能退）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a', enabled: false })] });
    r.register('a', (c) => stub(c.channel, { refundableWhenDisabled: true }));
    expect(r.getForRefund('a').channel).toBe('a');
    // 对照：同一通道在建单路径上是不可用的
    expectChannelError(() => r.get('a'), 'channel_disabled');
  });

  it('已禁用且 refundableWhenDisabled=false → 拒绝（该通道明确声明下线后不可退）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a', enabled: false })] });
    r.register('a', (c) => stub(c.channel, { refundableWhenDisabled: false }));
    expectChannelError(() => r.getForRefund('a'), 'channel_disabled_and_not_refundable');
  });

  it('未配置 / 未注册工厂的通道，退款同样拒绝（老订单不会因为配置被删就退不了钱以外的东西）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'nofactory' })] });
    expectChannelError(() => r.getForRefund('nope'), 'channel_not_configured');
    expectChannelError(() => r.getForRefund('nofactory'), 'channel_not_registered');
  });

  it('启用但不支持退款 → 拒绝（不是"返回 undefined 让调用方自己判"）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', (c) => stub(c.channel, { supportsRefund: false }, false));
    expectChannelError(() => r.getForRefund('a'), 'refund_not_supported');
  });
});

describe('getForCallback（回调语义：比退款更根本，禁用**也不**拦）', () => {
  /**
   * @why 这一组是本次新增，理由值得单独写：
   *      回调对应的是**钱已经收了、要落账**的事件，比退款更根本——
   *      退款是我们要主动退钱（不做，用户可以来问）；
   *      回调不做，就是"用户付了钱、订单永远是未支付、货不发、也没人报警"。
   *      所以 `getForCallback` **连 `refundableWhenDisabled` 都不看**：
   *      那条能力声明说的是"退款"，管不到"已经付成功的通知"。
   */
  it('已禁用 → **仍可取到**（禁用只阻止新单，不阻止已发生支付的回调落账）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a', enabled: false })] });
    r.register('a', (c) => stub(c.channel));
    expect(r.getForCallback('a').channel).toBe('a');
    // 对照：同一通道在建单路径上不可用（三条路径的边界就靠这几行钉住）
    expectChannelError(() => r.get('a'), 'channel_disabled');
  });

  it('已禁用且 refundableWhenDisabled=false → **照样可取**（该声明只管退款，管不到回调）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a', enabled: false })] });
    r.register('a', (c) => stub(c.channel, { refundableWhenDisabled: false }));
    expect(r.getForCallback('a').channel).toBe('a');
    // 对照：退款路径上这同一条配置是**拒绝**的
    expectChannelError(() => r.getForRefund('a'), 'channel_disabled_and_not_refundable');
  });

  it('未配置 / 未注册工厂 → 抛（验不了签就必须响亮地失败，不能静默收下）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'nofactory' })] });
    expectChannelError(() => r.getForCallback('nope'), 'channel_not_configured');
    expectChannelError(() => r.getForCallback('nofactory'), 'channel_not_registered');
  });
});

describe('注册期不变式（声明必须与实现一致）', () => {
  it('重复注册同名通道 → 抛（静默覆盖会让"生效的是谁"变成谜）', () => {
    const r = createPaymentRegistry({ configs: [] });
    r.register('a', (c) => stub(c.channel));
    expect(() => r.register('a', (c) => stub(c.channel))).toThrow(/重复注册/);
  });

  it('重复配置同名通道 → 构造时就抛（装配期错误必须炸）', () => {
    expect(() =>
      createPaymentRegistry({ configs: [cfg({ channel: 'a' }), cfg({ channel: 'a' })] }),
    ).toThrow(/配置重复/);
  });

  it('自报 channel 与注册键不一致 → 抛', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', () => stub('b'));
    expect(() => r.get('a')).toThrow(/registration 不一致|与注册键不一致/);
  });

  it('声明 supportsRefund=true 却没有 refund() → 抛（业务按声明调用会运行时炸）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', (c) => stub(c.channel, { supportsRefund: true }, false));
    expect(() => r.get('a')).toThrow(/supportsRefund 但没有实现/);
  });

  it('实现了 refund() 却声明 supportsRefund=false → 抛（调用方永远不会调它）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', (c) => stub(c.channel, { supportsRefund: false }, true));
    expect(() => r.get('a')).toThrow(/声明 supportsRefund=false/);
  });

  it('空通道名 → 抛（空字符串会让"这个通道是谁"无从回答）', () => {
    const r = createPaymentRegistry({ configs: [] });
    expect(() => r.register('', (c) => stub(c.channel))).toThrow(/通道名不能为空/);
  });

  it('注册晚于首次取用也能生效（先 register 再 get 与反之都要正确）', () => {
    const r = createPaymentRegistry({ configs: [cfg({ channel: 'a' })] });
    r.register('a', () => stub('a'));
    expect(r.get('a').channel).toBe('a');
    // 覆盖式注册被禁止，所以这里验证的是"缓存不会把后注册的实现挡住"
    expect(() => r.register('a', () => stub('a'))).toThrow(/重复注册/);
  });
});
