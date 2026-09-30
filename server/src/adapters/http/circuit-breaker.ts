/**
 * 职责：熔断器的**状态存放**（F12 第四单元）——把 `ports/circuit-breaker.ts` 的纯状态机
 *      "放到一个能跨请求活下来的地方"，并给出跳闸/恢复的信号。
 *
 * 边界：只管状态与信号；三态怎么迁移在端口里，什么时候调用它在 `fetch-client.ts` 里。
 *
 * @why 为什么状态机与存放要分开：状态机是**判定规则**（哪些失败计入、边界是"含"还是"不含"），
 *      它必须能被纯函数测到；存放是**进程级的副作用**（一个 Map）。
 *      混在一起的话，"三态迁移对不对"就只能靠"睡 30 秒"来测——那既慢又不稳定。
 *
 * @limitation 一：状态在**进程内存**里（一个 Map）。进程重启即全部复位为 closed——
 *              这是可接受的方向（重启后重新学习上游状态），但意味着
 *              "刚重启的实例会再打一次故障上游"。多实例部署时每个实例各有一份，
 *              上游看到的是"N 个实例 × 每实例一个探测"。
 * @limitation 二：Map **无上限**。key 来自 URL 的主机，正常只有个位数；
 *              但若出现"每次请求一个新子域"这类形态会无限增长。
 *              真出现时按 LRU 收口，现在不做（没有真实场景，提前做是猜）。
 * @limitation 三：**不持久化**。熔断状态不是业务数据，重启丢了不需要补；
 *              持久化反而会带来"重启后拿着昨天的状态拒绝今天的请求"这一更糟的形态。
 *
 * @see ../../ports/circuit-breaker.ts（状态机与契约）；./fetch-client.ts（调用方）；
 *      docs/地基搭建清单.md F12；docs/自主决策记录.md AJ-61
 */
import type { Logger } from '../../logger.js';
import type { HttpFailureKind } from '../../ports/http-client.js';
import {
  circuitAfter,
  circuitBefore,
  countsTowardTrip,
  DEFAULT_BREAKER_POLICY,
  initialCircuit,
  type BreakerPolicy,
  type CircuitSnapshot,
  type CircuitState,
} from '../../ports/circuit-breaker.js';

/**
 * `CircuitOpenError` 的定义已上移到 `ports/circuit-breaker.ts`（AJ-102）：
 * 它是"被熔断"的契约类型，errors.ts（分层规则覆盖区外）也要 import 它，
 * 定义留在本文件会形成 `ports → errors → adapters` 的传递性反向依赖。
 * 这里 re-export 仅为兼容既有引用点（fetch-client 与测试），**新代码请从 ports 导入**。
 */
export { CircuitOpenError } from '../../ports/circuit-breaker.js';

export interface CircuitBreakerOptions {
  policy?: BreakerPolicy;
  /** 时钟（默认 `Date.now`）。测试注入以把 30 秒冷却走完。 */
  now?: () => number;
  /** 跳闸 / 恢复的日志出口；不传则不记。 */
  logger?: Logger | undefined;
  /** 状态迁移回调（告警接这里；也可用于测试断言）。 */
  onStateChange?: ((key: string, from: CircuitState, to: CircuitState) => void) | undefined;
}

/** 出发前的判定结果。 */
export interface CircuitGate {
  allowed: boolean;
  state: CircuitState;
  /** 不放行时还要等多久（放行时为 0）。 */
  retryAfterMs: number;
}

export interface CircuitBreaker {
  /** 出发前调用。**不放行时不改变状态**（见端口里 `circuitBefore` 的 @why）。 */
  before(key: string): CircuitGate;
  /**
   * 一次尝试结束后调用。
   * @param kind `none` = 成功；其余按 `countsTowardTrip` 判定是否计入。
   */
  after(key: string, kind: HttpFailureKind): void;
  /** 当前状态（排障与测试用）。 */
  snapshot(key: string): CircuitSnapshot;
  /** 全部 key 的快照：`/readyz` 与"到底是谁在拒绝"这类问题用。 */
  snapshots(): Record<string, CircuitSnapshot>;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  const policy = opts.policy ?? DEFAULT_BREAKER_POLICY;
  const now = opts.now ?? Date.now;
  const logger = opts.logger;
  const onStateChange = opts.onStateChange;
  const states = new Map<string, CircuitSnapshot>();

