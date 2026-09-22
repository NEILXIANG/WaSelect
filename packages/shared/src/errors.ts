/**
 * 职责：错误码注册表（前端 / 后端 / 管理后台三端同源，唯一真源）。
 * 边界：只放"码 → HTTP 状态 + 默认文案 + 用户侧处理"的映射，不含抛出与格式化逻辑。
 * @see 技术文档 v0.5 §7（错误码表，本文必须逐条与之对齐）；docs/地基搭建清单.md F2
 * @limitation 新增错误码必须同时改三处：本表 + 技术文档 §7 + `api-contract.yaml`；
 *             漏改 api-contract 会被 `scripts/check-contract.mjs` 拦下（gate 报红）。
 * @tradeoff 用"码前三位数 = HTTP 状态"的约定换取零映射表（40001→400、40905→409、50003→500）：
 *           代价是错误码空间被 HTTP 状态绑住，自定义码必须以真实 HTTP 语义开头。
 */
export interface ErrorSpec {
  /** 业务错误码（前三位数即 HTTP 状态） */
  code: number;
  /** 默认文案（中文，面向用户；技术细节不在此处） */
  message: string;
  /** 前端 / 用户侧建议动作 */
  action: string;
}

export const ERROR_CODES: Readonly<Record<number, ErrorSpec>> = {
  40001: { code: 40001, message: '参数缺失或格式错误', action: '前端校验' },
  40002: { code: 40002, message: '地址须为英文/拼音或电话格式错误', action: '表单提示' },
  40011: {
    code: 40011,
    message: '条款版本缺失或已过期',
    action: '刷新页面重新加载条款后下单',
  },
  40101: { code: 40101, message: '未登录或登录已过期', action: '静默重新登录并重放请求' },
  40102: { code: 40102, message: '支付链接无效或已失效', action: '回小程序重新发起支付' },
  40301: { code: 40301, message: '无权限', action: '隐藏入口' },
  40401: { code: 40401, message: '商品不存在或已下架', action: '提示并刷新' },
  40901: { code: 40901, message: '库存不足', action: '提示并刷新' },
  40902: { code: 40902, message: '订单状态不允许此操作', action: '刷新订单' },
  40903: { code: 40903, message: '重复提交', action: '返回原结果' },
  40904: { code: 40904, message: '订单已过期', action: '重新下单' },
  40905: { code: 40905, message: '价格已变动', action: '提示刷新确认页' },
  40906: { code: 40906, message: '订单金额超过上限，请拆单', action: '提示拆分订单' },
  40907: { code: 40907, message: '该支付存在进行中的拒付，暂不可退款', action: '等争议结案后再操作' },
  42901: { code: 42901, message: '请求过于频繁', action: '稍后重试' },
  50001: { code: 50001, message: '支付创建失败', action: '重试或切换支付方式' },
  50002: { code: 50002, message: '回调验签失败', action: '记录日志，人工核对' },
  50003: { code: 50003, message: '汇率不可用', action: '阻止下单，管理员维护汇率' },
  50004: { code: 50004, message: '运费不可计算', action: '阻止下单，管理员补齐参数' },
};

/**
 * 由错误码推导 HTTP 状态码（码前三位数即状态）。
 * @param code 业务错误码
 * @returns HTTP 状态码；未知码一律 500（不暴露未登记的码）
 */
export function httpStatusOf(code: number): number {
  const status = Math.floor(code / 100);
  return status >= 400 && status <= 599 ? status : 500;
}

/** 判断一个数字是否是已登记的错误码。 */
export function isErrorCode(value: number): boolean {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

/** 取错误码定义；未登记时返回 undefined（调用方应映射 500 并记录告警）。 */
export function errorSpec(code: number): ErrorSpec | undefined {
  return ERROR_CODES[code];
}
