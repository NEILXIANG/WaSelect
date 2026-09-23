/**
 * 职责：HTTP 骨架的 L1 单测（F6）——**真起端口 + 真 fetch**，不 mock Express。
 * @why 骨架的价值全在横切行为（上下文注入、错误兜底、raw body 顺序），这些只在真实请求链路上才成立；
 *      用 supertest 或 mock 掉一层就测不到中间件顺序这类问题。
 * @see server/src/http.ts @why；docs/地基搭建清单.md F6
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { MemorySink } from '../../test/helpers/memory-sink.js';
import { createHttpApp, defaultHost, installShutdownHandlers, listen } from './http.js';
import { createLogger } from './logger.js';
import { AppError } from './errors.js';

const RAW_CALLBACK_PATH = '/api/v1/pay/callback/stripe';

/** 起一个真实服务，返回 baseUrl；用例结束后关闭。 */
async function start(mount?: (app: Express) => void): Promise<{
  baseUrl: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  const app = createHttpApp({
    logger,
    rawBodyPaths: [RAW_CALLBACK_PATH],
    silentPaths: ['/healthz'],
    mount,
  });
  const { port, close } = await listen(app);
  return { baseUrl: `http://127.0.0.1:${port}`, sink, close };
}

let current: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** start 的包装：记录句柄以便 afterEach 关闭。 */
async function serve(mount?: (app: Express) => void) {
  const s = await start(mount);
  current = s;
  return s;
}

describe('健康检查与请求标识', () => {
  it('GET /healthz 返回 200 且带请求标识头', async () => {
    const { baseUrl } = await serve();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-trace-id')).toBeTruthy();
  });

  it('上游传入的 x-trace-id 被沿用并回传（链路不能断）', async () => {
    const { baseUrl, sink } = await serve((app) => {
      app.get('/echo', (_req, res) => res.json({ ok: true }));
    });
    const res = await fetch(`${baseUrl}/echo`, { headers: { 'x-trace-id': 'trace-upstream' } });
    expect(res.headers.get('x-trace-id')).toBe('trace-upstream');
    const row = sink.find('http_request').at(-1);
    expect(row?.trace_id).toBe('trace-upstream');
  });

  it('健康检查不打访问日志，避免探活淹没日志', async () => {
    const { baseUrl, sink } = await serve();
    await fetch(`${baseUrl}/healthz`);
    expect(sink.find('http_request')).toHaveLength(0);
  });
});

describe('统一错误兜底', () => {
  it('业务 AppError → 对应状态码与错误码', async () => {
    const { baseUrl } = await serve((app) => {
      app.get('/boom', () => {
        throw new AppError(40901);
      });
    });
    const res = await fetch(`${baseUrl}/boom`);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ code: 40901, message: '库存不足' });
  });

  it('未知异常 → 500 + 50000，响应体不含内部细节', async () => {
    const { baseUrl, sink } = await serve((app) => {
      app.get('/crash', () => {
        throw new Error('password=xxx at 10.0.0.7');
      });
    });
    const res = await fetch(`${baseUrl}/crash`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('password');
    expect(body).not.toContain('10.0.0.7');
    expect(JSON.parse(body)).toEqual({ code: 50000, message: '服务器内部错误' });
    // 但日志里必须留下堆栈，否则无法定位（这是"日志承担可观测性"的兑现）
    const row = sink.find('unhandled_error').at(-1);
    expect(row?.err_message).toContain('10.0.0.7');
    expect(typeof row?.err_stack).toBe('string');
  });

  it('未匹配路由 → 404 + 40400（统一形状，不是 Express 默认 HTML）', async () => {
    const { baseUrl } = await serve();
    const res = await fetch(`${baseUrl}/no/such/route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40400);
  });

  it('坏 JSON → 400 + 40001，不是裸 500', async () => {
    const { baseUrl } = await serve((app) => {
      app.post('/echo', (req, res) => res.json({ got: req.body }));
    });
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });
});

describe('回调原文（验签前提）', () => {
  it('rawBodyPaths 里的路由拿到 Buffer 原文，不被 JSON 解析破坏', async () => {
    const { baseUrl } = await serve((app) => {
      app.post(RAW_CALLBACK_PATH, (req, res) => {
        res.json({ isBuffer: Buffer.isBuffer(req.body), type: typeof req.body });
      });
    });
    const res = await fetch(`${baseUrl}${RAW_CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_1', data: { a: 1 } }),
    });
    await expect(res.json()).resolves.toEqual({ isBuffer: true, type: 'object' });
  });

  it('非白名单路由仍然走 JSON 解析', async () => {
    const { baseUrl } = await serve((app) => {
      app.post('/api/v1/orders', (req, res) => res.json({ body: req.body }));
    });
    const res = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'S1' }),
    });
    await expect(res.json()).resolves.toEqual({ body: { sku: 'S1' } });
  });
});

