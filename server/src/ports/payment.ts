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
  /**
   * 能否**查询机构侧待支付会话的当前状态**（第三轮审查 MP3-04）。缺省 false。
   *
   * @why 只有它才能堵住"买家在浏览器里付完款、支付通知还没到，回微信点了取消订单"这个洞：
   *      那一瞬间我方库里订单仍是 `pending_payment`、支付行仍是 `initiated`，
   *      按本地状态**完全合法**的取消会把订单关掉、库存还回去，
   *      几秒后支付通知到达 → 变成"钱收了、单关了"的迟到付款，只能人工退款。
   *      堵它需要**问机构一句**：这个会话付了没有。不能问的通道（in_app 类，机构侧没有对应物）
   *      只能靠前端的"刚刚付过"提示兜底。
   * @why 可选而不是必填（与 `refund` 同口径，见 @limitation 三）：「机构侧有一个会话可查」
   *      不是普遍事实——mock / 未来的微信 Native 的"会话"就是我们库里的 payments 行，
   *      硬写必填会逼着这些通道实现一个返回常量的假方法，那比没有更糟（读代码的人会以为它真查了）。
   * @limitation 它驱动的是**取消**这一条业务分支（查到"已付或不确定"就拒绝取消），
   *            所以调用方必须先看它，不能假设每个通道都有 `sessionStatus()`。
   */
  supportsSessionQuery?: boolean;
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
   * **该币种下的金额，整数最小单位**（JPY=円、USD=分）。
   *
   * @why 取整只在 `packages/shared/money.ts` 的 `toMinor` 一处发生（ADR-09）：
   *      domain 换算完直接把整数最小单位交给端口，适配器**只做 `String()` 透传**。
   *      旧口径是"主单位浮点、适配器再 ×100 取整"——那是全仓第二处金额取整
   *      （二次审查 P3-1）：`.5` 边界上浮点误差会让 adapter 与 domain 差 1 分，
   *      而这种差异不报错，只在对账时冒出来。
   */
  amountMinor: number;
  destCountry: string;
  /** 幂等键：传给机构，避免重复建单（机构侧幂等 ≠ 我们自己的幂等表）。 */
  idempotencyKey: string;
  /**
   * 订单到期时间（ISO 8601 字符串）。**可选**。
   *
   * @why 放进端口（而不是塞进 `ChannelConfig.options`）：到期时间是**订单的事实**，
   *      不是通道私有配置。凡是有"会话 / 票据"概念的通道都要拿它去设机构侧到期，
   *      否则订单 30 分钟就关（D-33）、机构的支付会话还开到 24 小时之后——
   *      用户在第 23 小时付款成功，钱扣了却没有订单可落（迟到付款）。
   *      塞进 options 的结果就是每个适配器各认一个键名，改名必漂移。
   * @limitation **不传时适配器不得编造**：不发该参数、交给机构默认。编一个到期时间出来
   *              （"反正大概 30 分钟"）会同时误导关单与对账，比不发更危险。
   * @see ADR / 决策 D-33（订单 30 分钟超时关单）、D-49（银行卡走 Stripe 托管页）
   */
  expiresAt?: string | undefined;
  /**
   * 收货信息（订单**地址快照**，建单时固定）。**可选**：机构支持就附上，不支持的适配器忽略。
   *
   * @why D-60①：Stripe 走 `payment_intent_data[shipping]`，给 Radar 风控与**拒付举证**用
   *      （"寄到了哪、寄给了谁"是举证材料的核心）。放进端口而不是让适配器自己查库：
   *      适配器不认识订单表（约束四：依赖只能由外向内）。
   * @limitation 这是**建会话那一刻**的快照：发货前管理员改址不会回写机构侧（AJ-96 已登记）。
   * @limitation 含个人信息：只随出站请求体发给机构，**不进日志**（fetch 客户端只记 URL，不记 body）。
   */
  shipping?: PaymentShipping | undefined;
}

