/**
 * 职责：admin-web 请求封装 / 配置解析 / token 存储的单元测试（F15 单元②的**验收核心**）。
 *
 * @why 这三块是管理端所有页面共用的地基：它们错了不会报错，只会让"发货/退款"这类写操作
 *      在某个边界上静默走错路（带错 token、超时当失败重发、401 不登出）。
 *      所以清单 F15 给本端的验收项就是「后台 API 封装单测」——钉在这里，而不是钉在 UI 上。
 *
 * @how 传输层全部注入假 fetch（T-3"依赖要真"的边界：fetch 是宿主/第三方能力，允许 Fixture；
 *      不真发 HTTP——本机闸门也不放行进站回环以外的请求）。
 *
 * @see ./client.ts、./config.ts、./token-store.ts；miniprogram/utils/request.unit.test.ts（对齐的另一端）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@waselect/shared';
import {
  ApiError,
  NETWORK_ERROR_CODE,
  UNAUTHORIZED_CODE,
  parseRetryAfter,
  retryAfterMsSec,
} from './errors.js';
import { createAdminApi, DEFAULT_TIMEOUT_MS } from './client.js';
import { DEFAULT_API_BASE, normalizeBaseUrl, resolveApiBase } from './config.js';
import { createTokenStore, TOKEN_STORAGE_KEY } from './token-store.js';

/** 造一个 JSON 响应（带 content-type，贴近服务端真实形状）。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 抓取 fetch 收到的东西（url/init），供断言请求形状。 */
function fetchSpy(impl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const implFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return impl !== undefined ? impl(String(url), init) : jsonResponse({ ok: true });
  };
  return { calls, impl: implFn as typeof fetch };
}

