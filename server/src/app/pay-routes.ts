/**
 * 职责：支付相关的**两个路由**（F11 / ADR-28）——通道列表与统一回调分发。
 *
 * @why 这两个接口是"支付可插拔"这条承诺在 HTTP 层的兑现处：
 *      `GET /pay/channels` 让前端**不再写死支付方式**（加一个通道，前端自动多一个入口）；
 *      `POST /pay/callback/:channel` 让**新增通道不再新增路由**
 *      （旧写法是 `/pay/callback/wechat` 与 `/pay/callback/stripe` 各写一个，
 *       每加一种支付方式就要改路由文件——那正是 ADR-28 要消灭的"改代码才能加支付方式"）。
 *
 * @why 路由只做三件事：**取通道 → 让通道验签解析 → 交给统一管线**。
 *      它不认识任何机构（没有 `if (channel === 'stripe')`），
 *      判断抽象是否合格的标准就是这一条：加一个通道时本文件是否需要改动。
 *
 * @limitation 一：**不加登录态中间件**，这是**正确的设计而不是缺陷**——补记在此，因为
 *              "回调路由的中间件链里没有鉴权"容易被读成"回调没有鉴权"。
 *      · 机构服务器拿不到我们的 JWT，行业做法本来就是**用 HMAC 验签代替登录态**；
 *      · 本仓的验签**强制生效且无法绕过**：进入管线的**唯一**入口是
 *        `provider.parseWebhook(raw, headerBag(req))`（见下方第 2 段），它在任何业务处理、
 *        任何读库、任何落状态**之前**执行，失败即抛 `AppError(40103)`：
 *          – mock：`adapters/payment/mock.ts` 的 `parseWebhook` 做的是原始字节上的
 *            真 HMAC-SHA256 + `timingSafeEqual` 恒定时间比较；
 *          – stripe：`adapters/payment/stripe-checkout.ts` 的 `parseWebhook` 第一行
 *            就是 `verify(raw, headers[STRIPE_SIGNATURE_HEADER])`。
 *        `app/pay-callback.ts` 抬头亦已声明它只接受**已验签**的 `ProviderEvent`。
 *        所以给这条路由补一个 `requireAuth` 反而是**错的**：机构回调会被 401 全部挡掉。
 *      ⚠️ 代价（也是本条真正的约束）：**不鉴权 ⇒ 应答体必须零信息**
 *         ——`GET /pay/channels` 只返回通道名/入口形态/展示名；
 *         回调的应答体只有 `received` 与处置结果，不含金额、不含收件人（@limitation 四）。
 * @limitation 一·b：回调**受限流**（`deps.callbackLimiter`，装配处挂
 *              `rateLimitRules(config).publicWrite('pay.callback')`）。
 *      · 要防的不是"刷接口"——验签在前，刷了也落不了账——而是**告警/日志放大**：
 *        `SIGNATURE_MISCONFIG_REASONS` 把"带了格式正确的签名却对不上"升成 **error 级**
 *        （为了暴露密钥配错），于是这个匿名端点变成
 *        "一次请求 = 一条 error 级日志 = 一次 Sentry 上报"的放大器，不限流时它无上界。
 *      · @tradeoff 误伤的代价是**延迟**而不是漏单：429 对机构是**可重试**响应，
 *        而"回调可重试"正是本管线的设计前提（`early` / `inflight` 处置本来就回
 *        503 + `Retry-After` 让机构重发），机构按退避重投后仍能落账。
 *      · @limitation 它不会变成拒绝服务放大器：限流存储超 `RATE_LIMIT_MAX_KEYS` 时是
 *        **fail-open 驱逐**（adapters/rate-limit-memory.ts），被驱逐的 key 计数归零
 *        = 拿到更多配额。这与同样匿名、同样 30/分钟/IP 的 `GET /api/v1/orders/quote`
 *        是同一个暴露面，没有新增风险类别。
 * @limitation 二：`GET /pay/channels` 的三个查询参数**全部必填**（不给默认值）。
 *              "默认美国"就是把国家写死在服务端，正是 ADR-28 明令禁止的形态；
 *              而且默认值会让"前端忘了传"变成"看起来对但市场错了"，静默且难查。
 * @limitation 三：回调拿不到原始字节时抛 **50000** 而不是退化成空 Buffer。
 *              退化会让"路由忘了登记 rawBodyPaths"表现成**验签失败**——
 *              排查方向会指向密钥/机构，而真正的错误在我们自己的装配（http.ts @limitation 三）。
 *              这是我们的 bug，就该是 5xx（让机构重发 + 进告警），不是 4xx。
 * @limitation 四：**不落 `apply` 的结果到响应里**，也不把机构报文回显。
 *              机构报文含金额与个人信息，回显等于绕过脱敏（ADR-29 流 A 红线）。
 *
 * @see ports/payment.ts（通道与 Provider 契约）；app/pay-callback.ts（统一处理管线）；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §2.2；docs/地基搭建清单.md F11
 */
