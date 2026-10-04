/**
 * 职责：限流存储的**进程内实现**（I1-U3）——一个 Map 装下所有 key 的窗口计数。
 *
 * @why 选进程内实现而不是一步到位 Redis/DB：Render MVP 是**单 web 实例**（D-43 既定拓扑），
 *      进程内计数在单实例下就是全局正确的。为一个还不存在的多实例拓扑引入外部存储，
 *      得到的是"多一个依赖、多一种故障形态"，换不来任何当前收益。
 *
 * @limitation 一（**硬限制，多实例即失效**）：计数只在**本进程**内有效。
 *              扩到第二个实例那天，每个入口的实际限额变成 2× 配置值，且随实例数线性放大——
 *              这是"看起来有限流、实际防线稀释"的静默失效。**扩容前必须换成共享存储实现**
 *              （端口已留好：Redis INCR / DB 行锁都能实现 `RateLimitStore`），
 *              已登记 I1 方案 R-I1-2 与完成报告风险项。
 * @limitation 二：进程重启计数清零。对"防爆破"场景意味着攻击者等一次部署就重置——
 *              可接受：部署是分钟级事件，且登录类另有"连续失败锁定"（账号维度）兜底
 *              （见 ports/rate-limit.ts @limitation 一）。
 * @limitation 三：容量驱逐是 **fail-open**（超上限时先清过期窗口、再驱逐最老的 key）。
 *              被驱逐的 key 计数归零 = 它获得更多配额。之所以仍选 fail-open：
 *              fail-closed（超限 key 全拒）等于让攻击者用"伪造海量源 IP"把所有正常用户
 *              锁在门外（拒绝服务放大器）。IP 轮换本来就能绕过 IP 限流，
 *              驱逐只是把这个事实提前了一点，不引入新攻击面。
 *
 * @see ports/rate-limit.ts（端口与判定纯函数）；docs/I1阶段开发实施方案.md §3.3
 */
import { windowStartOf, type RateLimitStore, type RateLimitWindow } from '../ports/rate-limit.js';

/**
 * key 数上限（**防内存被刷爆**：攻击者轮换源 IP / 伪造 X-Forwarded-For 时，
 * 每个新 IP 一个 key，没有上限的 Map 就是内存炸弹）。
 * @why 10_000 的依据：单 key 约 60B，10k key ≈ 0.6MB，可忽略；
 *      而"同一时刻有 1 万个不同 IP 在访问"对 MVP 已经是真实攻击规模，驱逐策略见 @limitation 三。
 */
export const RATE_LIMIT_MAX_KEYS = 10_000;

export interface MemoryRateLimitStore extends RateLimitStore {
  /** 当前 key 数（测试与容量行为断言用）。 */
  size(): number;
}

export function createMemoryRateLimitStore(opts: { maxKeys?: number } = {}): MemoryRateLimitStore {
  const maxKeys = opts.maxKeys ?? RATE_LIMIT_MAX_KEYS;
  const map = new Map<string, RateLimitWindow>();
  return {
    size: () => map.size,
    hit(key, windowMs, nowMs) {
      let w = map.get(key);
      if (w === undefined || nowMs >= w.resetAtMs) {
        w = { count: 0, resetAtMs: windowStartOf(nowMs, windowMs) + windowMs };
        map.set(key, w);
      }
      w.count += 1;
      if (map.size > maxKeys) {
        // 先清过期窗口（它们已无意义）；仍超上限才驱逐最老的（fail-open，见 @limitation 三）
        for (const [k, v] of map) {
          if (nowMs >= v.resetAtMs) map.delete(k);
        }
        if (map.size > maxKeys) {
          // Map 按插入序迭代：第一个就是最老的未被清理的 key。
          // ⚠️ 这里**曾经**写"当前 key 刚被 set/更新过，不会排在第一个，不会被误删"——
          //    **理由是错的**：`map.set()` 对**已存在**的键只更新值、**不动插入位置**
          //    （实测：`m.set(a);m.set(b);m.set(a)` 之后迭代序仍是 `a,b`）。
          //    本函数里"窗口过期后重新 set"走的正是这条不动位置的路径，
          //    所以当前 key **完全可能**就是第一个。
          //    真正挡住误删的是下面那句 `oldest !== key`——**显式排除**，不是靠顺序保证。
          //    （与 `adapters/identity.ts` 缓存"回写前必须先 delete 自己"是同一个坑的两个位置。）
          // ⚠️ 代价与边界：当前 key 恰是第一个时这一次**不驱逐**，size 停在 maxKeys+1，
          //    下次 hit 才会带走它。我没有构造出 `maxKeys ≥ 1` 时能走到这里的输入
          //    （size > maxKeys 要求上一次驱逐失败，而那又要求上一次走到了这里），
          //    所以它目前是**防御性**的——别因为"看着不可达"就删掉它：
          //    上面那段错误注释正是"以为顺序能保证"删掉它之后的形态。
          const oldest = map.keys().next().value;
          if (oldest !== undefined && oldest !== key) map.delete(oldest);
        }
      }
      return { ...w };
    },
  };
}
