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
 * @why 替身的两条"脾气"来自 2026-09-28 测试审查第二轮（AJ-175）——此前它们缺席，于是两个真缺陷全绿：
 *      ① **同键异参报错**：@measured(docs.stripe.com/api/idempotent_requests, 2026-09-28)
 *        "The idempotency layer compares incoming parameters to those of the original request
 *        and errors if they're not the same"。原替身同键直接回缓存，于是"重试时 expires_at 重算
 *        → 参数变了"（KD-9）与"退款重试换了原因"（KD-4）在测试里都成功，在真 Stripe 上都会被拒。
 *      ② **退款只认 PaymentIntent**：@measured(docs.stripe.com/api/refunds/create, 2026-09-28)
 *        参数只有 `charge`（"The identifier of the charge to refund"）与 `payment_intent`
 *        （"The identifier of the PaymentIntent to refund"），传入无效标识会 "Raises an error"。
 *        原替身只查"带没带 payment_intent="，于是把 Checkout Session id（`cs_…`）当 PI 传过去（KD-11）
 *        在测试里退款成功，在真 Stripe 上每一笔都会失败。
 *
 *      ③ **退款有生命周期**（F-03，AJ-178）：@measured(docs.stripe.com/api/refunds/object, 2026-09-29)
 *        Refund.status ∈ pending / requires_action / succeeded / failed / canceled；
 *        @measured(docs.stripe.com/api/refunds/retrieve, 2026-09-29) `GET /v1/refunds/{id}` 取当前状态。
 *        同键重放回的是**首次响应的快照**（idempotent_requests："subsequent requests with the same key
 *        return the same result"），不是退款的当前状态——所以"重试 POST"永远等不到 pending 变成功，
 *        只有查询能。原替身所有退款恒为 succeeded，pending 这条死路在测试里不存在。
 *      ④ **一笔扣款只能被退满一次**：@measured(docs.stripe.com/error-codes, 2026-09-29)
 *        `charge_already_refunded`："The charge you're attempting to refund has already been refunded."
 *        同一 PI 上还有未失败（pending / requires_action / succeeded）的退款时，新键的退款被拒——
 *        于是"换了新键却没确认旧的已失败"这个缺陷会在测试里红，而不是悄悄退第二次。
 *
 * @limitation 一：幂等只模拟"同键同参回原结果 / 同键异参报错"，不模拟 24 小时窗口；
 *              同键异参的**状态码**文档没写明，这里取 400 + `idempotency_error`（未实测，凭记忆）——
 *              被测代码只需要"非 2xx 即失败"，不依赖具体状态码。
 * @limitation 一b：④ 里"被 pending 退款占住的扣款再退"真 Stripe 回的是 `charge_already_refunded`
 *              还是金额超限类错误，文档没写明（未实测）——被测代码只依赖"非 2xx 即失败"。
 * @limitation 二：不模拟其它错误码（402 卡被拒、429 限流）。
 *              需要时按用例单独造，不预先铺——铺了就会有人依赖上不存在的场景。
 * @limitation 三：`GET /v1/checkout/sessions/{id}` 回的会话一律带 `payment_intent`（等同"已付款"）；
 *              真 Stripe 在会话确认前该字段为 null（同一文档页示例 `"payment_intent": null`）——
 *              那条分支在适配器单测里用 `failNext` 单独造。
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
  /** 下一笔**新建**退款的初始状态（缺省 `succeeded`）：造 pending / failed 形态（F-03）。 */
  nextRefundStatus(status: string): void;
  /** 机构侧把某笔退款推进到新状态（模拟 pending → succeeded / failed 的异步完成）。 */
  settleRefund(refundId: string, status: string): void;
  /**
   * 设定会话的 `payment_status`（MP3-04：取消前"问机构一句"要读它）。缺省 `unpaid`
   * ——刚建的会话就是没付款，这是真实形态。
   * @why 单独给一个 setter 而不是让 GET 一律回某一种：这条查询的全部价值就在于
   *      **机构说了什么**会改变行为；固定回一种的替身等于把被测分支钉死在一支上。
   */
  setSessionPaymentStatus(sessionId: string, paymentStatus: string): void;
}

