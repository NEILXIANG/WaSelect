/**
 * 职责：支付排练（真通道、假钱）的编排逻辑——建单 → 发起支付 → 等付款落账 → 退款 / 拒付 → 出报告。
 * 入口 `scripts/stripe-rehearsal.ts` 只负责读参数、起 `stripe listen`、发 HTTP、打印与退出码。
 *
 * @why 上线前自动化方案（2026-10-16）：运维手册 §8 的 A 段此前是一份**手工步骤**（下单、复制链接、付款、
 *      去后台退款、对照时间线）。每次改支付代码都要人走一遍，于是实际上没人走——本仓库到 2026-10-16 为止
 *      所有 Stripe 相关结论都是按文档推断的（AJ-527 退款 4xx 形态、AJ-530 退款事件、本次回调限流）。
 *      把"人要做的"压缩到**一个动作**：在浏览器里输一次测试卡号；其余（建单、发起、等回调、退款、判定、写报告）由脚本做。
 * @why 同一套编排也能走 **mock 通道**（`--channel mock`）：不需要 Stripe 账户就能验"脚本本身对不对"，
 *      也让它成为 staging 冒烟之外、本机每次改支付代码后的回归入口。
 * @why 判定只看**订单状态**与**管理端视图**（status / payment_dispute / outcome），不看日志：
 *      买家与运营看到的就是这两样；日志里对不对由现有单测与 db 测试管。
 * @limitation 一：Stripe 托管页的付款动作仍要人做（Checkout Session 没有"用测试卡完成"的 API）。
 *              全自动要上无头浏览器（Playwright 填托管页），等 Stripe 测试账户到手、本脚本跑通后再加。
 * @limitation 二：等待靠轮询订单状态（默认 2 秒一次、最长 5 分钟）：回调经 `stripe listen` 转发，延迟通常几秒内。
 * @limitation 三：会话过期（30 分钟）这一幕不排练：等半小时不值；关单与过期回调由 e2e 与 db 测试覆盖。
 * @see docs/上线运维手册-首次部署·回滚·审核期切正式.md §8；docs/真平台验收清单.md；./smoke-lib.ts（同一种"纯逻辑 + 薄入口"拆法）
 */
import { createHmac } from 'node:crypto';

export interface RehearsalHttp {
  (
    method: 'GET' | 'POST',
    path: string,
    opts?: {
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
      redirect?: 'manual';
    },
  ): Promise<{ status: number; json: unknown; headers: Record<string, string> }>;
}