describe('访问日志（请求维度）', () => {
  it('每条请求落一条 http_request，含方法/路径/状态码/耗时', async () => {
    const { baseUrl, sink } = await serve((app) => {
      app.get('/slow', (_req, res) => setTimeout(() => res.json({ ok: 1 }), 5));
    });
    await fetch(`${baseUrl}/slow`);
    const row = sink.find('http_request').at(-1);
    expect(row?.http_method).toBe('GET');
    expect(row?.http_path).toBe('/slow');
    expect(row?.http_status).toBe(200);
    expect(row?.result).toBe('ok');
    expect(typeof row?.duration_ms).toBe('number');
    expect(row?.req_id).toBeTruthy();
  });

  it('4xx 记 warn、5xx 记 error，便于按级别筛问题', async () => {
    const { baseUrl, sink } = await serve((app) => {
      app.get('/e409', () => {
        throw new AppError(40902);
      });
      app.get('/e500', () => {
        throw new AppError(50001);
      });
    });
    await fetch(`${baseUrl}/e409`);
    await fetch(`${baseUrl}/e500`);
    const levels = Object.fromEntries(sink.rows().map((r) => [r.event, r.level]));
    expect(levels.request_rejected).toBe('warn');
    expect(levels.request_failed).toBe('error');
  });
});

/**
 * 监听地址与优雅关闭（P0 修复项）。
 * @why 「硬绑 127.0.0.1」和「没有 SIGTERM 处理」都不会在本地红灯——本地永远是"能连上、能 Ctrl-C"，
 *      只有在容器平台上才表现为"发布超时"和"部署时请求被腰斩"。
 *      所以这两条必须用**真实端口 + 真实信号**钉死，不能只测逻辑分支。
 */