export function createFakeStripeHttp(): FakeStripeHttp {
  const calls: HttpRequest[] = [];
  /** idempotency-key → 已建的会话。 */
  const sessions = new Map<string, { id: string; url: string; expires_at: number }>();
  /** 会话 id → 会话（供 GET 反查 payment_intent）。 */
  const sessionsById = new Map<string, { id: string; url: string; expires_at: number }>();
  /** `路径|幂等键` → 首次请求体（同键异参检查，见文件头 @why ①）。 */
  const firstBodies = new Map<string, string>();
  /** 退款幂等键 → 首次响应体**快照**（同键重放回首次响应，不是退款的当前状态，见 @why ③）。 */
  const refunds = new Map<string, string>();
  /** 退款 id → 退款当前状态（GET 查询与 ④ 的"已退满"判定都读它）。 */
  const refundsById = new Map<
    string,
    { id: string; object: 'refund'; status: string; payment_intent: string }
  >();
  /** 会话 id → 机构侧的 `payment_status`（缺省 unpaid = 刚建还没付）。 */
  const sessionPaymentStatus = new Map<string, string>();
  let nextRefund = 1;
  let pendingInitialStatus: string | undefined;
  /** payment_intent id → metadata（create 时从表单抓 + givenPaymentIntent 手工登记）。 */
  const paymentIntents = new Map<string, Record<string, string>>();
  let nextId = 1;
  let forced: { status: number; body: string; headers: Record<string, string> } | undefined;
  /**
   * `路径|幂等键` → 首次 **5xx** 响应。
   * @why B3 / AJ-199：@measured(docs.stripe.com/api/idempotent_requests, 2026-09-29)
   *      "results are saved … including 500 … for 24 hours"——同键后续请求拿回的是**同一个 500**，
   *      不是"再试一次"。原替身的 `failNext` 只影响下一次，于是"首次 5xx → 再次发起"在测试里
   *      会成功，在真 Stripe 上会一直失败到订单过期（30 分钟）之后。
   * @limitation 只缓存 **5xx**：4xx（402 卡被拒 / 400 参数错）真 Stripe 的缓存口径文档没写明，
   *              且被测代码对 4xx 也不靠"换键"来恢复——不造没实测过的脾气。
   */
  const failuresByKey = new Map<
    string,
    { status: number; body: string; headers: Record<string, string> }
  >();

  const client: FakeStripeHttp = {
    calls,
    failNext(status, body = '{"error":{"message":"forced failure"}}') {
      // 5xx 一律回 `Stripe-Should-Retry: false`（B4 / AJ-200）：真 Stripe 只在
      // "这次故障值得再试"时才回 true；替身默认给 false，于是"重发 5xx"这条路
      // 在测试里走不通——正是生产上的真实形状（重发拿回的是缓存的同一个失败）。
      forced = {
        status,
        body,
        headers: status >= 500 ? { 'stripe-should-retry': 'false' } : {},
      };
    },
    givenPaymentIntent(id, metadata) {
      paymentIntents.set(id, metadata);
    },
    nextRefundStatus(status) {
      pendingInitialStatus = status;
    },
    settleRefund(refundId, status) {
      const r = refundsById.get(refundId);
      if (r === undefined) throw new Error(`替身里没有这笔退款：${refundId}`);
      r.status = status;
    },
    setSessionPaymentStatus(sessionId, paymentStatus) {
      sessionPaymentStatus.set(sessionId, paymentStatus);
    },
    async send(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      const path = new URL(req.url).pathname;
      const idemKey = req.headers?.['idempotency-key'] ?? '';
      // 同键的 5xx **先到先得**（见 failuresByKey 的 @why）：真 Stripe 会把它回放 ≥24 小时。
      // 放在 `forced` 之前——"上次已经失败过"比"这次要造一个失败"更接近机构的真实状态。
      if (req.method === 'POST' && idemKey.length > 0) {
        const cachedFailure = failuresByKey.get(`${path}|${idemKey}`);
        if (cachedFailure !== undefined) return { ...cachedFailure };
      }
      if (forced !== undefined) {
        const f = forced;
        forced = undefined;
        if (req.method === 'POST' && idemKey.length > 0 && f.status >= 500) {
          failuresByKey.set(`${path}|${idemKey}`, f);
        }
        return { status: f.status, body: f.body, headers: f.headers };
      }
      // 没带鉴权头就像真 Stripe 一样拒绝：否则"忘了带 key"这个缺陷永远测不出来
      const auth = req.headers?.['authorization'] ?? '';
      if (!auth.startsWith('Bearer ')) {
        return { status: 401, body: '{"error":{"message":"missing api key"}}' };
      }
      const body = req.body ?? '';
      // 同键异参 → 报错（文件头 @why ①）。GET 不带键，不进这条
      if (req.method === 'POST' && idemKey.length > 0) {
        const slot = `${path}|${idemKey}`;
        const first = firstBodies.get(slot);
        if (first !== undefined && first !== body) {
          return {
            status: 400,
            body: JSON.stringify({
              error: {
                type: 'idempotency_error',
                message: `Keys for idempotent requests can only be used with the same parameters they were first used with (key=${idemKey})`,
              },
            }),
          };
        }
        firstBodies.set(slot, body);
      }

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
        sessionsById.set(id, session);
        // 与真 Stripe 同口径：Session 会带一个 PaymentIntent，
        // 其 metadata 来自表单的 payment_intent_data[metadata][*]
        const form = new URLSearchParams(body);
        // ⚠️ **整段抓取**而不是只抓 `order_id`：真 Stripe 会把 PI 的 metadata 全量复制过去，
        //    只抓一个键的话，新加的键（如 B5 的 `source`）在替身里永远不存在——
        //    于是"反查 PI"这条链在测试里拿到的形状与生产不一致，
        //    表现为"生产多一个键、测试少一个键"这种最难查的分叉。
        const meta: Record<string, string> = {};
        for (const [k, v] of form) {
          const m = /^payment_intent_data\[metadata\]\[([^\]]+)\]$/.exec(k);
          if (m !== null) meta[m[1] ?? ''] = v;
        }
        if (Object.keys(meta).length > 0) {
          paymentIntents.set(`pi_for_${id}`, meta);
        }
        return { status: 200, body: JSON.stringify(session) };
      }

      // 会话反查（退款前把 Checkout Session 换成 PaymentIntent，KD-11）
      const sessionGet = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
      if (sessionGet !== null && req.method === 'GET') {
        const found = sessionsById.get(sessionGet[1] ?? '');
        if (found === undefined) {
          return { status: 404, body: '{"error":{"message":"No such checkout.session"}}' };
        }
        return {
          status: 200,
          body: JSON.stringify({
            ...found,
            object: 'checkout.session',
            payment_intent: `pi_for_${found.id}`,
            // MP3-04：取消前要读它。缺省 unpaid（刚建的会话就是这个形态），
            // 用例要造"已付但通知未达"时用 setSessionPaymentStatus 覆盖。
            payment_status: sessionPaymentStatus.get(found.id) ?? 'unpaid',
          }),
        };
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
        const pi = new URLSearchParams(body).get('payment_intent');
        if (pi === null) {
          return { status: 400, body: '{"error":{"message":"missing payment_intent"}}' };
        }
        // 只认 PaymentIntent（文件头 @why ②）：把会话号 cs_… 当 PI 传 = 真 Stripe 上"查无此 PI"
        if (!pi.startsWith('pi_')) {
          return {
            status: 400,
            body: JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'resource_missing',
                message: `No such payment_intent: '${pi}'`,
              },
            }),
          };
        }
        const key = req.headers?.['idempotency-key'] ?? '';
        const prior = key.length > 0 ? refunds.get(key) : undefined;
        if (prior !== undefined) return { status: 200, body: prior };
        // ④ 一笔扣款只能被退满一次：同 PI 上还有未失败的退款 → 拒
        const occupied = [...refundsById.values()].some(
          (r) => r.payment_intent === pi && r.status !== 'failed' && r.status !== 'canceled',
        );
        if (occupied) {
          return {
            status: 400,
            body: JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'charge_already_refunded',
                message: "The charge you're attempting to refund has already been refunded.",
              },
            }),
          };
        }
        const refund = {
          id: `re_test_${String(nextRefund).padStart(4, '0')}`,
          object: 'refund' as const,
          status: pendingInitialStatus ?? 'succeeded',
          payment_intent: pi,
        };
        pendingInitialStatus = undefined;
        nextRefund += 1;
        refundsById.set(refund.id, refund);
        const snapshot = JSON.stringify(refund);
        if (key.length > 0) refunds.set(key, snapshot);
        return { status: 200, body: snapshot };
      }

      // 退款状态查询（F-03）：回**当前**状态（与 POST 重放回的首次快照相对）
      const refundGet = /^\/v1\/refunds\/([^/]+)$/.exec(path);
      if (refundGet !== null && req.method === 'GET') {
        const found = refundsById.get(refundGet[1] ?? '');
        if (found === undefined) {
          return { status: 404, body: '{"error":{"message":"No such refund"}}' };
        }
        return { status: 200, body: JSON.stringify(found) };
      }

      return { status: 404, body: '{"error":{"message":"unknown path"}}' };
    },
  };
  return client;
}
