/**
 * 职责：小程序请求封装的单测（F6c 壳）。
 *
 * @why `wx.request` 是**宿主能力**，属于"第三方"——按约束三，只有第三方才 mock，
 *      所以这里注入假的宿主入口（形状与官方一致：success/fail 回调 + statusCode/data），
 *      而不是去抽象一层自己的 HTTP 接口。验的是我们自己的收敛逻辑，不是微信的。
 *      注入走 `utils/wx-api.js` 的 `createWxApi({ request })`——宿主能力只有一个入口（F14）。
 *
 * @limitation 只测封装层。真机上的 wx.request 行为（超时、域名白名单、证书）不在覆盖范围内，
 *              需要真机验证的部分见 docs/地基搭建清单.md F14。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createRequester, NETWORK_ERROR_CODE, RELOGIN_CODE } from './request.js';
import { createWxApi, type WxRequestOption } from './wx-api.js';
import { errorSpec } from '@waselect/shared';
import { newTraceId } from './trace.js';

/**
 * 造一个假的宿主能力入口。
 *
 * @why 注入的是**整层 `WxApi`** 而不是单个 `request` 函数（F14 第一单元之后的新写法）：
 *      宿主能力只有一个入口，测试替换就替换这一层，
 *      于是"业务代码偷偷用了没被替换的 wx 能力"这件事会立刻变成"宿主不存在"的响亮失败，
 *      而不是静默拿到 undefined。
 *
 * @param script 每次调用返回什么（按顺序取；用完了重复最后一项）。
 *               传函数可以按"第几次调用"编排——40101 → 200 这类序列靠它。
 */
function fakeWx(
  script:
    | { statusCode?: number; data?: unknown; errMsg?: string }
    | ((n: number) => { statusCode?: number; data?: unknown; errMsg?: string }),
) {
  const calls: WxRequestOption[] = [];
  const request = (opts: WxRequestOption): void => {
    calls.push(opts);
    const nth = calls.length;
    const r = typeof script === 'function' ? script(nth) : script;
    if (r.errMsg !== undefined) opts.fail?.({ errMsg: r.errMsg });
    else opts.success?.({ statusCode: r.statusCode ?? 200, data: r.data });
  };
  return { calls, wx: createWxApi({ request }) };
}

describe('trace_id 贯穿', () => {
  it('每个请求自动带上 x-trace-id，且形状符合服务端要求', async () => {
    const wx = fakeWx({ statusCode: 201, data: { order_id: 'sk-1' } });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    await api({ url: 'https://api.test/orders', method: 'POST', idempotencyKey: 'k1' });

    const header = wx.calls[0]?.header ?? {};
    expect(header['x-trace-id']).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(header['idempotency-key']).toBe('k1');
    expect(header['content-type']).toBe('application/json');
  });

  it('同一次用户操作复用同一个 traceId（否则多跳请求在日志里串不起来）', async () => {
    const wx = fakeWx({ statusCode: 200, data: { ok: true } });
    const traceId = newTraceId();
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    await api({ url: 'https://api.test/a', traceId });
    await api({ url: 'https://api.test/b', traceId });

    const ids = wx.calls.map((c) => c.header?.['x-trace-id']);
    expect(new Set(ids)).toEqual(new Set([traceId]));
  });
});

describe('收敛错误', () => {
  it('2xx 且无 code → 成功，直接返回响应体', async () => {
    const wx = fakeWx({ statusCode: 200, data: { order_no: '260923-K7Q2MN' } });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).resolves.toEqual({
      order_no: '260923-K7Q2MN',
    });
  });

  it('HTTP 200 但响应体带 code → 按业务错误抛（这才是服务端真正的错误通道）', async () => {
    const wx = fakeWx({ statusCode: 200, data: { code: 40101, message: '未登录或登录已过期' } });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
  });

  it('HTTP 500 无业务码 → 用网络错误码，不与 5 位业务码混淆', async () => {
    const wx = fakeWx({ statusCode: 500, data: '<html>oops</html>' });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    const err = await api({ url: 'https://api.test/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(NETWORK_ERROR_CODE);
    expect(NETWORK_ERROR_CODE).toBeLessThan(0);
  });

  it('wx.request fail（断网）→ NETWORK_ERROR_CODE，且带原始 errMsg', async () => {
    const wx = fakeWx({ errMsg: 'request:fail url not in domain list' });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({
      code: NETWORK_ERROR_CODE,
      message: 'request:fail url not in domain list',
    });
  });
});

describe('token 与埋点', () => {
  it('有 token 才带 Authorization（没登录时不发空头，避免服务端多一次无效校验）', async () => {
    const wx = fakeWx({ statusCode: 200, data: {} });
    const api = createRequester({
      wx: wx.wx,
      getToken: () => '',
      log: () => undefined,
    });
    await api({ url: 'https://api.test/x' });
    expect(wx.calls[0]?.header?.authorization).toBeUndefined();

    const withToken = createRequester({
      wx: wx.wx,
      getToken: () => 'tk-1',
      log: () => undefined,
    });
    await withToken({ url: 'https://api.test/x' });
    expect(wx.calls[1]?.header?.authorization).toBe('Bearer tk-1');
  });

  it('成功与失败都会打一条埋点，且带同一个 trace_id（流 C 的基本盘）', async () => {
    const log = vi.fn();
    const ok = fakeWx({ statusCode: 200, data: { ok: 1 } });
    const bad = fakeWx({ statusCode: 200, data: { code: 40902, message: '状态不允许' } });
    const traceId = newTraceId();

    await createRequester({ wx: ok.wx, log })({
      url: 'https://api.test/a',
      traceId,
    });
    await createRequester({ wx: bad.wx, log })({
      url: 'https://api.test/b',
      traceId,
    }).catch(() => undefined);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ event: 'api_ok', trace_id: traceId });
    expect(log.mock.calls[1]?.[0]).toMatchObject({
      event: 'api_failed',
      trace_id: traceId,
      code: 40902,
    });
  });
});