describe('监听地址', () => {
  it('默认监听 0.0.0.0——容器平台从外部探端口，绑回环会导致部署健康检查超时', async () => {
    const app = createHttpApp({
      logger: createLogger({ env: 'development', destination: new MemorySink() }),
    });
    const started = await listen(app);
    current = started;
    expect(started.host).toBe('0.0.0.0');
    // 从 127.0.0.1 能连上，证明不是只绑了某个外网 IP
    const res = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it('HOST 环境变量可覆盖默认地址（本地只想绑回环时用）', async () => {
    const prev = process.env.HOST;
    process.env.HOST = '127.0.0.1';
    try {
      expect(defaultHost()).toBe('127.0.0.1');
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });

  it('HOST 为空串时回落到 0.0.0.0（空串比"没配"更危险：容易误判为已配置）', () => {
    const prev = process.env.HOST;
    process.env.HOST = '   ';
    try {
      expect(defaultHost()).toBe('0.0.0.0');
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });
});

describe('优雅关闭', () => {
  it('close() 之后端口不再接受连接', async () => {
    const app = createHttpApp({
      logger: createLogger({ env: 'development', destination: new MemorySink() }),
    });
    const started = await listen(app);
    await started.close();
    await expect(fetch(`http://127.0.0.1:${started.port}/healthz`)).rejects.toThrow();
  });

  it('存量请求不被腰斩：关闭期间已在处理中的请求仍能正常返回', async () => {
    // ⚠️ 路由必须挂在 mount 里，不能在 createHttpApp 之后再 app.get：
    //    兜底 404 是在 mount 之后注册的，事后补的路由会被它先吃掉（返回 404，handler 永不执行）。
    //    这是本骨架的真实陷阱——第一次写这个用例就踩了（表现为 await enteredHandler 永久挂起、用例 5s 超时）。
    // @why 另外必须等请求**真的进到 handler** 再发起关闭：fetch 的连接建立是异步的，
    //      若不等就 close()，测到的是"新连接被拒"（ECONNREFUSED）而不是"存量请求被腰斩"——
    //      那不是本用例想验的行为，红灯会误导人以为是优雅关闭坏了。
    let entered: () => void = () => undefined;
    const enteredHandler = new Promise<void>((r) => {
      entered = r;
    });
    const app = createHttpApp({
      logger: createLogger({ env: 'development', destination: new MemorySink() }),
      mount: (a) => {
        a.get('/slow', async (_req, res) => {
          entered();
          await new Promise((r) => setTimeout(r, 120));
          res.json({ ok: true });
        });
      },
    });
    const started = await listen(app);
    const inflight = fetch(`http://127.0.0.1:${started.port}/slow`).then((r) => r.status);
    await enteredHandler;
    // 此刻请求正在处理中——这正是"部署时被 SIGTERM"的真实时序
    const closedAt = performance.now();
    const closing = started.close();
    await expect(inflight).resolves.toBe(200);
    await expect(closing).resolves.toBeUndefined();
    // 关闭必须在存量请求结束后**立刻**完成：若等到客户端 keep-alive 自己超时，
    // 关闭耗时会变成 3s 级（实测未加清扫器时 3128ms），白白吃掉部署窗口。
    expect(performance.now() - closedAt).toBeLessThan(1000);
  });

  it('SIGTERM 触发关闭并退出码 0（beforeClose 先于 close 执行）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const app = createHttpApp({ logger });
    const started = await listen(app);
    const order: string[] = [];
    const exits: number[] = [];

    const uninstall = installShutdownHandlers(started, {
      logger,
      beforeClose: async () => {
        order.push('beforeClose');
      },
      exit: (code) => exits.push(code),
      exitDelayMs: 10,
    });
    try {
      expect(process.listeners('SIGTERM')).toHaveLength(1);
      expect(process.listeners('SIGINT')).toHaveLength(1);

      // 真实信号投递会把信号名作为第一个参数传给监听器，这里必须显式带上，
      // 否则 handler 收到 undefined，日志里的 signal 字段就空了（与生产不一致）
      process.emit('SIGTERM' as NodeJS.Signals, 'SIGTERM');
      await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 1000 });
      expect(order).toEqual(['beforeClose']);
      expect(sink.find('server_stopped')[0]?.signal).toBe('SIGTERM');
    } finally {
      uninstall();
      await started.close().catch(() => undefined);
    }
  });

  it('重复信号只处理一次（平台常 SIGTERM 后紧跟 SIGINT）', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'development', destination: sink });
    const started = await listen(createHttpApp({ logger }));
    let beforeCloseCalls = 0;
    const exits: number[] = [];
    const uninstall = installShutdownHandlers(started, {
      logger,
      beforeClose: async () => {
        beforeCloseCalls += 1;
      },
      exit: (code) => exits.push(code),
      exitDelayMs: 10,
    });
    try {
      process.emit('SIGTERM' as NodeJS.Signals, 'SIGTERM');
      process.emit('SIGINT' as NodeJS.Signals, 'SIGINT');
      await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0), { timeout: 1000 });
      expect(beforeCloseCalls).toBe(1);
    } finally {
      uninstall();
      await started.close().catch(() => undefined);
    }
  });

  it('卸载后不再响应信号（避免测试之间互相干扰）', async () => {
    const logger = createLogger({ env: 'development', destination: new MemorySink() });
    const started = await listen(createHttpApp({ logger }));
    const uninstall = installShutdownHandlers(started, {
      logger,
      exit: () => undefined,
      exitDelayMs: 10,
    });
    uninstall();
    expect(process.listeners('SIGTERM')).toHaveLength(0);
    await started.close();
  });
});

/**
 * `x-trace-id` 的形状校验（P1）。
 *
 * @why 这个头的值会写进**每一条日志**，且键名不在 redact 的敏感名单里——
 *      不校验就等于让客户端往我们的日志里写任意内容，且绕过脱敏。
 * @limitation 含裸换行的头值**发不出来**（fetch 与 Node 的 HTTP 解析器都会先拒），
 *      所以这里用**原始 socket**测的是"合法字节但形状危险"的那几种：超长、含空格、空值。
 *      换行场景另有一条用例，断言它根本到不了应用层。
 */