export interface RehearsalDeps {
  http: RehearsalHttp;
  /** 把一段话交给人并等他做完（托管页付款）；mock 通道不会调用 */
  prompt: (message: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 终端进度输出 */
  log: (line: string) => void;
}

export interface RehearsalOptions {
  channel: 'stripe' | 'mock';
  /** 开发登录前缀下的任意 code（WECHAT_DEV_LOGIN=dev- 时 openid = dev-<code>） */
  buyerCode: string;
  admin: { email: string; password: string; totp?: string | undefined };
  /** mock 通道：服务没开 MOCK_AUTO_CONFIRM 时脚本自己发签名回调 */
  mockCallbackSecret: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** 要排练的幕；默认 stripe 两幕、mock 一幕 */
  scenes?: readonly SceneId[] | undefined;
}

export type SceneId = 'pay_then_refund' | 'dispute';

export interface StepRecord {
  scene: SceneId;
  step: string;
  ok: boolean;
  detail: string;
  /** 这一步用了多久（毫秒） */
  ms: number;
}

/** Stripe 公开测试卡（docs.stripe.com/testing）。 */
export const TEST_CARDS = {
  success: '4242 4242 4242 4242',
  dispute: '4000 0000 0000 0259',
} as const;

/** 开发环境没配 MOCK_CALLBACK_SECRET 时通道用的占位密钥（channels.ts 同一个值；公开值，只给本机）。 */
export const DEV_MOCK_CALLBACK_SECRET = 'dev-mock-callback-secret-do-not-use-in-prod';

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * 从 `stripe listen` 的输出里取签名密钥。
 * @why 用正则取 `whsec_…` 而不是整行匹配：官方提示语是英文、可能随版本改措辞，密钥的形状不会变。
 * @limitation `stripe listen` 的实际提示语【待实测】：本函数只保证"输出里有 whsec_ 就取得到"。
 */
export function parseWebhookSecret(text: string): string | null {
  const m = /whsec_[A-Za-z0-9]+/.exec(text);
  return m === null ? null : m[0];
}

/** 轮询到 `pred` 为真，或超时抛错；每次都把最新值交给 `pred`。 */
export async function pollUntil<T>(
  fetchOnce: () => Promise<T>,
  pred: (v: T) => boolean,
  o: {
    intervalMs: number;
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    what: string;
  },
): Promise<T> {
  const start = o.now();
  for (;;) {
    const v = await fetchOnce();
    if (pred(v)) return v;
    if (o.now() - start >= o.timeoutMs) {
      throw new Error(`${o.what}：等了 ${String(Math.round(o.timeoutMs / 1000))} 秒仍未到`);
    }
    await o.sleep(o.intervalMs);
  }
}

function expectStatus(r: { status: number; json: unknown }, want: number, what: string): void {
  if (r.status !== want) {
    throw new Error(
      `${what}：期望 ${String(want)}，实际 ${String(r.status)} ${JSON.stringify(r.json).slice(0, 200)}`,
    );
  }
}

/** 一次排练里各幕共用的上下文（买家 token、地址、商品、管理员 token）。 */
interface Ctx {
  buyer: string;
  admin: string;
  addressId: string;
  productId: string;
  termsVersion: string;
}

async function setup(d: RehearsalDeps, o: RehearsalOptions): Promise<Ctx> {
  const login = await d.http('POST', '/api/v1/auth/wechat/login', { body: { code: o.buyerCode } });
  expectStatus(login, 200, '买家登录（需要服务配 WECHAT_DEV_LOGIN）');
  const buyer = String(obj(login.json)['token']);
  const terms = await d.http('GET', '/api/v1/terms');
  expectStatus(terms, 200, '条款');
  const termsVersion = String(obj(terms.json)['version']);
  const products = await d.http('GET', '/api/v1/products?page=1&size=1');
  expectStatus(products, 200, '商品列表');
  const items = obj(products.json)['items'];
  const productId = Array.isArray(items) ? String(obj(items[0])['id'] ?? '') : '';
  if (productId === '') throw new Error('没有在售商品：先 npm run dev 灌假数据');
  const addr = await d.http('POST', '/api/v1/addresses', {
    token: buyer,
    body: {
      recipient: 'Rehearsal Buyer',
      phone: '+14155550123',
      line1: '1 Market St',
      line2: null,
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94105',
    },
  });
  expectStatus(addr, 201, '新建收货地址');
  const addressId = String(obj(addr.json)['id']);
  const adminLogin = await d.http('POST', '/api/v1/auth/admin/login', {
    body: {
      email: o.admin.email,
      password: o.admin.password,
      ...(o.admin.totp === undefined ? {} : { totp: o.admin.totp }),
    },
  });
  expectStatus(adminLogin, 200, '管理员登录');
  return {
    buyer,
    admin: String(obj(adminLogin.json)['token']),
    addressId,
    productId,
    termsVersion,
  };
}

async function createAndStartPayment(
  d: RehearsalDeps,
  o: RehearsalOptions,
  c: Ctx,
  tag: string,
): Promise<{ orderId: string; payUrl: string | null }> {
  const order = await d.http('POST', '/api/v1/orders', {
    token: c.buyer,
    headers: { 'idempotency-key': `rehearsal-${tag}-${String(d.now())}` },
    body: {
      items: [{ product_id: c.productId, qty: 1 }],
      address_id: c.addressId,
      terms_version: c.termsVersion,
    },
  });
  expectStatus(order, 201, '建单');
  const orderId = String(obj(order.json)['order_id']);
  const pay = await d.http('POST', `/api/v1/orders/${orderId}/pay`, {
    token: c.buyer,
    headers: { 'idempotency-key': `rehearsal-pay-${tag}-${String(d.now())}` },
    body: { channel: o.channel },
  });
  expectStatus(pay, 200, '发起支付');
  const payload = obj(obj(pay.json)['payload']);
  if (o.channel === 'mock') {
    if (payload['auto'] !== true) {
      // 服务没开自动确认：脚本按 mock 通道的约定自己发一条签了名的回调（与 e2e 同一形状）。
      // provider_ref 必须是支付行上那一个（mock_<uuid>，由通道 create 时生成）：
      // 落账会核对单号族，编一个会被判 provider_ref_mismatch 转对账（本机实测 2026-10-16，这正是排练第一次红的原因）
      const adminView = await adminOrder(d, c, orderId);
      const payments = adminView['payments'];
      const initiated = Array.isArray(payments)
        ? payments.map(obj).find((p) => p['status'] === 'initiated')
        : undefined;
      const providerRef = initiated?.['provider_ref'];
      if (typeof providerRef !== 'string')
        throw new Error('管理端订单里没有 initiated 的支付行（发起支付没落 payments？）');
      const body = JSON.stringify({
        event_id: `evt-rehearsal-${tag}-${String(d.now())}`,
        type: 'payment.succeeded',
        order_id: orderId,
        provider_ref: providerRef,
        amount_minor: payload['amountJpy'],
        currency: payload['currency'] ?? 'JPY',
      });
      const cb = await d.http('POST', '/api/v1/pay/callback/mock', {
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': createHmac('sha256', o.mockCallbackSecret).update(body).digest('hex'),
        },
        body: JSON.parse(body) as unknown,
      });
      expectStatus(cb, 200, 'mock 回调');
      // 200 不等于落账：管线把"核对不通过"也回 200 并带 ignored（契约 /pay/callback 的 200 说明）——这里要响亮
      const ignored = obj(cb.json)['ignored'];
      if (ignored !== undefined) throw new Error(`mock 回调被忽略：${String(ignored)}`);
    }
    return { orderId, payUrl: null };
  }
  const payUrl = payload['pay_url'];
  if (typeof payUrl !== 'string')
    throw new Error('发起支付的响应里没有 pay_url（stripe 通道应是 copylink）');
  // 短链 /o/<id>?t=… 落在静态站；排练直接问 API 要 302 的 Location（= Stripe 托管页）
  const t = new URL(payUrl).searchParams.get('t') ?? '';
  const link = await d.http('GET', `/api/v1/pay/link/${orderId}?t=${encodeURIComponent(t)}`, {
    redirect: 'manual',
  });
  expectStatus(link, 302, '短链 → 托管页');
  const location = link.headers['location'] ?? '';
  if (!location.startsWith('https://checkout.stripe.com/'))
    throw new Error(`Location 不是 Stripe 托管页：${location}`);
  return { orderId, payUrl: location };
}