/** 收货信息（字段与 addresses / address_snapshot 同名同义；可选字段缺失时不发）。 */
export interface PaymentShipping {
  name: string;
  phone?: string | undefined;
  line1: string;
  line2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
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
  /**
   * 归一化结果：业务只认这几种。
   *
   * ⚠️ `disputed`（开案）与 `dispute_closed`（结案）**刻意分成两个值**，不合并成一个
   * `disputed` 再让消费方去看 `disputeStatus`：合并了就等于要求"每个拒付落账器都要自己
   * 分辨开案还是结案"，而漏分辨的表现是**结案事件把开案状态又写一遍**——
   * 已 won 的拒付被重新标成 open，风控页显示"进行中"，运营照它去拦退款，
   * 而机构那边早就结案了。分开之后，两个落点各自独立注册（U-F2 的注册表），
   * 谁漏注册谁就走 `ignored:<outcome>`——**看得见**，而不是静默写错。
   */
  outcome:
    'succeeded' | 'failed' | 'expired' | 'refunded' | 'disputed' | 'dispute_closed' | 'unknown';
  /**
   * 我们自己的订单 id（从机构 metadata 回带）。落账类事件取不到是**设计缺陷**，必须抛；
   * 与订单无关的机构事件（payout / balance 等）允许为空串且 outcome 必为 unknown（全量审计 2026-09-26）。
   */
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
  /**
   * 机构报的**事件时刻**（unix 毫秒）；缺省 = 机构没给，由消费方决定用入库时刻还是拒绝落库。
   *
   * @why 加它而不是让消费方用"我们收到的那一刻"：有些时刻是**期限的起点**，
   *      两者可以相差数小时（回调重试 / 队列积压 / 端点被停用后的补发）——
   *      最典型的是**拒付开案时刻**（`dispute.created`）：举证期限从它起算，
   *      用入库时刻会把举证窗口**算短**，那是真金白银的损失（迁移 013 / AJ-156 ③）。
   * @limitation 只有"起点必须取机构时间"的场景才该用它；
   *              订单的 `paid_at` 之类仍然取注入时钟（业务事实可被测试钉住，见 mark-paid.ts）。
   * @see migrations/013_dispute_opened_at.sql
   */
  occurredAtMs?: number | undefined;
  /**
   * **拒付对象**的机构状态原值（如 Stripe 的 `won` / `lost` / `needs_response`）。
   *
   * @why 结案必须知道**结果**（赢了还是输了），而这个信息只在机构对象的 `status` 上，
   *      事件类型（`charge.dispute.closed`）本身不携带它——只看事件类型的话，
   *      结案只能写成"已关闭"，风控页就答不出"这单拒付最后是赔了还是保住了"。
   * @limitation 一：只有 `outcome` 是 `disputed` / `dispute_closed` 的**拒付对象**才填它，
   *              原样给字符串、**不做映射**（映射属 domain，见 domain/dispute-input.ts）——
   *              适配器不认识业务词表，认识的就是"下一版机构文档改了枚举名"这种事故。
   * @limitation 二：⚠️ 这是 `ProviderEvent` 上第 5 个可选字段。它有滑向
   *              "机构字段的并集"的风险（本文件 @limitation 四就在防这个），
   *              所以只收"业务上必须在机构侧取值、我们这侧推不出来"的那几个：
   *              金额、币种、时刻、拒付状态。**其余一律不许加。**
   */
  disputeStatus?: string | undefined;
}

/**
 * 机构侧**待支付会话**的状态（MP3-04）。
 *
 * @why 三值而不是布尔"付没付"：`processing` 表示"机构没说没付，也说不准付了"
 *      （异步支付方式、3DS 挑战中、机构返回的形态我们认不出）。
 *      二值会逼着调用方把它并进某一支，而**并进 unpaid 就是允许取消**——
 *      那正是这个洞本身。三值让"不确定"有地方可去，调用方按最保守的一支处理。
 * @limitation 这是**查询那一刻**的快照，不是承诺：查询之后、取消事务提交之前
 *             仍可能有支付完成（残余窗口，见 `cancel-order.ts` 的 @limitation）。
 */
export type SessionStatus = 'paid' | 'unpaid' | 'processing';

export interface RefundRequest {
  orderId: string;
  providerRef: string;
  /** JPY 锚（记账与对账）。 */
  amountJpy: number;
  /**
   * **原扣款币种**：MVP 只做全额，**按原币退**（契约 `/admin/orders/{id}/refund`）。
   * @why 按原币退而不是按"今天的汇率折算成 JPY 再退"：汇率在收与退之间会变，
   *      折算退款会让用户拿到的金额与付款时不等（多退是损失、少退是纠纷）。
   */
  currency: string;
  /** 退款金额：**整数最小单位**（同 `PaymentRequest.amountMinor` 的 @why；MVP 全额=建单时的金额）。 */
  amountMinor: number;
  reason: string;
  /**
   * 第几次**重新发起**（缺省 0 = 首次）。只在上一笔被机构**确认失败**后才加一（F-03，AJ-178）。
   * @why 机构幂等键按订单固定时，确认失败的那笔会被机构缓存——同键重试永远拿回同一个失败；
   *      所以"确认失败"必须换键，而"结果未知"（超时 / 响应丢失）绝不能换键（换了可能退两次，KD-4）。
   *      由调用方按落库的失败事件计数，适配器只把它编进幂等键，不自己判断。
   */
  attempt?: number;
}

export interface RefundResult {
  providerRef: string;
  /** 机构侧的退款 id。 */
  refundRef: string;
  outcome: 'succeeded' | 'pending' | 'failed';
}

/** 请求头袋（key **一律小写**，由调用方归一化；Express 的 `req.header()` 大小写不敏感）。 */
export type HeaderBag = Readonly<Record<string, string | undefined>>;

