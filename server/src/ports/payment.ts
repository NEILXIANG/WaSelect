/**
 * 职责：**支付端口**（F11 / ADR-28）——业务核心认识的"支付"只有这些类型，
 *       不认识 Stripe、不认识微信、不认识任何具体机构。
 *
 * @why 这套接口存在的唯一理由是"**加一种支付方式不用改业务代码**"。
 *      判断它是否合格的标准也只有一条：新增一个通道时，
 *      `domain/` 与路由层是否需要改动？需要 → 抽象漏了；不需要 → 抽象成了。
 *      通道名（`mock` / `stripe` / `wechat`）在这里**只是字符串 key**，
 *      刻意不写成联合类型——写成联合类型的话，加通道就要先改 shared 的枚举，
 *      那还是"改代码才能加支付方式"。
 *
 * @why 能力声明（capabilities）与配置（config）是**两件不同的事**，两者都要过：
 *      - `ChannelConfig` 回答"**我们**要不要在这个市场开放它"（运营开关，DB/配置驱动）；
 *      - `ProviderCapabilities` 回答"这个机构**做不做得到**"（能力边界，适配器自报）。
 *      合二为一的典型后果是：把"美国暂不开放"写成"不支持美国"，
 *      于是上线美国市场时既要改配置又要改代码，而后者需要发版。
 *
 * @limitation 一：**只描述"发起支付 / 解析回调 / 退款"三件事**。
 *              对账（reconcile）与查询（query）等 F13/F14 再补——
 *              现在写了也是猜，猜出来的接口几乎一定会在真接入时返工。
 * @limitation 二：金额口径一律 **JPY 整数**（ADR-09：JPY 是唯一定价锚）。
 *              `currency` 字段只表示**扣款/展示币种**，不参与金额换算；
 *              换算与 3% 缓冲属 domain 的定价规则，不属本端口。
 * @limitation 三：`refund` 是**可选方法**而不是必填。
 *              理由是"不支持退款"是一种真实存在的能力状态（例如某些预付通道），
 *              把它写成必填就会逼着适配器抛"未实现"——那等于用运行时错误表达静态事实。
 *              代价：调用方必须先看 `capabilities.supportsRefund`；
 *              这个代价由注册表的**一致性校验**兜住（声明与实现不符 → 注册即失败）。
 * @limitation 四：回调解析统一到 `ProviderEvent` 后，**机构特有的字段会丢**。
 *              需要留存时由适配器自己落 `webhook_events` 原始报文（已有该表），
 *              不要让 `ProviderEvent` 长成一个"所有机构字段的并集"——那种类型三个月就没人敢改了。
 *
 * @see docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §2；docs/地基搭建清单.md F11；
 *      adapters/payment/registry.ts（注册表实现）
 */
import { AppError } from '../errors.js';

/** 前端入口形态：小程序据此决定"直接调起 / 引导复制链接 / 短链跳转"。 */
export type EntryMode = 'in_app' | 'copylink' | 'redirect';

/**
 * 适配器**自报**的能力（E-3）。框架按它筛选，业务不判断"这个能不能用"。
 *
 * @why `refundableWhenDisabled` 单独一条：通道**下线后老订单仍必须能退款**，
 *      否则"下线支付宝"就等于"已售订单退款功能一起没了"——
 *      这是通道可插拔最容易漏掉的语义，所以它是能力而不是配置。
 */
export interface ProviderCapabilities {
  /** 支持的扣款/结算币种。`'*'` 表示不限。 */
  currencies: readonly string[];
  /** 可服务的**目的国**。`'*'` 表示不限。 */
  countries: readonly string[];
  /** 前端入口形态（驱动 UI，不写死按钮）。 */
  entryMode: EntryMode;
  supportsRefund: boolean;
  supportsPartialRefund: boolean;
  supportsDispute: boolean;
  /** 单笔下限 / 上限（JPY）；不填表示无限制。 */
  minAmountJpy?: number | undefined;
  maxAmountJpy?: number | undefined;
  /** 通道下线后，已生成的支付单是否仍需可退款（见上 @why）。 */
  refundableWhenDisabled: boolean;
}

/** 通道配置：运营侧开关（DB 表驱动，改它不改代码、不发版）。 */
export interface ChannelConfig {
  /** 注册表 key。**任意字符串**：新增通道不需要改 shared 枚举。 */
  channel: string;
  enabled: boolean;
  /** 排序优先级，**小者优先**；相等时按 `channel` 字典序，保证结果稳定可测。 */
  priority: number;
  /** 该通道在这些目的国开放（`'*'` 不限）。 */
  countries: readonly string[];
  /** 该通道在这些币种开放。 */
  currencies: readonly string[];
  /** 前端展示名（外置文案，前端不写死通道名）。 */
  label: string;
  /** 前端图标 key（同上）。 */
  icon?: string | undefined;
  /** 传给工厂的通道私有配置（密钥等；**禁止进日志**）。 */
  options?: Readonly<Record<string, unknown>> | undefined;
}