function makeApi(overrides: Partial<Parameters<typeof createAdminApi>[0]> = {}) {
  const log = vi.fn();
  const onUnauthorized = vi.fn();
  const api = createAdminApi({
    baseUrl: 'http://api.test',
    getToken: () => 'tok-1',
    log,
    onUnauthorized,
    newTraceId: () => 'trace-fixed-1',
    ...overrides,
  });
  return { api, log, onUnauthorized };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('请求形状（header / 方法 / body / 拼接）', () => {
  it('成功：2xx 且无 code → resolve body；自动带 content-type 与 x-trace-id', async () => {
    const spy = fetchSpy(async () => jsonResponse({ items: [1, 2] }));
    const { api } = makeApi({ fetchImpl: spy.impl });
    const out = await api({ path: '/api/v1/admin/orders' });
    expect(out).toEqual({ items: [1, 2] });
    const call = spy.calls[0];
    expect(call?.url).toBe('http://api.test/api/v1/admin/orders');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-trace-id']).toBe('trace-fixed-1');
    expect(call?.init?.method).toBe('GET');
  });

  it('有 token 带 authorization，空 token 不带（与小程序端同口径）', async () => {
    const spy = fetchSpy();
    const { api } = makeApi({ fetchImpl: spy.impl });
    await api({ path: '/x' });
    expect((spy.calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer tok-1',
    );

    const spy2 = fetchSpy();
    const { api: api2 } = makeApi({ fetchImpl: spy2.impl, getToken: () => '' });
    await api2({ path: '/x' });
    expect(
      (spy2.calls[0]?.init?.headers as Record<string, string>)['authorization'],
    ).toBeUndefined();
  });

  it('写操作：method/body/idempotency-key 按选项发出', async () => {
    const spy = fetchSpy();
    const { api } = makeApi({ fetchImpl: spy.impl });
    await api({
      path: '/api/v1/admin/orders/o1/ship',
      method: 'POST',
      body: { carrier: 'EMS' },
      idempotencyKey: 'idem-1',
    });
    const init = spy.calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ carrier: 'EMS' }));
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');
  });

  it('opts.traceId 复用优先于生成（同一次用户操作的多个请求同一条链路）', async () => {
    const spy = fetchSpy();
    const { api } = makeApi({ fetchImpl: spy.impl });
    await api({ path: '/x', traceId: 'trace-reused' });
    expect((spy.calls[0]?.init?.headers as Record<string, string>)['x-trace-id']).toBe(
      'trace-reused',
    );
  });

  it('默认 newTraceId = crypto.randomUUID，形状过服务端 TRACE_ID_PATTERN（^[A-Za-z0-9._:-]{8,64}$）', async () => {
    const spy = fetchSpy();
    const { api } = makeApi({ fetchImpl: spy.impl, newTraceId: undefined });
    await api({ path: '/x' });
    const sent = (spy.calls[0]?.init?.headers as Record<string, string>)['x-trace-id'] ?? '';
    expect(sent).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
  });

  it('不传 fetchImpl 时取**调用时的**全局 fetch（生产默认路径；vi.stubGlobal 整体替换闸门）', async () => {
    const spy = fetchSpy(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', spy.impl);
    try {
      // ⚠️ createAdminApi 必须在 stubGlobal **之后**调：`deps.fetchImpl ?? fetch` 在构造时求值
      const { api } = makeApi({ fetchImpl: undefined });
      await expect(api({ path: '/x' })).resolves.toEqual({ ok: true });
      expect(spy.calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('不传 log 时默认 noop：请求正常完成、不抛错（装配层不接埋点也不能把请求搞挂）', async () => {
    const spy = fetchSpy(async () => jsonResponse({ ok: true }));
    const { api } = makeApi({ fetchImpl: spy.impl, log: undefined });
    await expect(api({ path: '/x' })).resolves.toEqual({ ok: true });
  });

  it('baseUrl 尾斜杠归一，不会拼出双斜杠', async () => {
    const spy = fetchSpy();
    const { api } = makeApi({ baseUrl: 'http://api.test/', fetchImpl: spy.impl });
    await api({ path: '/x' });
    expect(spy.calls[0]?.url).toBe('http://api.test/x');
  });

  it('baseUrl 不是 http(s) 绝对地址 → 构造时硬失败（相对路径会把请求打到静态站自己身上）', () => {
    expect(() => normalizeBaseUrl('/api')).toThrow(TypeError);
    expect(() => normalizeBaseUrl('api.test')).toThrow(TypeError);
    expect(() => normalizeBaseUrl('ftp://api.test')).toThrow(TypeError);
  });
});

describe('错误收敛（统一 ApiError 形状）', () => {
  it('业务错：body.code 原样透出，message 用服务端的', async () => {
    const spy = fetchSpy(async () =>
      jsonResponse({ code: 40902, message: '订单状态不允许此操作' }, 409),
    );
    const { api } = makeApi({ fetchImpl: spy.impl });
    const err = await api({ path: '/x', method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40902);
    expect((err as ApiError).message).toBe('订单状态不允许此操作');
  });

  it('P2-43/49：错误体的 data 与 retry-after 头原样带出（50300 退避、42901 锁定剩余）', async () => {
    const spy = fetchSpy(async () =>
      jsonResponse({ code: 50300, message: '服务暂不可用', data: { retry_after_ms: 4200 } }, 503, {
        'retry-after': '900',
      }),
    );
    const { api } = makeApi({ fetchImpl: spy.impl });
    const err = (await api({ path: '/x', method: 'POST' }).catch((e: unknown) => e)) as ApiError;
    expect(err.data).toEqual({ retry_after_ms: 4200 });
    expect(err.retryAfterSec).toBe(900);
    expect(retryAfterMsSec(err)).toBe(5);
    // 头缺失 / 非整数秒 → undefined（不能变成"0 分钟后再试"）
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
  });

  it('2xx 但 body 带 code → 仍按业务错（与小程序端同口径：成功 = 2xx 且无 code）', async () => {
    const spy = fetchSpy(async () => jsonResponse({ code: 50000, message: 'x' }, 200));
    const { api } = makeApi({ fetchImpl: spy.impl });
    await expect(api({ path: '/x' })).rejects.toMatchObject({ code: 50000 });
  });

  /**
   * 三审 P2-2：契约有两个 DELETE → 204（`/admin/products/{id}`、`/addresses/{id}`），204 无 body，
   * 旧实现 `res.json()` 失败 → 按"非 JSON"抛 `请求失败（HTTP 204）`：服务端已删、UI 报失败、
   * 管理员重试拿 40400。成功的空响应必须 resolve 为 null。
   */
  it('204 无 body → resolve null（删除类端点的成功形状，不是网络失败）', async () => {
    const spy = fetchSpy(async () => new Response(null, { status: 204 }));
    const { api } = makeApi({ fetchImpl: spy.impl });
    await expect(api({ path: '/admin/products/p1', method: 'DELETE' })).resolves.toBeNull();
  });

  it('PUT 是合法方法（契约有 4 条 PUT 路由；第一轮为它修了 CORS，客户端类型却没跟上）', async () => {
    const spy = fetchSpy(async () => jsonResponse({ ok: true }));
    const { api } = makeApi({ fetchImpl: spy.impl });
    await api({ path: '/admin/products/p1', method: 'PUT', body: { title: 'x' } });
    expect((spy.calls[0]?.init as RequestInit).method).toBe('PUT');
  });

  it('非 JSON 响应（平台 502 HTML 页）→ NETWORK_ERROR_CODE，message 带 HTTP 状态', async () => {
    const spy = fetchSpy(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const { api } = makeApi({ fetchImpl: spy.impl });
    await expect(api({ path: '/x' })).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
      message: '请求失败（HTTP 502）',
    });
  });

  it('fetch 直接 reject（DNS/断网）→ NETWORK_ERROR_CODE + 网络失败', async () => {
    const spy = fetchSpy(async () => Promise.reject(new TypeError('fetch failed')));
    const { api } = makeApi({ fetchImpl: spy.impl });
    await expect(api({ path: '/x' })).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
      message: '网络请求失败',
    });
  });

  it('超时：到时 abort → NETWORK_ERROR_CODE + 请求超时（取消的是等待，不是服务端执行）', async () => {
    vi.useFakeTimers();
    const spy = fetchSpy(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    const { api } = makeApi({ fetchImpl: spy.impl });
    const pending = api({ path: '/x', timeoutMs: 50 });
    const assertion = expect(pending).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
      message: '请求超时（50ms）',
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('响应头的 x-trace-id 优先于本地值（服务端对畸形上游值会重建，以它为准才对得上日志）', async () => {
    const spy = fetchSpy(async () =>
      jsonResponse({ code: 40902, message: 'x' }, 409, { 'x-trace-id': 'trace-from-server' }),
    );
    const { api, log } = makeApi({ fetchImpl: spy.impl });
    const err = await api({ path: '/x' }).catch((e: unknown) => e);
    expect((err as ApiError).traceId).toBe('trace-from-server');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ trace_id: 'trace-from-server' }));
  });
});

describe('40101：管理端没有静默重登，出口是 onUnauthorized 通知', () => {
  it('40101 → onUnauthorized 同步调一次，随后原样抛出（页面要能停 loading）', async () => {
    const spy = fetchSpy(async () =>
      jsonResponse({ code: UNAUTHORIZED_CODE, message: '未登录或登录已过期' }, 401),
    );
    const { api, onUnauthorized } = makeApi({ fetchImpl: spy.impl });
    const err = await api({ path: '/x' }).catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect((onUnauthorized.mock.calls[0]?.[0] as ApiError).code).toBe(UNAUTHORIZED_CODE);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(UNAUTHORIZED_CODE);
  });

  it('非 40101（如 40301 无权限）→ 不触发登出', async () => {
    const spy = fetchSpy(async () => jsonResponse({ code: 40301, message: '无权限' }, 403));
    const { api, onUnauthorized } = makeApi({ fetchImpl: spy.impl });
    await expect(api({ path: '/x' })).rejects.toMatchObject({ code: 40301 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('同源绑定：40101 在 shared 注册表登记且 action 是重新登录（注册表改了这里红）', () => {
    expect(ERROR_CODES[UNAUTHORIZED_CODE].action).toContain('重新登录');
  });
});

describe('埋点事件（流 C 的前端出口；事件名与小程序端对齐）', () => {
  it('api_ok / api_failed / api_network_error 三条都带 trace_id 与 path', async () => {
    const okSpy = fetchSpy(async () => jsonResponse({ ok: true }));
    const { api: okApi, log: okLog } = makeApi({ fetchImpl: okSpy.impl });
    await okApi({ path: '/ok' });
    expect(okLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_ok', trace_id: 'trace-fixed-1', path: '/ok' }),
    );

    const failSpy = fetchSpy(async () => jsonResponse({ code: 40902, message: 'x' }, 409));
    const { api: failApi, log: failLog } = makeApi({ fetchImpl: failSpy.impl });
    await failApi({ path: '/fail' }).catch(() => {});
    expect(failLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_failed', path: '/fail', code: 40902 }),
    );

    const netSpy = fetchSpy(async () => Promise.reject(new TypeError('down')));
    const { api: netApi, log: netLog } = makeApi({ fetchImpl: netSpy.impl });
    await netApi({ path: '/net' }).catch(() => {});
    expect(netLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'api_network_error',
        path: '/net',
        reason: 'network',
      }),
    );
  });
});

describe('跨端口径绑定（两端漂移必有一边红）', () => {
  it('NETWORK_ERROR_CODE 与 miniprogram/utils/request.js 同值（=-1）', () => {
    const mpSource = readFileSync(
      resolve(import.meta.dirname, '../../../miniprogram/utils/request.js'),
      'utf8',
    );
    const match = /NETWORK_ERROR_CODE\s*=\s*(-?\d+)/.exec(mpSource);
    expect(
      match,
      'miniprogram/utils/request.js 里没找到 NETWORK_ERROR_CODE——文件改了结构？',
    ).not.toBeNull();
    expect(Number(match?.[1])).toBe(NETWORK_ERROR_CODE);
  });

  it('DEFAULT_TIMEOUT_MS 与小程序端同口径（10s）', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('resolveApiBase（环境变量 → 可用值；§2 第 37 条的预处理点）', () => {
  it('未设置 / 空串 / 纯空白 → 本地默认（与 .env.example PUBLIC_API_BASE 一致）', () => {
    expect(resolveApiBase({})).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase({ VITE_API_BASE_URL: '' })).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase({ VITE_API_BASE_URL: '   ' })).toBe(DEFAULT_API_BASE);
    expect(DEFAULT_API_BASE).toBe('http://localhost:3000');
  });

  it('显式给值：尾斜杠归一', () => {
    expect(resolveApiBase({ VITE_API_BASE_URL: 'https://api.example.com/' })).toBe(
      'https://api.example.com',
    );
  });

  it('显式给值但形状非法 → 硬失败（错值不能回落默认值，那会静默打错环境）', () => {
    expect(() => resolveApiBase({ VITE_API_BASE_URL: '/api' })).toThrow(TypeError);
  });
});

describe('token-store（localStorage 真值 + 隐私模式内存降级）', () => {
  function mapStorage() {
    const m = new Map<string, string>();
    return {
      store: m,
      impl: {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      },
    };
  }

  it('set/get/clear 闭环；键带项目前缀', () => {
    const { store, impl } = mapStorage();
    const ts = createTokenStore(impl);
    expect(ts.get()).toBe('');
    ts.set('jwt-1');
    expect(ts.get()).toBe('jwt-1');
    expect(store.has(TOKEN_STORAGE_KEY)).toBe(true);
    expect(TOKEN_STORAGE_KEY).toContain('waselect');
    ts.clear();
    expect(ts.get()).toBe('');
  });

  it('读写抛错（隐私模式/存储被禁）→ 内存降级，功能不崩', () => {
    const broken = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    const ts = createTokenStore(broken);
    ts.set('jwt-x'); // 不崩
    expect(ts.get()).toBe('jwt-x');
    ts.clear();
    expect(ts.get()).toBe('');
  });
});
