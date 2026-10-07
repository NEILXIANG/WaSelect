/**
 * 职责：`utils/auth-session.js` 的单测——登录链的每一种故障形态各有用例。
 *
 * @why 这些断言钉的都是"离根因隔两层"的故障：
 *      ① code 空串 → 若发去服务端是 40101，排查方向会被引到"服务端拒绝登录"；
 *      ② 响应缺 token → 若照样写回，表现为"每次都 40101、每次重登都失败"；
 *      ③ wx.login 失败 → 必须能听出来，而不是"点了登录没反应"。
 *
 * @how `wx` 用 `createWxApi({ login })` 部分覆盖（其余能力不存在也没关系——
 *      本模块只调 `login` 这一个方法）；`api` 直接给假函数。
 *
 * @see ./auth-session.js
 */
import { describe, expect, it } from 'vitest';
import { loginWithWechat, singleFlight, wxLoginCode } from './auth-session.js';
import { createWxApi, type WxLoginOption } from './wx-api.js';

const BASE = 'https://api.example.com';

/** 假 wx：login 直接按给定方式回调。 */
function wxWith(loginImpl: (o: WxLoginOption) => void) {
  return createWxApi({ login: loginImpl });
}

describe('wxLoginCode', () => {
  it('正常 → 返回 code', async () => {
    const code = await wxLoginCode(wxWith((o) => o.success?.({ code: 'dev-code-1' })));
    expect(code).toBe('dev-code-1');
  });

  it('⚠️ code 空串 → 拒绝（空 code 发给服务端是 40101，会把排查方向引到服务端）', async () => {
    await expect(wxLoginCode(wxWith((o) => o.success?.({ code: '' })))).rejects.toThrow(
      /未返回 code/,
    );
    await expect(wxLoginCode(wxWith((o) => o.success?.({} as { code: string })))).rejects.toThrow(
      /未返回 code/,
    );
  });

  it('fail → 拒绝，错误信息带上 errMsg', async () => {
    await expect(wxLoginCode(wxWith((o) => o.fail?.({ errMsg: 'login:fail' })))).rejects.toThrow(
      /login:fail/,
    );
    await expect(wxLoginCode(wxWith((o) => o.fail?.({})))).rejects.toThrow(/wx.login 失败/);
  });
});

describe('loginWithWechat', () => {
  it('正常：code 进请求体、POST 到 /auth/wechat/login、返回 token', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const token = await loginWithWechat({
      wx: wxWith((o) => o.success?.({ code: 'dev-code-2' })),
      api: (opts: Record<string, unknown>) => {
        seen.push(opts);
        return Promise.resolve({ token: 'jwt-abc', user: { id: 'u-1', isAdmin: false } });
      },
      apiBase: BASE,
      traceId: 'trace-1',
    });
    expect(token).toBe('jwt-abc');
    expect(seen[0]).toMatchObject({
      url: `${BASE}/api/v1/auth/wechat/login`,
      method: 'POST',
      data: { code: 'dev-code-2' },
      traceId: 'trace-1',
    });
  });

  it('⚠️ 响应缺 token / token 空串 → 抛（不能让"登了个匿名态"活着走下去）', async () => {
    const wx = wxWith((o) => o.success?.({ code: 'c' }));
    for (const body of [{}, { token: '' }, null]) {
      await expect(
        loginWithWechat({ wx, api: () => Promise.resolve(body), apiBase: BASE }),
      ).rejects.toThrow(/缺少 token/);
    }
  });

  it('api 抛错（含 429 限流）→ 原样抛出，不重试', async () => {
    const err = Object.assign(new Error('请求太频繁'), { code: 42901 });
    await expect(
      loginWithWechat({
        wx: wxWith((o) => o.success?.({ code: 'c' })),
        api: () => Promise.reject(err),
        apiBase: BASE,
      }),
    ).rejects.toBe(err);
  });

  it('wx.login 失败时不发请求（少一次必然失败的网络往返）', async () => {
    let called = 0;
    await expect(
      loginWithWechat({
        wx: wxWith((o) => o.fail?.({ errMsg: 'denied' })),
        api: () => {
          called += 1;
          return Promise.resolve({ token: 't' });
        },
        apiBase: BASE,
      }),
    ).rejects.toThrow(/denied/);
    expect(called).toBe(0);
  });
});

describe('singleFlight：启动自动登录与请求层重登共用一个在途登录（P2-34）', () => {
  /** 一个计数的登录一跳：wx.login + /auth/wechat/login，后者挂起直到 release()。 */
  function countingLogin() {
    let posts = 0;
    let release: (token: string) => void = () => undefined;
    const login = singleFlight(() =>
      loginWithWechat({
        wx: wxWith((o) => o.success?.({ code: 'c' })),
        api: () => {
          posts += 1;
          return new Promise((r) => {
            release = (t) => r({ token: t });
          });
        },
        apiBase: BASE,
      }),
    );
    return { login, posts: () => posts, release: (t: string) => release(t) };
  }

  it('🔴 两个并发调用方（启动登录 + 40101 重登）→ 只发一次登录请求，拿到同一个 token', async () => {
    const h = countingLogin();
    const a = h.login();
    const b = h.login();
    await Promise.resolve();
    await Promise.resolve();
    h.release('jwt-1');
    expect(await a).toBe('jwt-1');
    expect(await b).toBe('jwt-1');
    expect(h.posts()).toBe(1);
  });

  it('结束后（成功或失败）再调 → 发起新的一次（不永远复用旧结果）', async () => {
    let n = 0;
    const flaky = singleFlight(async () => {
      n += 1;
      if (n === 1) throw new Error('first fails');
      return `t-${String(n)}`;
    });
    await expect(flaky()).rejects.toThrow('first fails');
    expect(await flaky()).toBe('t-2');
    expect(await flaky()).toBe('t-3');
  });
});
