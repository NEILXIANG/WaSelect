/**
 * 职责：限流中间件与**接线**的用例（I1-U3）——中间件行为用桩验，"真的挂上了"用真请求验。
 *
 * @why 接线用例（最后一组）是本文件存在的理由：限流器"组件做对了但没挂到路由上"
 *      不会让任何单测红（§2 第 35 条"能力存在 ≠ 能力被用上"）——只有真发第 31 个请求、
 *      看到 40101 变成 42901，才能证明挂载成立。探针用 `POST /orders/quote`：
 *      它的限流挂在 mount.ts 的 `app.use` 层（**先于**路由处理器），而无鉴权请求
 *      在 requireRole 处 40101——恰好提供"限流前置计数、与业务结果无关"的现成探针。
 *      （骨架退役前探针用的是骨架写路径，同一手法，U6c 迁到业务写路径。）
 *
 * @see app/rate-limit.ts（被测）；app/mount.ts（挂载点）；ports/rate-limit.ts；
 *      test/helpers/mount-ctx.ts（stub 装配上下文）
 */
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { fixedClock, mutableClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { stubMountContext } from '../../../test/helpers/mount-ctx.js';
import { createMemoryRateLimitStore } from '../adapters/rate-limit-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import {
  ipKey,
  ipKeyForLogin,
  rateLimitRules,
  rateLimiter,
  type RateLimiterDeps,
} from './rate-limit.js';

function makeDeps(clock?: Clock): { deps: RateLimiterDeps; sink: MemorySink } {
  const sink = new MemorySink();
  return {
    deps: {
      store: createMemoryRateLimitStore(),
      clock: clock ?? fixedClock('2026-01-02T12:00:00.000Z'),
      logger: createLogger({ env: 'test', destination: sink }),
    },
    sink,
  };
}

const RULE = { routeKey: 'test.route', limit: 2, windowMs: 60_000 };

interface Captured {
  err?: unknown;
  headers: Record<string, string>;
}

function run(deps: RateLimiterDeps, ip: string | undefined): Captured {
  const captured: Captured = { headers: {} };
  const handler = rateLimiter(deps, RULE);
  const req = { ip, method: 'POST', path: '/api/v1/x' } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
  } as unknown as Response;
  const next: NextFunction = (e?: unknown) => {
    captured.err = e;
  };
  handler(req, res, next);
  return captured;
}