  /** 写入并（在状态真的变了时）发信号。 */
  function commit(key: string, from: CircuitSnapshot, to: CircuitSnapshot): void {
    states.set(key, to);
    if (from.state === to.state) return;
    onStateChange?.(key, from.state, to.state);
    if (logger === undefined) return;

    if (to.state === 'open') {
      // 用 warn：这是"我们开始拒绝请求了"，是需要人知道的事，不能只在 debug 里
      logger.warn('circuit_open', {
        ctx: { key, threshold: policy.failureThreshold, cooldown_ms: policy.cooldownMs },
      });
    } else if (to.state === 'closed') {
      // 用 info：恢复同样要有信号——否则"已经好了"这件事没有任何痕迹
      logger.info('circuit_closed', { ctx: { key } });
    }
  }

  return {
    before(key) {
      const current = states.get(key) ?? initialCircuit();
      const { allowed, next } = circuitBefore(current, policy, now());
      commit(key, current, next);
      if (allowed) return { allowed: true, state: next.state, retryAfterMs: 0 };
      const openedAt = next.openedAtMs;
      // openedAt 为 null 只能来自"状态被别处写坏了"：端口已按 fail-closed 判定不放行，
      // 这里给不出准确的等待时间就报 0——报 0 比报一个凭空的数字诚实。
      // 防御分支（AJ-37 口径）：正常路径不可达，显式 ignore 并留理由，不写假测试。
      /* v8 ignore next 3 */
      if (openedAt === null) {
        return { allowed: false, state: next.state, retryAfterMs: 0 };
      }
      // `open`：距冷却结束还有多久；`half_open`（名额用完）：距探测超时还有多久——
      // 两种状态下 `openedAtMs` 都是"本轮计时起点"，同一个算式成立（R-01 / AJ-222）。
      const retryAfterMs = Math.max(0, policy.cooldownMs - (now() - openedAt));
      return { allowed: false, state: next.state, retryAfterMs };
    },

    after(key, kind) {
      /**
       * `unknown` **完全不动状态**（B4 / AJ-200）。
       * @why 原来走的是"不计入 ⇒ 当作成功 ⇒ 复位计数"：一个看不懂的失败
       *      （认不出的异常形状、1xx/3xx）会把已经攒下的连续失败**清零**，
       *      于是"上游一直在坏、中间夹着几次认不出的失败"永远跳不了闸——
       *      熔断在最需要它的时候是瞎的。
       *      它也不该计入跳闸（`countsTowardTrip` 已排除，理由见端口的 @why：
       *      看不懂的东西不能用来做"拒绝一切"这种强判断）。
       *      两个方向都不是 ⇒ 唯一诚实的做法是**什么都不做**。
       */
      const current = states.get(key) ?? initialCircuit();
      if (kind === 'unknown') {
        /**
         * 例外：**half_open 的探测**得到 unknown 时，把名额退回去（R-01 / AJ-222）。
         * @why "什么都不做"在 closed / open 下是对的，在 half_open 下却是**卡死**：
         *      探测名额已被这次请求占用，不回写就没人释放它。退回名额 = 当这次探测没发生过
         *      ——既不据此恢复（看不懂不能当成功），也不据此再跳闸（看不懂不能当失败），
         *      下一个请求接着探测。这与上面"两个方向都不是"的原则是同一条。
         */
        if (current.state === 'half_open' && current.halfOpenProbes > 0) {
          commit(key, current, { ...current, halfOpenProbes: current.halfOpenProbes - 1 });
        }
        return;
      }
      // ⚠️ "不计入"等价于"这次是好的"：4xx 是上游正确地答复了一个错误请求，
      //    说明它活着；half_open 的探测若返回 4xx，也必须据此复位——
      //    否则 half_open 的探测名额用完又不回到 open，会**永久卡住**（再也放不了行）。
      const ok = !countsTowardTrip(kind);
      commit(key, current, circuitAfter(current, policy, now(), ok));
    },

    snapshot(key) {
      return states.get(key) ?? initialCircuit();
    },

    snapshots() {
      return Object.fromEntries(states);
    },
  };
}
