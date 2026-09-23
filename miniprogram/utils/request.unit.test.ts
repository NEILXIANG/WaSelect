/**
 * 职责：小程序请求封装的单测（F6c 壳）。
 *
 * @why `wx.request` 是**宿主能力**，属于"第三方"——按约束三，只有第三方才 mock，
 *      所以这里注入假的 `wx.request`（形状与官方一致：success/fail 回调 + statusCode/data），
 *      而不是去抽象一层自己的 HTTP 接口。验的是我们自己的收敛逻辑，不是微信的。
 *
 * @limitation 只测封装层。真机上的 wx.request 行为（超时、域名白名单、证书）不在覆盖范围内，
 *              需要真机验证的部分见 docs/地基搭建清单.md F14。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createRequester, NETWORK_ERROR_CODE } from './request.js';
import { newTraceId } from './trace.js';

/** 造一个假的 wx.request：记录调用参数，并按 scripted 结果回调。 */
function fakeWx(result: { statusCode?: number; data?: unknown; errMsg?: string }) {
  const calls: unknown[] = [];
  const request = (opts: Record<string, unknown>): void => {
    calls.push(opts);
    const success = opts.success as (r: unknown) => void;
    const fail = opts.fail as (e: unknown) => void;
    if (result.errMsg !== undefined) fail({ errMsg: result.errMsg });
    else success({ statusCode: result.statusCode ?? 200, data: result.data });
  };
  return { calls, request };
}

describe('trace_id 贯穿', () => {
  it('每个请求自动带上 x-trace-id，且形状符合服务端要求', async () => {
    const wx = fakeWx({ statusCode: 201, data: { order_id: 'sk-1' } });
    const api = createRequester({ request: wx.request as never, log: () => undefined });
    await api({ url: 'https://api.test/orders', method: 'POST', idempotencyKey: 'k1' });

    const header = (wx.calls[0] as { header: Record<string, string> }).header;
    expect(header['x-trace-id']).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(header['idempotency-key']).toBe('k1');
    expect(header['content-type']).toBe('application/json');
  });

  it('同一次用户操作复用同一个 traceId（否则多跳请求在日志里串不起来）', async () => {
    const wx = fakeWx({ statusCode: 200, data: { ok: true } });
    const traceId = newTraceId();
    const api = createRequester({ request: wx.request as never, log: () => undefined });
    await api({ url: 'https://api.test/a', traceId });
    await api({ url: 'https://api.test/b', traceId });

    const ids = wx.calls.map((c) => (c as { header: Record<string, string> }).header['x-trace-id']);
    expect(new Set(ids)).toEqual(new Set([traceId]));
  });
});

describe('收敛错误', () => {
  it('2xx 且无 code → 成功，直接返回响应体', async () => {
    const wx = fakeWx({ statusCode: 200, data: { order_no: '260923-K7Q2MN' } });
    const api = createRequester({ request: wx.request as never, log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).resolves.toEqual({ order_no: '260923-K7Q2MN' });
  });

  it('HTTP 200 但响应体带 code → 按业务错误抛（这才是服务端真正的错误通道）', async () => {
    const wx = fakeWx({ statusCode: 200, data: { code: 40101, message: '未登录或登录已过期' } });
    const api = createRequester({ request: wx.request as never, log: () => undefined });
    await expect(api({ url: 'https://api.test/x' })).rejects.toMatchObject({ code: 40101 });
  });

  it('HTTP 500 无业务码 → 用网络错误码，不与 5 位业务码混淆', async () => {
    const wx = fakeWx({ statusCode: 500, data: '<html>oops</html>' });
    const api = createRequester({ request: wx.request as never, log: () => undefined });
    const err = await api({ url: 'https://api.test/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(NETWORK_ERROR_CODE);
    expect(NETWORK_ERROR_CODE).toBeLessThan(0);
  });

  it('wx.request fail（断网）→ NETWORK_ERROR_CODE，且带原始 errMsg', async () => {
    const wx = fakeWx({ errMsg: 'request:fail url not in domain list' });
    const api = createRequester({ request: wx.request as never, log: () => undefined });
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
      request: wx.request as never,
      getToken: () => '',
      log: () => undefined,
    });
    await api({ url: 'https://api.test/x' });
    expect((wx.calls[0] as { header: Record<string, string> }).header.authorization).toBeUndefined();

    const withToken = createRequester({
      request: wx.request as never,
      getToken: () => 'tk-1',
      log: () => undefined,
    });
    await withToken({ url: 'https://api.test/x' });
    expect((wx.calls[1] as { header: Record<string, string> }).header.authorization).toBe(
      'Bearer tk-1',
    );
  });

  it('成功与失败都会打一条埋点，且带同一个 trace_id（流 C 的基本盘）', async () => {
    const log = vi.fn();
    const ok = fakeWx({ statusCode: 200, data: { ok: 1 } });
    const bad = fakeWx({ statusCode: 200, data: { code: 40902, message: '状态不允许' } });
    const traceId = newTraceId();

    await createRequester({ request: ok.request as never, log })({ url: 'https://api.test/a', traceId });
    await createRequester({ request: bad.request as never, log })({
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
