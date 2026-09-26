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
 * @limitation 一：**不鉴权**。通道列表是公开配置（与 `/terms` / `/fx` 同级），
 *              回调来自机构服务器、它拿不到我们的用户 token。
 *              ⚠️ 因此本路由**绝不能**泄露任何订单信息：
 *                 `GET /pay/channels` 只返回通道名/入口形态/展示名；
 *                 回调的应答体只有 `received` 与处置结果，不含金额、不含收件人。
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
import type { Express, Request } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { paramId } from '../http.js';
import type { Logger } from '../logger.js';
import type { HeaderBag, PaymentRegistry, ProviderEvent } from '../ports/payment.js';
import type { WebhookStore } from '../ports/webhooks.js';
import { handleProviderCallback } from './pay-callback.js';

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
   * 把"支付成功"落到业务状态上。第二个参数是回调来自的通道（落账核对要用，见 pay-callback）。
   * @throws {AppError} 40400 / 40902（由管线做冲突分层）
   */
  apply: (event: ProviderEvent, channel: string) => Promise<void>;
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
   */
  app.post(`${PAY_CALLBACK_PREFIX}/:channel`, (req, res, next) => {
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
            apply: deps.apply,
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
        next(e);
      }
    })();
  });
}