/** `GET /pay/channels` 的一行：前端据此渲染入口，删掉一个通道前端自动不显示。 */
export interface ChannelView {
  channel: string;
  entryMode: EntryMode;
  label: string;
  icon?: string | undefined;
}

/** 发起支付的入参（业务侧只给这些，不给机构专属字段）。 */
export interface PaymentRequest {
  orderId: string;
  /** 对人单号：机构侧元数据用它，排障时两边能对上。 */
  orderNo: string;
  /** **JPY 锚**（ADR-09）：记账与对账始终用它，不随扣款币种变。 */
  amountJpy: number;
  /** 扣款币种。 */
  currency: string;
  /**
   * **该币种下**的金额（主单位）。换算由 domain 按 `fx_snapshot` 做，
   * 本端口**不做换算**——端口一旦开始换算，就会出现"同一个订单在两家机构金额不同"。
   */
  amountInCurrency: number;
  destCountry: string;
  /** 幂等键：传给机构，避免重复建单（机构侧幂等 ≠ 我们自己的幂等表）。 */
  idempotencyKey: string;
}

/**
 * 支付入口。**判别联合**而不是"所有字段都有的大对象"：
 * 前端按 `mode` 走不同分支，编译期就能保证"copylink 一定有 url"。
 */
export type PaymentEntry =
  /** 小程序内直接调起（机构返回的参数原样透传，本层不解释）。 */
  | { mode: 'in_app'; params: Readonly<Record<string, unknown>> }
  /** 复制/打开链接（D-49：Stripe Checkout 托管页走这条）。 */
  | { mode: 'copylink'; url: string }
  /** 302 跳转。 */
  | { mode: 'redirect'; url: string };

export interface PaymentSession {
  /** 机构侧的意图 id（Stripe 是 `cs_...`）。 */
  providerRef: string;
  entry: PaymentEntry;
  /** 到期时间（ISO）；机构不给则为空。 */
  expiresAt?: string | undefined;
}

/** 回调解析后的**统一**形态（各机构字段差异不穿透到业务）。 */
export interface ProviderEvent {
  /** 机构事件 id（去重键；机构不给时由适配器用报文摘要兜底）。 */
  eventId: string;
  /** 机构原始事件类型（进日志与 `webhook_events`，排障要看）。 */
  rawType: string;
  /** 归一化结果：业务只认这几种。 */
  outcome: 'succeeded' | 'failed' | 'expired' | 'refunded' | 'disputed' | 'unknown';
  /** 我们自己的订单 id（从机构 metadata 回带；取不到是**设计缺陷**，必须抛）。 */
  orderId: string;
  providerRef: string;
  /**
   * 机构报的金额（**最小单位**，如 USD 是分、JPY 是円）与它的币种。
   *
   * @why 这里**不换算成 JPY**：换算需要下单价时的 `fx_snapshot`（订单级），
   *      适配器拿不到也不该拿——拿到就会用它自己查到的"当前汇率"去换算一笔过去的交易，
   *      于是对账时永远差一点，且差额随时间变化，查不出原因。
   *      换算属 domain，用订单快照里那份汇率。
   */
  amountMinor?: number | undefined;
  currency?: string | undefined;
}

export interface RefundRequest {
  orderId: string;
  providerRef: string;
  /** JPY 锚（记账与对账）。 */
  amountJpy: number;
  /**
   * **原扣款币种**与该币种下的金额：MVP 只做全额，**按原币退**（契约 `/admin/orders/{id}/refund`）。
   * @why 按原币退而不是按"今天的汇率折算成 JPY 再退"：汇率在收与退之间会变，
   *      折算退款会让用户拿到的金额与付款时不等（多退是损失、少退是纠纷）。
   */
  currency: string;
  amountInCurrency: number;
  reason: string;
}

export interface RefundResult {
  providerRef: string;
  /** 机构侧的退款 id。 */
  refundRef: string;
  outcome: 'succeeded' | 'pending' | 'failed';
}

/** 请求头袋（key **一律小写**，由调用方归一化；Express 的 `req.header()` 大小写不敏感）。 */
export type HeaderBag = Readonly<Record<string, string | undefined>>;

export interface PaymentProvider {
  /** 必须与注册表的 key 一致（注册表注册时校验）。 */
  readonly channel: string;
  readonly capabilities: ProviderCapabilities;

  /** 发起支付（幂等由机构侧 idempotencyKey + 我们自己的幂等表双重保证）。 */
  create(req: PaymentRequest): Promise<PaymentSession>;

  /**
   * 验签 + 解析回调。**必须吃原始字节**（重新序列化会改变字节导致验不过）。
   * @throws {AppError} 40103（验签失败：入站方的问题，不重试）/ 40001（报文不可解析）
   */
  parseWebhook(raw: Buffer, headers: HeaderBag): Promise<ProviderEvent>;

  /** 退款。仅在 `capabilities.supportsRefund === true` 时存在（注册表强制一致性）。 */
  refund?(req: RefundRequest): Promise<RefundResult>;
}

