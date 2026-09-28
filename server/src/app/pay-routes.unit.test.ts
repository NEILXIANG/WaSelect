/**
 * 职责：支付路由的 L1 用例（F11）——**真起端口 + 真 fetch + 真注册表 + 真 mock Provider**。
 *
 * @why 只有存储与业务落点是桩：这里要验的是"路由把注册表与管线接对了"，
 *      用假的注册表就退化成"路由调了一个假东西"，接错照样绿。
 *      Provider 用**真实的 `createMockProvider`**（HMAC 验签是真的），
 *      这样"签名头取错名字 / raw body 没配"这类错误会真的红。
 *
 * @why 重点钉两件事：
 *      ① `GET /pay/channels` 是前端入口的唯一来源（下线通道必须自动消失）；
 *      ② `POST /pay/callback/:channel` 用 `getForCallback`——**已下线通道的在途回调仍要落账**。
 *      这两条合起来才是"可插拔"：只做①不做②，下线一个通道就吞掉一批已付款订单。
 *
 * @limitation 不验任何机构的真实报文格式：mock Provider 的报文形状是我们自己约定的；
 *              Stripe 的真实签名口径由 `stripe-checkout.unit.test.ts` 与契约测试覆盖。
 */
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { createHttpApp, listen } from '../http.js';
import { createPaymentRegistry } from '../adapters/payment/registry.js';
import { createMockProvider } from '../adapters/payment/mock.js';
import type { ChannelConfig, PaymentRegistry, ProviderCapabilities } from '../ports/payment.js';
import type { ProviderEvent } from '../ports/payment.js';
import {
  mountPayRoutes,
  PAY_CALLBACK_PREFIX,
  PAY_CHANNELS_PATH,
  type PayRoutesDeps,
} from './pay-routes.js';
import { RESULT_PAID } from './webhook-results.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { fakeWebhookStore } from '../../../test/helpers/fake-webhook-store.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { stubIdGen } from '../../../test/helpers/stub-id-gen.js';

const SECRET = 'routes-unit-secret';

/** 五个通道，覆盖"国家 / 币种 / 金额 / 下线"四种过滤维度（见 channelTable 的注释）。 */
interface ChannelSpec {
  channel: string;
  enabled?: boolean;
  priority: number;
  countries?: readonly string[];
  currencies?: readonly string[];
  label?: string;
  icon?: string;
  caps?: Partial<ProviderCapabilities>;
  /** 有配置但**不注册**工厂（配置先行于代码）。 */
  unregistered?: boolean;
}

const CHANNELS: readonly ChannelSpec[] = [
  { channel: 'a', priority: 10, label: '小程序支付', icon: 'wx' },
  {
    channel: 'b',
    priority: 20,
    countries: ['US'],
    currencies: ['JPY', 'USD'],
    label: '银行卡',
    // ⚠️ 能力侧也要放开 USD：可用 = 配置 ∩ 能力，只改配置一侧会被能力边界挡掉
    caps: { entryMode: 'copylink', currencies: ['JPY', 'USD'] },
  },
  { channel: 'c', priority: 30, countries: ['JP'], label: '日本国内' },
  { channel: 'd', priority: 40, enabled: false, label: '已下线' },
  { channel: 'e', priority: 50, label: '小额专用', caps: { maxAmountJpy: 5_000 } },
  { channel: 'ghost', priority: 60, unregistered: true },
];

function buildRegistry(specs: readonly ChannelSpec[] = CHANNELS): PaymentRegistry {
  const configs: ChannelConfig[] = specs.map((s) => ({
    channel: s.channel,
    enabled: s.enabled ?? true,
    priority: s.priority,
    countries: s.countries ?? ['*'],
    currencies: s.currencies ?? ['JPY'],
    label: s.label ?? s.channel,
    ...(s.icon !== undefined ? { icon: s.icon } : {}),
    options: { secret: SECRET },
  }));
  const registry = createPaymentRegistry({ configs });
  for (const s of specs) {
    if (s.unregistered === true) continue;
    registry.register(s.channel, (cfg) => {
      const base = createMockProvider(cfg, {
        clock: fixedClock('2026-01-02T00:00:00.000Z'),
        idGen: stubIdGen('K7Q2MN', 'u-1'),
      });
      return { ...base, capabilities: { ...base.capabilities, ...s.caps } };
    });
  }
  return registry;
}

interface Started {
  base: string;
  close: () => Promise<void>;
  sink: MemorySink;
  applied: ProviderEvent[];
  rec: ReturnType<typeof fakeWebhookStore>['rec'];
}

let current: Started | undefined;