import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { paramId } from '../http.js';
import type { Logger } from '../logger.js';
import type { HeaderBag, PaymentRegistry } from '../ports/payment.js';
import type { WebhookStore } from '../ports/webhooks.js';
import { handleProviderCallback, type CallbackPipelineDeps } from './pay-callback.js';

/**
 * 回调路径**前缀**：必须登记到 `createHttpApp` 的 `rawBodyPaths`。
 * @why 导出常量而不是让调用方手拼字符串：`pathMatchesPrefix` 要求"前缀后恰好是分隔符"，
 *      手拼时漏一个 `/api/v1` 前缀就会静默退化成 JSON 解析（验签必然失败且不报明确错）。
 */
export const PAY_CALLBACK_PREFIX = '/api/v1/pay/callback';

/** 通道列表路径。 */
export const PAY_CHANNELS_PATH = '/api/v1/pay/channels';

/**
 * `GET /pay/channels` 的查询参数。
 *
 * @why 用 zod 而不是手判：这里三个参数每一个的"形状错了"都有真实的后果
 *      （`country=us` 小写会让所有通道被过滤掉 → 用户看到"没有可用支付方式"），
 *      而 zod 的错误会**一次列全**，符合本项目配置层既有的做法（@see config.ts）。
 * @why **不**用 shared 的 `CURRENCY` 枚举：币种过滤的语义是"这个通道支不支持"，
 *      用封闭枚举会让"临时支持一个币种"必须先改 shared 再发版——那是把通道的
 *      可插拔性又收回去了一半。形状约束（`^[A-Z]{3}$`）足够挡住脏输入。
 */
