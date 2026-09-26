/**
 * 职责：**限流端口**（I1-U3）——窗口计数的状态形状、存储接口、放行判定与 Retry-After 计算。
 *
 * @why 判定逻辑（纯函数）与存储（接口）分开，与本仓 http-client 的重试判定同构：
 *      "怎么算"是契约，"存哪"是实现。固定窗口的三个语义（窗口起点 / 第 N 次放行 / Retry-After）
 *      若散在中间件与适配器里各写一份，两处必漂移——而限流漂移的形态是
 *      "某个入口限 31 次才拒、另一个限 29 次就拒"，不报错、只在压测或攻击时现形。
 *
 * @why 用**时钟对齐的固定窗口**而不是滑动窗口/令牌桶：
 *      ① 语义一句话能说清（"每分钟 30 次"），运营与用户都能预期；
 *      ② 内存实现只需一个 Map，无定时器、无后台清扫线程；
 *      ③ 边界突刺（窗口交界处 2×limit 次）是已知代价——MVP 的限流目的是
 *         防"脚本爆破登录/刷报价"而不是精确控流，2× 突刺不改变攻击成本的数量级。
 *
 * @limitation 一：计数维度只有"窗口内次数"，不区分"成功/失败"请求。
 *              登录类的"连续失败 N 次锁定"是**另一套机制**（账号维度、契约 /auth/admin/login
 *              的"连续失败 5 次锁 15 分钟"），别指望本端口实现它——本端口只管"太频繁"。
 * @limitation 二：`hit` 是**先计数后判定**：超限的那次请求也计入窗口。
 *              换来实现无需"读-判-写"两步（并发下没有不原子的问题）；
 *              代价是持续超限会把窗口一直顶在满格——这正是想要的行为（持续攻击持续被拒）。
 *
 * @see adapters/rate-limit-memory.ts（进程内实现）；app/rate-limit.ts（Express 中间件）；
 *      docs/I1阶段开发实施方案.md §3.3；三审 P5
 */
/** 一个 key 在某个窗口内的计数状态。 */
export interface RateLimitWindow {
  /** 本窗口已计次数（含本次 hit）。 */
  count: number;
  /** 本窗口结束时刻（ms epoch，**不含**——此刻起下一次 hit 计入新窗口）。 */
  resetAtMs: number;
}

/**
 * 窗口计数存储。`hit` 必须**原子地完成"读当前窗口 + 计数 +1"**——
 * 实现方自己保证（内存实现靠单线程事件循环；将来的 Redis/DB 实现靠 INCR 或行锁）。
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number, nowMs: number): RateLimitWindow;
}

/** 时钟对齐的窗口起点：`windowMs=60_000` 时，12:00:37 落在 12:00:00 这个窗口。 */
export function windowStartOf(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** 放行判定：第 limit 次放行，第 limit+1 次拒绝（"每分钟 30 次"= 第 30 次还能过）。 */
export function isAllowed(w: RateLimitWindow, limit: number): boolean {
  return w.count <= limit;
}

/**
 * 拒绝时的 Retry-After（秒）。**至少 1 秒**——返回 0 会让客户端立即重试，
 * 那等于把"限流"变成"请马上再来一次"，比不限还糟（多一次握手、多一条日志）。
 */
export function retryAfterSecOf(w: RateLimitWindow, nowMs: number): number {
  return Math.max(1, Math.ceil((w.resetAtMs - nowMs) / 1000));
}
