/**
 * 职责：L3 端到端测试的公共装配（F6c / F11）——起一个"什么都真"的骨架服务。
 *
 * @why 每个 e2e 文件都自己拼一遍 logger/app/db，就会出现"这个文件少配了 rawBodyPaths"，
 *      而它偏偏还能通过——因为那个文件根本没测回调。装配只有一处，少配的代价立刻在所有文件显现。
 *
 * 真实的东西：真端口、真库、真事务、真 JWT、真 HMAC 验签、真 pino 序列化。
 * 假的只有支付机构本身（骨架期应当如此，F11 换成 Stripe 真实验签）。
 *
 * @why 装配处**同时**挂骨架与支付路由：模拟回调现在是"注册表里的 `mock` 通道"，
 *      走的就是与真实通道完全相同的那条统一分发路径（`/pay/callback/:channel`）。
 *      这样端到端测试覆盖的不是"骨架自己的那条路"，而是**生产会走的那条路**——
 *      这是把模拟回调迁出骨架换来的最大收益。
 *
 * @limitation `withRawBody` 默认 **true**。回调验签依赖未经解析的原始字节，
 *              "配错"时的症状是验签永远失败，排查会误导向密钥/机构——
 *              所以 `skeleton.e2e.test.ts` 里有一条专门的断链用例把它钉住。
 * @limitation 二：**注册表是手工装配的**（`mockRegistry`），刻意绕过生产装配函数
 *              `buildPaymentRegistry`（换来轻量与可控时钟）。这意味着"配置 → 装配"
 *              这一段的改动在本层**测不到**——该接缝由 `server/src/main.db.test.ts`
 *              的「配置驱动的通道下线」describe（真 bootstrap）兜底，见
 *              `docs/测试策略与验证门禁.md` §3.3 链路覆盖矩阵第一行。
 *              新增"harness 绕过生产逻辑"的捷径时，必须同步检查矩阵里有没有对应行。
 */
