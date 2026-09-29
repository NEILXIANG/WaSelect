/**
 * 职责：支付 Provider 的**共用契约测试**（F11 / 测试策略 T-1 / T-3）。
 *
 * @why 这是"可插拔"真正兑现的地方，也是唯一能证明它兑现了的地方。
 *      接口画得再漂亮，如果没有"所有实现必须跑同一组测试"这个约束，
 *      那么第二个 Provider 会照着第一个的形状写，第三个照着第二个抄——
 *      抄到第三个时，接口里那些**没人用过的分支**早就烂了，而没人知道。
 *      共用一套测试的好处不是省代码，是**逼每个实现在同等强度下被检验**。
 *
 * @why 场景刻意覆盖"**失败路径**"（验签失败、报文坏、重放）：
 *      成功路径各家都能跑通，真正区分实现质量的是失败路径怎么报——
 *      验签失败回成 40001 会让机构以为"改改报文就行"从而反复重发；
 *      报文坏回成 40103 会让排障方向指向密钥而不是报文。两者都是真实事故形态。
 *
 * @how 每个 Provider 提供一份 `ProviderHarness`（造报文 + 造签名），
 *      套件只按端口语义断言，不认识任何机构。新增 Provider = 写一份 harness，
 *      **不用复制这些场景**。
 *
 * @limitation 一：不验"机构的真实行为"（那要真账号 + 真网络）；
 *              验的是"**我们对端口的承诺**"：形状、错误码、幂等、原始字节验签。
 * @limitation 二：`replayed`（时间容差）是**可选**场景：不带时间戳容差的通道跳过它，
 *              并在用例名里标出"不适用"——宁可少测一条，也不写一条假的重放用例。
 */
import { describe, expect, it } from 'vitest';
import {
  type HeaderBag,
  type PaymentProvider,
  type PaymentRequest,
  type ProviderEvent,
} from '../../server/src/ports/payment.js';

/** 一条回调报文（原始字节 + 应带的头）。 */
export interface SignedPayload {
  raw: Buffer;
  headers: HeaderBag;
}

/**
 * 契约测试要造的回调素材（"支付成功"是主路径，其它形状由各通道自己定义）。
 *
 * @why 金额统一用**最小单位 + JPY**：两个通道的样本都是 JPY 交易，
 *      而 JPY 的最小单位就是円，避免"到底传主单位还是分"这个歧义进到断言里。
 */
export interface SuccessEvent {
  orderId: string;
  providerRef: string;
  amountMinor: number;
}

/** 每个 Provider 提供一份：怎么造合法报文、怎么造各种坏报文。 */
export interface ProviderHarness {
  provider: PaymentProvider;
  signed(e: SuccessEvent): SignedPayload;
  wrongSignature(e: SuccessEvent): SignedPayload;
  noSignature(e: SuccessEvent): SignedPayload;
  /** 签名**正确**但内容不是合法 JSON。 */
  unparsable(): SignedPayload;
  /**
   * 时间戳过旧的重放报文；该通道无时间容差语义时**显式写 `undefined`**。
   *
   * @why 写成**必填且可为 undefined**（而不是可选方法）：
   *      `exactOptionalPropertyTypes` 下可选属性根本不能显式传 `undefined`，
   *      于是"不支持"只能靠**整个属性不写**来表达——而"没写"和"忘了写"在调用点长得一样。
   *      强制写出来，harness 作者就必须当场回答"你到底支不支持重放"。
   */
  replayed: ((e: SuccessEvent) => SignedPayload | undefined) | undefined;
}

/** 断言抛的是指定业务错误码（只比 code；message 是给人看的，details 只进日志）。 */
function expectCode(fn: () => Promise<unknown> | unknown, code: number): Promise<void> {
  return (async () => {
    try {
      await fn();
      expect.unreachable(`应当抛 code=${code}`);
    } catch (e) {
      expect((e as { code?: number }).code, `错误码应为 ${code}`).toBe(code);
    }
  })();
}