async function start(
  opts: {
    registry?: PaymentRegistry;
    withRawBody?: boolean;
    graceMs?: number;
    /** succeeded 的落账器；用例要验"额外注册的 outcome"时用 {@link appliers} 整体覆盖。 */
    apply?: (e: ProviderEvent) => Promise<void>;
    appliers?: PayRoutesDeps['appliers'];
  } = {},
): Promise<Started> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const { store, rec } = fakeWebhookStore({});
  const applied: ProviderEvent[] = [];
  const app = createHttpApp({
    logger,
    rawBodyPaths: (opts.withRawBody ?? true) ? [PAY_CALLBACK_PREFIX] : [],
    silentPaths: ['/healthz', '/readyz'],
    mount: (a) =>
      mountPayRoutes(a, {
        registry: opts.registry ?? buildRegistry(),
        webhooks: store,
        logger,
        graceMs: opts.graceMs ?? 900_000,
        appliers:
          opts.appliers ??
          ({
            succeeded: {
              apply:
                opts.apply ??
                (async (e) => {
                  applied.push(e);
                }),
              result: RESULT_PAID,
              disposition: 'paid',
            },
          } as PayRoutesDeps['appliers']),
      }),
  });
  const { port, close } = await listen(app);
  current = {
    base: `http://127.0.0.1:${port}`,
    close,
    sink,
    applied,
    rec,
  };
  return current;
}

afterEach(async () => {
  await current?.close();
  current = undefined;
});

function channelsUrl(q: string): string {
  return `${current?.base ?? ''}${PAY_CHANNELS_PATH}?${q}`;
}