const UNAUTHORIZED = { code: 40101, message: '未登录或登录已过期' };

describe('静默重登并重放（40101）', () => {
  it('🔒 硬编码的 40101 与 shared 错误码表**同源**（改了一边另一边要红）', () => {
    // @why 小程序不 import shared（nodeModules=false，引入要走构建 npm），
    //      所以这个码在 request.js 里是硬编码的。两处真值必须有东西把它们绑起来，
    //      否则哪天服务端把 40101 的语义改了，客户端还在傻傻地重登。
    //      绑的方式不是断言数字相等（那等于把 40101 抄第二遍），
    //      而是断言**这个码的 action 确实是"静默重新登录并重放请求"**。
    const spec = errorSpec(RELOGIN_CODE);
    expect(spec, `shared 里没有 ${RELOGIN_CODE} 这个码`).toBeDefined();
    expect(spec?.action).toBe('静默重新登录并重放请求');
  });

  it('40101 → 重登 → 重放**一次** → 成功（用户完全无感）', async () => {
    /**
     * ⚠️ token 用**有状态**的 stub（`let token` + setToken 真的写回去），
     *    不是 `getToken: () => 'old'` 这种常量——常量 stub 会让"重放到底带没带新 token"
     *    这条断言永远测不出来（重放带了旧 token 也照样"成功"，因为假上游不看 token）。
     *    这是"假数据要像真的"的具体含义：替身必须能**区分**正确与错误的实现。
     */
    let token = 'old';
    const h = fakeWx((n) =>
      n === 1 ? { statusCode: 200, data: UNAUTHORIZED } : { statusCode: 200, data: { ok: 1 } },
    );
    const api = createRequester({
      wx: h.wx,
      getToken: () => token,
      setToken: (t: string) => {
        token = t;
      },
      relogin: async () => 'new',
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).resolves.toEqual({ ok: 1 });
    expect(h.calls).toHaveLength(2);
    // 重放必须带上**新** token——否则重放一定还是 40101，等于白做一遍
    expect(h.calls[0]?.header?.authorization).toBe('Bearer old');
    expect(h.calls[1]?.header?.authorization).toBe('Bearer new');
  });

  it('重放**复用同一个 trace_id**（重登与重放属于同一次用户操作）', async () => {
    const h = fakeWx((n) =>
      n === 1 ? { statusCode: 200, data: UNAUTHORIZED } : { statusCode: 200, data: { ok: 1 } },
    );
    const traceId = newTraceId();
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => 'new',
      log: () => undefined,
    });
    await api({ url: 'https://api.test/x', traceId });
    const ids = h.calls.map((c) => c.header?.['x-trace-id']);
    expect(new Set(ids)).toEqual(new Set([traceId]));
  });

  it('重登成功后才写回 token（失败时不写——否则等于把用户登出）', async () => {
    const h = fakeWx({ statusCode: 200, data: UNAUTHORIZED });
    const written: string[] = [];
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      setToken: (t: string) => written.push(t),
      relogin: async () => {
        throw new Error('login failed');
      },
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
    expect(written).toEqual([]);
  });

  it('重登失败 → 交出**原始的 40101**，不是重登失败的原因', async () => {
    // @why 调用方按错误码表里的 action 处理（"重新登录"）。
    //      若这里抛出"login failed"，调用方会把它当成一个新类型的错误去处理或上报，
    //      而真正该做的事（重新登录）反而没触发。重登为什么失败已记在日志里。
    const h = fakeWx({ statusCode: 200, data: UNAUTHORIZED });
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => {
        throw new Error('login failed');
      },
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({
      code: 40101,
      message: '未登录或登录已过期',
    });
  });

  it('**只重放一次**：重放后还是 40101 → 抛出，不再递归（否则登录接口异常时是无限循环）', async () => {
    const h = fakeWx({ statusCode: 200, data: UNAUTHORIZED });
    let reloginCount = 0;
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => {
        reloginCount += 1;
        return 'new';
      },
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
    expect(reloginCount).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  it('⚠️ 并发的多个 40101 **只重登一次**（single-flight）', async () => {
    /**
     * @why 这条钉的是 `relogining` 那个共享句柄：进屏时常常并发发 3~5 个请求，
     *      它们会**同时**收到 40101。各登一次的后果不只是多打几次登录接口——
     *      更糟的是 5 个 token 先后写回，**最后写的不一定是最后返回的**，
     *      token 会倒退，表现为"刚登录完又 401"，且极难复现。
     */
    const h = fakeWx((n) =>
      n <= 3 ? { statusCode: 200, data: UNAUTHORIZED } : { statusCode: 200, data: { ok: n } },
    );
    let reloginCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => {
        reloginCount += 1;
        await gate; // 卡住，制造"重登在进行中"的窗口
        return 'new';
      },
      log: () => undefined,
    });
    const pending = [
      api({ url: 'https://api.test/a' }),
      api({ url: 'https://api.test/b' }),
      api({ url: 'https://api.test/c' }),
    ];
    await Promise.resolve(); // 让三个请求都走到 40101 并触发重登
    release?.();
    await Promise.all(pending);

    // 三个并发请求 → 重登只发生一次
    expect(reloginCount).toBe(1);
    // 3 次首次尝试 + 3 次重放 = 6 次网络调用
    expect(h.calls).toHaveLength(6);
  });

  it('一次重登失败后，**下一次请求还能再重登**（失败必须清掉在途标记）', async () => {
    // @why 只在成功时清 `relogining` 的话，一次失败会让后续所有请求
    //    永远复用那个已 rejected 的 Promise——表现为"重登失败一次之后再也登不上"，
    //    而错误信息还是最开始那一次（排查方向被彻底带偏）。
    const h = fakeWx((n) =>
      n <= 2 ? { statusCode: 200, data: UNAUTHORIZED } : { statusCode: 200, data: { ok: n } },
    );
    let attemptNo = 0;
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => {
        attemptNo += 1;
        if (attemptNo === 1) throw new Error('login failed');
        return 'new';
      },
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
    // 第 1 次：call1(40101) → 重登失败 → 抛。
    // 第 2 次：call2(40101) → 重登成功 → 重放 call3 → 成功。所以是 ok: 3。
    await expect(api({ url: 'https://api.test/x' })).resolves.toEqual({ ok: 3 });
    expect(attemptNo).toBe(2);
  });

  it('没配 `relogin` → 40101 **原样抛出**，不重放（没有重登手段时重放注定还是 40101）', async () => {
    const h = fakeWx({ statusCode: 200, data: UNAUTHORIZED });
    const api = createRequester({ wx: h.wx, getToken: () => 'old', log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
    expect(h.calls).toHaveLength(1);
  });

  it('非 40101 的错误**一律不重放**（5xx 重试是产品决策，不该在这里替页面决定）', async () => {
    const h = fakeWx({ statusCode: 503, data: { code: 50000, message: '服务器内部错误' } });
    let reloginCount = 0;
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => {
        reloginCount += 1;
        return 'new';
      },
      log: () => undefined,
    });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 50000 });
    expect(reloginCount).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('重登与重放都留埋点（否则"为什么点了没反应"查不到）', async () => {
    const log = vi.fn();
    const h = fakeWx((n) =>
      n === 1 ? { statusCode: 200, data: UNAUTHORIZED } : { statusCode: 200, data: { ok: 1 } },
    );
    const api = createRequester({
      wx: h.wx,
      getToken: () => 'old',
      relogin: async () => 'new',
      log,
    });
    await api({ url: 'https://api.test/x' });
    const events = log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('api_relogin');
    expect(events.filter((e) => e === 'api_relogin')).toHaveLength(2); // started + ok
  });
});

/** 剩余清单 4-6 / 4-7：ApiError 带上链路号与响应 data（报障小字、购物车定位失效商品）。 */
describe('ApiError 携带 traceId 与 data（4-6 / 4-7）', () => {
  it('🔴 业务错误：err.traceId = 本次链路号，err.data = 响应体 data', async () => {
    const wx = fakeWx({
      statusCode: 404,
      data: { code: 40401, message: '商品不存在或已下架', data: { product_id: 'p-x' } },
    });
    const api = createRequester({ wx: wx.wx, log: () => undefined });
    const err = await api({
      url: 'https://api.test/orders/quote',
      traceId: 'trace-12345678',
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 40401,
      traceId: 'trace-12345678',
      data: { product_id: 'p-x' },
    });
  });
});
