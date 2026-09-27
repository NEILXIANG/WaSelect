/**
 * 职责：错误码注册表（前端 / 后端 / 管理后台三端同源，唯一真源）。
 * 边界：只放"码 → HTTP 状态 + 默认文案 + 用户侧处理"的映射，不含抛出与格式化逻辑。
 * @see 技术文档 v0.5 §7（错误码表，本文必须逐条与之对齐）；docs/地基搭建清单.md F2
 * @limitation 新增错误码必须同时改三处：本表 + 技术文档 §7 + `api-contract.yaml`；
 *             漏改 api-contract 会被 `scripts/check-contract.mjs` 拦下（gate 报红）。
 * @tradeoff 用"码前三位数 = HTTP 状态"的约定换取零映射表（40001→400、40905→409、50003→500）：
 *           代价是错误码空间被 HTTP 状态绑住，自定义码必须以真实 HTTP 语义开头。
 * @why 错误码如果散落在各端，前端拿到的码与后端抛的码会对不上，且没有一处能回答"现在一共有多少个码"。
 *      集中成注册表之后，"漏改契约"这件事才有地方可以被脚本拦住（check-contract.mjs）。
 */
export interface ErrorSpec {
  /** 业务错误码（前三位数即 HTTP 状态） */
  code: number;
  /** 默认文案（中文，面向用户；技术细节不在此处） */
  message: string;
  /** 前端 / 用户侧建议动作 */
  action: string;
}

/* `as const satisfies` 而不是 `Readonly<Record<number, ErrorSpec>>`：
 * 前者保留每个码的字面量类型，才能导出 ErrorCode 联合类型，让调用处拼写错误在编译期就报红（见下方 ErrorCode）。 */