/** 按 mock Provider 的约定签名并发回调。 */
function postCallback(channel: string, body: string, secret: string = SECRET): Promise<Response> {
  const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return fetch(`${current?.base ?? ''}${PAY_CALLBACK_PREFIX}/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
    body,
  });
}

/**
 * 用 `node:http`（而不是 fetch）发一条**带重复头**的回调。
 *
 * @why 必须造这条用例：`headerBag` 里的 `Array.isArray(value) ? value[0] : value`
 *      是为"入站头是数组"准备的，而 **Node 的 http 解析器确实会给出数组**
 *      （对 `set-cookie`；其它重复头会被拼成 `"a, b"` 字符串——已实测）。
 *      没有这条用例时那条分支就是"写了但从没走过"，覆盖率上表现为一条从未踩到的分支，
 *      而它一旦写错就是"验签拿到的不是签名而是 `[object Array]`"——静默 40103，极难定位。
 * @limitation 用 `set-cookie` 只是因为它**确实**会变成数组；我们不关心它，
 *             要验的是"头袋里有数组时，签名头仍然取对"。
 */
function postCallbackWithArrayHeader(
  channel: string,
  body: string,
  secret: string = SECRET,
): Promise<{ status: number; text: string }> {
  const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  const url = new URL(`${current?.base ?? ''}${PAY_CALLBACK_PREFIX}/${channel}`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': signature,
          'set-cookie': ['a=1', 'b=2'],
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function eventBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: 'evt-1',
    type: 'payment.succeeded',
    order_id: 'sk-1',
    provider_ref: 'cs_1',
    ...over,
  });
}

describe('GET /pay/channels（前端入口的唯一来源）', () => {
  it('按 priority 返回可用通道视图，且**只有视图字段**（不带密钥与机构配置）', async () => {
    const s = await start();
    const res = await fetch(channelsUrl('country=US&currency=JPY&amount_jpy=10000'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      items: [
        { channel: 'a', entryMode: 'in_app', label: '小程序支付', icon: 'wx' },
        { channel: 'b', entryMode: 'copylink', label: '银行卡' },
      ],
    });
    expect(s.sink.find('pay_channels_listed')).toHaveLength(1);
  });

  it('国家 / 币种 / 金额任一不匹配的通道被过滤掉（筛选规则来自注册表，不写在路由里）', async () => {
    await start();
    await expect(
      (await fetch(channelsUrl('country=US&currency=USD&amount_jpy=10000'))).json(),
    ).resolves.toEqual({ items: [{ channel: 'b', entryMode: 'copylink', label: '银行卡' }] });
    // 小额：e 的 maxAmountJpy=5000 放行
    const small = (await await fetch(channelsUrl('country=US&currency=JPY&amount_jpy=3000')).then(
      (r) => r.json(),
    )) as { items: Array<{ channel: string }> };
    expect(small.items.map((i) => i.channel)).toEqual(['a', 'b', 'e']);
    // 日本：c 出现、b 消失
    const jp = (await (
      await fetch(channelsUrl('country=JP&currency=JPY&amount_jpy=10000'))
    ).json()) as { items: Array<{ channel: string }> };
    expect(jp.items.map((i) => i.channel)).toEqual(['a', 'c']);
  });

  it('**已下线**的通道不出现在列表里（配置一改，前端入口自动消失，不发版）', async () => {
    await start();
    const all = await fetch(channelsUrl('country=US&currency=JPY&amount_jpy=10000'));
    const body = (await all.json()) as { items: Array<{ channel: string }> };
    expect(body.items.map((i) => i.channel)).not.toContain('d');
  });

  it('三个查询参数**全部必填**：缺一个就 40001（不给默认值 = 不把国家写死在服务端）', async () => {
    await start();
    for (const q of [
      '',
      'country=US',
      'country=US&currency=JPY',
      'country=us&currency=JPY&amount_jpy=10000', // 小写国家
      'country=USA&currency=JPY&amount_jpy=10000', // 三位
      'country=US&currency=jpy&amount_jpy=10000', // 小写币种
      'country=US&currency=JPY&amount_jpy=0', // 非正数
      'country=US&currency=JPY&amount_jpy=12.5', // 非整数
    ]) {
      const res = await fetch(channelsUrl(q));
      expect(res.status, `query=${q} 应当 400`).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 40001 });
    }
  });
});

describe('POST /pay/callback/:channel（统一分发）', () => {
  it('签名正确 → 验签 + 解析 + 落账，应答 200 且 apply 收到归一化事件', async () => {
    const s = await start();
    const res = await postCallback('a', eventBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, order_id: 'sk-1' });
    expect(s.applied).toHaveLength(1);
    expect(s.applied[0]?.orderId).toBe('sk-1');
    expect(s.applied[0]?.outcome).toBe('succeeded');
    expect(s.rec.finished).toEqual([{ result: 'paid', token: 'tok-1', note: undefined }]);
    // 登记的 provider 就是路径里的通道名（对账时能直接回答"谁发的"）
    expect(s.rec.claimed[0]?.provider).toBe('a');
  });

  it('签名错 → 40103（入站方的问题，不占 5xx），且不落账', async () => {
    const s = await start();
    const res = await postCallback('a', eventBody(), 'wrong-secret');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40103 });
    expect(s.applied).toHaveLength(0);
  });

  it('报文不是合法 JSON → 40001（客户端可控输入，不是我们的故障）', async () => {
    await start();
    const res = await postCallback('a', 'not-json');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('未配置 / 未注册工厂的通道 → 40001（验不了签必须响亮失败，不能静默收下）', async () => {
    await start();
    await expect(postCallback('nope', eventBody())).resolves.toMatchObject({ status: 400 });
    const ghost = await postCallback('ghost', eventBody());
    expect(ghost.status).toBe(400);
    await expect(ghost.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('⚠️ 路由忘了登记 rawBodyPaths → **50000**（我们的装配 bug，不是验签失败）', async () => {
    // @why 这条是刻意的：退化成空 Buffer 会让错误表现成"验签失败"，
    //      排查会指向密钥与机构，而真因在我们自己的装配（pay-routes.ts @limitation 三）。
    await start({ withRawBody: false });
    const res = await postCallback('a', eventBody());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: 50000 });
  });

  it('非 succeeded 的结果 → 2xx 收下 + 登记 ignored:<outcome>，apply 不执行', async () => {
    const s = await start();
    const res = await postCallback('a', eventBody({ type: 'payment.expired' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      received: true,
      order_id: 'sk-1',
      ignored: 'expired',
    });
    expect(s.applied).toHaveLength(0);
    expect(s.rec.finished[0]?.result).toBe('ignored:expired');
  });

  it('🔒 已下线通道的回调**仍能落账**（用 get() 接回调 = 吞掉一批已付款订单）', async () => {
    const s = await start();
    // 对照：它在通道列表里确实不可见
    const list = (await (
      await fetch(channelsUrl('country=US&currency=JPY&amount_jpy=10000'))
    ).json()) as { items: Array<{ channel: string }> };
    expect(list.items.map((i) => i.channel)).not.toContain('d');
    // 但它的在途回调照样要处理
    const res = await postCallback('d', eventBody({ event_id: 'evt-d' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, order_id: 'sk-1' });
    expect(s.applied).toHaveLength(1);
    expect(s.rec.claimed[0]?.provider).toBe('d');
  });

  it('入站头里有数组（重复的 set-cookie）时，签名头仍取对 → 验签不受影响', async () => {
    const s = await start();
    const res = await postCallbackWithArrayHeader('a', eventBody());
    // 反证：若 headerBag 把数组塞进 HMAC，这里会是 40103（签名变成 [object Array]）
    expect(res.status).toBe(200);
    expect(res.text).toContain('"order_id":"sk-1"');
    expect(s.applied).toHaveLength(1);
  });

  it('回调应答体**不含**任何金额或报文内容（机构报文含 PII，回显等于绕过脱敏）', async () => {
    await start();
    const res = await postCallback(
      'a',
      eventBody({ amount_minor: 1234, currency: 'JPY', provider_ref: 'cs_secret_ref' }),
    );
    const text = await res.text();
    expect(text).not.toContain('1234');
    expect(text).not.toContain('cs_secret_ref');
    expect(text).not.toContain('stripe-signature');
  });
});
