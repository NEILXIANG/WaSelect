/**
 * 职责：`endpoints.ts`（管理端登录接口）的单测。
 *
 * @why 第三轮审查 TST3-03：这个文件原来 0% 覆盖、没有任何测试 import 它。
 *      它唯一的防线是"200 但形状变了 → 按 NETWORK_ERROR_CODE 硬失败并带真实 traceId"——
 *      没人测，这条防线被改坏（例如退回常量 traceId，或把空 token 当成功）时 gate 照绿。
 */
import { describe, expect, it } from 'vitest';
import { login, type AdminApi } from './endpoints.js';
import { ApiError, NETWORK_ERROR_CODE } from './errors.js';

function stubApi(resp: unknown) {
  const calls: Record<string, unknown>[] = [];
  const api = (async (req: Record<string, unknown>) => {
    calls.push(req);
    return resp;
  }) as unknown as AdminApi;
  return { api, calls };
}

describe('login', () => {
  it('按契约路径与请求体发出，返回 token', async () => {
    const { api, calls } = stubApi({ token: 'jwt.abc' });
    await expect(
      login(api, { email: 'ops@example.com', password: 'correct-horse-9' }),
    ).resolves.toBe('jwt.abc');
    expect(calls[0]).toMatchObject({
      path: '/api/v1/auth/admin/login',
      method: 'POST',
      body: { email: 'ops@example.com', password: 'correct-horse-9' },
    });
    expect(typeof calls[0]?.['traceId']).toBe('string');
  });

  it.each([
    ['没有 token', {}],
    ['token 为空串', { token: '' }],
    ['token 不是字符串', { token: 123 }],
    ['响应不是对象', null],
  ])('形状与契约不符（%s）→ NETWORK_ERROR_CODE，且报障码就是请求用的 traceId', async (_n, resp) => {
    const { api, calls } = stubApi(resp);
    const err = await login(api, { email: 'a@b.co', password: 'x'.repeat(12) }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(NETWORK_ERROR_CODE);
    expect((err as ApiError).traceId).toBe(calls[0]?.['traceId']);
  });
});
