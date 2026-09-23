/**
 * 职责：小程序端随机 ID 串的生成（Crockford Base32）。
 * 边界：只产出"形状合规的随机串"，不解释它的业务含义——
 *      trace_id 是链路、幂等键是意图，语义由各自模块负责。
 *
 * @why 存在的唯一理由是"字母表只写一份"。trace_id 与幂等键都要 Base32 随机串，
 *      若两处各抄一遍 ALPHABET，改了一处另一处不变，症状是"某个 ID 突然不合服务端形状"，
 *      而服务端对不合形状的 trace_id 是**静默丢弃并新建**（@see server/src/http.ts）——
 *      不报错、不失败，只是日志永远串不起来，排障时无从下手。
 *
 * @limitation 一：用 `Math.random()`，**不是加密随机**。
 *              trace_id / 幂等键都不是安全凭证，所以够用；
 *              ⚠️ 但禁止用它生成 token、签名、会话 ID、兑奖码等安全用途
 *              （服务端侧同款限制见 packages/shared/src/id.ts）。
 * @limitation 二：不复用 `packages/shared/src/id.ts`（那边是 mulberry32 确定性种子）。
 *              小程序目录是**独立构建产物**，不能 import 仓库外的模块，
 *              所以这里保留自己的一份实现——代价是 20 行重复，换来小程序可独立上传。
 * @tradeoff 长度固定 20 位（32^20 ≈ 1.2e30）：碰撞概率远低于"用户手滑"概率，
 *           不值得为此引入 UUID 依赖或计数器持久化。
 *
 * @see server/src/http.ts（TRACE_ID_PATTERN 字符集与长度要求）
 */
/** Crockford Base32：去掉 I / L / O / U，避免手抄时与 1 / 0 混淆。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 默认随机段长度；与前缀相加后仍落在服务端 8–64 的区间内。 */
const DEFAULT_LENGTH = 20;

/**
 * 生成一个带前缀的随机 ID。
 * @param {string} prefix 前缀（标明用途/来源端，便于在聚合日志里一眼区分）
 * @param {number} [length] 随机段长度，默认 20
 * @returns {string} 形如 `mp-7QK3M9VZ2RX8T4YB6N0C`
 */
export function randomId(prefix, length = DEFAULT_LENGTH) {
  let out = prefix;
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** 字符集（供单测断言形状，避免测试里再抄一份字母表）。 */
export const ID_ALPHABET_CHARS = ALPHABET;