export function runProviderContract(name: string, make: () => ProviderHarness): void {
  describe(`支付 Provider 契约（${name}）`, () => {
    const req: PaymentRequest = {
      orderId: 'sk-contract-1',
      orderNo: '260103-K7Q2MN',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      destCountry: 'US',
      idempotencyKey: 'idem-contract-1',
    };

    it('create 返回会话：providerRef 非空，entry.mode 与能力声明一致', async () => {
      const { provider } = make();
      const s = await provider.create(req);
      expect(s.providerRef.length).toBeGreaterThan(0);
      expect(s.entry.mode).toBe(provider.capabilities.entryMode);
      // 入口内容必须非空：in_app 要有参数，copylink/redirect 要有 url
      if (s.entry.mode === 'in_app') expect(Object.keys(s.entry.params).length).toBeGreaterThan(0);
      else expect(s.entry.url.length).toBeGreaterThan(0);
    });

    it('create 幂等：同一 Idempotency-Key 复用同一意图（不重复建单）', async () => {
      const { provider } = make();
      const a = await provider.create(req);
      const b = await provider.create(req);
      expect(b.providerRef).toBe(a.providerRef);
      // 换一个键则必须是**另一个**意图：否则说明它根本没看 idempotencyKey
      const c = await provider.create({ ...req, idempotencyKey: 'idem-contract-2' });
      expect(c.providerRef).not.toBe(a.providerRef);
    });

    it('parseWebhook 正常报文：orderId 回带正确、结果是 succeeded', async () => {
      const h = make();
      const s = await h.provider.create(req);
      const ev = await h.provider.parseWebhook(
        h.signed({ orderId: req.orderId, providerRef: s.providerRef, amountMinor: req.amountJpy })
          .raw,
        h.signed({ orderId: req.orderId, providerRef: s.providerRef, amountMinor: req.amountJpy })
          .headers,
      );
      expect(ev.orderId).toBe(req.orderId);
      expect(ev.outcome).toBe('succeeded');
      expect(ev.eventId.length).toBeGreaterThan(0);
      expect(ev.rawType.length).toBeGreaterThan(0);
    });

    it('报文被改动一个字节 → 40103（验签失败；绝不能是 200 或 40001）', async () => {
      const h = make();
      const p = h.signed({ orderId: req.orderId, providerRef: 'x', amountMinor: req.amountJpy });
      const tampered = Buffer.from(p.raw);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01;
      await expectCode(() => h.provider.parseWebhook(tampered, p.headers), 40103);
    });

    it('缺少签名头 → 40103（不是 40001：没签名不是"格式错"，是"身份不明"）', async () => {
      const h = make();
      const p = h.noSignature({
        orderId: req.orderId,
        providerRef: 'x',
        amountMinor: req.amountJpy,
      });
      await expectCode(() => h.provider.parseWebhook(p.raw, p.headers), 40103);
    });

    it('签名正确但内容不是合法 JSON → 40001（不是 40103：身份没问题，是报文坏）', async () => {
      const h = make();
      const p = h.unparsable();
      await expectCode(() => h.provider.parseWebhook(p.raw, p.headers), 40001);
    });

    it('重放旧报文 → 40103（时间容差）；该通道不适用时明确跳过并标注', async () => {
      const h = make();
      const p = h.replayed?.({
        orderId: req.orderId,
        providerRef: 'x',
        amountMinor: req.amountJpy,
      });
      if (p === undefined) {
        // ⚠️ 刻意不断言"通过"：这里断言的是"该通道确实没有提供重放场景"这一事实，
        //    让它在报告里以一条真实断言的形式存在，而不是无声地少测一条
        expect(
          h.replayed,
          `通道 ${name} 未提供重放场景（若它有时间容差，这里是漏测）`,
        ).toBeUndefined();
        return;
      }
      await expectCode(() => h.provider.parseWebhook(p.raw, p.headers), 40103);
    });

    it('退款（声明支持时）返回 refundRef 且不抛', async () => {
      const { provider } = make();
      if (!provider.capabilities.supportsRefund) {
        expect(provider.refund).toBeUndefined();
        expect(provider.refundStatus).toBeUndefined();
        return;
      }
      const s = await provider.create(req);
      const r = await provider.refund?.({
        orderId: req.orderId,
        providerRef: s.providerRef,
        amountJpy: req.amountJpy,
        currency: req.currency,
        amountMinor: req.amountMinor,
        reason: '缺货',
      });
      expect(r?.refundRef.length).toBeGreaterThan(0);
      expect(['succeeded', 'pending']).toContain(r?.outcome);
      // F-03（AJ-178）：能退就必须能查——pending 的退款只有靠查询才走得出 refunding
      expect(provider.refundStatus, '声明 supportsRefund 必须实现 refundStatus').toBeDefined();
      const status = await provider.refundStatus?.(r?.refundRef ?? '');
      expect(['succeeded', 'pending', 'failed']).toContain(status);
    });

    it('能力自洽：支持部分退款 ⇒ 必须支持全额退款（否则"部分退"没有退路）', () => {
      const { provider } = make();
      const c = provider.capabilities;
      if (c.supportsPartialRefund) expect(c.supportsRefund).toBe(true);
    });

    it('解析结果不得把机构私有字段漏进 ProviderEvent（统一形态的代价就是丢弃）', async () => {
      const h = make();
      const s = await h.provider.create(req);
      const p = h.signed({
        orderId: req.orderId,
        providerRef: s.providerRef,
        amountMinor: req.amountJpy,
      });
      const ev = await h.provider.parseWebhook(p.raw, p.headers);
      // 白名单之外的键出现在 event 上，说明有人把机构字段塞了进来
      const allowed = new Set([
        'eventId',
        'rawType',
        'outcome',
        'orderId',
        'providerRef',
        'amountMinor',
        'currency',
      ]);
      const extra = Object.keys(ev).filter((k) => !allowed.has(k));
      expect(extra).toEqual([]);
      expect((ev as ProviderEvent).outcome).toBeDefined();
    });
  });
}
