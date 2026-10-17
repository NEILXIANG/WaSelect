/**
 * 职责：冒烟检查的判定逻辑——假 HTTP 下每条检查的红 / 绿方向都钉住（否则冒烟本身就是假绿灯）。
 */
import { describe, expect, it } from 'vitest';
import {
  RECONCILE_MUST_BE_ZERO,
  adminChecks,
  formatReport,
  publicChecks,
  runChecks,
  type SmokeHttp,
} from './smoke-lib.js';

/** 一套"健康环境"的假响应；用例按需覆盖某一条来造红。 */
function healthy(overrides: Record<string, { status: number; json?: unknown }> = {}): SmokeHttp {
  const base: Record<string, { status: number; json?: unknown }> = {
    'GET /healthz': { status: 200, json: { ok: true } },
    'GET /readyz': { status: 200, json: { ok: true } },
    'GET /api/v1/terms': { status: 200, json: { version: 'TOS-2026-09-20' } },
    'GET /api/v1/home': { status: 200, json: { banners: [], category_tabs: [{ key: 'tea' }] } },
    'GET /api/v1/products?page=1&size=5': {
      status: 200,
      json: { items: [{ id: 'p-1', title: '南部鉄器 急須', price_jpy: 8800 }], total: 1 },
    },
    'GET /api/v1/products?page=1&size=1': {
      status: 200,
      json: { items: [{ id: 'p-1', title: '南部鉄器 急須', price_jpy: 8800 }], total: 1 },
    },
    'GET /api/v1/products/p-1': { status: 200, json: { id: 'p-1' } },
    'GET /api/v1/orders': { status: 401, json: { code: 40101 } },
    'POST /api/v1/auth/admin/login': { status: 200, json: { token: 't-admin' } },
    'GET /api/v1/admin/orders?size=1': { status: 200, json: { items: [], total: 0 } },
    'GET /api/v1/admin/reconciliation/latest': {
      status: 200,
      json: { run: { ran_at: '2026-10-16T18:10:00.000Z', counts: { late_paid_unrefunded: 2 } } },
    },
  };
  const table = { ...base, ...overrides };
  return (method, path) => {
    const hit = table[`${method} ${path}`];
    if (hit === undefined) return Promise.resolve({ status: 404, json: {} });
    return Promise.resolve({ status: hit.status, json: hit.json ?? {} });
  };
}

const CREDS = {
  email: 'ops@example.com',
  password: 'x'.repeat(12),
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

describe('publicChecks', () => {
  it('健康环境全绿，且每条都有摘要', async () => {
    const r = await runChecks(publicChecks(), healthy());
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(r.map((x) => x.detail)).toContain('version=TOS-2026-09-20');
  });

  it('🔴 就绪探针 503 → 那一条红，其余照常跑（一次看到全貌）', async () => {
    const r = await runChecks(publicChecks(), healthy({ 'GET /readyz': { status: 503 } }));
    expect(r.find((x) => x.name.startsWith('就绪'))?.ok).toBe(false);
    expect(r.filter((x) => x.ok)).toHaveLength(r.length - 1);
  });

  it('🔴 商品列表为空 / 首件没有整数价 → 红（空库上线、价格字段漂移都在这一条）', async () => {
    const empty = await runChecks(
      publicChecks(),
      healthy({
        'GET /api/v1/products?page=1&size=5': { status: 200, json: { items: [], total: 0 } },
      }),
    );
    expect(empty.find((x) => x.name.startsWith('商品列表'))?.detail).toContain('没有在售商品');
    const badPrice = await runChecks(
      publicChecks(),
      healthy({
        'GET /api/v1/products?page=1&size=5': {
          status: 200,
          json: { items: [{ id: 'p-1', title: 'x', price_jpy: '8800' }], total: 1 },
        },
      }),
    );
    expect(badPrice.find((x) => x.name.startsWith('商品列表'))?.ok).toBe(false);
  });

  it('🔴 受保护接口不带 token 回了 200 → 红（鉴权被配丢是最危险的一种"绿"）', async () => {
    const r = await runChecks(
      publicChecks(),
      healthy({ 'GET /api/v1/orders': { status: 200, json: { items: [] } } }),
    );
    expect(r.find((x) => x.name.includes('401'))?.ok).toBe(false);
  });
});

describe('adminChecks', () => {
  it('登录拿到 token 后，后续检查带着它；对账只有运营类异常 → 绿', async () => {
    const seen: string[] = [];
    const http: SmokeHttp = (m, p, o) => {
      seen.push(`${m} ${p} ${o?.token ?? ''}`);
      return healthy()(m, p, o);
    };
    const r = await runChecks(
      adminChecks(CREDS, () => '123456'),
      http,
    );
    expect(r.every((x) => x.ok)).toBe(true);
    expect(seen).toContain('GET /api/v1/admin/orders?size=1 t-admin');
  });

  it('🔴 对账的系统类异常（作业停跑 / 回调未完成）有数 → 红，并点名类目', async () => {
    for (const key of RECONCILE_MUST_BE_ZERO) {
      const r = await runChecks(
        adminChecks(CREDS, () => '123456'),
        healthy({
          'GET /api/v1/admin/reconciliation/latest': {
            status: 200,
            json: { run: { ran_at: '2026-10-16T18:10:00.000Z', counts: { [key]: 1 } } },
          },
        }),
      );
      const recon = r.find((x) => x.name.startsWith('每日对账'));
      expect(recon?.ok, key).toBe(false);
      expect(recon?.detail).toContain(key);
    }
  });

  it('🔴 从没跑过对账（run=null）→ 红：每日作业没在跑', async () => {
    const r = await runChecks(
      adminChecks(CREDS, () => '123456'),
      healthy({ 'GET /api/v1/admin/reconciliation/latest': { status: 200, json: { run: null } } }),
    );
    expect(r.find((x) => x.name.startsWith('每日对账'))?.detail).toContain('没跑过');
  });
});

describe('formatReport', () => {
  it('最后一行是结论，失败时写 FAILED 与数量', () => {
    const ok = formatReport('https://s.test', [{ name: 'a', ok: true, detail: '200' }]);
    expect(ok.split('\n').at(-1)).toBe('smoke ok: 1 passed (https://s.test)');
    const bad = formatReport('https://s.test', [
      { name: 'a', ok: true, detail: '200' },
      { name: 'b', ok: false, detail: '503' },
    ]);
    expect(bad.split('\n').at(-1)).toBe('smoke FAILED: 1 of 2 failed (https://s.test)');
  });
});