/** 工厂：配置 → 实例。**装配处**把密钥等外部依赖在这里闭包进去。 */
export type ProviderFactory = (cfg: ChannelConfig) => PaymentProvider;

/** 可用通道的查询条件（路由与 `/pay/channels` 共用）。 */
export interface ChannelQuery {
  destCountry: string;
  amountJpy: number;
  currency: string;
}

export interface PaymentRegistry {
  /** 注册一个工厂；重复注册同名通道 → 抛（静默覆盖会让"哪个实现生效"变成谜）。 */
  register(channel: string, factory: ProviderFactory): void;
  /**
   * 取**可用于新建支付**的通道。未注册 / 未配置 / 已禁用 → 抛 40001。
   * @why 不带 enabled 判断的 `get()` 是最危险的 API：调用方忘了判 `enabled`，
   *      下线一个通道后老路径照常出新单——所以"能建单"与"能退款"必须是两个方法。
   */
  get(channel: string): PaymentProvider;
  /**
   * 取**可用于退款**的通道：已禁用的通道在这里仍可取到，
   * 但仅当 `capabilities.refundableWhenDisabled === true`（见该字段的 @why）。
   */
  getForRefund(channel: string): PaymentProvider;
  /**
   * 取**用于解析已发生支付的回调**的通道。
   *
   * @why 这是第三个取用方法，**不是** `get()` 或 `getForRefund()` 的别名——
   *      三条路径对应三件不同的事，混用任何两条都会出事故：
   *        · `get()`           = **新单**：禁用即不可用（下线后不再有新的钱走这条路）
   *        · `getForRefund()`  = **老单退款**：禁用仍可用，但要 `refundableWhenDisabled`
   *        · `getForCallback()`= **老单回调**：禁用**也不拦**，且连 `refundableWhenDisabled` 都不看
   *      回调比退款更根本：退款不做，用户可以来问、客服可以补；
   *      回调不做，就是"用户付了钱、订单永远停在未支付、货不发、也没有任何告警"——
   *      而触发它的往往正是"通道刚被下线"这一刻（还有一批在路上、在宽限期内的支付）。
   *      用 `get()` 接回调 = 每下线一个通道就静默吞掉一批已付款的订单。
   *
   * @limitation **不检查 enabled**，因此一个被永久下线且代码已删除的通道，
   *             其迟到回调会拿到 40001（`channel_not_registered`）而不是被静默忽略。
   *             这是刻意的：验不了签就必须响亮地失败，让"还有钱在路上"变成一条可检索的告警，
   *             而不是变成对账时才发现的差额。
   */
  getForCallback(channel: string): PaymentProvider;
  /** 按 `(目的国, 金额, 币种, 优先级)` 过滤并排序；禁用项不出现。 */
  listAvailable(query: ChannelQuery): ChannelView[];
}

/** 列表里表示"不限"的通配符。 */
export const ANY = '*';

/**
 * 国家/币种是否命中（`'*'` 表示不限）。
 *
 * @why 抽成纯函数：**"什么算命中"是契约的一部分**，写进各适配器就会出现
 *      "这个适配器认 `*`、那个不认"的分裂——而这正是最容易被忽略的一致性。
 *      与 `payloadHash` / `requestFingerprint` 同理：语义性纯函数留在 ports（AJ-47）。
 */
export function matchesScope(list: readonly string[], value: string): boolean {
  return list.includes(ANY) || list.includes(value);
}

/**
 * 该通道在给定条件下是否**可用**（配置开关 ∩ 能力边界 ∩ 金额区间）。
 *
 * @why 放在 ports 而不是注册表里：它是**规则**，注册表只是规则的调用方。
 *      规则留在实现里，将来换一个注册表（比如带灰度/成功率策略的）就得复制一份规则，
 *      两份规则迟早漂移——漂移的表现是"同一个订单，走 A 路径能付、走 B 路径不能"。
 * @limitation 只判"能不能用"，不判"该不该首选"（那是路由策略，属于更高一层，F11 只做到按 priority 排序）。
 */
export function isChannelAvailable(
  cfg: ChannelConfig,
  caps: ProviderCapabilities,
  query: ChannelQuery,
): boolean {
  if (!cfg.enabled) return false;
  // 配置侧：这个市场/币种我们开不放
  if (!matchesScope(cfg.countries, query.destCountry)) return false;
  if (!matchesScope(cfg.currencies, query.currency)) return false;
  // 能力侧：这个机构做不做得到
  if (!matchesScope(caps.countries, query.destCountry)) return false;
  if (!matchesScope(caps.currencies, query.currency)) return false;
  // 金额区间：上下限都是"含"（`amount < min` 才排除，等于 min 可以用）
  if (caps.minAmountJpy !== undefined && query.amountJpy < caps.minAmountJpy) return false;
  if (caps.maxAmountJpy !== undefined && query.amountJpy > caps.maxAmountJpy) return false;
  return true;
}

/** 通道不可用时的统一错误（码 40001：调用方给了一个当前不可用的通道）。 */
export function channelUnavailable(channel: string, reason: string): AppError {
  return new AppError(40001, { reason, ctx: { channel } });
}
