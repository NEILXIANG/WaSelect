/**
 * 职责：微信 code2session 适配器 + dev 替身的单测（I1-U6b）。
 *
 * @why 重点钉"微信的错误是 200 + errcode"这个异形：只查 HTTP status 的实现
 *      会把 code 无效当成功——这是本适配器最容易被"简化"掉的防线。
 *      secret 进 query 是微信唯一支持的形态，脱敏由 fetch-client 的 safeUrl 负责
 *      （这里断言"我们的确把 secret 放进了 query"——两边拼起来才是完整证据链）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchClient } from '../http/fetch-client.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../ports/http-client.js';
import { createWechatAuth } from './code2session.js';
import { createDevWechatAuth } from './dev-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 收集式假 HttpClient（响应按队列出；默认 200 空对象——各用例显式喂）。 */
function fakeHttp(queue: HttpResponse[]): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    http: {
      send: (req) => {
        calls.push(req);
        const next = queue.shift();
        if (next === undefined) throw new Error('测试没喂够响应');
        return Promise.resolve(next);
      },
    },
  };
}

const OPTS = { appId: 'wx-test-appid', appSecret: 'wx-test-secret' };

describe('真实 code2session', () => {
  it('成功：GET 带 appid/secret/js_code/grant_type，返回 openid；session_key 不出返回值', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: '{"openid":"o-real-1","session_key":"SK-SECRET"}' },
    ]);
    const auth = createWechatAuth({ http, ...OPTS });
    const s = await auth.code2session('code-abc');

    expect(s).toEqual({ openid: 'o-real-1' });
    expect('session_key' in s).toBe(false); // 端口 @why：它等同用户半密码，不出适配器
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/sns/jscode2session');
    expect(url.searchParams.get('appid')).toBe(OPTS.appId);
    expect(url.searchParams.get('secret')).toBe(OPTS.appSecret);
    expect(url.searchParams.get('js_code')).toBe('code-abc');
    expect(url.searchParams.get('grant_type')).toBe('authorization_code');
    expect(calls[0]?.method).toBe('GET');
  });

  it('200 + errcode 40029（invalid code）→ 40101，不是成功也不是 500', async () => {
    const { http } = fakeHttp([{ status: 200, body: '{"errcode":40029,"errmsg":"invalid code"}' }]);
    const auth = createWechatAuth({ http, ...OPTS });
    await expect(auth.code2session('bad')).rejects.toMatchObject({ code: 40101 });
  });

  it('200 + errcode 40163（code been used，重放）→ 40101（用户侧问题同档归一）', async () => {
    const { http } = fakeHttp([
      { status: 200, body: '{"errcode":40163,"errmsg":"code been used"}' },
    ]);
    const auth = createWechatAuth({ http, ...OPTS });
    await expect(auth.code2session('replayed')).rejects.toMatchObject({ code: 40101 });
  });

  it('200 + 其它 errcode（45011 频率限制 / -1 系统忙）→ 抛普通 Error（我们的/上游的问题折叠 50000，不伪装成用户失败）', async () => {
    for (const errcode of [45_011, -1]) {
      const { http } = fakeHttp([{ status: 200, body: `{"errcode":${errcode}}` }]);
      const auth = createWechatAuth({ http, ...OPTS });
      await expect(auth.code2session('x')).rejects.toThrow(/errcode/);
      await expect(auth.code2session('x')).rejects.not.toMatchObject({ code: 40101 });
    }
  });

  it('HTTP 非 200（微信侧故障）→ 抛普通 Error（折叠 50000）', async () => {
    const { http } = fakeHttp([{ status: 502, body: 'bad gateway' }]);
    const auth = createWechatAuth({ http, ...OPTS });
    await expect(auth.code2session('x')).rejects.toThrow(/HTTP 502/);
  });

  it('200 无 errcode 也无 openid → 抛（回包形状漂移必须响亮失败）', async () => {
    const { http } = fakeHttp([{ status: 200, body: '{"session_key":"x"}' }]);
    const auth = createWechatAuth({ http, ...OPTS });
    await expect(auth.code2session('x')).rejects.toThrow(/缺 openid/);
  });

  it('🔴 声明"只发一次"：请求里带 maxAttempts: 1（PAY3-07，防止有人把 GET 当成天然可重试而删掉）', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: '{"openid":"o-real-1","session_key":"SK"}' },
    ]);
    const auth = createWechatAuth({ http, ...OPTS });
    await auth.code2session('code-abc');

    expect(calls[0]?.maxAttempts).toBe(1);
  });

  /**
   * 🔴 端到端（适配器 + 真实 fetch-client）：网络层断开后**不再发第二次**。
   *
   * @why 只断言"请求里带了 maxAttempts"是不够的：它验的是我们**写了**这个字段，
   *      而真正的风险是"写了但实现不认"（端口与实现各说一份口径）。
   *      所以这条用真实 `createFetchClient` 驱动：第一次抛 `TypeError('fetch failed')`
   *      （undici 对 ECONNRESET 的抛法），第二次喂 40163——
   *      修复前会走到第二次、把一次网络抖动变成 40101（用户侧登录失败）。
   */
  it('🔴 网络错误后不重试：只打一次上游，且失败是网络错误而不是 40101（PAY3-07）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (calls.length === 1) throw new TypeError('fetch failed'); // 响应在路上断了
      return {
        status: 200,
        body: '{"errcode":40163,"errmsg":"code been used"}',
        headers: new Map(),
      };
    });
    const http = createFetchClient({ breaker: null, sleep: () => Promise.resolve() });
    const auth = createWechatAuth({ http, ...OPTS });

    await expect(auth.code2session('code-abc')).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveLength(1); // 第二次拿回的会是 40163 → 被当成用户侧失败
  });
});

describe('dev 替身', () => {
  it('openid = 前缀 + code（不校验 code——这正是它只能活在 development/test 的原因）', async () => {
    const auth = createDevWechatAuth('dev-');
    await expect(auth.code2session('anything')).resolves.toEqual({ openid: 'dev-anything' });
    await expect(auth.code2session('')).resolves.toEqual({ openid: 'dev-' });
  });
});