async function orderStatus(d: RehearsalDeps, c: Ctx, orderId: string): Promise<string> {
  const r = await d.http('GET', `/api/v1/orders/${orderId}`, { token: c.buyer });
  expectStatus(r, 200, '查订单');
  return String(obj(r.json)['status']);
}

async function adminOrder(
  d: RehearsalDeps,
  c: Ctx,
  orderId: string,
): Promise<Record<string, unknown>> {
  const r = await d.http('GET', `/api/v1/admin/orders/${orderId}`, { token: c.admin });
  expectStatus(r, 200, '管理端查订单');
  return obj(r.json);
}

type StepFn = () => Promise<string>;

/** 跑一幕：逐步记录耗时与结果；某一步失败则这一幕剩下的步跳过（后一幕照常）。 */
async function runScene(
  d: RehearsalDeps,
  scene: SceneId,
  steps: readonly [string, StepFn][],
  out: StepRecord[],
): Promise<void> {
  for (const [name, fn] of steps) {
    const t0 = d.now();
    try {
      const detail = await fn();
      out.push({ scene, step: name, ok: true, detail, ms: d.now() - t0 });
      d.log(`  ✓ ${name} — ${detail}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      out.push({ scene, step: name, ok: false, detail, ms: d.now() - t0 });
      d.log(`  ✗ ${name} — ${detail}`);
      return;
    }
  }
}

/** 整场排练。返回每一步的记录；全绿与否由调用方按 `ok` 判。 */
export async function runRehearsal(d: RehearsalDeps, o: RehearsalOptions): Promise<StepRecord[]> {
  const out: StepRecord[] = [];
  const poll = {
    intervalMs: o.pollIntervalMs,
    timeoutMs: o.pollTimeoutMs,
    sleep: d.sleep,
    now: d.now,
  };
  let c: Ctx;
  const t0 = d.now();
  try {
    c = await setup(d, o);
    out.push({
      scene: 'pay_then_refund',
      step: '准备：买家登录、地址、商品、管理员登录',
      ok: true,
      detail: `商品 ${c.productId}`,
      ms: d.now() - t0,
    });
  } catch (e) {
    out.push({
      scene: 'pay_then_refund',
      step: '准备：买家登录、地址、商品、管理员登录',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      ms: d.now() - t0,
    });
    return out;
  }
  const scenes =
    o.scenes ?? (o.channel === 'stripe' ? ['pay_then_refund', 'dispute'] : ['pay_then_refund']);

  if (scenes.includes('pay_then_refund')) {
    d.log('第一幕：付款成功 → 整单退款');
    let orderId = '';
    await runScene(
      d,
      'pay_then_refund',
      [
        [
          '建单并发起支付',
          async () => {
            const r = await createAndStartPayment(d, o, c, 'ok');
            orderId = r.orderId;
            if (r.payUrl !== null) {
              await d.prompt(
                `在浏览器打开下面的链接，用测试卡 ${TEST_CARDS.success}（任意未来有效期 / CVC / 邮编）付款：\n${r.payUrl}`,
              );
            }
            return `订单 ${orderId}`;
          },
        ],
        [
          '等付款落账（订单 → paid）',
          async () => {
            const s = await pollUntil(
              () => orderStatus(d, c, orderId),
              (s) => s === 'paid',
              { ...poll, what: '付款落账' },
            );
            return `status=${s}`;
          },
        ],
        [
          '管理端整单退款',
          async () => {
            const r = await d.http('POST', `/api/v1/admin/orders/${orderId}/refund`, {
              token: c.admin,
              body: { reason: '排练：整单退款' },
            });
            expectStatus(r, 202, '退款');
            return `outcome=${String(obj(r.json)['outcome'])}`;
          },
        ],
        [
          '等退款落定（订单 → refunded）',
          async () => {
            const s = await pollUntil(
              () => orderStatus(d, c, orderId),
              (s) => s === 'refunded',
              { ...poll, what: '退款落定（stripe 靠 refund.updated 回调）' },
            );
            return `status=${s}`;
          },
        ],
      ],
      out,
    );
  }

  if (scenes.includes('dispute')) {
    d.log('第二幕：付款成功 → 银行拒付');
    let orderId = '';
    await runScene(
      d,
      'dispute',
      [
        [
          '建单并发起支付',
          async () => {
            const r = await createAndStartPayment(d, o, c, 'dispute');
            orderId = r.orderId;
            if (r.payUrl !== null) {
              await d.prompt(
                `在浏览器打开下面的链接，用**拒付**测试卡 ${TEST_CARDS.dispute} 付款：\n${r.payUrl}`,
              );
            }
            return `订单 ${orderId}`;
          },
        ],
        [
          '等付款落账（订单 → paid）',
          async () => {
            const s = await pollUntil(
              () => orderStatus(d, c, orderId),
              (s) => s === 'paid',
              { ...poll, what: '付款落账' },
            );
            return `status=${s}`;
          },
        ],
        [
          '等拒付到达（管理端 payment_dispute=open）',
          async () => {
            const v = await pollUntil(
              () => adminOrder(d, c, orderId),
              (v) => v['payment_dispute'] === 'open',
              { ...poll, what: '拒付回调（charge.dispute.created）' },
            );
            return `has_dispute=${String(v['has_dispute'])}`;
          },
        ],
        [
          '拒付中发货被拦（40909）',
          async () => {
            const r = await d.http('POST', `/api/v1/admin/orders/${orderId}/ship`, {
              token: c.admin,
              body: { carrier: 'japanpost', tracking_no: 'EJ123456789JP' },
            });
            if (r.status !== 409) throw new Error(`期望 409 / 40909，实际 ${String(r.status)}`);
            return `code=${String(obj(r.json)['code'])}`;
          },
        ],
      ],
      out,
    );
  }
  return out;
}

/** Markdown 报告（存档到 var/rehearsal/，也是验收清单打勾的依据）。 */
export function renderReport(
  o: { channel: string; startedAt: string; baseUrl: string },
  steps: readonly StepRecord[],
): string {
  const failed = steps.filter((s) => !s.ok).length;
  const lines = [
    `# 支付排练报告（${o.channel}）`,
    '',
    `- 时间：${o.startedAt}`,
    `- 目标：${o.baseUrl}`,
    `- 结论：${failed === 0 ? `全部通过（${String(steps.length)} 步）` : `${String(failed)} 步失败 / 共 ${String(steps.length)} 步`}`,
    '',
    '| 幕 | 步骤 | 结果 | 说明 | 耗时 |',
    '|---|---|---|---|---|',
    ...steps.map(
      (s) =>
        `| ${s.scene} | ${s.step} | ${s.ok ? '✓' : '✗'} | ${s.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${String(Math.round(s.ms / 100) / 10)}s |`,
    ),
    '',
  ];
  return lines.join('\n');
}
