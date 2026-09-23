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
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors.js';
import { patchContext } from './context.js';

/** 角色：小程序用户与管理员是两套完全独立的入口（ADR-21：管理端为独立 Web）。 */
export type Role = 'user' | 'admin';

/** 通过鉴权后的身份。 */
export interface Principal {
  /** 内部用户 ID（users.id 或 admins.id），不是 openid——openid 不进 token（脱敏红线）。 */
  sub: string;
  role: Role;
  /** 签发时写入的 token 版本，将来做即时失效用（当前恒为 1）。 */
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
 * @param role 期望角色；`user` 路由用 'user'，管理端路由一律 'admin'
 */
export function requireRole(role: Role, cfg: AuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearerOf(req);
    if (token === undefined) {
      next(new AppError(40101));
      return;
    }
    // 把期望角色传下去：`aud` 由 jose 在验签阶段强制比对，比"验完再看 role"早一步拒绝
    verifyToken(token, cfg, role)
      .then((principal) => {
        if (principal.role !== role) {
          // 角色不符是 403 而不是 401：已认证但无权，前端应隐藏入口而不是重新登录
          next(new AppError(40301, { expected: role, actual: principal.role }));
          return;
        }
        req.auth = principal;
        // 写进日志上下文：此后这条请求链路上的所有日志都带 user_id，无需每个 handler 手动传
        patchContext({ user_id: principal.sub, actor: principal.role });
        next();
      })
      .catch((e: unknown) => next(e instanceof AppError ? e : new AppError(40101)));
  };
}

/**
 * 口令哈希（管理员登录用）。
 * @limitation bcrypt 截断 72 字节，超长口令会被静默截断——入口处应限制口令长度 ≤ 72 字节。
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** 校验口令；任何异常（哈希损坏）都按"不匹配"处理，不抛细节。 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
