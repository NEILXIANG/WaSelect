/**
 * 职责：把**配置**装配成**支付注册表**（F11 / ADR-28 的装配处）。
 *
 * @why 这一层单独存在，是为了让"开通一个通道"这件事只剩两个动作：
 *      ① 配置里加一个通道名（`PAYMENT_CHANNELS`）；
 *      ② 在这里注册它的工厂（一行 `registry.register(...)`）。
 *      业务代码、路由、`/pay/channels` 全都**不需要改**——这就是可插拔的兑现形式。
 *
 * @why 放在 `adapters/`：它**知道**有哪些具体 Provider（谁实现了什么），
 *      这正是适配器层的职责；业务只见 `ports/payment.ts` 的 `PaymentRegistry` 接口。
 *
 * @limitation 一：**通道的默认属性（优先级 / 国家 / 币种 / 展示名）目前是内置表**。
 *              这是 ADR-28 明令要消灭的形态（"禁止写死国家"），但现在还没有
 *              `payment_channels` 表可查，硬凑一个接口只会写出一个假的配置源。
 *              ⚠️ 所以这张表被刻意写得**很小、很显眼**，并且只服务两件事：
 *              排序与展示；真正的"开不开放"来自 `PAYMENT_CHANNELS`（配置，非代码）。
 *              @todo R2-4（`payment_channels` 表落地后改为读表，本文件退化为 seed/回退）
 *              @limitation 一·续：在这之前，改一个国家/币种要改代码并发版——这是已知债务，不是设计。
 * @limitation 二：**配置里有、代码里没注册的通道静默跳过**。
 *              这不是宽容：配置可以比代码先行（先关掉、后删代码），
 *              否则"配置里留着旧通道名"会让服务起不来，而删配置与删代码的节奏本就不同步。
 *              ⚠️ 代价：拼错通道名不会报错，只表现为"这个通道从来没出现过"——
 *              所以启动日志会打印最终生效的通道清单（见 `describeChannels`）。
 * @limitation 三：**"下线"≠"删配置"**（二次审查 P1-NEW-1 修复后的语义）。
 *              把通道名从 `PAYMENT_CHANNELS` 删掉 = 停止接**新单**（`enabled=false`），
 *              但只要凭据还在，工厂照样注册——该通道**在途订单的回调与退款不受影响**
 *              （`getForCallback` / `getForRefund` 不拦禁用通道，这是它们的存在意义）。
 *              曾经的形态是"删配置 → 配置条目整个消失 → 在途回调在验签前被 40001 拒掉、
 *              `webhook_events` 零留痕"，把"禁用不拦回调"的设计承诺架空了。
 *              ⚠️ 例外：mock 只有在**显式配置了密钥**时才会在未列出状态下注册——
 *              开发占位密钥是公开值，未列出还注册 = 给伪造回调开门（P3-7 同源）。
 * @limitation 四：Stripe 的 `successUrl / cancelUrl` 由 `CHECKOUT_BASE_URL` 拼出
 *              （`/pay/done` 与 `/pay/cancelled`）。两张静态页**已建**（F15 / AJ-82：
 *              `checkout-static/pay/` 三张状态页 + 构建期生成 `_redirects`，路径对齐由
 *              `STRIPE_RETURN_PATHS` 同源断言钉住）——此处仅说明 URL 的拼出来源。
 *              ⚠️ 唯一未经实测的是 **CF Pages `_redirects` 对查询串的保留行为**（L4 项）：
 *              短链 `/o/:id?t=…` 的 token 在查询串里，平台若丢查询串则回跳链断——
 *              已登记地基清单，首次部署 CF Pages 时必须验证。
 *
 * @see ports/payment.ts；adapters/payment/registry.ts；docs/地基搭建清单.md F11；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §2.2
 */
import type { AppConfig } from '../../config.js';
import type { Clock } from '../../ports/clock.js';
import type { HttpClient } from '../../ports/http-client.js';
import type { IdGen } from '../../ports/ids.js';
import type { ChannelConfig, PaymentRegistry } from '../../ports/payment.js';
import { createPaymentRegistry } from './registry.js';
import { createMockProvider } from './mock.js';
import { createStripeCheckoutProvider } from './stripe-checkout.js';

/**
 * 通道的**默认属性**（@limitation 一：临时内置表，待 `payment_channels` 表取代）。
 *
 * @why `priority` 小者优先：微信支付是我们唯一能在小程序内直接调起的通道（D-15），
 *      通过率最高、也最符合用户在微信内的预期，所以排第一；银行卡是覆盖"没有大陆钱包"
 *      用户的第二路径（D-49），排第二；mock 只在审核 / 本地演示用，垫底。
 */