const ChannelsQuery = z.object({
  country: z.string().regex(/^[A-Z]{2}$/, 'country 必须是 ISO 3166-1 alpha-2 大写两位（如 US）'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency 必须是 ISO 4217 大写三位（如 JPY）'),
  amount_jpy: z.coerce.number().int().positive('amount_jpy 必须是正整数（JPY 整数円）'),
});

export interface PayRoutesDeps {
  registry: PaymentRegistry;
  webhooks: WebhookStore;
  logger: Logger;
  /** 回调早到宽限期（毫秒）。 */
  graceMs: number;
  /**
   * 回调入口的限流中间件（装配处按 `rateLimitRules(config).publicWrite('pay.callback')` 生成）。
   *
   * @why 必填而不是可选：这条路由**没有登录态**（见 @limitation 一），
   *      限流是它唯一一道"挡住无上界外部流量"的闸——做成可选等于允许装配时忘了挂，
   *      而忘了挂**不报错、不告警**，只能等 Sentry 配额被吃光才被发现
   *      （与 `linkLimiter` 同为公开入口，同口径）。
   */
  callbackLimiter: RequestHandler;
  /**
   * 按 outcome 注册的落账器，原样透传给回调管线。
   *
   * @why 这里**不重新定义**落账语义、也不在这里挑 outcome：路由层只做
   *      "验签 + 解析 + 交给管线"，落点由管线按注册表演（@see pay-callback.ts
   *      CallbackPipelineDeps.appliers）。路由里加一句 `if (outcome === ...)` 就等于
   *      把"哪些 outcome 有落点"变成两份，F12 接状态机时必漂。
   * @throws {AppError} 40400 / 40902（由管线做冲突分层）
   */
  appliers: CallbackPipelineDeps['appliers'];
}

/**
 * 把请求头收敛成 `HeaderBag`（key 一律小写，重复头取第一个）。
 *
 * @why 验签方读签名头必须**大小写不敏感**：Node 已经把入站头名转成小写，
 *      但 `req.headers` 的类型里值可能是 `string[]`（如重复的 `cookie`），
 *      直接当成字符串传给 HMAC 会得到 `[object Array]` 之类的内容 → 验签恒失败。
 * @limitation **不记录**这些头：头里可能有 `stripe-signature`、`authorization`，
 *              属于密钥类内容（ADR-29 脱敏红线），本函数只在内存里传递它们。
 */
function headerBag(req: Request): HeaderBag {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** 取回调的原始字节；拿不到就是我们的装配错（@limitation 三）。 */
function rawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  throw new AppError(50000, {
    reason: `回调路由未登记到 rawBodyPaths（${PAY_CALLBACK_PREFIX}）：拿不到原始字节，无法验签`,
    ctx: { http_path: req.path },
  });
}

/**
 * 验签失败里"像配置错误"的那几类（第三轮缺口 P1-1）：签名头齐全、格式正确，只是算出来对不上 / 时刻过期。
 * @limitation reason 由各适配器给；新增通道时把它的同类 reason 加进来，否则只会 warn。
 */
const SIGNATURE_MISCONFIG_REASONS: ReadonlySet<string> = new Set([
  'stripe_signature_mismatch',
  'stripe_timestamp_expired',
  'mock_signature_mismatch',
]);

export function mountPayRoutes(app: Express, deps: PayRoutesDeps): void {
  /**
   * ── 1. 可用通道列表（前端入口的唯一来源）─────────────────────────────────
   * @why 前端**据此渲染**支付方式，不再写死"微信支付 / 银行卡"两个按钮：
   *      下线一个通道 → 配置一改，这里就不返回它 → 前端自动不显示（不发版）；
   *      上线一个新通道 → 同理自动出现。`entryMode` 决定前端是"直接调起"还是"复制链接"。
   */
  app.get(PAY_CHANNELS_PATH, (req, res, next) => {
    void (async () => {
      try {
        const parsed = ChannelsQuery.safeParse(req.query);
        if (!parsed.success) {
          // 一次列全（与配置层同做法），避免调用方改一个参数重启一次
          throw new AppError(40001, {
            reason: 'pay/channels 查询参数不合法',
            ctx: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
          });
        }
        const items = deps.registry.listAvailable({
          destCountry: parsed.data.country,
          currency: parsed.data.currency,
          amountJpy: parsed.data.amount_jpy,
        });
        deps.logger.info('pay_channels_listed', {
          result: 'ok',
          ctx: {
            country: parsed.data.country,
            currency: parsed.data.currency,
            amount_jpy: parsed.data.amount_jpy,
            count: items.length,
          },
        });
        // ⚠️ 只回视图（channel / entryMode / label / icon），不带任何机构配置或密钥
        res.json({ items });
      } catch (e) {
        next(e);
      }
    })();
  });

  /**
   * ── 2. 统一回调分发 ────────────────────────────────────────────────────
   * 三个动作：取通道 → 验签解析（通道自己的事）→ 交给统一管线（所有通道共有的事）。
   *
   * @why 用 `getForCallback` 而不是 `get`：**被下线的通道，其在途支付的回调仍必须能被处理**。
   *      用 `get()` 的后果是"每下线一个通道，就静默吞掉一批已付款订单"，
   *      详见 ports/payment.ts 上 `getForCallback` 的 @why。
   * @why 限流**先于**验签：超限的请求不该再花力气算 HMAC。被限流的请求没有
   *      登记行、没有落账（幂等与宽限期都不受影响），机构看到 429 会按退避重投——
   *      与管线自己的 503 + `Retry-After` 是同一套重发模型。
   */
  app.post(`${PAY_CALLBACK_PREFIX}/:channel`, deps.callbackLimiter, (req, res, next) => {
    void (async () => {
      try {
        const channel = paramId(req.params.channel);
        const raw = rawBody(req);
        const provider = deps.registry.getForCallback(channel);
        // 验签与解析是**通道自己的事**：路由不认识任何机构的报文格式
        const event = await provider.parseWebhook(raw, headerBag(req));
        const outcome = await handleProviderCallback(
          {
            webhooks: deps.webhooks,
            logger: deps.logger,
            graceMs: deps.graceMs,
            appliers: deps.appliers,
          },
          channel,
          raw,
          event,
        );
        deps.logger.info('pay_callback_handled', {
          order_id: event.orderId,
          channel,
          result: outcome.disposition,
          ctx: { event_id: event.eventId, raw_type: event.rawType, http_status: outcome.status },
        });
        if (outcome.retryAfter !== undefined) res.set('retry-after', String(outcome.retryAfter));
        res.status(outcome.status).json(outcome.body);
      } catch (e) {
        // 第三轮缺口 P1-1（AJ-385）：报文**带着格式正确的签名却对不上**（或签名时刻过期）——
        // 这是"webhook 密钥配错 / 端点 URL 指向了错的环境"的典型症状，而这类事故是**静默**的：
        // 机构判投递失败、几天后放弃，买家付了钱订单却过期。40103 默认 warn 级不进 Sentry，这里单独升 error。
        // 缺签名 / 签名格式坏的不升级：那是扫描器乱打，升级只会制造告警噪声。
        if (e instanceof AppError && e.code === 40103) {
          // Object(...)：details 缺失时得到空对象而不是抛错（读不到 reason → 'undefined'，不在名单里 → 只 warn）
          const reason = String((Object(e.details) as { reason?: unknown }).reason);
          if (SIGNATURE_MISCONFIG_REASONS.has(reason)) {
            deps.logger.error('callback_signature_rejected', {
              result: 'rejected',
              ctx: { channel: String(req.params.channel), reason },
            });
          }
        }
        next(e);
      }
    })();
  });
}
