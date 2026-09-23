/**
 * 职责：小程序端幂等键（`Idempotency-Key`）的生成与"一次意图一个键"的生命周期管理。
 * 边界：只管键的**产生与作废时机**；键怎么用、服务端怎么判重，由 request.js 与服务端决定。
 *
 * @why 支付链路里重试是常态：网络抖动、用户狂点、超时重发。
 *      若每次点击都现生成一个键（曾经的写法是 `mp-${Date.now()}`），
 *      服务端看到的是**两个不同的键** → 建出两张单、可能扣两次款。
 *      跨境退款要跨机构跨币种，纠错成本远高于这里多写 20 行。
 *      真正的规则只有一句：**同一次意图的所有尝试共用一个键；意图完成或内容变了才换键。**
 *
 * @why 不拿 trace_id 当幂等键：两者生命周期不同——
 *      trace_id 是"一次页面操作"的链路（点一次按钮建一次），
 *      幂等键是"一次业务意图"（成功前不换）。混用会让"重试"看起来像"新操作"，
 *      或让"新操作"被当成重放返回旧单。前缀也不同，日志里必须能一眼分辨。
 *
 * @limitation 一：键只存在**页面实例的内存里**，不落本地缓存。
 *      后果：页面销毁重建（如 `redirectTo`、小程序被回收后冷启动）会丢键，
 *      此时用户重试会被当成新意图——这是刻意接受的：
 *      持久化"未完成的下单意图"需要引入草稿单概念，MVP 不做（真要做应落在服务端的草稿/购物车，而非客户端）。
 * @limitation 二：`retire()` 只作废**客户端**的键，不影响服务端 `idempotency_keys` 的 24h 记录。
 *      所以"换键"后的新请求不会被误判成重放（服务端按 `user+route+key` 作用域存），
 *      但同一键在 24 小时内重复出现，服务端仍会重放首次结果——这正是幂等的目的。
 *
 * @tradeoff 不引入"重试次数上限"或"指数退避"：重放是安全的（服务端保证同键只执行一次），
 *           退避策略属于交互体验，交给页面决定；这里只保证"键是对的"。
 *
 * @see server/src/idempotency.ts（@limitation 二：handler 抛错会删占位行，因此失败后必须**保留**键再试）；
 *      docs/地基搭建清单.md F8
 */
import { randomId } from './random-id.js';

/** 前缀 `mpord-`：与 trace_id 的 `mp-` 区分，便于在日志里分辨"这是幂等键不是链路号"。 */
const PREFIX = 'mpord-';

/**
 * 生成一个幂等键。
 * @returns 形如 `mpord-7QK3M9VZ2RX8T4YB6N0C`
 * @note 不含 `:` —— 服务端 `scopeKey()` 用 `:` 拼 `user:route:key`，
 *       键里带冒号会让作用域串产生歧义（不报错，但排查时读不出来）。
 */
export function newIdempotencyKey() {
  return randomId(PREFIX, 20);
}

/**
 * `acquire()` 的返回：把"是不是重试"一并给出来，避免调用方搞错取值顺序
 * （先 `isRetry()` 再 `acquire()` 这种顺序依赖，是给人挖坑）。
 * @typedef {{ key: string, isRetry: boolean }} IntentKey
 */

/**
 * 创建一个"意图级幂等键"的生命周期器。
 *
 * 用法（页面里）：
 * ```js
 * this.intentKey = createIntentIdempotency();          // onLoad 里建，随页面实例
 * const { key, isRetry } = this.intentKey.acquire();   // 发请求前取键
 * ... 成功 → this.intentKey.retire();                  // 完成后作废，下次点击是新意图
 * ... 失败 → 什么都不做，键留着给重试用
 * ```
 *
 * @param {object} [opts]
 * @param {Function} [opts.newKey] 键生成器（**测试注入点**：注入递增序列让断言可复现）
 */
export function createIntentIdempotency(opts = {}) {
  const newKey = opts.newKey ?? newIdempotencyKey;
  /** 当前意图的键；null = 尚无进行中的意图。 */
  let current = null;

  return {
    /**
     * 取本次意图的键：首次调用新建，之后**复用同一个**（重试因此是同一个键）。
     * @returns {IntentKey}
     */
    acquire() {
      if (current === null) {
        current = newKey();
        return { key: current, isRetry: false };
      }
      return { key: current, isRetry: true };
    },

    /**
     * 作废当前键。两处必须调：
     *   1. 请求**成功**后 —— 这次意图已完成，再点是新意图（新的一张单）；
     *   2. 意图的**内容变了**（购物车/地址改了）或用户主动"重新下单" ——
     *      沿用旧键会让"改过内容的新单"被服务端当成重放，原样返回旧单的结果，
     *      症状是"用户改了地址，下单后看到的还是旧地址那张单"。
     */
    retire() {
      current = null;
    },
  };
}
