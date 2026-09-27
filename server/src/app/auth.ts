/**
 * 职责：鉴权骨架（F6b）——token 签发/校验、口令哈希、角色守卫中间件。
 * 边界：只做"你是谁、你能不能进"；**不做**登录业务（code2session、管理员登录流程属业务期）。
 *
 * @why 鉴权做成骨架而不是等业务期再写：它是唯一的"横切安全面"，晚做就意味着中间写的所有路由
 *      都要回头补守卫；而补守卫最容易漏的是"忘了补"的那一个（管理端接口泄露的代价最大）。
 *
 * @limitation 一：JWT 用 HS256 + 单一密钥，且**不做服务端的 token 黑名单**。
 *              后果：登出 / 封禁后旧 token 在 exp 之前仍然有效。MVP 可接受（影响窗口 = token 有效期）；
 *              若将来需要即时失效，改为在 `users.token_version` 上做版本比对（F7 之后有库了才能做）。
 * @limitation 二：口令哈希用 bcryptjs（纯 JS）。比 argon2id 弱、比原生 bcrypt 慢约 3–5 倍。
 *              选它是因为无需本地编译（本机 npm install 常被资源看门狗杀，原生模块编译是重灾区）；
 *              管理员登录是低频操作，性能无所谓。cost 固定 10，写在这里以便将来统一调。
 * @limitation 三：`requireRole` 只判角色，不判"这个管理员能不能改这张单"——那是授权（F10 之后的业务规则），
 *              骨架只保证"没 token 进不来、user token 进不了 admin 接口"。
 *
 * @tradeoff 用无状态 JWT 而非会话表：换来零 DB 读、横向扩容无痛；
 *           代价就是上面 @limitation 一的"无法即时失效"，记录在案，届时按标记的方式补。
 *
 * @see 技术文档 v0.5 §5（鉴权）、D-52（管理端在 Cloudflare Access 之后）、docs/地基搭建清单.md F6b
 */
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors.js';
import { patchContext } from '../context.js';
import type { IdentityCheck } from '../adapters/identity.js';

/** 角色：小程序用户与管理员是两套完全独立的入口（ADR-21：管理端为独立 Web）。 */
export type Role = 'user' | 'admin';

/** 通过鉴权后的身份。 */
export interface Principal {
  /** 内部用户 ID（users.id 或 admins.id），不是 openid——openid 不进 token（脱敏红线）。 */
  sub: string;
  role: Role;
  /** 签发时写入的 token 版本：改密/封禁/撤权后回源比对 `users.token_ver`，不等自然过期（D25，已生效）。 */
  ver?: number | undefined;
}

export interface AuthConfig {
  /** JWT 密钥（≥32 字符，来自 JWT_SECRET）。 */
  secret: string;
  /** 签发者，用于隔离环境（dev/stg/prod 互不信任）。 */
  issuer?: string | undefined;
  /** 有效期（秒）。 */
  ttlSec?: number | undefined;
}

/**
 * 默认有效期：**技术文档 v0.5 §5 的口径**——用户 7 天（`aud=mp`）、管理员 **12 小时**（`aud=admin`）。
 *
 * @why 曾经写的是管理员 8 小时，与文档不一致。这类"代码与文档差一点"的偏差最危险：
 *      它不会让任何测试变红（两边都能自圆其说），只会在某天有人拿着文档去核对 token 有效期时
 *      才发现，而那时已无法判断"到底是文档错了还是代码错了"。所以这里直接引文档条款号，
 *      并在测试里断言具体秒数（43200），让偏差在 CI 就暴露。
 */
export const DEFAULT_TTL_SEC: Readonly<Record<Role, number>> = {
  user: 7 * 24 * 3600,
  admin: 12 * 3600,
};

