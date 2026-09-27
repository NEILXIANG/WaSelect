/**
 * 职责：限流的 **Express 中间件与规则表**（I1-U3）——把端口的判定接到请求路径上。
 *
 * @why 规则（哪个入口 / 多少次 / 多大窗口）集中成一张表而不是散在各路由：
 *      "全站哪些入口有限流"必须一眼能看全——散写的话，回答这个问题要遍历所有路由文件，
 *      而漏看的那条恰好就是攻击面（三审 P5：登录路由挂载前限流器必须先落）。
 *
 * @why key 维度是 `routeKey + 客户端 IP`：不同入口的配额互相独立（刷报价不消耗登录配额），
 *      同一入口按来源分摊（一个被攻击的 IP 不影响其它用户）。
 *      ⚠️ `req.ip` 只在 `trust proxy` 层数正确时可信（http.ts @limitation 一，D23）——
 *      层数配错，攻击者改 `X-Forwarded-For` 就等于无限换 key。所以本中间件**绝不**自己读
 *      `X-Forwarded-For`，只用 `req.ip`（它的取值策略在骨架层统一管）。
 *
 * @why 超限走 `AppError(42901)` 而不是直接 `res.status(429)`：响应形状（`{code, message}`）
 *      必须与其它业务错误一致（http.ts 统一兜底），前端不需要为限流单写一套解析。
 *      `Retry-After` 在抛错**之前**写进响应头——兜底只写 body，不动已有头。
 *
 * @limitation 一：计数对**所有请求**生效（含最终 4xx 的）——"先失败 30 次登录"照样消耗配额。
 *              这正是防爆破想要的：失败尝试本来就是攻击载荷。
 * @limitation 二：窗口时长（60s / 900s）写在规则表里而不是配置项：
 *              它与配置变量名（`RATE_LIMIT_QUOTE_PER_MIN` / `RATE_LIMIT_LOGIN_PER_15MIN`）
 *              是**同一语义的两半**，变量名本身已编码窗口；把窗口也做成配置会出现
 *              "名字叫 PER_MIN 实际窗口 10 分钟"的失真。窗口要改 = 语义要改 = 发版。
 * @limitation 三：计数存**进程内存**，因此配额是**每实例**的，不是全局的
 *              （N 个实例 = 攻击者有 N 倍配额；实例重启 = 计数清零）。
 *              MVP 单实例部署（Render Web Starter）下这是可接受的：换成共享存储（Redis/PG）
 *              会为一条限流引入一个**新的可用性依赖**——缓存挂了要不要放行？放行等于没限流，
 *              不放行等于全站 429。要做就在真有多实例、且能回答这个问题之后。
 *              ⚠️ 这也是"跨实例行为无法在单进程里被测"的部分：**不要**为它写假测试
 *              （起两个 store 断言不共享，验的是测试自己），它只能靠这条注释说清。
 *
 * @see ports/rate-limit.ts（判定纯函数）；adapters/rate-limit-memory.ts（存储）；
 *      docs/I1阶段开发实施方案.md §3.3；config.ts（RATE_LIMIT_* 形状校验）
 */
import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { isAllowed, retryAfterSecOf, type RateLimitStore } from '../ports/rate-limit.js';
import type { AppConfig } from '../config.js';

/** 一条限流规则：挂在哪个入口、窗口内允许多少次。 */
export interface RateLimitRule {
  /** 进计数 key 与日志（`routeKey:ip`）。 */
  routeKey: string;
  limit: number;
  windowMs: number;
}

export interface RateLimiterDeps {
  store: RateLimitStore;
  clock: Clock;
  logger: Logger;
}

/**
 * 规则表（唯一出处）。新增"需要限流的入口"时在这里加一条，并在挂载处挂上。
 * ⚠️ "表里有规则但路由没挂"与"路由挂了但表里没有"都是失真——
 *    挂载点与各路由模块同文件（mount.ts / 各 routes 模块），review 时必须一起看。
 */
export function rateLimitRules(config: AppConfig): {
  /** 管理端登录：5 次 / 15 分钟 / IP（D-52；窗口时长见文件头 @limitation 二）。 */
  adminLogin: RateLimitRule;
  /** 报价/小程序登录/短链等高频公开入口：30 次 / 分钟 / IP。 */
  publicWrite: RateLimitRule;
} {
  return {
    adminLogin: {
      routeKey: 'auth.admin.login',
      limit: config.RATE_LIMIT_LOGIN_PER_15MIN,
      windowMs: 15 * 60_000,
    },
    publicWrite: {
      routeKey: 'public.write',
      limit: config.RATE_LIMIT_QUOTE_PER_MIN,
      windowMs: 60_000,
    },
  };
}

/** 生成一条限流中间件（挂在 `app.use(path, …)` 或单个路由上）。 */
export function rateLimiter(deps: RateLimiterDeps, rule: RateLimitRule): RequestHandler {
  const log = deps.logger.child({ module: 'rate-limit' });
  return (req, res, next) => {
    const now = deps.clock.now().getTime();
    // 只读 req.ip（骨架层按 trust proxy 层数取值），绝不自己读 X-Forwarded-For（文件头 @why）
    const ip = req.ip ?? 'unknown';
    const w = deps.store.hit(`${rule.routeKey}:${ip}`, rule.windowMs, now);
    if (isAllowed(w, rule.limit)) {
      next();
      return;
    }
    const retryAfter = retryAfterSecOf(w, now);
    res.setHeader('retry-after', String(retryAfter));
    log.warn('rate_limited', {
      http_method: req.method,
      http_path: req.path,
      result: 'rejected',
      ctx: {
        route_key: rule.routeKey,
        limit: rule.limit,
        window_ms: rule.windowMs,
        retry_after_sec: retryAfter,
      },
    });
    next(new AppError(42901));
  };
}
