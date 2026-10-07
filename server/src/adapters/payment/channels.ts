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
 * @limitation 一：**通道的默认属性有两个来源，`payment_channels` 表优先**（R2-4 已接线，AJ-379）。
 *              ① `payment_channels` 表（迁移 010 建表 + seed，`adapters/payment-channel-config.ts` 读）——**运行期真源**，
 *                 改排序 / 国家 / 币种 / 文案改数据即可，不发版；
 *              ② {@link CHANNEL_DEFAULTS}（本文件内置常量）——退化为**表的 seed 真源与回退值**，
 *                 只在"表里没有这一行"时生效（表里少一行 = 静默回退，所以回退必须可见，见 `attrSources`）。
 *              ⚠️ 表的定位是**排序与展示**，真正的"开不开放"永远来自 `PAYMENT_CHANNELS`（配置，非代码）：
 *              让库里一行 UPDATE 能打开通道，等于绕过 `config.ts` 的三条安全闸门
 *              （生产 mock 只在审核期、审核期只允许 mock）——**库里的数据不过任何一道闸门**。
 *              @see adapters/payment-channel-config.ts 文件头的 @why（这条取舍的完整论证）。
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
import type { ChannelConfigRow } from '../payment-channel-config.js';
import { mockAutoConfirmEnabled, type AppConfig } from '../../config.js';
import type { Clock } from '../../ports/clock.js';
import type { HttpClient } from '../../ports/http-client.js';
import type { IdGen } from '../../ports/ids.js';
import type { ChannelConfig, PaymentRegistry } from '../../ports/payment.js';
import { createPaymentRegistry } from './registry.js';
import { createMockProvider } from './mock.js';
import { createStripeCheckoutProvider } from './stripe-checkout.js';

/**
 * 通道的**默认属性**——`payment_channels` 表的 seed 真源与**回退值**（@limitation 一）。
 *
 * @why `priority` 小者优先：微信支付是我们唯一能在小程序内直接调起的通道（D-15），
 *      通过率最高、也最符合用户在微信内的预期，所以排第一；银行卡是覆盖"没有大陆钱包"
 *      用户的第二路径（D-49），排第二；mock 只在审核 / 本地演示用，垫底。
 * @why 接线之后它的身份变了：不再是"通道配置"，而是"表里没这一行时用什么"。
 *      这个身份必须写在注释里——否则下一个人会以为改这里就能改线上行为，
 *      而实际上表里有那一行、改常量完全不生效（**改了没反应，比没得改更容易骗人**）。
 */
/**
 * ⚠️ 导出只为两件事：
 *    ① `payment_channels` 表的迁移 seed（010）与本表**字段级同源比对**
 *       （payment-channels-seed.db.test.ts）——seed 值逐字等于这里的声明，改一边不改另一边立即红；
 *    ② 上表的**回退值**（本文件装配时用）。
 *    业务代码不得把它当"通道配置的读取口"（运行期读注册表，不读本常量）。
 */
export const CHANNEL_DEFAULTS: Readonly<
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

/**
 * 一个通道的属性来自哪里。
 * - `table`：`payment_channels` 表里有这一行（**接线生效**）；
 * - `builtin`：表里没有，回退到 {@link CHANNEL_DEFAULTS}；
 * - `fallback`：表里没有、内置表也没有（新增通道的过渡态），回退到 `FALLBACK_DEFAULT`。
 */
export type ChannelAttrSource = 'table' | 'builtin' | 'fallback';

/** 装配产物：注册表 + 两个清单（与配置清单对照，差集各有含义，见各字段注释）。 */
export interface PaymentAssembly {
  registry: PaymentRegistry;
  /**
   * 实际注册了工厂的通道。`configured − registered` = 被静默跳过的：wechat 未实现 /
   * stripe 密钥不全 / 未知通道。启动日志必须把它与 configured 并列（见 `describeChannels` 的 @why）。
   */
  registered: string[];
  /**
   * 每个已装配通道的**属性来源**（启动时打进日志，见下面的 @why）。
   *
   * @why 接线最大的风险不是"读错"，而是**读了个空**还一切正常：表里少一行、
   *      查询返回空、或者压根忘了把表的行传进来——三种情况都会静默回退到内置常量，
   *      表现与"接线生效"完全一样（空对空假绿灯）。
   *      把它打进启动日志，"这次到底读的是表还是常量"才有据可查。
   */
  attrSources: Readonly<Record<string, ChannelAttrSource>>;
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
  /**
   * `payment_channels` 表读出来的属性（**表优先**，R2-4 / AJ-379）。
   * @why 注入而不是在本函数里查库：装配处是**同步**的（`mountAllRoutes` 也是），
   *      让它变 async 会波及十几个调用点；而"读表"本来就该发生在装配之前
   *      （`main.ts` 里那一次 await），这是 F10"IO 只从外面进来"的同一条纪律。
   *      undefined = **未接线**（测试与未接线的装配路径）→ 全部走内置常量。
   */
  channelRows: readonly ChannelConfigRow[] | undefined = undefined,
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

  const fromTable = new Map((channelRows ?? []).map((r) => [r.channel, r]));
  const attrSources: Record<string, ChannelAttrSource> = {};
  const configs: ChannelConfig[] = [...names].map((channel) => {
    const row = fromTable.get(channel);
    const builtin = CHANNEL_DEFAULTS[channel];
    // 表 > 内置常量 > 兜底（@limitation 一）。⚠️ 顺序里没有 `row.enabled`：开关只认配置
    const base = row ?? builtin ?? FALLBACK_DEFAULT;
    /**
     * ⚠️ 来源按**实际取到的那个对象**判定，不按"表里有没有这一行"判定。
     * @why 分开算的话来源会**说谎**：把上面的 precedence 改了（内置优先），
     *      日志里写的仍是 `table`，而实际用的是内置值——"接线生效"这个结论
     *      就成了一句谁也证伪不了的话。用对象同一性判定，两者不可能不一致。
     */
    attrSources[channel] = base === row ? 'table' : base === builtin ? 'builtin' : 'fallback';
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

  // ── mock：审核期 / 测试的假通道（真实 HMAC 验签，密钥来自配置）─────────────
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
  //         （生产列出 wechat 由 config.ts 规则 3c 拒启，见那里）

  /**
   * 装配期把每个已注册通道**构造一次**（工程缺口第二轮复核 F1）。
   * @why 注册表里"配置币种 ⊆ 能力币种"等一致性校验在首次 resolve 时才跑、抛错后不缓存。
   *      AJ-379 之后属性来自 `payment_channels` 表——运营改错一行币种、重启，健康检查全绿，
   *      而 `GET /pay/channels`、回调、自动确认从第一个请求起全部 500。放在这里，错误落在启动那一刻。
   * @why 只构造**已注册**的：工厂只在凭据齐全时才注册（见上），构造它们不会因为"本地没配密钥"而炸。
   */
  for (const ch of registered) registry.getForCallback(ch);

  const offline = registered.filter((c) => !listed.has(c));
  return { registry, registered, offline, attrSources };
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
      // 审核模式：服务端自签确认 mock 付款（技术文档 §2.9 / AJ-179）。审核模式下只允许 mock（config 规则 2b），
      // 非审核模式的 mock 只是测试/本地通道，付款靠显式签名回调驱动
      // 本地模拟付款（MOCK_AUTO_CONFIRM，仅 development / test；config 跨字段 1g 拦公网环境）——第二道防线同样按环境判
      autoConfirm: config.REVIEW_MODE === 'on' || mockAutoConfirmEnabled(config),
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
