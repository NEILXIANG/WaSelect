/**
 * 职责：**代码路由 ↔ 契约路由双向比对**（I1-U1，L2 契约层）——消灭"路由面靠人肉对契约"。
 *
 * @why 三次全量审查把"契约-代码漂移"列为最高雪崩风险：错误码/枚举面有 check-contract.mjs
 *      机器守着，但路由面没有。I1 要新增十余条业务路由，没有这道比对，每加一条都可能
 *      "代码挂了契约没写"或"契约写了代码没做"，而两种漂移都不报错、只在联调时炸。
 *
 * @why 快照 app 走 `mountAllRoutes`（app/mount.ts）而不是自己拼一份挂载清单：
 *      复制一份 = 比对器与生产各自维护一份路由表，比对器本身就成了漂移源。
 *      挂载期不触库（mount.ts @limitation 一），所以这里可以用"调用即抛"的 stub db。
 *
 * @why 豁免清单与未实现清单**登记在本文件**（比对策略的所在地）：
 *      它们不是"配置"，是**审查决策**——每一条都要写理由，失效立即被 diffRoutes 的规则 ③④⑤
 *      报红逼着删除。放在这里，review 路由变化时必然会看到这两份清单。
 *
 * @limitation 只比"方法 + 路径形状"，不比 schema（route-snapshot.ts @limitation 一）。
 *
 * @see app/route-snapshot.ts（采集与比对纯函数）；docs/I1阶段开发实施方案.md §3.1；
 *      scripts/check-contract.mjs（错误码/枚举面的同类机制）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createHttpApp } from './http.js';
import { mountAllRoutes } from './app/mount.js';
import {
  collectAppRoutes,
  diffRoutes,
  normalizeRoutePath,
  parseContractRoutes,
  type NotImplementedRoute,
  type RouteRef,
} from './app/route-snapshot.js';
import { createLogger } from './logger.js';
import { MemorySink } from '../../test/helpers/memory-sink.js';
import { stubMountContext } from '../../test/helpers/mount-ctx.js';

const contractYaml = readFileSync(
  resolve(import.meta.dirname, '../../contracts/api-contract.yaml'),
  'utf8',
);

/**
 * 构建路由快照 app：真实走 `mountAllRoutes`，但所有依赖在**被调用时**抛错
 * （stub 上下文见 test/helpers/mount-ctx.ts——"挂载期无 IO"的机器自证只有一份）。
 */
function buildRouteSnapshotApp(): Express {
  const logger = createLogger({ env: 'test', destination: new MemorySink() });
  return createHttpApp({
    logger,
    mount: (a) => mountAllRoutes(a, stubMountContext({ logger })),
  });
}

/**
 * 代码侧豁免：允许"挂了但不在契约里"的路由。**每条必须给理由；没有路由再匹配时 diffRoutes 报红。**
 * 骨架（/skeleton/*）是脚手架不是契约 API——业务路由落地后整体退役（地基清单既定口径），
 * 退役时本豁免会因"无路由匹配"自动变红，逼着删除。
 */
const CODE_EXEMPTIONS = [
  {
    pattern: /^(GET|POST) \/skeleton(\/|$)/,
    reason: '骨架脚手架（F6c）：非契约 API，I1 业务路由落地后退役，届时本条豁免自动失效报红',
  },
] as const;

/**
 * 契约侧未实现登记：允许"契约写了但代码还没有"的路由。**每条必须给理由；实现后必须删除（diffRoutes 规则④）。**
 * 这是 I1 的"施工围挡"：随着 U2–U7 落地，本清单只许变短不许变长。
 */
function ni(method: string, path: string, reason: string): NotImplementedRoute {
  return { method, path, reason };
}
const NOT_IMPLEMENTED: readonly NotImplementedRoute[] = [
  ni('POST', '/auth/wechat/login', 'I1-U6：微信登录（端口+dev 适配器；真接等公司主体 AppID）'),
  ni('POST', '/auth/admin/login', 'I1-U6：管理员登录（欠账②，含管理员 seed）'),
  ni('POST', '/internal/jobs/daily', '欠账①：每日对账端点，I1 收尾前落地或明示移交'),
  ni('GET', '/home', 'I2：小程序首页聚合（依赖 Banner 管理端）'),
  ni('GET', '/orders', 'I1-U5：我的订单列表'),
  ni('GET', '/orders/{id}', 'I1-U5：订单详情'),
  ni('POST', '/orders/{id}/pay', 'I1-U6：发起支付'),
  ni('GET', '/pay/link/{id}', 'I1-U6：短链落地（D-49）'),
  ni('POST', '/orders/{id}/cancel', 'I1-U5：取消订单'),
  ni('GET', '/admin/orders', 'I2 管理端'),
  ni('GET', '/admin/orders/{id}', 'I2 管理端'),
  ni('POST', '/admin/orders/{id}/ship', 'I2 管理端'),
  ni('POST', '/admin/orders/{id}/refund', 'I2 管理端（售后阶段，依赖真实通道退款）'),
  ni('POST', '/admin/orders/{id}/address', 'I2 管理端'),
  ni('GET', '/admin/products', 'I2 管理端'),
  ni('POST', '/admin/products', 'I2 管理端'),
  ni('PUT', '/admin/products/{id}', 'I2 管理端'),
  ni('PATCH', '/admin/products/{id}/status', 'I2 管理端'),
  ni('POST', '/admin/upload', 'I2 管理端（依赖 R2）'),
  ni('GET', '/admin/fx', 'I2 管理端'),
  ni('POST', '/admin/fx', 'I2 管理端'),
  ni('GET', '/admin/shipping-rates', 'I2 管理端'),
  ni('PUT', '/admin/shipping-rates', 'I2 管理端'),
  ni('GET', '/admin/banners', 'I2 管理端'),
  ni('POST', '/admin/banners', 'I2 管理端'),
  ni('PUT', '/admin/banners/{id}', 'I2 管理端'),
  ni('DELETE', '/admin/banners/{id}', 'I2 管理端'),
  ni('GET', '/admin/disputes', 'I2 管理端（拒付，D-50）'),
  ni('POST', '/admin/users/{id}/block', 'I2 管理端'),
];