const CHANNEL_DEFAULTS: Readonly<
  Record<string, Pick<ChannelConfig, 'priority' | 'countries' | 'currencies' | 'label' | 'icon'>>
> = {
  wechat: {
    priority: 10,
    countries: ['*'],
    currencies: ['JPY'],
    label: '微信支付',
    icon: 'wechat',
  },
  stripe: { priority: 20, countries: ['*'], currencies: ['USD'], label: '银行卡', icon: 'card' },
  mock: { priority: 90, countries: ['*'], currencies: ['JPY'], label: '模拟支付', icon: 'flask' },
};

/**
 * 未被 {@link CHANNEL_DEFAULTS} 收录的通道用它兜底（新增通道不会因为漏登记就消失）。
 *
 * @tradeoff `currencies: ['*']` 意味着"任何币种查询都匹配"——对新通道是**乐观默认**
 *           （先让它出现，长得朴素也比消失强），代价是可能出现在机构实际做不到的币种下
 *           （二次审查 P2-18）。兜底只在"配置里有、默认表没有"的过渡态生效，
 *           被 CHANNEL_DEFAULTS 收录的通道走声明值，并由注册表的
 *           "配置币种 ⊆ 能力币种"断言守着（P3-2），所以风险面只有过渡态这一段。
 */
const FALLBACK_DEFAULT = {
  priority: 100,
  countries: ['*'],
  currencies: ['*'],
  label: '其他支付方式',
} as const;

export interface ChannelAssemblyDeps {
  /** 出网 HTTP（Stripe 用）；带超时（@see ports/http-client.ts 的 @why）。 */
  http: HttpClient;
  clock: Clock;
  idGen: IdGen;
}

/**
 * 列出**配置里写了**的通道名（进启动日志的 `configured` 字段）。
 *
 * @why 配置拼错 / 密钥缺失导致的"通道没注册"是静默的（@limitation 二），
 *      唯一能让它在**上线当天**而不是"用户说没有支付入口"那天被发现的手段，
 *      就是启动时把 configured 与 registered **两个清单一起**打出来对照——
 *      只打 configured 等于没打（曾经就是这个形态：日志事件名叫
 *      `payment_channels_registered`，内容却是配置清单，密钥缺失照样"一切正常"）。
 */
export function describeChannels(config: AppConfig): string[] {
  return [...config.PAYMENT_CHANNELS];
}

/** 装配产物：注册表 + 两个清单（与配置清单对照，差集各有含义，见各字段注释）。 */
export interface PaymentAssembly {
  registry: PaymentRegistry;
  /**
   * 实际注册了工厂的通道。`configured − registered` = 被静默跳过的：wechat 未实现 /
   * stripe 密钥不全 / 未知通道。启动日志必须把它与 configured 并列（见 `describeChannels` 的 @why）。
   */
  registered: string[];
  /**
   * **已下线但仍保留回调/退款能力**的通道（`registered − configured`）：
   * 凭据还在所以工厂注册了，但不在 `PAYMENT_CHANNELS` 里（`enabled=false`，不接新单）。
   * 这份清单必须在启动日志里可见——"下线通道的在途订单还活着"是运营事实，不该静默。
   */
  offline: string[];
}

/**
 * 按配置装配注册表。
 *
 * 语义（二次审查 P1-NEW-1 修复后）：
 *  - `enabled` = 通道名是否在 `PAYMENT_CHANNELS` 里（**配置是新单的唯一开关**）；
 *  - 工厂**凭据齐全就注册**，与是否列出无关——所以"下线"（从列表删除）只停新单，
 *    在途订单的回调与退款照常（@limitation 三）。
 *
 * @throws {Error} 配置重复 / 工厂自报 channel 与注册键不一致 / 声明与实现不符（注册期不变式）
 */
