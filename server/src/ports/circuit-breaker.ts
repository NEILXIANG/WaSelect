/**
 * 职责：熔断器（circuit breaker）的**契约与状态机**（F12 第四单元）——纯函数，无状态、无 IO。
 *
 * 边界：只定义"三态怎么迁移"与"哪些失败该计入"；**状态的存放**在 `adapters/http/circuit-breaker.ts`，
 *      与 `fetch-client` 的接线也在那里。本文件不知道 HTTP，也不认识 `fetch`。
 *
 * @why 为什么重试之外还要熔断：重试保护的是**单次抖动**，熔断保护的是**上游持续不可用**。
 *      上游真挂了的时候，重试只会让每个请求各自再打三次——
 *      ① 用户等满 6 秒预算才知道失败（而上游其实 50ms 就返回了"我挂了"）；
 *      ② 我们把流量**加倍**砸向一个正在故障恢复的上游（重试放大故障，是分布式系统里经典的雪崩成因）；
 *      ③ 连接池被这些注定失败的请求占满，连"上游恢复了"都试不出来。
 *      熔断把这些请求在**出发前**就拒掉：快速失败 + 给上游留出恢复窗口。
 *
 * @why 为什么它是**唯一一种"用一个失败换另一个失败"的容错**：
 *      重试错了最多多花几秒；熔断错了是**主动让本来能成功的请求失败**。
 *      所以它判错的代价更高，规矩也更严：只有"上游确实不行"的信号才计入（见 `countsTowardTrip`）。
 *
 * @limitation 一：状态是**进程内**的（存在适配器里）。多实例部署时每个实例各跳各的，
 *              上游看到的是"N 个实例 × 每实例一个探测"。对本项目的量级可接受；
 *              真要全局一致，得把状态放进 Postgres/Redis——那是另一个数量级的复杂度，不做。
 * @limitation 二：**连续计数**而不是滑动窗口失败率。窗口更精确但要存一串时间戳，
 *              而"连续 5 次失败"已经足以表达"上游现在不行"，且状态只有一个整数。
 * @limitation 三：冷却时长**固定**，不会因反复跳闸而变长。于是最坏形态是
 *              "每 cooldownMs 放一个探测请求"——对本项目的调用量（日百单）完全可接受；
 *              若将来出现高频调用，再引入指数冷却。
 *
 * @see ../adapters/http/circuit-breaker.ts（状态存放与接线）；
 *      ./http-client.ts（重试判定，本文件是它的下一层）；
 *      docs/地基搭建清单.md F12；docs/自主决策记录.md AJ-55（重试的上一条）
 */
import type { HttpFailureKind } from './http-client.js';

/** 三态：`closed` 正常放行 / `open` 拒绝一切 / `half_open` 只放探测请求。 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 一条熔断器的全部状态。**刻意只有四个字段**：它是要被存起来、被打印、被测的。 */
export interface CircuitSnapshot {
  state: CircuitState;
  /** 连续失败计数（成功即清零）。 */
  failureCount: number;
  /** 最近一次跳闸的时刻（毫秒）；未跳闸为 null——用 null 而不是 0，避免"0 时刻"被当成有效时间。 */
  openedAtMs: number | null;
  /** half_open 期间已放行的探测请求数。 */
  halfOpenProbes: number;
}

export interface BreakerPolicy {
  /** 连续失败多少次才跳闸。 */
  failureThreshold: number;
  /** 跳闸后多久允许第一个探测请求（毫秒）。 */
  cooldownMs: number;
  /** half_open 期间最多放行几个探测请求。 */
  halfOpenMaxProbes: number;
}

/**
 * 默认策略：连续 5 次失败跳闸、冷却 30 秒、每次只放 1 个探测。
 *
 * @why 阈值 5 而不是 3：与重试策略叠着看——一次请求最多打 3 次（DEFAULT_RETRY_POLICY），
 *      单次抖动通常在 1～2 次内恢复；阈值取 3 会让"一次请求的三次尝试"直接把上游判死，
 *      那等于把重试和熔断做成了同一件事。取 5 意味着"至少跨两个请求都失败"才跳。
 * @why 冷却 30 秒：上游从故障恢复的典型量级是几十秒到几分钟（发布、主从切换）；
 *      太短（几秒）等于没保护，太长（几分钟）会让恢复后的流量迟迟回不来。
 *      ⚠️ 这个数字是**拍的**，拿到真实故障样本后校准——它是配置项，调整不发版。
 * @why 只放 1 个探测：探测的意义是"试一下好了没有"，1 个足够；
 *      放多个会让"刚恢复的上游"立刻被一批请求砸回去。
 */