/**
 * JWT 受众（`aud`）：小程序用户与管理端各一个取值，与技术文档 §5 的 `aud=mp` / `aud=admin` 一致。
 *
 * @why 只靠 token 里的 `role` 字段区分身份是不够的：`role` 是我们自己塞进 payload 的业务字段，
 *      而 `aud` 是 JWT **标准声明**，由验签库在校验阶段强制比对——攻击者即使拿到一个合法签名、
 *      能改 payload 的场景（例如将来误用无签名算法、或另一个服务共用了同一把密钥），
 *      也过不了 `aud` 这一关。属于纵深防御，不是因为"role 校验已经够了"。
 * @limitation `aud` 不防"同一把密钥、同一受众"的两个服务互认——那是 `issuer` 的职责（见 AuthConfig.issuer）。
 */
export const AUDIENCE: Readonly<Record<Role, string>> = {
  user: 'mp',
  admin: 'admin',
};

/** bcrypt cost：10 是纯 JS 实现下"安全与响应"的平衡点，改这里要同步压测登录耗时。 */
const BCRYPT_COST = 10;

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * 签发 token。
 * @param principal 身份（sub + role）；openid / 邮箱等标识一律不写进 token（token 会被前端存着）
 */
export async function signToken(principal: Principal, cfg: AuthConfig): Promise<string> {
  // 先校验身份本身：角色非法时 DEFAULT_TTL_SEC[role] 是 undefined，会算出 NaN 过期时间，
  // 而 jose 只在签名那一步才报"Invalid setExpirationTime input"——错误信息完全指不到根因。
  // 这里硬失败，让"签发了一个角色不明的 token"在开发期就炸，而不是等到线上验签失败。
  if (principal.role !== 'user' && principal.role !== 'admin') {
    throw new TypeError(`role 必须是 user 或 admin，收到 ${String(principal.role)}`);
  }
  if (typeof principal.sub !== 'string' || principal.sub.length === 0) {
    throw new TypeError('sub 必须是非空字符串');
  }
  const ttl = cfg.ttlSec ?? DEFAULT_TTL_SEC[principal.role];
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: principal.role, ver: principal.ver ?? 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.sub)
    .setIssuer(cfg.issuer ?? 'waselect')
    .setAudience(AUDIENCE[principal.role])
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(keyOf(cfg.secret));
}

/**
 * 校验 token；任何失败（过期 / 签名错 / 密钥不对 / 受众不符 / 角色不符）统一抛 40101。
 *
 * @param expect 期望角色。传入时会额外校验 `aud` 与该角色匹配，不符 → **40301**（见下）。
 *               不传则只要求受众属于这两者之一（用于"先拿到身份、再决定怎么走"的调用点）。
 * @security 不区分**验签失败**的原因对外暴露——细分原因等于给攻击者一个"这个 token 只是过期了"的提示。
 *
 * @tradeoff 受众不符返回 **403 而不是 401**：token 已通过验签（确实是本公司签发的合法凭证），
 *           只是不该用于这个入口。返回 401 会让管理端误以为"登录失效"而触发重新登录，
 *           掩盖真正的问题（前端把用户 token 发给了管理端接口）。
 *           代价：jose 无法在验签阶段直接拒掉（那样只能给 401），`aud` 比对改在验签之后手工做——
 *           安全性等价（签名已验过，比对在同一函数内、无提前 return），语义更好。
 */
export async function verifyToken(
  token: string,
  cfg: AuthConfig,
  expect?: Role,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyOf(cfg.secret), {
      issuer: cfg.issuer ?? 'waselect',
      // 受众必须是本项目这两个取值之一：挡掉"共用同一把密钥的另一个服务"签发的 token
      audience: [AUDIENCE.user, AUDIENCE.admin],
      // 显式算法白名单：防算法替换类攻击（如 RS256→HS256 混淆）。
      // 注：jose 本身就不实现 alg=none（unsecured JWT），所以这不是唯一防线，是纵深防御——
      // 保留它的真正理由是"换库或换人时不会悄悄失去这道约束"。
      algorithms: ['HS256'],
      // 三审 S3：exp / iat 必须存在——签发侧总带，但校验侧不强制的话，任何一次漏写
      //（未来的脚本、另一条签发路径）就是一枚永久有效的 token。
      requiredClaims: ['exp', 'iat'],
    }));
  } catch {
    throw new AppError(40101);
  }
  const principal = toPrincipal(payload);
  if (expect !== undefined && payload.aud !== AUDIENCE[expect]) {
    throw new AppError(40301, {
      expected_audience: AUDIENCE[expect],
      actual_audience: payload.aud,
    });
  }
  return principal;
}

