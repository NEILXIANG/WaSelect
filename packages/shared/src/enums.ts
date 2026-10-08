/**
 * 职责：跨端共享枚举与展示映射（订单状态 / 支付通道 / 币种 / 国家）。
 * 边界：只放常量与纯映射，不含状态迁移规则（那是业务，属 F10 通用执行器之上的具体规则）。
 * @see 技术文档 v0.5 §1（状态机，10 态）、§2（通道）、ADR-09（JPY 唯一锚）
 * @limitation 状态"能迁到哪"不在这里——迁移表属业务第一批；地基只保证枚举与展示映射齐全且不漂移。
 * @why 订单状态字符串若在 server / admin-web / miniprogram 三端各写一份，拼写漂移只会在**运行时**
 *      以"状态对不上"现形，而且排查时看哪一端的代码都像对的。集中一处后至少能用类型联合锁住。
 */

/** 订单状态（10 态，与技术文档 §1 逐字一致）。 */
export const ORDER_STATUS = [
  'created',
  'pending_payment',
  'paid',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'expired',
  'refunding',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** 已终态：不可再迁移（关单与守卫判断的公共部分）。 */
export const TERMINAL_ORDER_STATUS = ['completed', 'cancelled', 'expired', 'refunded'] as const;

/** 支付通道（注册表里的 key；`mock` 仅供审核期与测试）。 */
export const PAYMENT_CHANNEL = ['mock', 'wechat', 'stripe'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNEL)[number];

/**
 * 用户行为埋点（流 C，M-21 / AJ-409）：`POST /beacon` 接收的事件名白名单。
 *
 * @why 白名单而不是"任意事件名"：事件名是**查询面**（转化漏斗按它分组），也是 PII 的潜在入口——
 *      允许任意字符串，客户端一个 bug 就能把手机号当事件名写进库。新增事件 = 改这里 + 契约 + 隐私政策。
 * @see contracts/api-contract.yaml `BeaconEventName`（check-contract 双向比对）；
 *      miniprogram/utils/beacon.js（小程序侧同名常量，由其单测绑回本表）
 */
export const BEACON_EVENT = [
  'page_view',
  'add_to_cart',
  'checkout_enter',
  'pay_start',
  'pay_abandon',
] as const;
export type BeaconEvent = (typeof BEACON_EVENT)[number];

/** `page_view` 的页面键白名单（页面键而不是路径：路径带 query，query 里可能有 id 以外的东西）。 */
export const BEACON_PAGE = [
  'home',
  'detail',
  'cart',
  'checkout',
  'pay',
  'order',
  'order_detail',
  'user',
] as const;
export type BeaconPage = (typeof BEACON_PAGE)[number];

/** `pay_abandon` 的原因：back（离开支付页）/ cancel（收银台取消）/ fail（发起或收银台失败）。 */
export const BEACON_ABANDON_REASON = ['back', 'cancel', 'fail'] as const;
export type BeaconAbandonReason = (typeof BEACON_ABANDON_REASON)[number];

/** 币种：JPY 是唯一定价锚与记账币；其余只作展示与扣款。 */
export const CURRENCY = ['JPY', 'CNY', 'USD'] as const;
export type Currency = (typeof CURRENCY)[number];

/** MVP 只涉及日本原产（JP）与美国收货（US）。 */
export const COUNTRY = ['JP', 'US'] as const;
export type Country = (typeof COUNTRY)[number];

/**
 * 商品分类（与 api-contract `GET /products?category` 的 4 值枚举逐字一致）。
 *
 * @why 此前它只以字符串数组的形式手抄在 `app/product-routes.ts`（该文件 @limitation 一
 *      已预告"I2 提炼进 shared"）。现在管理端上架是**第二个消费方**：再手抄一份，
 *      两边的合法值就会各自漂移，而漂移的表现是"管理端能建一个买家永远筛不到的商品"。
 *
 * @limitation 契约的 `ProductInput.category` **尚未声明 enum**（只有 `GET /products?category`
 *             的查询参数有）。本常量以查询参数那一处为锚，与它由单测双向比对守着；
 *             待契约给 ProductInput 补上 enum 后，两处都归到同一个锚点。
 * @see enums.unit.test.ts（与契约的双向比对）
 */
export const PRODUCT_CATEGORY = ['beauty', 'daily', 'kitchen', 'food'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORY)[number];

/**
 * 商品合规标签（与 api-contract `ProductInput.compliance_tags` 的 11 值枚举逐字一致；
 * `scripts/check-contract.mjs` 做双向集合比对）。
 *
 * @why 三审 B5：它是上架拦截的判定依据（D-42 / D-45 / D-51，见 BLOCKED_COMPLIANCE_TAG），
 *      此前只存在于契约文本里、shared 没有常量——I1 写校验时只能在路由里手抄字符串，
 *      拼错一个（`quasi-drug`）就是一条"合规拦截静默失效"。
 */
export const COMPLIANCE_TAG = [
  'liquid',
  'battery',
  'cosmetic',
  'food',
  'flammable',
  'aerosol',
  'electrical',
  'quasi_drug',
  'sunscreen',
  'children_product',
  'alcohol',
] as const;
export type ComplianceTag = (typeof COMPLIANCE_TAG)[number];

/**
 * 上架即拒（40001）的标签：航空禁寄（flammable / aerosol，D-42）、MVP 不上电器（electrical，D-45）、
 * 美国 FDA 口径属 OTC 药品（quasi_drug / sunscreen）、CPSIA（children_product）、酒类免许（alcohol）（D-51）。
 * liquid / battery / cosmetic / food 只是**标记**（影响运输与申报），不拦。
 */
export const BLOCKED_COMPLIANCE_TAG = [
  'flammable',
  'aerosol',
  'electrical',
  'quasi_drug',
  'sunscreen',
  'children_product',
  'alcohol',
] as const satisfies readonly ComplianceTag[];

/**
 * 前端订单展示分组（技术文档 §1 末尾的映射）。
 * @tradeoff 放在 shared 而非前端：管理后台与小程序要显示同一套标签，避免两处文案漂移。
 */
export const ORDER_STATUS_DISPLAY: Readonly<Record<OrderStatus, string>> = {
  created: '待付款',
  pending_payment: '待付款',
  paid: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  completed: '已签收',
  cancelled: '已关闭',
  expired: '已关闭',
  refunding: '退款中',
  refunded: '已退款',
};

/** 运行时校验：判断字符串是否属于某枚举（替代 `as` 强转，防止脏数据穿透）。 */
export function isOneOf<T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