import { createHmac } from 'node:crypto';
import { signToken, type AuthConfig } from '../../server/src/app/auth.js';
import { markOrderPaid } from '../../server/src/app/mark-paid.js';
import type { Db } from '../../server/src/adapters/db.js';
import { createHttpApp, listen, type StartedServer } from '../../server/src/http.js';
import { createLogger } from '../../server/src/logger.js';
import { mountSkeleton } from '../../server/src/skeleton.js';
import { mountPayRoutes, PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { createWebhookStore } from '../../server/src/adapters/webhooks.js';
import { createIdempotencyExecutor } from '../../server/src/adapters/idempotency.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import { createPaymentRegistry } from '../../server/src/adapters/payment/registry.js';
import { createMockProvider } from '../../server/src/adapters/payment/mock.js';
import { createStripeCheckoutProvider } from '../../server/src/adapters/payment/stripe-checkout.js';
import type { HttpClient } from '../../server/src/ports/http-client.js';
import { systemIdGen } from '../../server/src/adapters/ids.js';
import type { IdGen } from '../../server/src/ports/ids.js';
import { registerBusinessEventLog } from '../../server/src/app/business-events.js';
import { MemorySink } from '../helpers/memory-sink.js';
import { fixedClock } from '../helpers/fixed-clock.js';

export const E2E_AUTH: AuthConfig = { secret: 'e2e-jwt-secret-'.repeat(3), issuer: 'waselect-e2e' };
/** 模拟回调的 HMAC 密钥：也是注册表里 `mock` 通道的 `options.secret`。 */
export const E2E_CALLBACK_SECRET = 'mock-callback-secret';
/** 全程只用一个链路 ID，便于断言"几跳日志是同一条链"。 */
export const E2E_TRACE = 'e2e-trace-0001';
export const E2E_USER = 'u-e2e';

/**
 * e2e 的"现在"：**固定值**，且刻意远离真实今天。
 *
 * @why 时钟一旦固定，单号的日期段就成了**可断言的常量**——
 *      端到端层面因此能证明"业务真的用了装配处注入的那个时钟"，
 *      而不是某处偷偷 `new Date()`（那种写法在真实时间下测不出来）。
 * @why 选 `2026-01-02T15:30:00Z` 这个时刻：它刚过 JST 跨日点（UTC 15:00），
 *      UTC 日与本机的本地日都还是 01-02，只有 JST 已经是 01-03——
 *      于是"用错时区"和"用了注入时钟之外的时钟"两种错法都会立刻变红。
 */
export const E2E_NOW = '2026-01-02T15:30:00.000Z';
/**
 * `E2E_NOW` 对应的单号日期段（JST `YYMMDD`）。
 *
 * ⚠️ 刻意写成**字面量**而不是再调一次 `jstDateShort()`：
 *    后者等于"用被测的函数去算期望值"，函数算错了测试照样绿。
 */
export const E2E_ORDER_NO_DATE = '260103';

/** mock 通道在注册表里的配置（e2e 装配用）。 */
export const E2E_MOCK_CHANNEL = 'mock';
/** stripe 通道的 endpoint 密钥（e2e 装配用；形状仿 `whsec_...`，值本身是测试假数据）。 */
export const E2E_STRIPE_WHSEC = 'whsec_e2e_test_secret';

export interface SkeletonServer {
  server: StartedServer;
  /** 形如 `http://127.0.0.1:<port>` */
  base: string;
  sink: MemorySink;
}

/**
 * 造 e2e 注册表；`stripeHttp` 提供时**额外**注册 stripe 通道（验签走真 HMAC，
 * 出站调用走传入的替身——通常是 test/helpers/fake-stripe-http.ts 的"有脾气的假实现"）。
 *
 * @param enabled mock 通道是否启用（= 通道配置里的 `enabled`）。传 false 即"该通道已下线"，
 *                用于验证"下线后入口消失、但老单回调仍能落账"。
 */
function mockRegistry(
  enabled: boolean,
  idGen: IdGen,
  now: string,
  stripeHttp?: HttpClient,
): ReturnType<typeof createPaymentRegistry> {
  const configs = [
    {
      channel: E2E_MOCK_CHANNEL,
      enabled,
      priority: 10,
      countries: ['*'],
      currencies: ['JPY'],
      label: '模拟支付',
      options: { secret: E2E_CALLBACK_SECRET },
    },
    ...(stripeHttp !== undefined
      ? [
          {
            channel: 'stripe',
            enabled: true,
            priority: 20,
            countries: ['*'],
            currencies: ['JPY', 'USD'],
            label: '银行卡',
            options: {
              secretKey: 'sk_test_e2e_fake',
              webhookSecret: E2E_STRIPE_WHSEC,
              successUrl: 'https://checkout.e2e.example/pay/done',
              cancelUrl: 'https://checkout.e2e.example/pay/cancelled',
            },
          },
        ]
      : []),
  ];
  const registry = createPaymentRegistry({ configs });
  registry.register(E2E_MOCK_CHANNEL, (cfg) =>
    createMockProvider(cfg, { clock: fixedClock(now), idGen }),
  );
  if (stripeHttp !== undefined) {
    registry.register('stripe', (cfg) =>
      createStripeCheckoutProvider(cfg, { http: stripeHttp, clock: fixedClock(now), idGen }),
    );
  }
  return registry;
}

export async function startSkeleton(
  db: Db,
  opts: {
    withRawBody?: boolean;
    graceMs?: number;
    now?: string;
    idGen?: IdGen;
    /** mock 通道是否启用（默认启用）；false = 模拟"通道已下线"。 */
    mockEnabled?: boolean;
    /** 提供则注册 stripe 通道（真 HMAC 验签，出站走这个替身）。 */
    stripeHttp?: HttpClient;
  } = {},
): Promise<SkeletonServer> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  const now = opts.now ?? E2E_NOW;
  const idGen = opts.idGen ?? systemIdGen;
  const app = createHttpApp({
    logger,
    rawBodyPaths: (opts.withRawBody ?? true) ? [PAY_CALLBACK_PREFIX] : [],
    silentPaths: ['/healthz'],
    mount: (a) => {
      // 与生产同一条装配路径：总线与订阅者都在装配处接好（不复制一份"测试专用总线"）
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);

      // ── 支付路由（F11 统一分发）：模拟回调走的就是真实通道那条路 ───────────
      mountPayRoutes(a, {
        registry: mockRegistry(opts.mockEnabled ?? true, idGen, now, opts.stripeHttp),
        webhooks: createWebhookStore(db),
        logger,
        graceMs: opts.graceMs ?? 900_000,
        apply: async (e) => markOrderPaid(db, events, fixedClock(now), e.orderId),
      });

      // env 显式给 development：骨架在 production 下会拒绝挂载（SEC2 闸门），装配处必须回答一次
      mountSkeleton(a, {
        db,
        // 幂等执行器：与生产同一条装配路径（实现在装配处注入，业务侧只见端口）
        idempotency: createIdempotencyExecutor(db),
        events,
        // 与生产同一条装配路径：生产注入 systemClock，这里注入固定时钟。
        // 业务代码不知道自己拿到的是哪一个——这正是"时间可测"的落点。
        clock: fixedClock(now),
        // 默认用真实 IdGen（e2e 多数用例要建多张单，固定 id 会撞唯一约束）；
        // 需要"断言 id 就是某个值"的用例显式传 `idGen`（见 stubIdGen 的 @limitation）
        idGen,
        logger,
        auth: E2E_AUTH,
        env: 'development',
      });
    },
  });
  const server = await listen(app);
  return { server, base: `http://127.0.0.1:${server.port}`, sink };
}

/** 签发一个骨架用的用户 token。 */
export function userToken(sub: string = E2E_USER): Promise<string> {
  return signToken({ sub, role: 'user' }, E2E_AUTH);
}

/** 按 mock 通道的约定给回调报文签名（HMAC-SHA256 hex）。 */
export function signMockCallback(body: string, secret: string = E2E_CALLBACK_SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}