export const ERROR_CODES = {
  40001: { code: 40001, message: '参数缺失或格式错误', action: '前端校验' },
  40002: { code: 40002, message: '地址须为英文/拼音或电话格式错误', action: '表单提示' },
  40011: {
    code: 40011,
    message: '条款版本缺失或已过期',
    action: '刷新页面重新加载条款后下单',
  },
  40101: { code: 40101, message: '未登录或登录已过期', action: '静默重新登录并重放请求' },
  40102: { code: 40102, message: '支付链接无效或已失效', action: '回小程序重新发起支付' },
  /**
   * 回调验签失败。**刻意用 401 而不是 500**（原为 50002，D6 改口径）：
   * ① 这是**入站请求方**的问题，不是我们的故障——按 500 记会让错误预算和 5xx 告警
   *    被"别人发来的垃圾报文"吃掉，真正的服务端故障反而看不见（与 D13 同类）；
   * ② 任何人都能构造一个无效签名的回调，等于任何人都能刷我们的 5xx。
   * @limitation 机构（Stripe/微信）对 4xx 与 5xx **都会重试**，所以 4xx 换不来"不再重试"，
   *             它换来的是**监控语义正确**。密钥轮换期间丢失的事件靠每日对账补齐，不靠重试。
   */
  40103: { code: 40103, message: '回调验签失败', action: '不重试，人工核对' },
  40301: { code: 40301, message: '无权限', action: '隐藏入口' },
  40400: {
    code: 40400,
    message: '请求的资源不存在',
    action: '接口路径写错或版本不匹配，前端不应重试',
  },
  40401: { code: 40401, message: '商品不存在或已下架', action: '提示并刷新' },
  40901: { code: 40901, message: '库存不足', action: '提示并刷新' },
  40902: { code: 40902, message: '订单状态不允许此操作', action: '刷新订单' },
  // 三审 P3-5：40903 的语义是"首次仍在执行、等待超时**没有**结果"（adapters/idempotency.ts 抬头），
  // 旧 action"返回原结果"与之相反——根本没有原结果可返回；正确动作是提示处理中，稍后同键重放/查单
  40903: { code: 40903, message: '重复提交', action: '提示处理中，稍后用同一幂等键重放或查询订单' },
  40904: { code: 40904, message: '订单已过期', action: '重新下单' },
  40905: { code: 40905, message: '价格已变动', action: '提示刷新确认页' },
  40906: { code: 40906, message: '订单金额超过上限，请拆单', action: '提示拆分订单' },
  40907: {
    code: 40907,
    message: '该支付存在进行中的拒付，暂不可退款',
    action: '等争议结案后再操作',
  },
  /**
   * 同一个 Idempotency-Key 传了**不一样**的请求内容。
   *
   * @why 曾经只按键重放、不比对内容（评审 D4），于是客户端复用键的 bug 被静默吞掉：
   *      用户点了两次"买不同的东西"，第二次返回的是第一次的结果——他以为下单成功，
   *      钱也没扣，而日志里这条跟正常重放长得一模一样。
   *      "静默成功"比报错危险得多，所以这里必须 409 并让前端去查自己的键生命周期。
   * @limitation 指纹由服务端对请求体取 sha256 得出，因此"内容相同"的判定依赖
   *              序列化的稳定性——实现里用按键排序的规范化序列化，避免键顺序造成误判。
   */
  40908: {
    code: 40908,
    message: '幂等键复用但请求内容不一致',
    action: '前端须为每次新意图生成新的幂等键，不要用同一个键提交不同内容',
  },
  /**
   * 有进行中的拒付时**发货**被拦（I2 U-B2a；与 40907 同一个事实、两个消费方）。
   *
   * @why 不复用 40907：40907 的文案是"暂不可**退款**"，用它拦发货会把
   *      "发货被拒"显示成"退款被拒"，客服照着去查退款，方向整个反掉。
   *      两个动作各一个码的代价是多一条注册表项，
   *      换来的是提示文案与动作一一对应（ADR-29：文案与事实不符同样算 bug）。
   * @see domain/admin-order-actions.ts（shipGuard 的 @limitation 一：这条是可推翻的保守口径）
   */
  40909: {
    code: 40909,
    message: '该支付存在进行中的拒付，暂不可发货',
    action: '等争议结案后再发货；若客户主张未收到货，先与拒付处理人确认',
  },
  /**
   * 同一币种同一生效时间已有一条汇率（`fx_rates` 的 `UNIQUE(quote, effective_from)`）。
   *
   * @why 不折叠成 50000：非 AppError 一律兜底成 50000，而 50000 的 action 是
   *      "服务端故障"——运营照着去查服务端，真因却是"你刚提交过同一时间的一条"。
   *      这是**用户输入冲突**，不是故障，必须让提示指向"换个生效时间"。
   *      同理不用 40001（文案是通用的"参数缺失或格式错误"，同样指不向真因）。
   * @why 仓储**刻意不做 upsert**（ops-config.ts @limitation 二）：覆盖会静默抹掉前一条
   *      维护记录，"上一次是多少"变成不可知。抛冲突而不是覆盖，是这个取舍的代价。
   * @see adapters/ops-config.ts（抛 23505）；app/admin-ops-routes.ts（转成本码）
   */
  40910: {
    code: 40910,
    message: '该币种在此生效时间已有一条汇率',
    action: '换一个生效时间，或先查看列表里已有的那条',
  },
  42901: { code: 42901, message: '请求过于频繁', action: '稍后重试' },
  50000: {
    code: 50000,
    message: '服务器内部错误',
    action: '未归类异常的兜底码；响应体只给本文案，细节仅进日志',
  },
  50001: { code: 50001, message: '支付创建失败', action: '重试或切换支付方式' },
  // ⚠️ 50002（回调验签失败）已于 D6 改为 40103：验签失败是入站方的问题，不算服务端故障。
  //    删掉而不是留着，是为了避免"两个码一个含义"——那种情况下会各自漂移。
  50003: { code: 50003, message: '汇率不可用', action: '阻止下单，管理员维护汇率' },
  50004: { code: 50004, message: '运费不可计算', action: '阻止下单，管理员补齐参数' },
  /**
   * 上游（Stripe / 微信等出站）暂时不可用——熔断打开时对调用方的兜底响应（C4 / 地基清单欠账 ③）。
   * @why 刻意用 503 而不是 500：熔断是**暂时性**故障，503 带 Retry-After 语义，
   *      前端 / 网关 / 上游重试能据此退避；归 500 会让"上游挂了"被记成"我方内部错误"，
   *      污染错误预算与 5xx 告警（与 40103 同类：把非我方故障挡在 5xx 之外）。
   * @limitation 熔断打开本身意味着**一段时间内不会再尝试出站**，所以 503 只是"当前这几次请求"
   *      的兜底；真正的恢复由熔断器冷却后探测决定，不靠调用方重试触发。
   */
  50300: {
    code: 50300,
    message: '服务暂时不可用，请稍后重试',
    action: '按 Retry-After 退避后重试',
  },
} as const satisfies Record<number, ErrorSpec>;

/** 已登记错误码的联合类型（字面量）：调用处传错码在**编译期**就报红，而不是运行时回落 500 才发现。 */
export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * 由错误码推导 HTTP 状态码（码前三位数即状态）。
 * @param code 业务错误码
 * @returns HTTP 状态码；未知码一律 500（不暴露未登记的码）
 */
export function httpStatusOf(code: number): number {
  const status = Math.floor(code / 100);
  return status >= 400 && status <= 599 ? status : 500;
}

/** 判断一个数字是否是已登记的错误码（类型守卫，命中后收窄为 ErrorCode 字面量联合）。 */
export function isErrorCode(value: number): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

/** 取错误码定义；未登记时返回 undefined（调用方应映射 50000 并记录告警）。 */
export function errorSpec(code: number): ErrorSpec | undefined {
  return (ERROR_CODES as Record<number, ErrorSpec | undefined>)[code];
}
