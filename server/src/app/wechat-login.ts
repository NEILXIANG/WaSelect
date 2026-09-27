/**
 * 职责：小程序登录核心（I1-U6b）——code 换 openid → 首登建 users 行 → 签发 JWT。
 *
 * @why 建行用 `INSERT … ON CONFLICT (openid) DO NOTHING` + 再 SELECT，而不是
 *      "先 SELECT 判断、不存在再 INSERT"：两个并发首登在"查完没插"的窗口里会
 *      双双走进 INSERT，一个撞 23505——而 PG 事务里一条语句报错整个事务进
 *      aborted 状态，靠 savepoint 捞回来是 D32 的模式，重；ON CONFLICT 把
 *      "争取建行"压成**一条原子语句**，谁先谁建行、后来的读到同一行，
 *      不需要事务包裹、没有 aborted 状态要处理。被丢弃的那个预生成 id 无人见过，
 *      不构成泄露。
 *
 * @why 永远签 `role: 'user'`：小程序登录面对的是公开入口（任何装了微信的人），
 *      管理端身份必须走管理端登录（欠账②，/auth/admin/login 的 aud=admin + 密码 +
 *      失败锁定）——即便某个 users 行 is_admin=true，从本入口拿到的 token 也只能是
 *      用户受众（aud=mp）。isAdmin 字段**如实**从库行读给前端做 UI 引导，
 *      但它不影响签发的角色。
 *
 * @limitation 一：code 形状不在这里校验（路由层 zod 已拦空串/非串）；
 *              微信侧的真伪校验是适配器的职责，核心不重复——核心的假设是
 *              "进来的 code 已经被某一层处理过形状"。
 * @limitation 二：登录不挂幂等键（契约未声明 IdemKey）：同一 code 重放会被微信
 *              40163 拒掉（→ 40101），天然防重；dev 替身下同 code 重放是幂等读 +
 *              ON CONFLICT 不建行，结果一致。
 *
 * @see ports/wechat-auth.ts（openid 来源）；app/auth.ts signToken（签发）；
 *      migrations/001_init.sql users 表
 */
import type { Db } from '../adapters/db.js';
import { patchContext } from '../context.js';
import type { Logger } from '../logger.js';
import type { IdGen } from '../ports/ids.js';
import type { WechatAuth } from '../ports/wechat-auth.js';
import { signToken, type AuthConfig } from './auth.js';

export interface WechatLoginDeps {
  wechatAuth: WechatAuth;
  authConfig: AuthConfig;
  idGen: IdGen;
  logger: Logger;
}

export interface WechatLoginResult {
  token: string;
  user: { id: string; isAdmin: boolean };
}

interface UserRow {
  id: string;
  is_admin: boolean;
  token_ver: number;
}

export async function loginWithWechat(
  db: Db,
  deps: WechatLoginDeps,
  input: { code: string },
): Promise<WechatLoginResult> {
  const session = await deps.wechatAuth.code2session(input.code);

  // 争取建行（并发首登安全，文件头 @why）；命中已有行时 DO NOTHING（count=0）
  const inserted = await db`
    insert into users (id, openid) values (${`u-${deps.idGen.uuid()}`}, ${session.openid})
    on conflict (openid) do nothing
  `;
  // count=1 表示这次真的建了行（首登）；0 表示 openid 已存在（复登）——转化漏斗用
  const isNewUser = inserted.count === 1;
  const rows = await db`
    select id, is_admin, token_ver from users where openid = ${session.openid}
  `;
  const user = rows[0] as UserRow | undefined;
  if (user === undefined) {
    // ON CONFLICT 成功后同库同名行必存在；到这里只能说明 openid 唯一约束被改过——
    // 那是 schema 级事故，响亮失败而不是静默 500 在别处
    throw new Error(`users 行缺失：ON CONFLICT 后 select 未命中（schema 漂移？）`);
  }

  // ⚠️ 必须签当前 token_ver（全量审计 2026-09-26 P1）：曾经不带 ver → 永远签 1，而 requireRole 用库里的
  //    token_ver 比对；一旦有人 bump（改密/强制下线），该用户之后每次登录仍拿到 ver=1 →
  //    所有受保护接口 40101 → 前端静默重登 → 无限循环，表现为"登录成功但什么都做不了"。
  const token = await signToken(
    { sub: user.id, role: 'user', ver: Number(user.token_ver) },
    deps.authConfig,
  );
  // 登录成功这一刻起，本请求后续日志都该带身份（与 requireRole 验签成功后同处置）；
  // 无上下文时（核心被脱离 HTTP 直接调用）no-op，由 context.ts 兜底
  patchContext({ user_id: user.id, actor: `user:${user.id}` });
  // ⚠️ openid 明文不进日志（ADR-29 脱敏红线：用户级标识）；user_id 是保留键，
  //    由上面的 patchContext 进上下文，不许在调用点显式传（logger strict 会拒）；
  //    is_new_user 是运营关心的首登/复登漏斗指标
  deps.logger.info('wechat_login', {
    result: 'ok',
    ctx: { is_new_user: isNewUser, is_admin: user.is_admin },
  });
  return { token, user: { id: user.id, isAdmin: user.is_admin } };
}
