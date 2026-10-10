/**
 * 职责：**每一条受保护路由 × 每一种身份状态** 的守卫结论表（测试审查 U-J7）。
 *      路由清单取自生产装配后**实际挂载**的路由（`collectAppRoutes`），不手抄；
 *      公开路由集合取自契约 `security: []`，两边对不上即红。
 *
 * @why 审查发现：身份状态回源（封禁 / 版本失效 / 撤管理员，D25 / N9）只在
 *      `auth.unit.test.ts` 里用**假的身份查询**测过；经真实路由验证的只有 `GET /orders`
 *      与 `/admin/products` 各一条。守卫是**逐路由挂**的（每个 mount 函数各自传 identity），
 *      任何一条路由漏传 `identity`，那条路由上封禁就不生效——而其它路由的用例照样绿。
 *      既有各文件的守卫用例都是手抄路由表，新加的路由不会自动进覆盖。
 *      本文件把"守卫挂没挂、挂对没"变成**全量、自动**的检查：新路由一挂上就自动进表。
 * @why 所有身份状态都在**第一次请求前**种好、每条用例起一个新服务：
 *      身份查询有 60 秒缓存（按路由组各一份），先请求再改状态会测到缓存而不是回源。
 *      "改状态后多久生效"是另一个问题，登记在测试审查报告的缺口一节（KD-6）。
 *
 * @measured 2026-09-28 首跑：以为"管理端 token 打买家路由"会在验签阶段因 aud 不符得 40101，
 *           实测**全部 40301**（买家 token 打管理端路由同样 40301）——与 auth.ts requireRole
 *           "角色不符是 403 而不是 401"的注释一致，期望值据此改正；10 + 20 条路由结论完全一致，
 *           说明这是统一行为而非个别路由的偶然。
 * @limitation 一：只断言**守卫**的结论（401 / 403 / 放行）。放行之后业务上返回什么
 *              （404 / 400 / 200）不在本表——参数都是占位的 `x`，业务失败是预期的。
 * @limitation 二：公开路由、内部作业（共享密钥）、机构回调（签名）不在本表：
 *              它们不走 JWT 守卫，各有专门的测试文件。
 *
 * @see app/auth.ts requireRole；adapters/identity.ts；adapters/risk-admin.ts（封禁 +1 token_ver）；
 *      contracts/api-contract.yaml（security）；docs/自主决策记录.md AJ-174
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { IDENTITY_CACHE_TTL_MS } from '../adapters/identity.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  CHAIN_JWT_SECRET,
  seedChainFixture,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { API_PREFIX, normalizeRoutePath, type RouteRef } from './route-snapshot.js';

const { load: loadYaml } = createRequire(import.meta.url)('js-yaml') as {
  load: (s: string) => unknown;
};

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
});

type Contract = { paths: Record<string, Record<string, { security?: unknown[] }>> };

/**
 * Path Item 里除了 HTTP 方法还可以有 `servers` / `parameters` / `summary` 等键（OpenAPI 3.0）。
 * @why 契约 0.6.10 ④ 给 `/healthz` `/readyz` 补了 path 级 `servers`（探针挂在根路径），
 *      本用例曾把每个键都当方法 → 冒出 `SERVERS /healthz`（一致性审计 AJ-176 实测）。与 contract-document 同一白名单。
 */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** 契约里声明为公开（`security: []`）或走非 JWT 鉴权的路由。 */
function nonJwtRoutesFromContract(): Set<string> {
  const doc = loadYaml(
    readFileSync(new URL('../../../contracts/api-contract.yaml', import.meta.url), 'utf8'),
  ) as Contract;
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method)) continue;
      const sec = op.security;
      const isBearer =
        sec === undefined ||
        (Array.isArray(sec) && sec.some((s) => Object.keys(s as object).includes('bearerAuth')));
      if (!isBearer) out.add(`${method.toUpperCase()} ${normalizeRoutePath(path)}`);
    }
  }
  return out;
}

type Kind = 'buyer' | 'admin';
function classify(routes: readonly RouteRef[]): { kind: Kind; route: RouteRef }[] {
  const open = nonJwtRoutesFromContract();
  const out: { kind: Kind; route: RouteRef }[] = [];
  for (const r of routes) {
    if (open.has(`${r.method} ${r.path}`)) continue;
    // `/auth/admin/*` 里受保护的（登录本身是公开的、已被上面排除）同属管理端守卫——
    // AJ-442 新增退出端点前这里只认 `/admin/` 前缀，退出端点被误判成买家路由
    const isAdmin = r.path.startsWith('/admin/') || r.path.startsWith('/auth/admin/');
    out.push({ kind: isAdmin ? 'admin' : 'buyer', route: r });
  }
  return out;
}

