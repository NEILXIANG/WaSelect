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
 *      ⚠️ IP 进 key 之前还要过 {@link ipKey}（IPv6 归到 /64，B18 / AJ-205）——
 *      两件事是**两个防线**：trust proxy 管"这个 IP 是不是真的"，ipKey 管"真的 IP 有多碎"。
 *      只做前者的话，攻击者用自己真实的 /64 就能换桶。
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

/**
 * 客户端 IP → **限流桶**的键（B18 / AJ-205）。
 *
 * @why 直接用完整 IP 当键，IPv6 等于**没有限流**：一台主机通常拿到整个 /64（2^64 个地址），
 *      攻击者每换一个后缀就是一个全新的桶。管理员登录 5 次/15 分钟的防爆破因此失效，
 *      而它正是 A1（枚举管理员邮箱）的前置防线。
 *      更糟的是第二条：**刷满 key 会触发存储层的 fail-open 驱逐**
 *      （`rate-limit-memory.ts` @limitation 三 → 超过 `RATE_LIMIT_MAX_KEYS` 就删最老的），
 *      于是 attacker 顺手把**其它来源**的计数也清零了。
 *
 * @why 归一到 /64 而不是更粗的 /48：/64 是"一台主机/一个子网"的通用粒度
 *      （SLAAC 的最小分配单位就是 /64），比它粗会误伤同一家运营商的邻居，
 *      比它细则挡不住换后缀。IPv4 原样（一个地址 = 一台主机的现实粒度）。
 * @why `::ffff:a.b.c.d`（IPv4-mapped）**转成 IPv4**：它就是 IPv4，
 *      只是 socket 层用 IPv6 结构装着——不转的话同一个来源在双栈环境里会拿到两个桶
 *      （一会儿 IPv4 一会儿 IPv4-mapped），各算一半配额。
 * @why 不认识的形状**原样返回**：它不是"放行"，只是"不归一"——
 *      该 IP 仍然有自己的桶（甚至更严格），不产生新的绕过面。
 *      拒掉或报错反而会让"取不到 IP"变成一种攻击手段（想办法让解析失败）。
 *
 * @why **先展开 `::` 再取前 64 位**（AJ-234）：原实现是 `split(':').slice(0, 4)`，`::` 在 split 后
 *      是一个空串、占掉一段——`2001:db8::1:2:3:4` 被取成 `2001:db8::1`，接口标识符的第一段混进了桶键，
 *      同一个 /64 能拆出 65536 个桶。Node 给的 `req.ip` 正是压缩写法，所以这不是冷门输入。
 *      @measured(rate-limit.unit.test.ts「压缩写法」, 2026-09-30)：
 *        修复前 `ipKey('2001:db8::1:2:3:4')` = `2001:db8::1::/64`，与 `…::5:2:3:4` 不同桶；
 *        修复后两者都是 `2001:db8:0:0::/64`。
 *
 * @limitation 只做**字符串**处理，不引 `net` 模块：限流键要的是"稳定且够粗"。
 *              解析按 RFC 4291 的文本形态手写（至多一个 `::`、8 段、每段 1–4 位十六进制、
 *              末 32 位可写成点分十进制、可带 `%zone`）；任何一条不满足就**原样返回**，不猜。
 *              `::1`（回环）与 `fe80::…`（链路本地）同样归一到各自的 /64。
 * @limitation 持有 /48 或 /56 前缀的来源仍有 256～65536 个 /64 可用——取 /64 是粒度取舍（见上），
 *              不是上限；真要挡这一类得靠边缘（Cloudflare）的速率规则。
 */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  // IPv4-mapped：`::ffff:1.2.3.4` → `1.2.3.4`（与纯 IPv4 共用同一个桶）
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const groups = expandIpv6(ip);
  if (groups === null) return ip;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * **登录额度**的来源键：IPv6 归到 `/56`（比全站限流的 /64 更粗，PAY3-01）。
 *
 * @why 粒度必须**比全站限流更粗**，因为两件事的对手不同：
 *      全站限流（/64）的对手是"一个来源刷接口"，/64 已经足够；
 *      登录的**来源桶**要防的是"凑够 N 个来源去耗光邮箱桶"——而 IPv6 下凑来源**不要钱**：
 *      一台持有 /56 的主机（常见的家宽前缀委派）就有 256 个 /64，HE 隧道免费给 /48（65,536 个）。
 *      按 /64 计，一台机器每 15 分钟就能往邮箱桶里塞 256×5 次，AJ-243 那句
 *      "要锁死所有人得凑够 6 个来源"等于没设防。
 * @why 只改**登录**，不动全站限流的 /64（报告的原话："这只作用于登录额度"）：
 *      全站限流转粗会把同一家 ISP 的正常用户并进一个桶，代价大于收益；
 *      登录只有一个（或极少数）管理员，并桶的代价小得多。
 * @why 取 /56 而不是更粗的 /48：/56 已经把"单机换 /64"这条路堵死
 *      （256 个来源塌成 1 个），再粗就要开始把真实的**不同组织**并进同一个桶——
 *      那时两个管理员（或管理员与同 ISP 的攻击者）会互相消耗对方的 5 次额度，
 *      反而制造出新的可用性问题。
 * @limitation 持有 /48 的来源仍有 256 个 /56 可用——**这一层不是上限，只是抬高成本**。
 *              真正的上限是邮箱桶（30 次）+ 计数窗口（OPS3-04）+ 边缘侧的
 *              Cloudflare Access 与源站校验（`ORIGIN_VERIFY_SECRET`）。
 *              三者缺一，SEC2-01（单个攻击者可持续锁死管理员登录）就仍然成立。
 */
