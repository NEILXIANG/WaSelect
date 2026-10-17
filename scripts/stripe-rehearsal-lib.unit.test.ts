/**
 * 职责：支付排练编排的单测——假 HTTP 下每一幕的步骤顺序、等待、失败方向都钉住；
 * mock 通道的真实跑法见 `npm run stripe:rehearsal -- --channel mock`（打本机 dev 服务）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEV_MOCK_CALLBACK_SECRET,
  parseWebhookSecret,
  pollUntil,
  renderReport,
  runRehearsal,
  type RehearsalDeps,
  type RehearsalHttp,
} from './stripe-rehearsal-lib.js';

/** 一个会"推进"的假服务：付款后几次轮询才变 paid，退款后几次轮询才变 refunded；拒付幕按同样节奏。 */
function fakeServer(o: {
  channel: 'stripe' | 'mock';
  paidAfterPolls?: number;
  disputeAfterPolls?: number;
  refundOutcome?: 'succeeded' | 'pending';
}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const orders = new Map<
    string,
    { status: string; polls: number; dispute: boolean; disputePolls: number }
  >();
  let seq = 0;
  const http: RehearsalHttp = (method, path, opts) => {
    calls.push(`${method} ${path}`);
    const ok = (status: number, json: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve({ status, json, headers });
    if (path === '/api/v1/auth/wechat/login') return ok(200, { token: 'buyer-t' });
    if (path === '/api/v1/terms') return ok(200, { version: 'TOS-1' });
    if (path.startsWith('/api/v1/products'))
      return ok(200, { items: [{ id: 'p-1', price_jpy: 1000 }], total: 1 });
    if (path === '/api/v1/addresses') return ok(201, { id: 'addr-1' });
    if (path === '/api/v1/auth/admin/login') return ok(200, { token: 'admin-t' });
    if (path === '/api/v1/orders' && method === 'POST') {
      const id = `o-${String(++seq)}`;
      orders.set(id, { status: 'pending_payment', polls: 0, dispute: false, disputePolls: 0 });
      return ok(201, { order_id: id, order_no: `W${id}` });
    }
    const pay = /^\/api\/v1\/orders\/(o-\d+)\/pay$/.exec(path);
    if (pay !== null) {
      const id = pay[1] ?? '';
      if (o.channel === 'mock')
        return ok(200, { payload: { auto: false, amountJpy: 1000, currency: 'JPY' } });
      return ok(200, { payload: { pay_url: `http://localhost:5173/o/${id}?t=tok-${id}` } });
    }
    if (path === '/api/v1/pay/callback/mock') {
      const b = opts?.body as { order_id?: string; provider_ref?: string };
      const row = orders.get(String(b?.order_id));
      // 与真管线同口径：单号对不上回 200 + ignored，不落账
      if (b?.provider_ref !== `mock_${String(b?.order_id)}`)
        return ok(200, { received: true, ignored: 'settlement_mismatch' });
      if (row !== undefined) row.status = 'paid';
      return ok(200, { received: true, order_id: b?.order_id });
    }
    const link = /^\/api\/v1\/pay\/link\/(o-\d+)\?t=(.+)$/.exec(path);
    if (link !== null)
      return ok(
        302,
        {},
        { location: `https://checkout.stripe.com/c/pay/cs_test_${link[1] ?? ''}` },
      );
    const detail = /^\/api\/v1\/orders\/(o-\d+)$/.exec(path);
    if (detail !== null) {
      const row = orders.get(detail[1] ?? '');
      if (row === undefined) return ok(404, {});
      // stripe 通道：人在托管页付了款之后（prompt 之后）过几次轮询才到账
      if (
        row.status === 'pending_payment' &&
        prompts.length > 0 &&
        ++row.polls >= (o.paidAfterPolls ?? 2)
      )
        row.status = 'paid';
      if (row.status === 'refunding' && ++row.polls >= 4) row.status = 'refunded';
      return ok(200, { status: row.status });
    }
    const refund = /^\/api\/v1\/admin\/orders\/(o-\d+)\/refund$/.exec(path);
    if (refund !== null) {
      const row = orders.get(refund[1] ?? '');
      if (row !== undefined) row.status = o.refundOutcome === 'pending' ? 'refunding' : 'refunded';
      return ok(202, { order_id: refund[1], outcome: o.refundOutcome ?? 'succeeded' });
    }
    const ship = /^\/api\/v1\/admin\/orders\/(o-\d+)\/ship$/.exec(path);
    if (ship !== null) {
      const row = orders.get(ship[1] ?? '');
      return row?.dispute === true ? ok(409, { code: 40909 }) : ok(200, {});
    }
    const admin = /^\/api\/v1\/admin\/orders\/(o-\d+)$/.exec(path);
    if (admin !== null) {
      const row = orders.get(admin[1] ?? '');
      if (row === undefined) return ok(404, {});
      if (row.status === 'paid' && ++row.disputePolls >= (o.disputeAfterPolls ?? 2))
        row.dispute = true;
      return ok(200, {
        status: row.status,
        has_dispute: row.dispute,
        // 管理端详情带支付行：mock 排练要从这里拿 provider_ref 发回调
        payments: [
          {
            provider_ref: `mock_${admin[1] ?? ''}`,
            status: row.status === 'pending_payment' ? 'initiated' : 'succeeded',
          },
        ],
        ...(row.dispute ? { payment_dispute: 'open' } : {}),
      });
    }
    return ok(404, { path });
  };
  let t = 0;
  const deps: RehearsalDeps = {
    http,
    prompt: (m) => {
      prompts.push(m);
      return Promise.resolve();
    },
    sleep: () => {
      t += 1000;
      return Promise.resolve();
    },
    now: () => t,
    log: () => undefined,
  };
  return { deps, calls, prompts };
}

const OPTS = {
  buyerCode: 'rehearsal',
  admin: { email: 'a@b.c', password: 'x'.repeat(12) },
  mockCallbackSecret: DEV_MOCK_CALLBACK_SECRET,
  pollIntervalMs: 1000,
  pollTimeoutMs: 10_000,
} as const;

describe('runRehearsal：stripe 通道', () => {
  it('🔴 两幕全绿：付款→退款，付款→拒付→发货被拦；两次提示都带托管页地址与对应测试卡', async () => {
    const f = fakeServer({ channel: 'stripe' });
    const steps = await runRehearsal(f.deps, { ...OPTS, channel: 'stripe' });
    expect(steps.filter((s) => !s.ok)).toEqual([]);
    expect(steps.map((s) => s.step)).toEqual([
      '准备：买家登录、地址、商品、管理员登录',
      '建单并发起支付',
      '等付款落账（订单 → paid）',
      '管理端整单退款',
      '等退款落定（订单 → refunded）',
      '建单并发起支付',
      '等付款落账（订单 → paid）',
      '等拒付到达（管理端 payment_dispute=open）',
      '拒付中发货被拦（40909）',
    ]);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).toContain('4242 4242 4242 4242');
    expect(f.prompts[0]).toContain('https://checkout.stripe.com/c/pay/cs_test_o-1');
    expect(f.prompts[1]).toContain('4000 0000 0000 0259');
  });

  it('🔴 退款是 pending（机构处理中）→ 要等 refund.updated 把订单推到 refunded，而不是看到 202 就算过', async () => {
    const f = fakeServer({ channel: 'stripe', refundOutcome: 'pending' });
    const steps = await runRehearsal(f.deps, {
      ...OPTS,
      channel: 'stripe',
      scenes: ['pay_then_refund'],
    });
    expect(steps.at(-1)).toMatchObject({
      step: '等退款落定（订单 → refunded）',
      ok: true,
      detail: 'status=refunded',
    });
  });

  it('🔴 付款一直不到账 → 那一步超时红，这一幕剩下的步跳过，下一幕照常', async () => {
    const f = fakeServer({ channel: 'stripe', paidAfterPolls: 999 });
    const steps = await runRehearsal(f.deps, { ...OPTS, channel: 'stripe', pollTimeoutMs: 3000 });
    const first = steps.filter((s) => s.scene === 'pay_then_refund');
    expect(first.map((s) => s.ok)).toEqual([true, true, false]);
    expect(first.at(-1)?.detail).toContain('等了 3 秒');
    expect(steps.filter((s) => s.scene === 'dispute')).toHaveLength(2);
  });
});

