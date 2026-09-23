/**
 * 职责：身份状态查询（D25）——把"这个 token 的主人现在还有效吗"这件事从 JWT 里剥离出来。
 *
 * @why JWT 是无状态的：签出去就收不回来。于是"改密 / 封禁 / 注销"之后，
 *      旧 token 在有效期（管理员 12 小时）之内**依然能进后台**——
 *      泄露事件的处置窗口被硬生生拉到 12 小时，这是不可接受的（复现缺陷 D25）。
 *      修法只能是"校验时回源查一次状态"，而这件事必须做成**端口**而不是内联 SQL：
 *      ① 鉴权骨架（auth.ts）不该认识数据库（ADR-28 的依赖方向）；
 *      ② 单元测试要能在不启库的情况下验证"封禁后拒访问"这条规则。
 *
 * @tradeoff 每个请求多一次查询 vs 即时吊销：用 60 秒进程内缓存把代价压到"每 60 秒一次"，
 *           换来的是"改密后最多 60 秒失效"。60 秒不是安全上界而是工程折中——
 *           真要秒级失效就得上 Redis 或在网关层做，MVP 阶段不值得。
 *
 * @limitation 缓存是**每进程**的。多实例部署时，一个实例上的封禁在其他实例上最多延迟 60 秒生效。
 *             Render 单实例阶段无影响；将来扩容要把缓存换成共享存储（Redis）或把 TTL 降到几秒。
 *
 * @see server/src/auth.ts（requireRole 用它）、migrations/003（users.token_ver）
 */
import type { Db } from './db.js';

/** 一个用户当前的身份状态。 */
export interface IdentityRecord {
  /** token 版本（users.token_ver）：改密 / 封禁时 +1，旧 token 即失效。 */
  tokenVer: number;
  /** 封禁时间；null = 未封禁。 */
  blockedAt: Date | null;
  /**
   * 是否管理员（users.is_admin）。
   * @why token 里的 role 是签发时写死的，"撤销某人的管理员权限"改的是库里的这一列——
   *      不回源带上它，撤权要等 token 自然过期（12 小时越权窗口，二审 N9）。
   */
  isAdmin: boolean;
}

/**
 * 身份状态查询端口。
 * @returns 记录；**null 表示这个 sub 已经不存在**（注销 / 数据被清），调用方应按"凭证失效"处理。
 */
export interface IdentityCheck {
  load(sub: string): Promise<IdentityRecord | null>;
}

/** 缓存默认时长（毫秒）：60 秒（见文件头 @tradeoff）。 */
export const IDENTITY_CACHE_TTL_MS = 60_000;

/**
 * 缓存条目上限（N29）。
 * @why 无界 Map 是内存泄漏面：每个不同的 sub（包括恶意伪造的不存在用户——
 *      "查不到"也会被缓存，见 withIdentityCache @limitation）都永久占一格。
 *      10k 条 × 每条几十字节 ≈ 不到 1MB，而攻击者要灌爆它得先造 10k 个合法签名的 token——
 *      造价远高于收益。
 */
export const IDENTITY_CACHE_MAX_ENTRIES = 10_000;

/**
 * Postgres 实现。
 *
 * @why 只查两列、走主键：这是**每个请求**都可能走的路径（有缓存时是每 60 秒），
 *      任何多余的列或联表都会在最热的路径上累加成本。
 * @limitation `users` 表里管理员与小程序用户是同一张表（MVP 单表 + is_admin），
 *              所以这里不区分角色；将来若拆表，本函数是唯一的改动点。
 */
export function createIdentityCheck(db: Db): IdentityCheck {
  return {
    async load(sub: string): Promise<IdentityRecord | null> {
      const rows = await db`select token_ver, blocked_at, is_admin from users where id = ${sub}`;
      const row = rows[0];
      if (row === undefined) return null;
      return {
        tokenVer: Number(row.token_ver),
        blockedAt: (row.blocked_at as Date | null) ?? null,
        isAdmin: row.is_admin === true,
      };
    },
  };
}

/**
 * 给任意 IdentityCheck 加一层进程内 TTL 缓存（带上限的 LRU）。
 *
 * @why 不加缓存时，每个带 token 的请求都要查一次库——而 JWT 的全部优点（零 IO）就被抵消了。
 *      60 秒 TTL 的语义是"最坏情况：改密后 60 秒内旧 token 仍可用"，把这个数字显式写出来，
 *      比"默认缓存一下"更容易被日后重新评估。
 * @why LRU 用 Map 的插入序实现（命中时 delete+set 提到最新）：零依赖、O(1)，
 *      代价是"近似 LRU"——过期但未访问的条目要等逐出时才清，不主动扫描。
 * @limitation 缓存的是**成功**结果，也缓存"查不到"（null）——
 *              否则"不存在的用户"会被每个请求打一次库，成为放大攻击面。
 *              代价：刚被创建的用户最多 60 秒后才认得（登录流程本身会走非缓存路径）。
 */
export function withIdentityCache(
  check: IdentityCheck,
  ttlMs: number = IDENTITY_CACHE_TTL_MS,
  maxEntries: number = IDENTITY_CACHE_MAX_ENTRIES,
): IdentityCheck {
  const cache = new Map<string, { at: number; record: IdentityRecord | null }>();
  return {
    async load(sub: string): Promise<IdentityRecord | null> {
      const hit = cache.get(sub);
      const now = Date.now();
      if (hit !== undefined && now - hit.at < ttlMs) {
        // 命中刷新新旧（Map 迭代序 = 插入序，尾部最新）：热点用户不该被逐出
        cache.delete(sub);
        cache.set(sub, hit);
        return hit.record;
      }
      const record = await check.load(sub);
      if (cache.size >= maxEntries) {
        // 逐出最久未用（迭代序第一个）。过期但未被访问的条目排在最前，会被最先带走
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(sub, { at: now, record });
      return record;
    },
  };
}
