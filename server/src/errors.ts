/**
 * 职责：错误与响应规范（F4）——把任意异常收敛成**一种**对前端与日志都稳定的形状。
 * 边界：框架无关（不 import Express）；中间件与全局兜底在 F6 接入。
 *
 * @why 跨境支付里"下单失败"有十几种成因，如果每个 handler 自定义响应形状，
 *      前端就要写十几个分支、日志就无法按码聚合，出问题只能靠猜。
 *      统一形状后：`code` 可机读（前端按 action 提示）、`message` 可给人看、细节只进日志。
 *
 * @limitation 一：`details` **只用于内部日志**，绝不出现在响应体里（`toErrorResponse` 结构上就不带它）。
 *              理由：details 常带 SQL、上游返回体、内部 ID，属于外泄面。
 * @limitation 二：非 AppError 一律折叠成 50000 + 固定文案，**连 err.message 都不回传**——
 *              这会让"上游说 connection refused"这类信息在客户端丢失，定位要靠 trace_id 回查日志（F5）。
 *              这是刻意的取舍：可观测性由日志承担，不由错误响应承担。
 * @limitation 三：`AppError` 的 code 参数是 `ErrorCode` 字面量联合，未登记的码在**编译期**就报红；
 *              但运行时从外部进来的数字（如上游返回的错码）仍需 `isErrorCode` 判定后传入，不能直接 `as`。
 *
 * @tradeoff 用"一个错误类 + 一个序列化函数"而不是各业务自定义 Error 子类：
 *           换来零分支的全局兜底与可机读的码，代价是表达力弱——需要携带结构化字段时塞进 details（只进日志）。
 *
 * @see packages/shared/src/errors.ts（码注册表，唯一真源）、技术文档 v0.5 §7、docs/地基搭建清单.md F4
 */
import { errorSpec, httpStatusOf, isErrorCode, type ErrorCode } from '@waselect/shared';
// ⚠️ 必须来自 ports（AJ-102）：CircuitOpenError 是"被熔断"的契约类型。
//    从 adapters 导入会形成 ports → 本文件 → adapters 的传递性反向依赖
//    （本文件在 layeringBlocks 覆盖区外，lint 不报红，靠这条注释与代码审查守）。
import { CircuitOpenError } from './ports/circuit-breaker.js';

/** 对外响应的统一错误体（`data` 仅在需要附带结构化信息时出现，如字段级校验结果）。 */
export interface ErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** 非 AppError 折叠后的兜底码（HTTP 500）。已在 shared 注册表登记，保证"响应里的码一定已登记"。 */
const INTERNAL_ERROR_CODE = 50000;
/** 兜底文案：对用户可见，不含任何内部细节。 */
const INTERNAL_ERROR_MESSAGE = '服务器内部错误';

/**
 * 应用错误：已知业务语义，可安全对外。
 *
 * @param code 必须是 shared 注册表里已登记的码（编译期强制；新增码要先改 shared + 技术文档 §7 + api-contract）
 * @param details 内部细节（SQL、上游响应、内部 ID 等），**只进日志**，`toErrorResponse` 不会输出它
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, details?: unknown) {
    super(errorSpec(code)?.message ?? INTERNAL_ERROR_MESSAGE);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatusOf(code);
    this.details = details;
  }
}

/**
 * 把任意异常序列化为「HTTP 状态 + 响应体」。
 *
 * @security 非 AppError 分支刻意丢弃原始 message 与 stack：内部路径、SQL、上游细节一律不外泄。
 * @returns `{ status, body }`；调用方只需 `res.status(status).json(body)`
 */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return { status: err.httpStatus, body: { code: err.code, message: err.message } };
  }
  // C4：熔断打开抛出的 `CircuitOpenError` 是**暂时性**故障，不该被折叠成 500（"我方内部错误"）。
  //     映射成 50300（上游暂不可用），并把 `retry_after_ms` 透给前端做退避提示。
  //     @why 在这里（通用序列化层）而非各 route 的 catch：熔断可能从支付、对账等**任何**出站链路冒出，
  //           逐条 catch 会漏；这里是唯一对所有异常统一归一化的地方。
  //     @see 地基清单 F12 待办 ③；adapters/http/fetch-client.ts @limitation 六（映射属 app 层）
  if (err instanceof CircuitOpenError) {
    return {
      status: 503,
      body: {
        code: 50300,
        message: errorSpec(50300)?.message ?? '服务暂时不可用，请稍后重试',
        data: { retry_after_ms: err.retryAfterMs },
      },
    };
  }
  return { status: 500, body: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } };
}

/**
 * 供日志使用的结构化错误摘要（**含 details 与 stack**，绝不直接进响应）。
 * @see docs/代码注释规范与日志体系设计.md（流 A：运行日志）
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return {
      err_type: 'AppError',
      err_code: err.code,
      err_message: err.message,
      details: err.details,
    };
  }
  const e = err as Error | undefined;
  return {
    err_type: e?.name ?? typeof err,
    err_message: e?.message ?? String(err),
    err_stack: e?.stack,
  };
}

/**
 * 把外部数字收敛成 ErrorCode（用于回调 / 上游返回的错码）。
 * @returns 已登记返回原码；否则返回 undefined，由调用方决定抛 50000 还是忽略
 */
export function asErrorCode(value: number): ErrorCode | undefined {
  return isErrorCode(value) ? value : undefined;
}