function toPrincipal(payload: JWTPayload): Principal {
  const role = payload.role;
  if (payload.sub === undefined || (role !== 'user' && role !== 'admin')) {
    throw new AppError(40101);
  }
  return { sub: payload.sub, role, ver: typeof payload.ver === 'number' ? payload.ver : undefined };
}

/**
 * 从 Authorization 头取 Bearer token。
 * @returns token；缺失或格式错误返回 undefined（由调用方决定是 401 还是放行）
 */
export function bearerOf(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * 角色守卫中间件：校验通过后在 `req.auth` 上挂身份，并把 user_id/actor 写进日志上下文。
 *
 * @param role 期望角色；`user` 路由用 'user'，管理端路由一律 'admin'
 * @param cfg 鉴权配置
 * @param identity 身份状态查询（D25）。**不传则不查库**——保留给单元测试（生产装配一律传，见 mount.ts）；
 *                 生产装配必须传（main.ts），否则改密/封禁无法即时生效。
 */
export function requireRole(
  role: Role,
  cfg: AuthConfig,
  opts?: { identity?: IdentityCheck | undefined },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearerOf(req);
    if (token === undefined) {
      next(new AppError(40101));
      return;
    }
    // 把期望角色传下去：`aud` 由 jose 在验签阶段强制比对，比"验完再看 role"早一步拒绝
    verifyToken(token, cfg, role)
      .then(async (principal) => {
        if (principal.role !== role) {
          // 角色不符是 403 而不是 401：已认证但无权，前端应隐藏入口而不是重新登录
          next(new AppError(40301, { expected: role, actual: principal.role }));
          return;
        }
        // ── 回源查身份状态（D25）：JWT 验签通过 ≠ 这个人现在还能用 ──────────────
        if (opts?.identity !== undefined) {
          const record = await opts.identity.load(principal.sub);
          if (record === null) {
            // 人没了（注销 / 数据清理）：token 本身是合法签发的，但指向的主体已不存在
            next(new AppError(40101));
            return;
          }
          if (record.blockedAt !== null) {
            // 封禁：403 而不是 401。返回 401 会让前端"静默重新登录并重放"，
            // 于是被封禁的用户会陷入无限重登循环——而"你被封禁了"这个事实被完全掩盖。
            next(new AppError(40301, { reason: 'blocked' }));
            return;
          }
          if (record.tokenVer !== (principal.ver ?? 1)) {
            // 改密 / 主动下线：token 已过期，重新登录是正确动作
            next(new AppError(40101, { reason: 'token_version_mismatch' }));
            return;
          }
          if (role === 'admin' && !record.isAdmin) {
            // N9：token 里的 role 是签发时写死的，"撤销管理员"改的是库里的 is_admin——
            // 不回源比对，撤权要等 token 自然过期（12 小时越权窗口）。
            // 40301 与"角色不符"同码：已认证但无权，语义一致
            next(new AppError(40301, { reason: 'not_admin' }));
            return;
          }
        }
        req.auth = principal;
        // 写进日志上下文：此后这条请求链路上的所有日志都带 user_id，无需每个 handler 手动传。
        // @why actor 记成 `user:<id>` 而不是只记角色（D22）：只记 `actor: 'user'` 等于
        //      "有个用户干了某事"——出事后要还原"谁干的"就得到处翻。角色与身份是两个维度，
        //      分别落在 `actor`（可读的归属串）与 `user_id`（可检索的 ID）上。
        patchContext({ user_id: principal.sub, actor: `${principal.role}:${principal.sub}` });
        next();
      })
      // ⚠️ 只能透传，不能再折叠成 40101（基座自查 P1-1，曾折叠）：
      //    verifyToken / toPrincipal 的一切失败**已经**在抛出点转成 AppError(40101)，
      //    能走到这个 catch 的非 AppError 只剩两类——`identity.load()` 的基础设施异常
      //    （DB 连接失败等）与代码 bug。把前者折叠成 40101 的后果是：
      //    DB 抖动期间全站用户收到"登录过期"，前端按 action「静默重新登录并重放」
      //    形成无限重登风暴，而日志里一个 500 都没有——监控完全看不见真正的故障。
      //    透传后由全局兜底折叠成 50000 + error 级日志（http.ts unhandled_error）。
      .catch((e: unknown) => next(e));
  };
}