export function ipKeyForLogin(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const groups = expandIpv6(ip);
  if (groups === null) return ip;
  // /56 = 前 3 段 + 第 4 段的高 8 位（低 8 位清零）
  const fourth = (Number.parseInt(groups[3] ?? '0', 16) & 0xff00).toString(16);
  return `${groups.slice(0, 3).join(':')}:${fourth}::/56`;
}

/**
 * 把 IPv6 文本展开成 8 段（每段去前导零、小写）；不是合法形态返回 null。
 * @why 返回段数组而不是规范化字符串：调用方只要前 4 段，拼回完整地址再拆是多余的一来一回。
 */
function expandIpv6(ip: string): string[] | null {
  // `%zone`（链路本地地址的接口名）不属于地址本身
  let text = ip.split('%')[0] ?? '';
  // 末 32 位写成点分十进制（如 `64:ff9b::192.0.2.33`）：折成两段十六进制
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    const o = v4.slice(2, 6).map(Number);
    if (o.some((n) => n > 255)) return null;
    const hi = ((o[0] ?? 0) << 8) | (o[1] ?? 0);
    const lo = ((o[2] ?? 0) << 8) | (o[3] ?? 0);
    text = `${v4[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null; // 至多一个 `::`
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const gs = part.split(':');
    return gs.every((g) => /^[0-9a-f]{1,4}$/i.test(g))
      ? gs.map((g) => Number.parseInt(g, 16).toString(16))
      : null;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // `::` 至少代表一段零
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

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
  /**
   * 报价/建单/发起支付/小程序登录/短链等公开入口：30 次 / 分钟 / IP，**每个入口独立一个桶**。
   * @why 全量审计 2026-09-26 P1：曾经五处共用 `public.write` 一个桶——用户在购物车里改几次数量
   *      （每次一个报价）+ 建单 + 发起支付就逼近 30，第 31 次登录/短链被 42901；移动网络 CGNAT 下
   *      成百上千用户共享一个出口 IP，共享桶会把无关用户一起拒掉。按入口分桶后配额互不消耗。
   */
  publicWrite: (routeKey: string) => RateLimitRule;
  /**
   * 支付回调：RATE_LIMIT_CALLBACK_PER_MIN（默认 600）次 / 分钟 / IP（四天提交复查 2026-10-16）。
   * @why 回调的来源是**支付机构**而不是买家：Stripe 从少数固定 IP 发出全店所有订单的事件（每笔至少两条），
   *      沿用买家入口的 30/分钟，积压重投或高峰时会被 429 → 机构指数退避（可到小时级）→ 订单在此期间到期关单，
   *      钱到了却只能走迟到付款退款。限流在这里只为给"验签失败刷 error 日志"设上界，额度要按机构的出口算。
   * @limitation 仍是按 IP 计、进程内计数（同 publicWrite）；超限回 429，机构会重投，不丢事件但会延迟。
   */
  payCallback: RateLimitRule;
} {
  return {
    adminLogin: {
      routeKey: 'auth.admin.login',
      limit: config.RATE_LIMIT_LOGIN_PER_15MIN,
      windowMs: 15 * 60_000,
    },
    publicWrite: (routeKey: string) => ({
      routeKey: `public.write.${routeKey}`,
      limit: config.RATE_LIMIT_QUOTE_PER_MIN,
      windowMs: 60_000,
    }),
    payCallback: {
      routeKey: 'pay.callback',
      limit: config.RATE_LIMIT_CALLBACK_PER_MIN,
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
    // B18 / AJ-205：IPv6 必须归到 /64 再进 key（否则一台主机就是 2^64 个桶）
    const w = deps.store.hit(`${rule.routeKey}:${ipKey(ip)}`, rule.windowMs, now);
    if (isAllowed(w, rule.limit)) {
      next();
      return;
    }
    const retryAfter = retryAfterSecOf(w, now);
    res.setHeader('retry-after', String(retryAfter));
    log.warn('rate_limited', {
      http_method: req.method,
      // ⚠️ `req.baseUrl || req.path`，不是 `req.path`（SEC-10）：
      //    本中间件也会被**挂在前缀上**（`mount.ts` 的 `app.use('/api/v1/orders/quote', …)`），
      //    那时 Express 把挂载路径从 req.path 里剥掉了，req.path 恒为 `'/'`——
      //    日志里就只剩"某个路径被限流了"，而限流是按入口分桶的，看不出是哪个桶。
      //    `baseUrl` 是挂载前缀（路由级挂载时为空串，此时回落到 req.path 拿完整路径）。
      http_path: req.baseUrl || req.path,
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
