/**
 * 职责：**审核期 / 测试**的假支付通道（`mock`）——把"支付"这条链路走通，但不碰任何真实机构。
 *
 * @why 它是三个目的的交汇点，缺一个就不该存在：
 *      ① 审核期必须能演示下单到支付（微信审核要看得见完整链路）；
 *      ② 端到端测试要有一个"能确定性地走到 paid"的通道；
 *      ③ 它是注册表的**最小可用样本**：新人照着它写第二个 Provider，
 *         比照着接口文档写快得多——接口对不对，看第一个实现写起来别不别扭就知道。
 *
 * @why 验签**照样做真的**（HMAC-SHA256 over 原始字节），只是密钥来自配置：
 *      "假通道"不等于"不要安全训练"。如果 mock 通道不验签，
 *      那么 `parseWebhook` 这条路径在接入真实通道之前就没人真正走过——
 *      真实通道接上来时才发现"raw body 没配""签名头取错名字"这类问题，代价高得多。
 *
 * @limitation 一：**进程内**幂等（Map 存 idempotencyKey → session）。
 *              重启即失效，多实例也不共享——这只够审核演示与测试，
 *              真实机构的幂等由机构侧保证（我们把 `idempotencyKey` 传过去）+ 我们自己的幂等表。
 *              ⚠️ 无界 Map 会涨：审核/测试调用量可忽略，若将来把它用于压测要加上限。
 * @limitation 二：不做拒付（dispute）、不做部分退款——能力声明里已如实写 false，
 *              注册表会强制"声明与实现一致"，所以这里假称支持会直接注册失败。
 * @limitation 三：入口形态写死 `in_app`。它是"小程序内唤起"的占位，
 *              真实的小程序内支付参数由机构下发（将来 wechat 通道的实现负责），
 *              本实现只保证 `params` 非空且不含密钥。
 *
 * @see ../../ports/payment.ts；docs/地基搭建清单.md F11
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGen } from '../../ports/ids.js';
import type {
  ChannelConfig,
  HeaderBag,
  PaymentProvider,
  PaymentRequest,
  PaymentSession,
  ProviderEvent,
  RefundRequest,
} from '../../ports/payment.js';

/** 模拟回调的签名头（mock 通道自定义约定，不是任何机构的真实口径）。 */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

/** 模拟回调的报文形状（mock 通道自定义约定，不是任何机构的真实口径）。 */
export interface MockEventBody {
  event_id: string;
  type: string;
  order_id: string;
  provider_ref: string;
  /** 最小单位金额 + 币种（与 `ProviderEvent` 同一口径，不做换算）。 */
  amount_minor?: number;
  currency?: string;
}

/** 报文类型 → 归一化结果。**未列出的类型一律 unknown**（不猜，猜错比不认更危险）。 */
const OUTCOME_BY_TYPE: Readonly<Record<string, ProviderEvent['outcome']>> = {
  'payment.succeeded': 'succeeded',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'disputed',
};

export interface MockProviderDeps {
  clock: Clock;
  idGen: IdGen;
}

/** 从配置里取密钥：缺失要在**装配期**炸，而不是等到第一个回调验签失败。 */
function secretOf(cfg: ChannelConfig): string {
  const secret = cfg.options?.['secret'];
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      `mock 通道缺少 options.secret（channel=${cfg.channel}）：不配密钥等于任何人都能伪造回调`,
    );
  }
  return secret;
}