/**
 * 口令长度上限（**字符数**，非字节）：1024。
 * @why 有了预哈希之后长度不再受 bcrypt 的 72 字节限制，但仍要挡住"传 10MB 字符串进来"这种
 *      输入——那不是安全问题（bcrypt 成本仍在），而是白白的 CPU/内存浪费（DoS 面）。
 *      取 1024 是因为它远超任何真实口令/passphrase 的长度，不会误伤。
 */
export const PASSWORD_MAX_CHARS = 1024;

/**
 * 预哈希：把任意长度口令压成 64 个十六进制字符（< 72 字节），**彻底**绕开 bcrypt 的截断。
 *
 * @why 直接用 bcrypt 时，`'a'*72 + 'SUFFIX1'` 与 `'a'*72 + 'DIFFERENT'` 会互相校验通过——
 *      两个不同的口令被当成同一个，且全程没有任何提示（复现缺陷 D15）。
 *      对管理员用长 passphrase（20 个词）的场景，这等于"以为设了强口令，实际只用了前 72 字节"。
 *
 * @why 用 **SHA-256 而不是 HMAC-SHA256**：HMAC 需要一把密钥，而密钥一旦轮换（JWT_SECRET 轮换是既定需求）
 *      **所有人的口令会同时失效**——那是"改密钥 → 全站强制重置密码"的耦合，代价远大于收益。
 *      无盐预哈希是否削弱安全性？不削弱：bcrypt 自带每哈希随机盐，最终哈希仍互不相同；
 *      攻击者拿到库后对每个候选口令仍要付一次完整的 bcrypt 成本，预哈希只是把"超长输入"变短。
 *
 * @limitation 与"标准 bcrypt 哈希"不再兼容。若将来要导入外部系统导出的 `$2b$` 哈希，
 *             不能直接喂给 verifyPassword（它期待的是 sha256 之后的 bcrypt）。
 *             届时的做法是在哈希串上加前缀（如 `v2$`）做版本区分，而不是退回无预哈希。
 * @tradeoff 换来"任意长度口令都完整参与校验"，代价是"口令熵实际上限 256 位"（无实际影响）
 *           与上面那条兼容性代价。
 */
function preHash(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

/**
 * 口令哈希（管理员登录用）。
 * @throws {Error} 口令超过 {@link PASSWORD_MAX_CHARS} 字符
 */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length > PASSWORD_MAX_CHARS) {
    throw new Error(
      `口令过长：最多 ${PASSWORD_MAX_CHARS} 个字符（超出部分是白白浪费 CPU，不是安全问题）`,
    );
  }
  return bcrypt.hash(preHash(plain), BCRYPT_COST);
}

/**
 * 校验口令；任何异常（哈希损坏、输入过长）都按"不匹配"处理，不抛细节。
 * @why 校验侧刻意**不抛**超长错误：抛错等于告诉调用方"你的输入触发了长度分支"，
 *      属于可以被用来探测系统行为的信息；登录结果只有"通过 / 不通过"两种。
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (plain.length > PASSWORD_MAX_CHARS) return false;
  try {
    return await bcrypt.compare(preHash(plain), hash);
  } catch {
    return false;
  }
}