async function hit(
  srv: ChainServer,
  r: RouteRef,
  token: string | undefined,
): Promise<{ status: number; code: unknown }> {
  const path = `${API_PREFIX}${r.path.replace(/\{\}/g, 'x')}`;
  const withBody = r.method !== 'GET' && r.method !== 'DELETE';
  const res = await fetch(`${srv.url}${path}`, {
    method: r.method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': `matrix-${r.method}-${r.path}`,
      ...(withBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(withBody ? { body: '{}' } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: unknown };
  return { status: res.status, code: json.code };
}

describe('受保护路由 × 身份状态：守卫结论表（路由清单取自真实装配）', () => {
  it('每一条挂载的路由都能被归类：要么契约声明为非 JWT，要么是买家路由或管理端路由', async () => {
    const srv = await buildChainServer(db);
    try {
      const guarded = classify(srv.routes);
      // 双向：买家与管理端两类都存在（防止分类函数把一切都判成"公开"而空跑）
      expect(guarded.filter((g) => g.kind === 'buyer').length).toBeGreaterThanOrEqual(10);
      expect(guarded.filter((g) => g.kind === 'admin').length).toBeGreaterThanOrEqual(15);
      // 契约声明为 JWT 的每一条都真的挂载了（否则本表会漏行）
      const mounted = new Set(srv.routes.map((r) => `${r.method} ${r.path}`));
      const doc = loadYaml(
        readFileSync(new URL('../../../contracts/api-contract.yaml', import.meta.url), 'utf8'),
      ) as Contract;
      const open = nonJwtRoutesFromContract();
      const missing: string[] = [];
      for (const [path, ops] of Object.entries(doc.paths)) {
        for (const method of Object.keys(ops).filter((m) => HTTP_METHODS.has(m))) {
          const k = `${method.toUpperCase()} ${normalizeRoutePath(path)}`;
          if (!open.has(k) && !mounted.has(k)) missing.push(k);
        }
      }
      expect(missing, '契约声明需要鉴权、实现却没挂载').toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('令牌策略接到了每条路由上：同密钥签 HS512 / 不带 exp 的 token → 所有受保护路由 40101', async () => {
    // 补回链路矩阵 §3.3「令牌策略 → 鉴权中间件 → 真路由」一行：它原落点 skeleton.e2e 随骨架退役被删，
    // 此后只剩 auth.unit 的中间件级用例——证明不了"每条真路由都用的是同一套策略"
    const key = new TextEncoder().encode(CHAIN_JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u-1')
      .setIssuer('waselect')
      .setAudience('mp')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const noExp = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer('waselect')
      .setAudience('mp')
      .setIssuedAt(now)
      .sign(key);
    const srv = await buildChainServer(db);
    try {
      const bad: string[] = [];
      for (const { kind, route } of classify(srv.routes)) {
        if (kind !== 'buyer') continue;
        for (const [name, t] of [
          ['hs512', hs512],
          ['no-exp', noExp],
        ] as const) {
          const r = await hit(srv, route, t);
          if (r.code !== 40101)
            bad.push(`${name} ${route.method} ${route.path} → ${String(r.code)}`);
        }
      }
      expect(bad).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('无 token / 伪造 token → 所有受保护路由 40101', async () => {
    const srv = await buildChainServer(db);
    try {
      const bad: string[] = [];
      for (const { route } of classify(srv.routes)) {
        for (const t of [undefined, 'not-a-jwt']) {
          const r = await hit(srv, route, t);
          if (r.code !== 40101)
            bad.push(`${route.method} ${route.path} token=${String(t)} → ${String(r.code)}`);
        }
      }
      expect(bad).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('买家路由：正常买家放行；版本失效 / 库里查无此人 → 40101；管理端 token → 40301；被封禁 → 40301（不是 40101）', async () => {
    // 封禁走**真实管理端路由**（它会把 token_ver +1）；版本失效单独只抬 token_ver
    const setup = await buildChainServer(db);
    const block = await fetch(`${setup.url}${API_PREFIX}/admin/users/u-2/block`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor('u-admin', 'admin')}`,
        'content-type': 'application/json',
        'idempotency-key': 'block-u2',
      },
      body: '{}',
    });
    expect(block.status).toBeLessThan(300);
    await setup.close();
    await db`insert into users (id, openid) values ('u-stale', 'o-stale')`;
    await db`update users set token_ver = token_ver + 1 where id = 'u-stale'`;

    const srv = await buildChainServer(db); // 新服务 = 身份缓存全冷
    try {
      const tokens = {
        ok: await tokenFor('u-1'),
        blocked: await tokenFor('u-2'),
        stale: await tokenFor('u-stale'),
        ghost: await tokenFor('u-nobody'),
        adminAud: await tokenFor('u-admin', 'admin'),
      };
      const bad: string[] = [];
      for (const { kind, route } of classify(srv.routes)) {
        if (kind !== 'buyer') continue;
        const ok = await hit(srv, route, tokens.ok);
        if (ok.status === 401 || ok.status === 403)
          bad.push(`ok ${route.method} ${route.path} → ${String(ok.code)}`);
        const expectations: [keyof typeof tokens, number][] = [
          ['blocked', 40301],
          ['stale', 40101],
          ['ghost', 40101],
          ['adminAud', 40301], // 角色不符 = 已认证但无权（auth.ts requireRole：403 而非 401）
        ];
        for (const [who, code] of expectations) {
          const r = await hit(srv, route, tokens[who]);
          if (r.code !== code)
            bad.push(
              `${who} ${route.method} ${route.path} → ${String(r.code)}（应为 ${String(code)}）`,
            );
        }
      }
      expect(bad).toEqual([]);
      // 封禁的拒绝原因写进日志（403 与"角色不符"同码，区分全靠这一栏）
      expect(JSON.stringify(srv.sink.lines)).toContain('blocked');
    } finally {
      await srv.close();
    }
  });

  it('管理端路由：正常管理员放行；买家 token → 40301；被撤管理员 → 40301（not_admin）', async () => {
    await db`insert into users (id, openid, email, is_admin) values ('u-exadmin', 'o-exadmin', 'ex@example.com', false)`;
    const srv = await buildChainServer(db);
    try {
      const ok = await tokenFor('u-admin', 'admin');
      const revoked = await tokenFor('u-exadmin', 'admin'); // token 里是 admin，库里已撤权
      const buyer = await tokenFor('u-1');
      const bad: string[] = [];
      for (const { kind, route } of classify(srv.routes)) {
        if (kind !== 'admin') continue;
        const a = await hit(srv, route, ok);
        if (a.status === 401 || a.status === 403)
          bad.push(`ok ${route.method} ${route.path} → ${String(a.code)}`);
        const b = await hit(srv, route, buyer);
        if (b.code !== 40301) bad.push(`buyer ${route.method} ${route.path} → ${String(b.code)}`);
        const c = await hit(srv, route, revoked);
        if (c.code !== 40301) bad.push(`revoked ${route.method} ${route.path} → ${String(c.code)}`);
      }
      expect(bad).toEqual([]);
      expect(JSON.stringify(srv.sink.lines)).toContain('not_admin');
    } finally {
      await srv.close();
    }
  });
});

describe('身份缓存全站共用一份（KD-6，AJ-175）', () => {
  /**
   * @why 曾经每组路由各持一份缓存（11 份）：同一个人被封禁后，**已缓存过他**的路由组继续放行最长 60 秒，
   *      **从没查过他**的路由组立刻拒绝——买家在订单页能用、在地址页被拒，客服看到的是"时好时坏"。
   *      判别断言是第二步：地址组此前从未查过 u-1，若它有自己的冷缓存就会回源读到封禁 → 403。
   * @limitation 缓存窗口本身（封禁后最长 60 秒仍放行）是既定口径（D25），这里断言的是"全站同一时刻同一结论"，
   *             不是"立即生效"；跨实例（多进程）仍各有一份，MVP 单实例部署不涉及。
   */
  it('库里封禁后：缓存窗口内各组路由结论一致（都放行）；过了 TTL 各组同时拒绝 40301', async () => {
    const srv = await buildChainServer(db);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const token = await tokenFor('u-1');
      const get = async (p: string): Promise<{ status: number; code: unknown }> => {
        const r = await fetch(`${srv.url}${API_PREFIX}${p}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const j = (await r.json().catch(() => ({}))) as { code?: unknown };
        return { status: r.status, code: r.status >= 400 ? j.code : undefined };
      };
      expect(await get('/orders')).toEqual({ status: 200, code: undefined }); // 订单组把 u-1 缓存为"正常"
      await db`update users set blocked_at = now() where id = 'u-1'`; // 库里已封（直接改库 = 旁路/另一进程）
      expect(await get('/addresses')).toEqual({ status: 200, code: undefined }); // 从没查过 u-1 的地址组：同一份缓存
      expect(await get('/orders')).toEqual({ status: 200, code: undefined });
      clock.mockReturnValue(t0 + IDENTITY_CACHE_TTL_MS + 1);
      expect(await get('/addresses')).toEqual({ status: 403, code: 40301 });
      expect(await get('/orders')).toEqual({ status: 403, code: 40301 });
    } finally {
      clock.mockRestore();
      await srv.close();
    }
  });
});
