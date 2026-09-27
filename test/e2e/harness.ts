/**
 * 职责：L3 端到端测试的公共装配（F6c / F11）——起一个"什么都真"的服务。
 *
 * @why 每个 e2e 文件都自己拼一遍 logger/app/db，就会出现"这个文件少配了 rawBodyPaths"，
 *      而它偏偏还能通过——因为那个文件根本没测回调。装配只有一处，少配的代价立刻在所有文件显现。
 *
 * 真实的东西：真端口、真库、真事务、真 JWT、真 HMAC 验签、真 pino 序列化。
 * 假的只有支付机构本身（mock 通道 + stripe 出站替身）。
 *
 * @why 装配处挂的是**支付路由**（统一分发 `/pay/callback/:channel`）：模拟回调走的就是
 *      与真实通道完全相同的那条路——端到端测试覆盖的是**生产会走的那条路**。
 *      （U6c 之前这里还挂骨架端点做造单工具；骨架退役后造单改插库/业务端点，
 *      本装配只剩"生产形态"的部分。）
 *
 * @limitation `withRawBody` 默认 **true**。回调验签依赖未经解析的原始字节，
 *              "配错"时的症状是验签永远失败，排查会误导向密钥/机构——
 *              所以 `pay-callback-pipeline.e2e.test.ts` 里有一条专门的断链用例把它钉住。
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
import { mountPayRoutes, PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { createWebhookStore } from '../../server/src/adapters/webhooks.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import type { EventBus } from '../../server/src/ports/events.js';
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

export interface E2EServer {
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
  // ⚠️ 下面两份通道配置的 priority/icon/label 必须与生产装配（channels.ts 的
  //    CHANNEL_DEFAULTS）**逐字对齐**——本文件是"第二份手写值"，漂移过一次（2026-09-25：
  //    mock 缺 icon，pay-channels.e2e 一直在与生产不一致的形状上断言全绿，被
  //    main.db.test.ts 的链路用例当场抓红）。对齐由该文件的 icon 断言反向钉住。
  const configs = [
    {
      channel: E2E_MOCK_CHANNEL,
      enabled,
      priority: 90,
      countries: ['*'],
      currencies: ['JPY'],
      label: '模拟支付',
      icon: 'flask',
      options: { secret: E2E_CALLBACK_SECRET },
    },
    ...(stripeHttp !== undefined
      ? [
          {
            channel: 'stripe',
            enabled: true,
            priority: 20,
            countries: ['*'],
            currencies: ['USD'],
            label: '银行卡',
            icon: 'card',
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

export async function startApp(
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
    /**
     * 在装配处追加订阅者（与生产同一条路：`registerBusinessEventLog` 之后、路由挂载之前）。
     * @why 链路用例要验"回调 → 落账 → 提交后分发 → 订阅者失败"的接缝，订阅者必须挂在
     *      **真实那条总线**上，而不是测试里另造一条。
     */
    subscribe?: (events: EventBus) => void;
  } = {},
): Promise<E2EServer> {
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
      opts.subscribe?.(events);

      // ── 支付路由（F11 统一分发）：模拟回调走的就是真实通道那条路 ───────────
      mountPayRoutes(a, {
        registry: mockRegistry(opts.mockEnabled ?? true, idGen, now, opts.stripeHttp),
        webhooks: createWebhookStore(db),
        logger,
        graceMs: opts.graceMs ?? 900_000,
        // 与生产同一条落账路径（含通道/金额核对，三审 S1② / U1）：
        //    落账必须带"钱是怎么来的"——少传就编译不过，想在 e2e 里跳过核对
        //    没有这条路（mark-paid.ts PaidSettlement 的 @why）
        apply: async (e, channel) =>
          markOrderPaid(db, events, fixedClock(now), e.orderId, {
            channel,
            providerRef: e.providerRef,
            amountMinor: e.amountMinor,
            currency: e.currency,
          }),
      });
    },
  });
  const server = await listen(app);
  return { server, base: `http://127.0.0.1:${server.port}`, sink };
}

/** 签发 e2e 用户 token（直接签，不走登录端点——登录链路有自己的测试）。 */
export function userToken(sub: string = E2E_USER): Promise<string> {
  return signToken({ sub, role: 'user' }, E2E_AUTH);
}

/** 按 mock 通道的约定给回调报文签名（HMAC-SHA256 hex）。 */
export function signMockCallback(body: string, secret: string = E2E_CALLBACK_SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}
