/**
 * 职责：Stripe 的**假 HTTP 客户端**（`HttpClient` 的一个实现）。
 *
 * @why 它是"依赖要真"这条原则的**边界**：Stripe 是真三方，测试里不能真打（要密钥、要网络、
 *      结果还不可复现），所以三方本身用替身；而**我们自己的代码**（建会话、编码表单、
 *      验签、解析、映射）全部走真实实现。这样契约测试验的是我们的代码，不是我们的替身。
 *
 * @why 替身要**有脾气**（验鉴权头、认幂等键、对未知路径返回 404）：
 *      一个"什么都返回 200"的替身只能测出"我们不会崩"，
 *      测不出"我们真的带了鉴权头""我们真的传了幂等键"——而漏掉后者等于重复扣款。
 *
 * @limitation 一：幂等按 `Idempotency-Key` **整键**缓存（真实 Stripe 也是这个语义，
 *              但有 24 小时窗口与请求体一致性校验；这里不做，够用即可）。
 * @limitation 二：不模拟错误码（402 卡被拒、429 限流）。
 *              需要时按用例单独造，不预先铺——铺了就会有人依赖上不存在的场景。
 */
import type { HttpClient, HttpRequest, HttpResponse } from '../../server/src/ports/http-client.js';

export interface FakeStripeHttp extends HttpClient {
  /** 收到的全部请求（断言"我们到底发了什么"用）。 */
  readonly calls: HttpRequest[];
  /** 让下一次请求失败（模拟上游 5xx / 网络错误）。 */
  failNext(status: number, body?: string): void;
  /**
   * 登记一个"机构侧已存在"的 PaymentIntent（供 dispute 事件反查）。
   * 不登记就查到 = 404——替身有脾气：测得出"反查失败会怎么走"。
   */
  givenPaymentIntent(id: string, metadata: Record<string, string>): void;
}

export function createFakeStripeHttp(): FakeStripeHttp {
  const calls: HttpRequest[] = [];
  /** idempotency-key → 已建的会话。 */
  const sessions = new Map<string, { id: string; url: string; expires_at: number }>();
  /** payment_intent id → metadata（create 时从表单抓 + givenPaymentIntent 手工登记）。 */
  const paymentIntents = new Map<string, Record<string, string>>();
  let nextId = 1;
  let forced: { status: number; body: string } | undefined;

  const client: FakeStripeHttp = {
    calls,
    failNext(status, body = '{"error":{"message":"forced failure"}}') {
      forced = { status, body };
    },
    givenPaymentIntent(id, metadata) {
      paymentIntents.set(id, metadata);
    },
    async send(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      if (forced !== undefined) {
        const f = forced;
        forced = undefined;
        return { status: f.status, body: f.body };
      }
      // 没带鉴权头就像真 Stripe 一样拒绝：否则"忘了带 key"这个缺陷永远测不出来
      const auth = req.headers?.['authorization'] ?? '';
      if (!auth.startsWith('Bearer ')) {
        return { status: 401, body: '{"error":{"message":"missing api key"}}' };
      }
      const path = new URL(req.url).pathname;
      const body = req.body ?? '';

      if (path === '/v1/checkout/sessions' && req.method === 'POST') {
        const key = req.headers?.['idempotency-key'] ?? '';
        if (key.length === 0) {
          return { status: 400, body: '{"error":{"message":"missing idempotency key"}}' };
        }
        const cached = sessions.get(key);
        if (cached !== undefined) return { status: 200, body: JSON.stringify(cached) };
        const id = `cs_test_${String(nextId).padStart(4, '0')}`;
        nextId += 1;
        const session = {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          expires_at: 1_800_000_000,
        };
        sessions.set(key, session);
        // 与真 Stripe 同口径：Session 会带一个 PaymentIntent，
        // 其 metadata 来自表单的 payment_intent_data[metadata][*]
        const form = new URLSearchParams(body);
        const orderId = form.get('payment_intent_data[metadata][order_id]');
        if (orderId !== null) {
          paymentIntents.set(`pi_for_${id}`, { order_id: orderId });
        }
        return { status: 200, body: JSON.stringify(session) };
      }

      // dispute 事件的反查通道（适配器在 dispute 对象取不到 order_id 时调它）
      const piMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
      if (piMatch !== null && req.method === 'GET') {
        const pi = paymentIntents.get(piMatch[1] ?? '');
        if (pi === undefined) {
          return { status: 404, body: '{"error":{"message":"No such payment_intent"}}' };
        }
        return {
          status: 200,
          body: JSON.stringify({ id: piMatch[1], object: 'payment_intent', metadata: pi }),
        };
      }

      // D-50 会话作废（关单连带）：与建会话同一层防线——无幂等键的 POST 拒掉，
      // 否则"忘了带键"这个缺陷在测试里永远测不出来（超时后无人敢重发）
      const expireMatch = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
      if (expireMatch !== null && req.method === 'POST') {
        if ((req.headers?.['idempotency-key'] ?? '').length === 0) {
          return { status: 400, body: '{"error":{"message":"missing idempotency key"}}' };
        }
        return {
          status: 200,
          body: JSON.stringify({
            id: expireMatch[1],
            object: 'checkout.session',
            status: 'expired',
          }),
        };
      }

      if (path === '/v1/refunds' && req.method === 'POST') {
        // 退款必须带 payment_intent：漏了就是"退到哪儿去"没说清楚
        if (!body.includes('payment_intent=')) {
          return { status: 400, body: '{"error":{"message":"missing payment_intent"}}' };
        }
        return { status: 200, body: JSON.stringify({ id: 're_test_0001', status: 'succeeded' }) };
      }

      return { status: 404, body: '{"error":{"message":"unknown path"}}' };
    },
  };
  return client;
}