export function createMockProvider(cfg: ChannelConfig, deps: MockProviderDeps): PaymentProvider {
  const secret = secretOf(cfg);
  /** idempotencyKey → 已创建的会话（见 @limitation 一）。 */
  const sessions = new Map<string, PaymentSession>();

  return {
    channel: cfg.channel,
    capabilities: {
      currencies: ['JPY'],
      countries: ['*'],
      entryMode: 'in_app',
      supportsRefund: true,
      supportsPartialRefund: false,
      supportsDispute: false,
      refundableWhenDisabled: true,
    },

    async create(req: PaymentRequest): Promise<PaymentSession> {
      const cached = sessions.get(req.idempotencyKey);
      if (cached !== undefined) return cached;
      const session: PaymentSession = {
        providerRef: `mock_${deps.idGen.uuid()}`,
        entry: {
          mode: 'in_app',
          // 只给"前端唤起需要的样子"，不含任何密钥或内部字段。
          // `auto: true` 是审核期的自动确认信号（契约 PaymentIntent payload 的 mock 形状）：
          // 前端据此直接走"模拟支付成功"流程，不必硬编码 channel === 'mock'（D-56 不写死通道名）
          params: {
            auto: true,
            orderId: req.orderId,
            amountJpy: req.amountJpy,
            currency: req.currency,
          },
        },
        expiresAt: new Date(deps.clock.now().getTime() + 30 * 60 * 1000).toISOString(),
      };
      sessions.set(req.idempotencyKey, session);
      return session;
    },

    async parseWebhook(raw: Buffer, headers: HeaderBag): Promise<ProviderEvent> {
      const signature = headers[MOCK_SIGNATURE_HEADER] ?? '';
      /**
       * ⚠️ 期望值要保留**十六进制字符串**本身，不能只留 Buffer。
       * @why 曾经写成 `sha256:${expected.toString('hex')}`：对一个"由 hex 字符串构造的 Buffer"
       *      再 `.toString('hex')` 是**二次编码**——64 个 hex 字符变成 128 个 hex 字符，
       *      拼上前缀共 135 字符，超出 `webhook_events.event_id varchar(128)`，
       *      表现为机构没给 event_id 时回调**一律 500**（真库才暴露，单测测不到长度）。
       *      端到端把模拟回调迁到统一分发后这条路径才第一次被真库走到。
       */
      const expectedHex = createHmac('sha256', secret).update(raw).digest('hex');
      const expected = Buffer.from(expectedHex, 'utf8');
      const got = Buffer.from(signature, 'utf8');
      // 恒定时间比较 + 先比长度（长度不等时 timingSafeEqual 会抛）
      const ok = got.length === expected.length && timingSafeEqual(got, expected);
      if (!ok) {
        // 40103：入站方的问题，不重试（D6）
        throw new AppError(40103, { channel: cfg.channel, reason: 'mock_signature_mismatch' });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(40001, { channel: cfg.channel, reason: 'mock_payload_not_json' });
      }
      const body = parsed as Partial<MockEventBody> | null;
      const orderId = body?.order_id;
      const providerRef = body?.provider_ref;
      // 取不到 order_id 是**我们的设计缺陷**（create 时没把单号写进 metadata），
      // 不是入站方的问题——所以抛 50000 让它进告警，而不是当作坏报文回 4xx
      if (typeof orderId !== 'string' || orderId.length === 0) {
        throw new Error(`mock 回调缺少 order_id：通道=${cfg.channel}，type=${String(body?.type)}`);
      }
      return {
        eventId: typeof body?.event_id === 'string' ? body.event_id : `sha256:${expectedHex}`,
        rawType: typeof body?.type === 'string' ? body.type : 'unknown',
        outcome: OUTCOME_BY_TYPE[String(body?.type)] ?? 'unknown',
        orderId,
        providerRef: typeof providerRef === 'string' ? providerRef : '',
        ...(typeof body?.amount_minor === 'number' ? { amountMinor: body.amount_minor } : {}),
        ...(typeof body?.currency === 'string' ? { currency: body.currency.toUpperCase() } : {}),
      };
    },

    async refund(req: RefundRequest) {
      // mock 不对接真实机构退款；但**形状**必须是真的（有 refundRef、有 outcome），
      // 否则上层的"退款成功"分支在真实通道接上来之前一次都没被走过
      return {
        providerRef: req.providerRef,
        refundRef: `mock_re_${deps.idGen.uuid()}`,
        outcome: 'succeeded' as const,
      };
    },
  };
}