export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
};

/** 解析不出主机时的兜底桶名。 */
export const UNKNOWN_BREAKER_KEY = 'unknown';

export function initialCircuit(): CircuitSnapshot {
  return { state: 'closed', failureCount: 0, openedAtMs: null, halfOpenProbes: 0 };
}

/**
 * 哪些失败该让上游"背锅"（计入跳闸）。
 *
 * @why **4xx 必须排除**：400/401/402/404 是我们自己传错参数、签名错了、卡被拒，
 *      上游是健康的。把它们计入的表现是"我们一个 bug 把健康的上游判死，
 *      而且 bug 修好后还要等冷却"——一次误伤要赔两次。
 * @why `unknown` 也排除：既然看不懂，就别据此做"拒绝一切"这种强判断。
 *      保守方向的代价是少保护了一点，激进方向的代价是误伤——这里必须选保守。
 * @why 429（rate_limited）**计入**：上游在明说"我现在扛不住"，正是该让出窗口的信号；
 *      注意它与重试策略的关系——429 允许重试（因为它带 Retry-After 语义），
 *      但连续 429 说明"我们整体的量超了"，那就该熔断而不是继续挤。
 */
export function countsTowardTrip(kind: HttpFailureKind): boolean {
  return (
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'server_error' ||
    kind === 'rate_limited'
  );
}

/**
 * 出发前的判定。
 *
 * @returns `allowed` = 是否放行；`next` = 判定后的状态（**不放行时原样返回入参**，见 @why）
 * @why `allowed=false` 时 `next` 必须是**同一个对象引用**（不是新拷贝）：
 *      "看一眼"不应该改变状态——否则健康检查、日志打印这类只读动作
 *      会悄悄消耗掉 half_open 的探测名额，表现为"探测请求数怎么总是不够"。
 */
export function circuitBefore(
  s: CircuitSnapshot,
  p: BreakerPolicy,
  now: number,
): { allowed: boolean; next: CircuitSnapshot } {
  if (s.state === 'closed') return { allowed: true, next: s };

  if (s.state === 'open') {
    const openedAt = s.openedAtMs;
    // openedAt 为 null 意味着"状态说 open 却没有跳闸时刻"——只能是不变量被破坏了，
    // 这里选择**当作刚跳闸**（重新计时）而不是放行：放行会让一个坏状态静默通过。
    if (openedAt === null || now - openedAt < p.cooldownMs) return { allowed: false, next: s };
    return {
      allowed: true,
      next: {
        state: 'half_open',
        failureCount: s.failureCount,
        openedAtMs: openedAt,
        halfOpenProbes: 1,
      },
    };
  }

  // half_open
  if (s.halfOpenProbes >= p.halfOpenMaxProbes) return { allowed: false, next: s };
  return { allowed: true, next: { ...s, halfOpenProbes: s.halfOpenProbes + 1 } };
}

/**
 * 一次尝试结束后的状态迁移。
 *
 * @param ok true = 这次尝试成功（拿到 2xx/3xx）
 */
export function circuitAfter(
  s: CircuitSnapshot,
  p: BreakerPolicy,
  now: number,
  ok: boolean,
): CircuitSnapshot {
  if (ok) return initialCircuit();

  // half_open 的探测失败 → 立刻再跳，且**重新计时**（沿用旧时刻会让冷却形同虚设）
  if (s.state === 'half_open') {
    return { state: 'open', failureCount: s.failureCount, openedAtMs: now, halfOpenProbes: 0 };
  }

  const failureCount = s.failureCount + 1;
  if (s.state === 'open' || failureCount >= p.failureThreshold) {
    return { state: 'open', failureCount, openedAtMs: now, halfOpenProbes: 0 };
  }
  return { ...s, failureCount };
}

/**
 * URL → 熔断器分组键（**上游主机**）。
 *
 * @why 粒度写在契约里而不是实现里：这是"什么算同一个上游"的判定，改了它就改了熔断的行为——
 *      按 URL 分（太细）→ 几乎永远跳不了闸；按"全局一个"（太粗）→ 一个接口挂了连坐全部。
 *      默认**按主机**，与"上游 = 一个机构的一套服务"这个心智一致。
 * @why 解析失败落到一个固定桶（`unknown`）而不是抛错或每次新建一个桶：
 *      抛错会让"URL 拼错"变成熔断层的崩溃；每次新桶等于关闭了熔断。
 */
export function breakerKey(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return UNKNOWN_BREAKER_KEY;
  }
}