describe('x-trace-id 必须是安全的形状', () => {
  /** 原始 socket 发请求：绕过 fetch/undici 对头值的合法性校验，模拟真实畸形输入。 */
  function rawGet(port: number, headerLine: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          `GET /healthz HTTP/1.1\r\nHost: t\r\nx-trace-id: ${headerLine}\r\nConnection: close\r\n\r\n`,
        );
      });
      let buf = '';
      sock.setTimeout(3000, () => sock.destroy());
      sock.on('data', (d: Buffer) => {
        buf += d.toString();
      });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
  }

  it('合法值沿用并回传（跨服务链路不能断）', async () => {
    const { baseUrl } = await serve();
    const res = await fetch(`${baseUrl}/healthz`, { headers: { 'x-trace-id': 'trace-abc-123' } });
    expect(res.headers.get('x-trace-id')).toBe('trace-abc-123');
  });

  it('超长 / 含空格 / 空值一律丢弃并新建（原始 socket 直发）', async () => {
    const { baseUrl, sink } = await serve();
    const port = Number(new URL(baseUrl).port);
    for (const bad of ['x'.repeat(200), 'has space here', '', '   ', 'a']) {
      const raw = await rawGet(port, bad);
      const got = /x-trace-id: (\S+)/.exec(raw)?.[1];
      expect(got).toBeDefined();
      expect(got).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
      expect(got).not.toBe(bad.trim());
    }
    // 并且日志里没有出现那些畸形值
    const all = sink.lines.join('\n');
    expect(all).not.toContain('x'.repeat(200));
    expect(all).not.toContain('has space here');
  });

  it('换行注入到不了应用层：HTTP 解析器先拒（本校验不是这层的防线）', async () => {
    // fetch 会在客户端直接抛错——证明裸换行根本发不出去
    await expect(
      fetch(`${(await serve()).baseUrl}/healthz`, {
        headers: { 'x-trace-id': 'abc\n{"event":"pay_succeeded"}' },
      }),
    ).rejects.toThrow();
  });
});

/** 报文解析错误的归类精度（P1）。 */
describe('错误归类：解析错误 vs 服务端 bug', () => {
  it('JSON 语法错 → 40001（参数格式错误）', async () => {
    const { baseUrl } = await serve();
    const res = await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ bad json',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('解析错误的日志不带请求体片段（请求体是客户端可控内容）', async () => {
    const { baseUrl, sink } = await serve();
    await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"card":"4242424242424242"',
    });
    expect(sink.lines.join('\n')).not.toContain('4242424242424242');
  });

  /**
   * @why 客户端可控的输入（畸形 JSON、超大报文）不该占用 **error 通道**。
   *      错误码虽已是 40001，但日志事件曾是 `unhandled_error` 且带堆栈——
   *      后果：扫描器/爬虫每天刷几百条畸形请求，就把真正要看的 5xx 全淹了，
   *      而且 `err_stack` 里带的是客户端报文的解析上下文。
   */
  it('JSON 语法错记 warn（request_rejected），不进 unhandled_error，也不带堆栈', async () => {
    const { baseUrl, sink } = await serve();
    await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ bad json',
    });
    expect(sink.find('unhandled_error')).toHaveLength(0);
    const rejected = sink.find('request_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.level).toBe('warn');
    expect(rejected[0]?.err_stack).toBeUndefined();
  });

  it('请求体超限同样是客户端问题：warn 而非 error', async () => {
    const { baseUrl, sink } = await serve();
    await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(120 * 1024) }),
    });
    expect(sink.find('unhandled_error')).toHaveLength(0);
    const rejected = sink.find('request_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.level).toBe('warn');
  });

  it('业务代码抛的 SyntaxError → 50000，不能被误判成"用户传参错"', async () => {
    const { baseUrl, sink } = await serve((app) => {
      app.get('/bug', () => {
        // 模拟后端自己的 JSON.parse 失败：这是 bug，不是用户问题
        JSON.parse('{oops');
      });
    });
    const res = await fetch(`${baseUrl}/bug`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: 50000 });
    // 且必须记为 unhandled_error（要人来看），而不是 request_rejected
    expect(sink.find('unhandled_error').length).toBeGreaterThan(0);
  });
});
