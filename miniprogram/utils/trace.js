/**
 * 职责：小程序端链路 ID（`trace_id`）的生成。
 * 边界：只生成 ID，不负责存储与上报。
 *
 * @why 服务端对 `x-trace-id` 的形状要求是 `^[A-Za-z0-9._:-]{8,64}$`，不符即**丢弃并新建**。
 *      客户端若生成了不合形状的值，症状是"小程序里看到的链路 ID 和服务端日志里的对不上"——
 *      不报错、不失败，只是排障时怎么都串不起来。所以字符集必须在这里就与服务端对齐。
 *
 * @limitation 用 `Math.random()` 而非加密随机：trace_id 只用于日志关联，不是安全凭证。
 *              ⚠️ **禁止**用它生成 token、签名、会话 ID 等安全用途（shared/id.ts 同款限制）。
 *
 * @see server/src/http.ts（TRACE_ID_PATTERN）；docs/代码注释规范与日志体系设计.md（统一字段）
 */
import { randomId } from './random-id.js';

/** 前缀 `mp-` 标明来源端，便于在聚合日志里一眼区分"小程序发起"与"服务端/回调"。 */
const PREFIX = 'mp-';

/**
 * 生成一个新的链路 ID。
 * @returns 形如 `mp-7QK3M9VZ2RX8T4YB6N0C`（总长 23，落在服务端 8–64 的区间内）
 */
export function newTraceId() {
  return randomId(PREFIX, 20);
}
