/**
 * 职责：鉴权骨架的 L0/L1 单测（F6b）。安全相关，逐条测"失败路径"而不只是成功路径。
 * @why 鉴权代码最危险的 bug 是"该拒绝的时候放行了"，只测成功路径等于没测。
 * @see server/src/auth.ts @limitation（无 token 黑名单 / bcrypt 72 字节截断）
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createHttpApp, listen } from '../http.js';
import { createLogger } from '../logger.js';
import { SignJWT } from 'jose';
import {
  AUDIENCE,
  bearerOf,
  DEFAULT_TTL_SEC,
  hashPassword,
  requireRole,
  signToken,
  verifyPassword,
  verifyToken,
  type AuthConfig,
  type Principal,
} from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { decodeJwt } from 'jose';

const cfg: AuthConfig = { secret: 'a'.repeat(40), issuer: 'waselect-test' };
const otherSecret: AuthConfig = { secret: 'b'.repeat(40), issuer: 'waselect-test' };
const user: Principal = { sub: 'u-1', role: 'user' };
const admin: Principal = { sub: 'a-1', role: 'admin' };

/** base64url（不带填充）——手工构造恶意 token 用。 */
function b64u(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('signToken / verifyToken', () => {
  it('往返一致：sub 与 role 正确带回', async () => {
    const token = await signToken(user, cfg);
    const got = await verifyToken(token, cfg);
    expect(got.sub).toBe('u-1');
    expect(got.role).toBe('user');
  });

  it('过期 token 拒绝（返回 40101，且不区分失败原因）', async () => {
    const token = await signToken(user, { ...cfg, ttlSec: -10 });
    await expect(verifyToken(token, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  /**
   * `aud` 与有效期（技术文档 v0.5 §5 口径）。
   * @why 这两条都是"代码与文档差一点不会让任何测试变红"的典型：数值写错、aud 漏设，
   *      系统照样跑得很好。只能靠**直接断言文档里写的那个数**来钉住。
   */
  it('aud 按角色区分：用户 mp / 管理员 admin（技术文档 §5）', async () => {
    expect(AUDIENCE).toEqual({ user: 'mp', admin: 'admin' });
    expect(decodeJwt(await signToken(user, cfg)).aud).toBe('mp');
    expect(decodeJwt(await signToken(admin, cfg)).aud).toBe('admin');
  });

  it('有效期符合文档：用户 7 天、管理员 12 小时（43200 秒）', async () => {
    expect(DEFAULT_TTL_SEC.user).toBe(7 * 24 * 3600);
    expect(DEFAULT_TTL_SEC.admin).toBe(12 * 3600);

    const now = Math.floor(Date.now() / 1000);
    const adminToken = decodeJwt(await signToken(admin, cfg));
    expect((adminToken.exp as number) - (adminToken.iat as number)).toBe(43200);
    expect((adminToken.iat as number) - now).toBeLessThanOrEqual(2);
  });

  it('受众不符 → 40301（已验签但不属于该入口，不能让前端误判为"登录失效"）', async () => {
    const userToken = await signToken(user, cfg);
    // 不传 expect 时仍能解出身份（供"先拿身份再分流"的调用点）
    await expect(verifyToken(userToken, cfg)).resolves.toMatchObject({ role: 'user' });
    // 传了 expect=admin 就因 aud 不符被拒；是 403 不是 401
    await expect(verifyToken(userToken, cfg, 'admin')).rejects.toMatchObject({ code: 40301 });
  });

  it('管理员 token 反向也进不了 user 入口', async () => {
    const adminToken = await signToken(admin, cfg);
    await expect(verifyToken(adminToken, cfg, 'user')).rejects.toMatchObject({ code: 40301 });
  });

  it('受众不是本项目取值（另一服务共用密钥）→ 40101', async () => {
    const foreign = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-x')
      .setIssuer('waselect-test')
      .setAudience('some-other-service')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode('a'.repeat(40)));
    await expect(verifyToken(foreign, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('换密钥签发的 token 拒绝（环境隔离）', async () => {
    const token = await signToken(user, otherSecret);
    await expect(verifyToken(token, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('issuer 不一致拒绝（dev 的 token 不能进 prod）', async () => {
    const token = await signToken(user, { ...cfg, issuer: 'other' });
    await expect(verifyToken(token, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('篡改载荷拒绝', async () => {
    const token = await signToken(user, cfg);
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('token 结构异常');
    const forged = `${parts[0]}.${b64u({ sub: 'u-2', role: 'admin', iss: cfg.issuer })}.${parts[2]}`;
    await expect(verifyToken(forged, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  // 诚实标注：jose 默认就不支持 alg=none，去掉白名单这条也不会变绿转红。
  // 保留它是回归保护——将来换 JWT 库时能立刻发现"新库允许 unsecured JWT"。
  it('alg=none 攻击拒绝（jose 不支持 unsecured JWT，白名单属纵深防御）', async () => {
    const now = Math.floor(Date.now() / 1000);
    const noneToken = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({
      sub: 'u-1',
      role: 'admin',
      iss: cfg.issuer,
      iat: now,
      exp: now + 3600,
    })}.`;
    await expect(verifyToken(noneToken, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  /**
   * 三审变异 U23：`algorithms: ['HS256']` 白名单被删掉时全绿——alg=none 用例对它零约束
   *（jose 本就拒 none）。真正能让白名单"红"的是：同一把密钥签 HS512，无白名单即通过。
   */
  it('同密钥签发的 HS512 token 拒绝（算法白名单必须真的在起作用）', async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('admin')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(hs512, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  /**
   * 三审 S3：无 `exp` 的 token 必须拒绝。签发侧总带 exp，但任何未来的签发路径/脚本漏写一次，
   * 就是一枚**永久有效**的 token；校验侧强制 requiredClaims 才是不依赖"签发侧记得"的防线。
   */
  it('缺 exp / iat 的 token 拒绝（永久有效的 token 不允许存在）', async () => {
    const noExp = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('mp')
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(noExp, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('签发侧拒绝非法角色（否则 TTL 变 NaN，报错信息完全指不到根因）', async () => {
    await expect(signToken({ sub: 'u-1', role: 'root' as never }, cfg)).rejects.toThrow(TypeError);
    await expect(signToken({ sub: '', role: 'user' }, cfg)).rejects.toThrow(TypeError);
  });

  it('校验侧也拒绝非法角色（纵深防御：伪造的 token 不能拿到任意角色）', async () => {
    // 绕过 signToken，直接用同一个密钥签一个 role=root 的 token，验证 verify 仍会拒绝
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(forged, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('无 sub 的 token 拒绝', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(cfg.issuer ?? 'waselect')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(forged, cfg)).rejects.toMatchObject({ code: 40101 });
  });
});

describe('口令哈希', () => {
  it('正确口令通过，错误口令失败', async () => {
    const hash = await hashPassword('Admin#2026ok');
    await expect(verifyPassword('Admin#2026ok', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('哈希值不等于明文，且同明文两次哈希不同（带盐）', async () => {
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    expect(h1).not.toBe('same-password');
    expect(h1).not.toBe(h2);
  });

  it('哈希损坏时按不匹配处理，不抛内部错误', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('requireRole 中间件（真 HTTP）', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(identity?: IdentityCheck) {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const app = createHttpApp({
      logger,
      mount: (a: Express) => {
        a.get('/api/v1/me', requireRole('user', cfg, { identity }), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
        a.get('/admin/orders', requireRole('admin', cfg, { identity }), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
      },
    });
    const started = await listen(app);
    close = started.close;
    return { baseUrl: `http://127.0.0.1:${started.port}`, sink };
  }

  it('无 Authorization 头 → 40101', async () => {
    const { baseUrl } = await serve();
    const res = await fetch(`${baseUrl}/api/v1/me`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40101 });
  });

  it('非 Bearer 格式 → 40101', async () => {
    const { baseUrl } = await serve();
    const token = await signToken(user, cfg);
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Token ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('user token 进 admin 接口 → 40301（已认证但无权，前端应隐藏入口）', async () => {
    const { baseUrl } = await serve();
    const token = await signToken(user, cfg);
    const res = await fetch(`${baseUrl}/admin/orders`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 40301 });
  });

  it('admin token 进 user 接口 → 40301（两套入口互不通用）', async () => {
    const { baseUrl } = await serve();
    const token = await signToken(admin, cfg);
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('正确角色的 token 放行，且身份进日志上下文', async () => {
    const { baseUrl, sink } = await serve();
    const token = await signToken(user, cfg);
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sub: 'u-1' });
    const row = sink.find('http_request').at(-1);
    expect(row?.user_id).toBe('u-1');
    // D22：actor 记到具体的人，只记角色无法追责
    expect(row?.actor).toBe('user:u-1');
  });

  describe('身份状态回源校验（D25）', () => {
    /** 固定身份：未封禁、ver=1。 */
    const alive: IdentityCheck = {
      load: async () => ({ tokenVer: 1, blockedAt: null, isAdmin: true }),
    };

    it('ver 对不上 → 40101（改密后旧 token 必须失效）', async () => {
      const { baseUrl } = await serve({
        load: async () => ({ tokenVer: 2, blockedAt: null, isAdmin: true }),
      });
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 40101 });
    });

    it('已封禁 → 40301 而不是 401（401 会让前端陷入无限重登）', async () => {
      const { baseUrl } = await serve({
        load: async () => ({ tokenVer: 1, blockedAt: new Date(), isAdmin: true }),
      });
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 40301 });
    });

    it('admin token 但库里 is_admin=false → 40301（N9：撤权必须回源拦截，不是只 +token_ver）', async () => {
      // @why token 里的 role 是签发时写死的，"撤销某人的管理员权限"改的是库里的 is_admin——
      //      不回源校验的话，撤销要等 token 自然过期（12 小时越权窗口）。
      const { baseUrl } = await serve({
        load: async () => ({ tokenVer: 1, blockedAt: null, isAdmin: false }),
      });
      const res = await fetch(`${baseUrl}/admin/orders`, {
        headers: { authorization: `Bearer ${await signToken(admin, cfg)}` },
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 40301 });
    });

    it('admin token 且库里 is_admin=true → 放行（不能误伤正常管理员）', async () => {
      const { baseUrl } = await serve({
        load: async () => ({ tokenVer: 1, blockedAt: null, isAdmin: true }),
      });
      const res = await fetch(`${baseUrl}/admin/orders`, {
        headers: { authorization: `Bearer ${await signToken(admin, cfg)}` },
      });
      expect(res.status).toBe(200);
    });

    it('用户已不存在 → 40101（token 合法但主体没了）', async () => {
      const { baseUrl } = await serve({ load: async () => null });
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(401);
    });

    it('identity 查询本身故障（DB 异常）→ 50000，绝不能折叠成 40101', async () => {
      // ⚠️ 基座自查 P1-1：折叠成 40101 的话，DB 抖动期间全站用户收到"登录过期"，
      //    前端按 action「静默重新登录并重放」陷入无限重登风暴，
      //    而真正的故障（DB 不可达）在日志里一个 500 都没有——监控完全看不见。
      const { baseUrl, sink } = await serve({
        load: async () => {
          throw new Error('connection refused');
        },
      });
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ code: 50000 });
      // 且日志里必须是 error 级、err_type 不是 AppError——监控靠它发现"这是基础设施故障"
      const errRow = sink.find('unhandled_error').at(-1);
      expect(errRow?.err_type).toBe('Error');
    });

    it('状态正常时放行（不能误伤）', async () => {
      const { baseUrl } = await serve(alive);
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(200);
    });

    it('不传 identity 时不查库（骨架期与单元测试的口子，行为与改造前一致）', async () => {
      const { baseUrl } = await serve(undefined);
      const res = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${await signToken(user, cfg)}` },
      });
      expect(res.status).toBe(200);
    });
  });
});

/**
 * D15：bcrypt 只取前 **72 字节**，超长口令的尾部不参与校验。
 * @why 曾经 `hashPassword('a'*72 + 'SUFFIX1')` 与 `'a'*72 + 'DIFFERENT'` 互相都能校验通过
 *      ——两个**不同**的口令被当成同一个（复现缺陷 D15）。管理员用长 passphrase 时尤其危险：
 *      他以为自己设了 20 个词的口令，实际只有前 72 字节生效，而这件事没有任何提示。
 */
describe('口令哈希：72 字节截断（D15）', () => {
  it('72 字节之后的差异也必须参与校验', async () => {
    const hash = await hashPassword(`${'a'.repeat(72)}SUFFIX1`);
    await expect(verifyPassword(`${'a'.repeat(72)}DIFFERENT`, hash)).resolves.toBe(false);
    await expect(verifyPassword(`${'a'.repeat(72)}SUFFIX1`, hash)).resolves.toBe(true);
  });

  it('多字节口令（日本語）按**字节**而非字符截断', async () => {
    // 25 个 'あ' = 75 字节，差异在第 76 字节——若按字符数算（25 < 72）会以为没超限而漏判
    const hash = await hashPassword(`${'あ'.repeat(25)}X`);
    await expect(verifyPassword(`${'あ'.repeat(25)}X`, hash)).resolves.toBe(true);
    await expect(verifyPassword(`${'あ'.repeat(25)}Y`, hash)).resolves.toBe(false);
  });

  it('超长输入被拒（防 DoS，不是安全上限）', async () => {
    await expect(hashPassword('x'.repeat(1025))).rejects.toThrow(/过长|1024/);
    // 校验侧不抛错，一律按"不匹配"处理——避免用异常内容探测出系统行为
    await expect(verifyPassword('x'.repeat(1025), 'whatever')).resolves.toBe(false);
  });

  it('空口令仍然可用（不替调用方做业务判断）', async () => {
    const hash = await hashPassword('');
    await expect(verifyPassword('', hash)).resolves.toBe(true);
  });
});

/**
 * D25：JWT 验签通过 ≠ 这个人现在还能用。
 *
 * @why token 里早就有 `ver` 字段、users 表早就有 `blocked_at`，但校验时**两个都不看**——
 *      于是改密之后旧 token 依然能进后台（管理员有效期 12 小时），
 *      凭据泄露的处置窗口被硬生生拉到 12 小时。这是"字段都齐了、就差一步比对"的典型。
 */

describe('bearerOf', () => {
  it('大小写不敏感地识别 Bearer，缺失时返回 undefined', () => {
    const mk = (v: string | undefined) => ({
      header: (n: string) => (n === 'authorization' ? v : undefined),
    });
    expect(bearerOf(mk('Bearer abc') as never)).toBe('abc');
    expect(bearerOf(mk('bearer abc') as never)).toBe('abc');
    expect(bearerOf(mk(undefined) as never)).toBeUndefined();
    expect(bearerOf(mk('Basic abc') as never)).toBeUndefined();
  });
});

/**
 * N16 定向：toPrincipal / requireRole 里"伪造载荷形状"的分支。
 * @why jose 层强制 aud ∈ {mp, admin}，所以"role 非法 / 无 sub"要走到 toPrincipal，
 *      伪造 token 必须**带合法 aud**——否则在 jose 层就被拒，测的是另一条路径。
 */
describe('伪造载荷的形状防线（N16 定向）', () => {
  it('aud 合法但 role 不是 user/admin → 40101（toPrincipal 拒绝，不是 jose 拒绝）', async () => {
    const withSub = await new SignJWT({ role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('mp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(withSub, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('aud 合法但无 sub → 40101（同上，必须是 toPrincipal 这条路径）', async () => {
    const forged = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('mp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifyToken(forged, cfg)).rejects.toMatchObject({ code: 40101 });
  });

  it('无 ver claim 的老 token → principal.ver 为 undefined（requireRole 侧按 1 处理）', async () => {
    const forged = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('mp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(cfg.secret));
    const principal = await verifyToken(forged, cfg);
    expect(principal.ver).toBeUndefined();
  });
});

describe('requireRole 的伪造形状分支（N16 定向）', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(identity?: IdentityCheck) {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const app = createHttpApp({
      logger,
      mount: (a: Express) => {
        a.get('/admin/orders', requireRole('admin', cfg, { identity }), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
        a.get('/api/v1/me', requireRole('user', cfg, { identity }), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
      },
    });
    const started = await listen(app);
    close = started.close;
    return { baseUrl: `http://127.0.0.1:${started.port}` };
  }

  it('aud 与入口匹配但 role 不符（伪造 admin-aud + user-role）→ 40301 expected/actual', async () => {
    // @why verifyToken 的 aud 检查管"进没进对门"，管不到"门里身份对不对"——
    //      这条分支只有"aud 匹配但 role 不符"的伪造 token 能走到。
    const { baseUrl } = await serve();
    const forged = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('admin')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(cfg.secret));
    const res = await fetch(`${baseUrl}/admin/orders`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(403);
    // details（expected/actual）按设计不进响应体（errors.ts 不外泄细节），只断言错误码
    await expect(res.json()).resolves.toMatchObject({ code: 40301 });
  });

  it('无 ver 的老 token + 库里 tokenVer=2 → 40101（`ver ?? 1` 的回落侧）', async () => {
    const { baseUrl } = await serve({
      load: async () => ({ tokenVer: 2, blockedAt: null, isAdmin: true }),
    });
    const forged = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer(cfg.issuer ?? 'waselect')
      .setAudience('mp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(cfg.secret));
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40101 });
  });
});

describe('verifyPassword 的异常兜底（N16 定向）', () => {
  it('库里哈希损坏（bcrypt.compare 抛错）→ false，不抛细节', async () => {
    // @why 校验侧绝不把"哈希坏了"和"口令错了"区分开——区分等于泄露系统内部状态。
    // ⚠️ 不是任意坏串都会让 compare 抛：'not-a-bcrypt-hash' 这类它只是返回 false；
    //    结构合法但 cost 非法（99 轮）才会真抛——本例必须用后者，否则测不到 catch 分支。
    const illegalCostHash = `$2b$99$${'x'.repeat(53)}`;
    await expect(verifyPassword('whatever', illegalCostHash)).resolves.toBe(false);
    // 普通坏串不抛、直接 false 的行为也顺手钉住（两条路径对外语义一致）
    await expect(verifyPassword('whatever', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});