describe('ipKey：IPv6 归一到 /64（B18 / AJ-205）', () => {
  /**
   * @why 这里钉的是"**攻击面有没有真的缩小**"，不是"字符串长什么样"。
   *      用完整 IPv6 当键时，同一台主机换一个后缀就是新桶——
   *      管理员登录 5 次/15 分钟的防爆破（A1 的前置防线）对 IPv6 完全失效。
   *      所以每条都必须落到"**同一个 /64 里的不同地址必须进同一个桶**"。
   */
  it('同一 /64 的不同地址 → 同一个桶（换了后缀也躲不开）', () => {
    const a = ipKey('2001:db8:abcd:1234:1111:2222:3333:4444');
    const b = ipKey('2001:db8:abcd:1234:dead:beef:0000:0001');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:abcd:1234::/64');
  });

  it('不同 /64 → 不同桶（不是把所有 IPv6 合成一个）', () => {
    expect(ipKey('2001:db8:abcd:1234::1')).not.toBe(ipKey('2001:db8:abcd:5678::1'));
  });

  it('IPv4 原样（一个地址 = 一台主机的现实粒度）', () => {
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4');
  });

  /**
   * @why IPv4-mapped（`::ffff:1.2.3.4`）**必须**转成 IPv4：
   *      双栈环境下同一个来源一会儿是 `1.2.3.4` 一会儿是 `::ffff:1.2.3.4`，
   *      不转就是两个桶、各算一半配额——攻击者靠"交替形态"把自己的配额翻倍。
   */
  it('IPv4-mapped 转成 IPv4：与纯 IPv4 共用同一个桶', () => {
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });

  it('不认识的形状原样返回（不猜、不放行）', () => {
    expect(ipKey('unknown')).toBe('unknown');
    expect(ipKey('')).toBe('');
    // 冒号形状但不是合法 IPv6：段数超了 / 出现两个 `::` / 非十六进制 / 段超过 4 位
    expect(ipKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(ipKey('1::2::3')).toBe('1::2::3');
    expect(ipKey('2001:db8:zzzz:1::1')).toBe('2001:db8:zzzz:1::1');
    expect(ipKey('2001:db8:12345:1::1')).toBe('2001:db8:12345:1::1');
    // `::` 至少代表一段零：已经写满 8 段再加 `::` 不合法；点分段超过 255 不合法
    expect(ipKey('1:2:3:4:5:6:7::8')).toBe('1:2:3:4:5:6:7::8');
    expect(ipKey('64:ff9b::999.0.2.33')).toBe('64:ff9b::999.0.2.33');
  });

  /**
   * AJ-234（B18 的残留）：**压缩写法**（含 `::`）必须先展开再取前 64 位。
   * @why 原实现是 `ip.split(':').slice(0, 4)`——`::` 在 split 后是一个空串，占掉一段。
   *      `2001:db8::1:2:3:4`（= `2001:db8:0:0:1:2:3:4`）被取成 `2001:db8::1`，
   *      于是前 64 位里含零段的前缀下，**接口标识符的第一段混进了桶键**：
   *      同一个 /64 能拆出 65536 个桶，登录防爆破与"刷满键触发驱逐"在这类前缀上照样可绕。
   *      而 Node 给出的 `req.ip` 正是压缩写法，这不是冷门输入。
   *      原来的用例全用四段非零前缀（`2001:db8:abcd:1234:…`），恰好避开了它。
   */
  it('🔴 压缩写法：同一 /64 里换接口标识符 → 仍是同一个桶', () => {
    const a = ipKey('2001:db8::1:2:3:4'); // 2001:db8:0:0 | 1:2:3:4
    const b = ipKey('2001:db8::5:2:3:4'); // 2001:db8:0:0 | 5:2:3:4
    const c = ipKey('2001:db8::ffff'); // 2001:db8:0:0 | 0:0:0:ffff
    expect(a).toBe('2001:db8:0:0::/64');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('🔴 `::` 落在前 64 位之内：不同 /64 仍然分得开', () => {
    expect(ipKey('2001:db8::1:0:0:0:1')).toBe('2001:db8:0:1::/64'); // 2001:db8:0:1 | 0:0:0:1
    expect(ipKey('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64');
    expect(ipKey('2001:db8:0:2::1')).toBe('2001:db8:0:2::/64');
  });

  it('同一地址的不同写法（大小写 / 前导零 / 带 zone id）→ 同一个桶', () => {
    const want = ipKey('2001:db8:abcd:1234::1');
    expect(ipKey('2001:0DB8:ABCD:1234:0000:0000:0000:0001')).toBe(want);
    expect(ipKey('2001:db8:abcd:1234::1%en0')).toBe(want);
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('回环 `::1` 也按规则归一（它也是一个 /64；不再因"段数不足"被当成不认识）', () => {
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::')).toBe('0:0:0:0::/64');
  });

  it('末 32 位写成点分十进制的 IPv6（非 IPv4-mapped）：前 64 位照常归一', () => {
    expect(ipKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  /**
   * 中间件层：两个"看起来不同"的 IPv6 必须共用配额。
   * @why 只测 `ipKey` 这个函数是不够的——把函数做对了但中间件没用它，
   *      同样全绿（§2 第 35 条：能力存在 ≠ 能力被用上）。这一条走完整中间件路径。
   */
  it('中间件：同一 /64 的两个地址打满 2 次后，第三个地址就被 42901（B18 接线）', () => {
    const { deps } = makeDeps();
    run(deps, '2001:db8:abcd:1234::1');
    run(deps, '2001:db8:abcd:1234:9999:8888:7777:6666'); // 同一个 /64，形态完全不同
    const third = run(deps, '2001:db8:abcd:1234:aaaa::1');
    expect(third.err).toBeInstanceOf(AppError);
    expect((third.err as AppError).code).toBe(42901);
    // 另一个 /64 不受影响（不是"把所有 IPv6 合成一个桶")
    expect(run(deps, '2001:db8:abcd:5678::1').err).toBeUndefined();
  });
});

describe('rateLimiter 中间件（桩）', () => {
  it('限额内放行（第 1、2 次无错误透传）', () => {
    const { deps } = makeDeps();
    expect(run(deps, '1.1.1.1').err).toBeUndefined();
    expect(run(deps, '1.1.1.1').err).toBeUndefined();
  });

  it('超限 → AppError(42901) + Retry-After 头 + warn 日志', () => {
    const { deps, sink } = makeDeps();
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    const third = run(deps, '1.1.1.1');
    expect(third.err).toBeInstanceOf(AppError);
    expect((third.err as AppError).code).toBe(42901);
    // 固定时钟 + 60s 窗口：第 3 次命中时 resetAt − now 恰为 60_000ms ⇒ retry-after 必须是 60（不是"≥1"：
    //   写成 `Math.max(1, …)` 永远回 1 也能过 ≥1，审查 2026-10-09 C4）
    expect(third.headers['retry-after']).toBe('60');
    const log = sink.find('rate_limited')[0];
    expect(log?.level).toBe('warn');
    expect(log?.['http_path']).toBe('/api/v1/x');
  });

  /**
   * SEC-10：本中间件也会**挂在前缀上**（`mount.ts` 的 `app.use('/api/v1/orders/quote', …)`）。
   *
   * @why Express 会把挂载前缀从 `req.path` 里剥掉 ⇒ `req.path` 恒为 `'/'`，
   *      于是 `rate_limited` 日志的 `http_path` 一条有用的信息都没有——
   *      而限流是**按入口分桶**的，"哪个入口被限了"正是这条日志唯一要回答的问题。
   *      路由级挂载（`app.post('/path', limiter, …)`）时 `baseUrl` 是空串，回落到 `req.path`。
   */
  it('🔴 挂在前缀上时日志的 http_path 是完整挂载路径，不是 "/"（SEC-10）', () => {
    const { deps, sink } = makeDeps();
    const handler = rateLimiter(deps, RULE);
    const req = {
      ip: '1.1.1.1',
      method: 'POST',
      path: '/',
      baseUrl: '/api/v1/orders/quote',
    } as unknown as Request;
    for (let i = 0; i < 10; i += 1) {
      handler(
        req,
        { setHeader: () => undefined } as unknown as Response,
        (() => undefined) as unknown as NextFunction,
      );
    }
    const log = sink.find('rate_limited')[0];
    expect(log?.['http_path']).toBe('/api/v1/orders/quote');
  });

  it('按 IP 隔离：A 超限不影响 B', () => {
    const { deps } = makeDeps();
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1'); // A 超限
    expect(run(deps, '2.2.2.2').err).toBeUndefined();
  });

  it('🔴 支付回调单独一条规则：默认每 IP 每分钟 600 次，不沿用买家写入口的 30（四天提交复查 2026-10-16）', () => {
    // @why Stripe 的 webhook 从少数固定 IP 发出，全店所有订单的事件挤在每 IP 一个桶里；
    //      30/分钟在重投积压时会被 429 → Stripe 指数退避（可到小时级）→ 订单期间到期关单、钱变成迟到付款
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/x',
      JWT_SECRET: 'rate-limit-unit-secret-'.repeat(3),
      PAYMENT_CHANNELS: 'mock',
      TERMS_VERSION: 'T',
    };
    const rule = rateLimitRules(loadConfig(base)).payCallback;
    expect(rule.limit).toBe(600);
    expect(rule.windowMs).toBe(60_000);
    expect(rule.routeKey).toBe('pay.callback');
    expect(
      rateLimitRules(loadConfig({ ...base, RATE_LIMIT_CALLBACK_PER_MIN: '50' })).payCallback.limit,
    ).toBe(50);
  });

  it('publicWrite(routeKey) 每个入口独立桶：报价打满不消耗登录 / 建单的配额（全量审计 P1）', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/x',
      JWT_SECRET: 'rate-limit-unit-secret-'.repeat(3),
      PAYMENT_CHANNELS: 'mock',
      TERMS_VERSION: 'T',
      RATE_LIMIT_QUOTE_PER_MIN: '2',
    });
    const rules = rateLimitRules(cfg);
    const keys = new Set(
      ['orders.quote', 'orders.create', 'orders.pay', 'pay.link', 'auth.wechat.login'].map(
        (k) => rules.publicWrite(k).routeKey,
      ),
    );
    expect(keys.size).toBe(5);
    const { deps } = makeDeps();
    const hit = (rule: ReturnType<typeof rules.publicWrite>): Captured => {
      const captured: Captured = { headers: {} };
      rateLimiter(deps, rule)(
        { ip: '9.9.9.9', method: 'POST', path: '/x' } as unknown as Request,
        { setHeader: () => undefined } as unknown as Response,
        ((e?: unknown) => {
          captured.err = e;
        }) as NextFunction,
      );
      return captured;
    };
    hit(rules.publicWrite('orders.quote'));
    hit(rules.publicWrite('orders.quote'));
    expect(hit(rules.publicWrite('orders.quote')).err).toBeDefined(); // 报价桶满
    expect(hit(rules.publicWrite('auth.wechat.login')).err).toBeUndefined(); // 登录桶不受影响
  });

  it('req.ip 缺失按 unknown 计（绝不自己读 X-Forwarded-For）', () => {
    const { deps } = makeDeps();
    run(deps, undefined);
    run(deps, undefined);
    expect(run(deps, undefined).err).toBeInstanceOf(AppError);
  });

  it('窗口走注入时钟：推进假时钟越过窗口 → 配额回来（确定性，不靠真实时间漂）', () => {
    // @why 旧版这条只发三次请求、断言第三次超限——中间件若自己 `new Date()` 它**照样绿**
    //      （三次请求几乎必然落在同一分钟里），只在跨分钟边界时偶发红：一条会 flaky 的用例。
    //      改成**推进注入时钟**之后：真用了注入时钟 → 配额回来；
    //      用了 `new Date()` → 推进假时钟不影响计数，第 4、5 次仍然超限 → 红。
    //      "时间来自注入时钟"从一句注释变成一条确定性断言（U-J4）。
    const { clock, advance } = mutableClock('2026-01-02T12:00:00.000Z');
    const { deps } = makeDeps(clock);
    run(deps, '1.1.1.1');
    run(deps, '1.1.1.1');
    expect(run(deps, '1.1.1.1').err).toBeInstanceOf(AppError); // 窗口内第 3 次：超限

    advance(RULE.windowMs + 1); // 越过窗口边界
    expect(run(deps, '1.1.1.1').err).toBeUndefined(); // 配额回来
    expect(run(deps, '1.1.1.1').err).toBeUndefined();
    expect(run(deps, '1.1.1.1').err).toBeInstanceOf(AppError); // 新窗口再次打满
  });
});

describe('限流接线（真请求，防"组件对了但没挂上"）', () => {
  it('业务写路径（POST /orders/quote）：前 30 次 40101（鉴权拦下），第 31 次 42901（限流拦下）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const app = createHttpApp({
      logger,
      mount: (a) => mountAllRoutes(a, stubMountContext({ logger })),
    });
    const server = await listen(app);
    try {
      const url = `http://127.0.0.1:${server.port}/api/v1/orders/quote`;
      const post = () =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      // ⚠️ 避开整分钟边界（第二轮审计 2026-10-11 gate:fast 偶发红：第 31 次得到 401 而不是 429）：
      //    限流是按整分钟对齐的固定窗口（ports/rate-limit.ts `windowStartOf`），这里走真实时钟；
      //    31 次请求约 0.6 秒，恰好跨过整分钟时计数清零、第 31 次被放行。离边界不足 3 秒就等到下一分钟开头再打。
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      if (msToNextMinute < 3_000) await new Promise((r) => setTimeout(r, msToNextMinute + 50));
      // 默认 RATE_LIMIT_QUOTE_PER_MIN=30：前 30 次穿过限流，被 requireRole 拦成 40101
      for (let i = 0; i < 30; i += 1) {
        const res = await post();
        const body = (await res.json()) as { code: number };
        expect(body.code).toBe(40101);
      }
      // 第 31 次：限流先于鉴权
      const res = await post();
      const body = (await res.json()) as { code: number };
      expect(res.status).toBe(429);
      expect(body.code).toBe(42901);
      expect(res.headers.get('retry-after')).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});

/**
 * PAY3-01：登录额度的**来源桶**对 IPv6 归到 `/56`，比全站限流的 /64 更粗。
 *
 * @why 两台机器的对手不同：全站限流的对手是"一个来源刷接口"，/64 够；
 *      登录来源桶的对手是"凑够 N 个来源去耗光邮箱桶"——而 IPv6 下凑来源**不要钱**
 *      （一台 /56 的主机就有 256 个 /64，HE 隧道免费给 /48）。
 *      按 /64 计，一台机器每 15 分钟就能往邮箱桶里塞 256×5 次，
 *      AJ-243 那句"要锁死所有人得凑够 6 个来源"等于没设防。
 */
describe('ipKeyForLogin：登录来源对 IPv6 归到 /56（PAY3-01）', () => {
  it('🔴 同一个 /56 内 256 个不同的 /64 → 同一个来源桶', () => {
    const base = ipKeyForLogin('2001:db8:1:00::1');
    for (let i = 1; i < 256; i += 37) {
      const g = i.toString(16);
      expect(ipKeyForLogin(`2001:db8:1:${g}::1`), g).toBe(base);
    }
    expect(base).toBe('2001:db8:1:0::/56');
  });

  it('不同的 /56 → 不同桶（不是把所有 IPv6 合成一个）', () => {
    expect(ipKeyForLogin('2001:db8:1:100::1')).not.toBe(ipKeyForLogin('2001:db8:1:200::1'));
    expect(ipKeyForLogin('2001:db8:1:ff00::1')).not.toBe(ipKeyForLogin('2001:db8:1:0::1'));
  });

  it('第 4 段只取高 8 位（/56 = 3.5 段）', () => {
    // 0x12ff 与 0x1200 同 /56；0x1300 不同
    expect(ipKeyForLogin('2001:db8:1:12ff::1')).toBe('2001:db8:1:1200::/56');
    expect(ipKeyForLogin('2001:db8:1:1300::1')).toBe('2001:db8:1:1300::/56');
  });

  it('IPv4 原样返回；IPv4-mapped 折成 IPv4（与纯 IPv4 共用同一个桶）', () => {
    expect(ipKeyForLogin('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKeyForLogin('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('认不出的形态原样返回（不猜，与 ipKey 同口径）', () => {
    for (const bad of ['unknown', '', '2001:db8:zzzz:1::1', '1::2::3']) {
      expect(ipKeyForLogin(bad), bad).toBe(bad);
    }
  });

  it('比 ipKey 更粗，但**更粗**不等于"粗到没用"：/48 之间仍分开', () => {
    const a = ipKeyForLogin('2001:db8:aaaa:100::1');
    const b = ipKeyForLogin('2001:db8:bbbb:100::1');
    expect(a).not.toBe(b);
    // 同一 /64 当然也同桶（更粗的函数不会把同 /64 拆开）
    expect(ipKeyForLogin('2001:db8:1:2::1')).toBe(ipKeyForLogin('2001:db8:1:2::ffff'));
  });
});