/**
 * 机构**明确答复**"这次请求失败了"（拿到了 HTTP 响应且非 2xx），与"结果未知"相对。
 *
 * @why 这两类失败的处理方向**相反**，所以必须由抛出方（适配器）标明，不能让调用方猜：
 *      - 明确拒绝：机构什么都没建 → 下一次发起**必须换幂等键**（B3 / AJ-199）。
 *      - 结果未知（超时 / 连接中断 / 预算耗尽）：会话**可能已经建好** → 下一次发起
 *        **必须沿用同一把键**去把它取回来，换键就会建出第二个会话（与退款 KD-4 同一口径）。
 *      没有这个类型时，调用方只能"一律重试"，于是 B3 那种"机构把 5xx 按键缓存 ≥24h、
 *      而订单只活 30 分钟"的场景会让这张单终身付不了。
 * @why 放在 ports 而不是某个适配器：它是**所有**机构适配器对业务层的共同承诺，
 *      业务核心（`app/pay-intent.ts`）只认这个类型，不认识 stripe / mock / 微信。
 * @limitation 只表达"机构给了答复"，**不表达**这个失败是否可恢复（402 卡被拒与 500 上游故障
 *              都是明确拒绝）——可恢复与否由调用方按 status 自己判断。
 */
export class ProviderRejectedError extends Error {
  /** 机构返回的 HTTP 状态码。 */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderRejectedError';
    this.status = status;
  }
}

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

  /**
   * 查一笔退款的**当前**状态（F-03，AJ-178）。与 `refund` 同进同退（注册表强制：能退就必须能查）。
   * @why 机构对退款可能先回 pending、稍后才落定；而同键重发 `refund` 拿回的是**首次响应快照**，
   *      永远等不到结果——pending 的唯一出口是按退款单号查询。
   * @throws 查询本身失败（网络 / 非 2xx）→ 抛；调用方**不得**把它当成"退款失败"。
   * @limitation 返回值复用 `RefundResult['outcome']`：机构的中间态（如 Stripe `requires_action`）
   *             一律并入 pending，认不出的状态也并入 pending——只有机构明确说失败才算 failed。
   */
  refundStatus?(refundRef: string): Promise<RefundResult['outcome']>;

  /**
   * 查机构侧**待支付会话**的状态（MP3-04）。与 `capabilities.supportsSessionQuery` 同进同退（注册表强制）。
   *
   * @why 取消订单前必须能问这一句：本地库在"买家已付款、通知未达"的窗口里看不出任何异常，
   *      而那一窗口对银行卡（Stripe 托管页）是**常态**——用户付完切回微信只要几秒，
   *      回调常常还没到。没有这个查询，"取消"就只能凭本地状态放行。
   * @throws 查询本身失败（网络 / 非 2xx）→ 抛；调用方按 fail-closed 处理
   *         （查不到 = 不敢取消，而不是"查不到就当没付"）。
   * @limitation 认不出的机构状态一律并入 `processing`（保守方向），与 `refundStatus` 同口径。
   */
  sessionStatus?(providerRef: string): Promise<SessionStatus>;

  /**
   * 作废机构侧的**待支付会话**（D-50：订单关单/取消的连带动作）。
   *
   * @why 可选方法而不是必填：「机构侧有一个可作废的会话」不是普遍事实——
   *      in_app 通道（mock/未来微信 Native）的"会话"是我们库里的 payments 行，
   *      机构侧没有对应物，写出来只能是空实现。调用方（关单订阅者）按
   *      `typeof provider.expireSession === 'function'` 判定，不需要 capabilities
   *      字段：它不像 refund 那样驱动业务分支（售后路由要看 supportsRefund 决定
   *      给不给入口），只是"有就顺手调一下"。
   * @why **best-effort 语义**：调用方保证已先把库内 payments 行作废（那是底线事实），
   *      本方法失败不重试、不告警升级——机构侧会话有自己的自然过期
   *      （我们建会话时给的 expires_at），作废只是让"已关单的链接"立刻死、
   *      不等自然死亡。失败只配一条 warn 日志。
   * @throws 实现方对非 2xx 直接抛 Error（与 create/refund 同口径）；调用方必须兜住。
   */
  expireSession?(providerRef: string): Promise<void>;

  /**
   * 造一条**本通道自己签名**的「支付成功」回调报文（审核模式自动确认，技术文档 §2.9 / AJ-179）。
   *
   * @why 审核期 mock 通道没有机构来发回调，小程序却已按 `auto:true` 显示「支付已完成」——
   *      服务端要自己把这笔确认掉。让通道**造报文**而不是让业务层直接改 paid：
   *      报文随后走与真实回调同一条路（parseWebhook 验签 → 回调管线 → mark-paid 核对金额/单号 → 去重登记），
   *      审核期验到的就是生产那条路。事件 id 必须由意图确定（同一意图多次造 → 同一 id → 管线去重）。
   * @limitation **真实机构通道永远不实现它**：钱到没到只能由机构说。只有审核期假通道、且配置开了自动确认时才存在；
   *             调用方（app/auto-confirm.ts）另有"只确认测试单"的第二道防线。
   */
  selfConfirmation?(input: SelfConfirmationInput): SignedCallback;
}

/** `selfConfirmation` 的入参：确认哪一笔意图（全部取自已落库的 payments 行）。 */
export interface SelfConfirmationInput {
  orderId: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
}

/** 一条带签名的回调报文（原始字节 + 验签要的头）。 */
export interface SignedCallback {
  raw: Buffer;
  headers: HeaderBag;
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
