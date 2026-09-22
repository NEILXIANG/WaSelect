/**
 * 职责：HTTP 骨架的 L1 单测（F6）——**真起端口 + 真 fetch**，不 mock Express。
 * @why 骨架的价值全在横切行为（上下文注入、错误兜底、raw body 顺序），这些只在真实请求链路上才成立；
 *      用 supertest 或 mock 掉一层就测不到中间件顺序这类问题。
 * @see server/src/http.ts @why；docs/地基搭建清单.md F6
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { Buffer } from 'node:buffer';
import { MemorySink } from '../../test/helpers/memory-sink.js';
import { createHttpApp, listen } from './http.js';
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
  const { port, close } = await listen(app, 0);
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
