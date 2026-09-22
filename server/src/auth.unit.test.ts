/**
 * 职责：鉴权骨架的 L0/L1 单测（F6b）。安全相关，逐条测"失败路径"而不只是成功路径。
 * @why 鉴权代码最危险的 bug 是"该拒绝的时候放行了"，只测成功路径等于没测。
 * @see server/src/auth.ts @limitation（无 token 黑名单 / bcrypt 72 字节截断）
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { MemorySink } from '../../test/helpers/memory-sink.js';
import { createHttpApp, listen } from './http.js';
import { createLogger } from './logger.js';
import { SignJWT } from 'jose';
import {
  bearerOf,
  hashPassword,
  requireRole,
  signToken,
  verifyPassword,
  verifyToken,
  type AuthConfig,
  type Principal,
} from './auth.js';

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

  async function serve() {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const app = createHttpApp({
      logger,
      mount: (a: Express) => {
        a.get('/api/v1/me', requireRole('user', cfg), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
        a.get('/admin/orders', requireRole('admin', cfg), (req, res) =>
          res.json({ sub: req.auth?.sub }),
        );
      },
    });
    const started = await listen(app, 0);
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
    expect(row?.actor).toBe('user');
  });
});

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