describe('代码路由 ↔ 契约路由（I1-U1）', () => {
  it('双向一致：豁免与未实现清单之外零漂移', () => {
    const code = collectAppRoutes(buildRouteSnapshotApp());
    const contract = parseContractRoutes(contractYaml);
    expect(
      diffRoutes(code, contract, {
        codeExemptions: CODE_EXEMPTIONS,
        notImplemented: NOT_IMPLEMENTED,
      }),
    ).toEqual([]);
  });

  // ── 健全性断言：扫描器自己不能"扫空了还绿"（与 check-contract.mjs 的自检同口径）────────
  it('健全性：采集与解析都必须拿到真实数量（防正则/内省失效导致假绿）', () => {
    const code = collectAppRoutes(buildRouteSnapshotApp());
    const contract = parseContractRoutes(contractYaml);
    // 当前事实：healthz/readyz/channels/callback + 骨架 3 条 = 7；将来只增不减（骨架退役时豁免同步删）
    expect(code.length).toBeGreaterThanOrEqual(7);
    // 契约当前 40+ 条路由；解析失效（返回 0/几条）必须红
    expect(contract.length).toBeGreaterThanOrEqual(40);
    // 关键路由必须在场（防"归一化把路径全变成同一个形状"这类静默错）
    expect(code).toContainEqual({ method: 'POST', path: '/pay/callback/{}' });
    expect(contract).toContainEqual({ method: 'POST', path: '/orders' });
  });
});

// ── 比对器的缺陷注入式自测（纯函数，不依赖真实 app/契约）────────────────────
// @why "比对器自己先被测，然后才轮到它去测别人"：以下每条对应 diffRoutes 的一条规则，
//      若规则失效（比如忘了查豁免失效），对应用例立即红。
describe('diffRoutes 比对器自测', () => {
  const contract: readonly RouteRef[] = [
    { method: 'GET', path: '/orders' },
    { method: 'POST', path: '/orders/{}/pay' },
  ];
  const baseOpts = { codeExemptions: [], notImplemented: [] } as const;

  it('代码多出一条契约没有的路由 → 红（规则①）', () => {
    const code: readonly RouteRef[] = [...contract, { method: 'DELETE', path: '/orders/{}' }];
    const problems = diffRoutes(code, contract, baseOpts);
    expect(problems.some((p) => p.includes('DELETE /orders/{}'))).toBe(true);
  });

  it('契约路由未实现且未登记 → 红（规则②）', () => {
    const code: readonly RouteRef[] = [{ method: 'GET', path: '/orders' }];
    const problems = diffRoutes(code, contract, baseOpts);
    expect(problems.some((p) => p.includes('POST /orders/{}/pay'))).toBe(true);
  });

  it('豁免失效（没有路由再匹配）→ 红（规则③）', () => {
    const code: readonly RouteRef[] = [...contract];
    const problems = diffRoutes(code, contract, {
      codeExemptions: [{ pattern: /^GET \/skeleton/, reason: '测试豁免' }],
      notImplemented: [],
    });
    expect(problems.some((p) => p.includes('豁免已失效'))).toBe(true);
  });

  it('豁免能正常吸收匹配的路由 → 绿', () => {
    const code: readonly RouteRef[] = [...contract, { method: 'POST', path: '/skeleton/orders' }];
    const problems = diffRoutes(code, contract, {
      codeExemptions: [{ pattern: /\/skeleton(\/|$)/, reason: '测试豁免' }],
      notImplemented: [],
    });
    expect(problems).toEqual([]);
  });

  it('未实现清单里的路由已实现 → 红（规则④）', () => {
    const problems = diffRoutes(contract, contract, {
      codeExemptions: [],
      notImplemented: [{ method: 'GET', path: '/orders', reason: '测试登记' }],
    });
    expect(problems.some((p) => p.includes('已实现'))).toBe(true);
  });

  it('未实现清单条目不在契约中 → 红（规则⑤）', () => {
    const code: readonly RouteRef[] = [...contract];
    const problems = diffRoutes(code, contract, {
      codeExemptions: [],
      notImplemented: [{ method: 'GET', path: '/no-such-route', reason: '测试登记' }],
    });
    expect(problems.some((p) => p.includes('不在契约中'))).toBe(true);
  });

  it('路径参数名归一：:id 与 {id} 视为同形状', () => {
    expect(normalizeRoutePath('/api/v1/orders/:id/pay')).toBe('/orders/{}/pay');
    expect(normalizeRoutePath('/orders/{id}')).toBe('/orders/{}');
  });
});