export function buildPaymentRegistry(
  config: AppConfig,
  deps: ChannelAssemblyDeps,
): PaymentAssembly {
  const stripeReady =
    config.STRIPE_SECRET_KEY !== undefined &&
    config.STRIPE_WEBHOOK_SECRET !== undefined &&
    config.CHECKOUT_BASE_URL !== undefined;
  // mock 的注册条件见 @limitation 三：列出（开发/审核期正常用）或显式配了密钥
  // （未列出但显式配密钥 = 运营有意保留在途回调）。只占位密钥时不注册——公开值不能开门。
  const listed = new Set<string>(config.PAYMENT_CHANNELS);
  // ⚠️ 生产**不适用**"未列出但有密钥 → 保留回调"（三审 S1）：mock 的在途订单只可能是审核期测试单，
  //    没有值得保留的回调；保留的只是一扇"持密钥者可伪造支付成功"的门。config 规则 1b 已在启动期
  //    拒绝这种组合，本处是第二道防线（两道都在，因为它是"能改订单状态的门"）。
  const mockRegistered =
    listed.has('mock') ||
    (config.NODE_ENV !== 'production' && config.MOCK_CALLBACK_SECRET !== undefined);

  const names = new Set<string>(listed);
  if (mockRegistered) names.add('mock');
  if (stripeReady) names.add('stripe');

  const configs: ChannelConfig[] = [...names].map((channel) => {
    const base = CHANNEL_DEFAULTS[channel] ?? FALLBACK_DEFAULT;
    return {
      channel,
      // 在 `PAYMENT_CHANNELS` 里出现 = 开放新单；不在 = 只保留在途订单的回调/退款（@limitation 三）
      enabled: listed.has(channel),
      ...base,
      options: optionsFor(channel, config),
    };
  });

  const registry = createPaymentRegistry({ configs });
  const registered: string[] = [];

  // ── mock：骨架期 / 审核期的假通道（真实 HMAC 验签，密钥来自配置）─────────────
  if (mockRegistered) {
    registry.register('mock', (cfg) =>
      createMockProvider(cfg, { clock: deps.clock, idGen: deps.idGen }),
    );
    registered.push('mock');
  }

  /**
   * ── stripe：三要素齐全就注册（与是否列出无关，见本函数头注释的语义）────────
   * @why 工厂在 `options` 不全时会抛（密钥缺失 = 任何人都能伪造回调，必须响亮失败）。
   *      而 `listAvailable` 会**构造**每个已启用通道的 Provider——
   *      若在这里无条件注册 stripe 工厂，本地没配 Stripe 密钥时
   *      `GET /pay/channels` 会整体 500（一个坏通道拖垮整个支付入口）。
   *      所以"能不能构造"必须先于"要不要开放"被判断。
   */
  if (stripeReady) {
    registry.register('stripe', (cfg) =>
      createStripeCheckoutProvider(cfg, { http: deps.http, clock: deps.clock, idGen: deps.idGen }),
    );
    registered.push('stripe');
  }

  // wechat：R1（日本收单机构事前相談）通过前没有实现 → 配置里写了也只是静默跳过
  const offline = registered.filter((c) => !listed.has(c));
  return { registry, registered, offline };
}

/**
 * Stripe 回跳路径（checkout-static 静态站上的两张页）。
 * @why 导出成常量是**单一来源**：静态站那边必须有同名的两张页，
 *      缺了的表现是「用户付完款落到 404，而回调照样落账」（钱收了、页面挂了）。
 *      两边的对齐由 `scripts/checkout-build-lib.unit.test.ts` 断言钉住。
 */
export const STRIPE_RETURN_PATHS = { success: '/pay/done', cancel: '/pay/cancelled' } as const;

/** 通道私有配置（密钥等；**禁止进日志**——它们只存在于 cfg.options 里）。 */
function optionsFor(channel: string, config: AppConfig): Readonly<Record<string, unknown>> {
  if (channel === 'mock') {
    return {
      // 与 main.ts 原先的回落值保持一致：开发与测试环境可以不配；
      // 生产启用 mock 时 config.ts 的跨字段规则已强制必须显式配置（见 config.ts）
      secret: config.MOCK_CALLBACK_SECRET ?? 'dev-mock-callback-secret-do-not-use-in-prod',
    };
  }
  if (channel === 'stripe') {
    const base = config.CHECKOUT_BASE_URL ?? '';
    return {
      secretKey: config.STRIPE_SECRET_KEY ?? '',
      webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? '',
      // successUrl/cancelUrl 指向 checkout-static 的两张状态页（已建，AJ-82）；
      // 路径与静态页清单的对齐由 checkout-build-lib 同源断言钉住，这里只负责拼 URL
      successUrl: `${base}${STRIPE_RETURN_PATHS.success}`,
      cancelUrl: `${base}${STRIPE_RETURN_PATHS.cancel}`,
    };
  }
  return {};
}