describe('runRehearsal：mock 通道', () => {
  it('🔴 服务没开自动确认 → 脚本自己发签名回调；不提示人做任何事；只有第一幕', async () => {
    const f = fakeServer({ channel: 'mock' });
    const steps = await runRehearsal(f.deps, { ...OPTS, channel: 'mock' });
    expect(steps.filter((s) => !s.ok)).toEqual([]);
    expect(steps.filter((s) => s.scene === 'dispute')).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect(f.calls).toContain('POST /api/v1/pay/callback/mock');
  });
});

describe('纯函数', () => {
  it('parseWebhookSecret：从 stripe listen 的输出里取 whsec_；没有就 null', () => {
    expect(
      parseWebhookSecret('> Ready! Your webhook signing secret is whsec_abc123XYZ (^C to quit)'),
    ).toBe('whsec_abc123XYZ');
    expect(parseWebhookSecret('Getting ready...')).toBeNull();
  });

  it('pollUntil：到了就返回最新值；超时抛带时长的错', async () => {
    let n = 0;
    let t = 0;
    const o = {
      intervalMs: 500,
      timeoutMs: 2000,
      sleep: () => ((t += 500), Promise.resolve()),
      now: () => t,
      what: 'x',
    };
    expect(
      await pollUntil(
        () => Promise.resolve(++n),
        (v) => v >= 3,
        o,
      ),
    ).toBe(3);
    await expect(
      pollUntil(
        () => Promise.resolve(0),
        (v) => v > 0,
        o,
      ),
    ).rejects.toThrow('x：等了 2 秒仍未到');
  });

  it('renderReport：结论行写清通过 / 失败步数；表格里的竖线与换行被转义', () => {
    const md = renderReport(
      { channel: 'mock', startedAt: '2026-10-16T00:00:00Z', baseUrl: 'http://127.0.0.1:3000' },
      [
        { scene: 'pay_then_refund', step: 'a', ok: true, detail: 'x|y\nz', ms: 1234 },
        { scene: 'pay_then_refund', step: 'b', ok: false, detail: 'boom', ms: 10 },
      ],
    );
    expect(md).toContain('- 结论：1 步失败 / 共 2 步');
    expect(md).toContain('| pay_then_refund | a | ✓ | x\\|y z | 1.2s |');
  });
});
