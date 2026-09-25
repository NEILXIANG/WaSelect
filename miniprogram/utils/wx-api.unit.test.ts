/**
 * 职责：宿主能力封装（`wx-api`）的单测（F14 第一单元）。
 *
 * @why 这一层只有几十行，但钉的是三件**错了不报错**的事：
 *      ① **宿主缺失要响亮失败**——静默返回 undefined 会让崩溃推迟到业务行的
 *         `undefined.request(...)`，报错指向业务代码而不是根因；
 *      ② **取到的不是字符串就当"没存过"**——`getStorageSync` 官方返回 unknown，
 *         若原样透传，调用方就要各写各的断言，漏写的那处会在某个版本突然拿到对象；
 *      ③ **覆盖是"部分覆盖"而不是"整体替换"**——整体替换的后果是
 *         "没被替换到的能力静默变成 undefined"，表现为换个用例就崩。
 *
 * @how 宿主用 `vi.stubGlobal('wx', …)` 装假——**装的是 `globalThis.wx` 这个宿主全局**，
 *      不是注入到函数里。这样才能验到"从宿主取"这条真实路径（`createWxApi()` 不传参）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWxApi, type RealtimeLogger } from './wx-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个假宿主，并记录被读到的调用。 */
function stubHost(
  over: {
    storage?: Record<string, unknown>;
    logger?: RealtimeLogger | undefined;
  } = {},
) {
  const seen: string[] = [];
  const storage: Record<string, unknown> = { ...(over.storage ?? {}) };
  const requested: unknown[] = [];
  vi.stubGlobal('wx', {
    request: (o: unknown) => {
      seen.push('request');
      requested.push(o);
    },
    getStorageSync: (k: string) => {
      seen.push(`get:${k}`);
      return storage[k];
    },
    setStorageSync: (k: string, v: unknown) => {
      seen.push(`set:${k}`);
      storage[k] = v;
    },
    ...(over.logger === undefined ? {} : { getRealtimeLogManager: () => over.logger }),
  });
  return { seen, storage, requested };
}

describe('宿主缺失时必须响亮失败（不是静默 undefined）', () => {
  it('不注入、也没有 `globalThis.wx` → 调用时抛，且错误信息指向"宿主不存在"', () => {
    const api = createWxApi();
    expect(() => api.request({ url: 'https://x.test' })).toThrow(/wx 宿主不存在/);
    expect(() => api.getStorageSync('token')).toThrow(/wx 宿主不存在/);
    expect(() => api.setStorageSync('token', 't')).toThrow(/wx 宿主不存在/);
    expect(() => api.getRealtimeLogManager()).toThrow(/wx 宿主不存在/);
  });

  it('**import 时不取宿主**——只有调用才取（否则 Node 侧连 import 都做不到）', () => {
    // @why 这条钉的是 `@limitation 四`：宿主在每次调用时取，不在 import 时取。
    //      若改成模块顶层 `const wx = globalThis.wx`，本文件在 Node 里 import 就会崩，
    //      这条会红——于是"能不能被 Node 单测 import"这件事就有了守卫。
    expect(() => createWxApi()).not.toThrow();
  });
});

describe('走真实宿主时的行为', () => {
  it('getStorageSync 取到字符串 → 原样返回', () => {
    stubHost({ storage: { token: 'tk-1' } });
    expect(createWxApi().getStorageSync('token')).toBe('tk-1');
  });

  it('⚠️ 取到的**不是字符串** → 空串（不是原样透传 unknown）', () => {
    // @why 官方 `getStorageSync` 返回 unknown。若这里原样透传，
    //      "读出来到底是什么"就要每个调用方各自断言一次，漏写的那处会在某天突然拿到对象。
    //      把契约收紧成 string，类型上就只有一种答案。
    stubHost({ storage: { oops: { a: 1 }, n: 42 } });
    expect(createWxApi().getStorageSync('oops')).toBe('');
    expect(createWxApi().getStorageSync('n')).toBe('');
  });

  it('key 不存在 → 空串（与官方语义一致：不是 undefined）', () => {
    stubHost();
    expect(createWxApi().getStorageSync('nope')).toBe('');
  });

  it('setStorageSync 写进去能被 getStorageSync 读出来（往返）', () => {
    const { storage } = stubHost();
    const api = createWxApi();
    api.setStorageSync('token', 'tk-2');
    expect(storage.token).toBe('tk-2');
    expect(api.getStorageSync('token')).toBe('tk-2');
  });

  it('request 原样转发给宿主（不做任何改写——改写就等于又发明一套 HTTP 接口）', () => {
    const { requested } = stubHost();
    const option = { url: 'https://x.test', method: 'POST' as const, data: { a: 1 } };
    createWxApi().request(option);
    expect(requested[0]).toBe(option);
  });

  it('宿主没有 `getRealtimeLogManager` → 返回 undefined（方法本身是可选的）', () => {
    stubHost();
    expect(createWxApi().getRealtimeLogManager()).toBeUndefined();
  });

  it('有 `getRealtimeLogManager` → 原样返回日志器', () => {
    const logger: RealtimeLogger = { info: () => undefined };
    stubHost({ logger });
    expect(createWxApi().getRealtimeLogManager()).toBe(logger);
  });
});

describe('注入是"部分覆盖"，不是"整体替换"', () => {
  it('只覆盖 request 时，storage 仍走真实宿主（不会静默变成 undefined）', () => {
    // @why 这条钉的是 `createWxApi` 的 @why：整体替换的后果是
    //      "测试里没替换到的能力变成 undefined"，表现为换个用例就 `undefined is not a function`。
    const { storage } = stubHost({ storage: { token: 'tk-3' } });
    const api = createWxApi({ request: () => undefined });
    api.setStorageSync('token', 'tk-4');
    expect(storage.token).toBe('tk-4');
    expect(api.getStorageSync('token')).toBe('tk-4');
  });

  it('覆盖的能力真的被用上（注入不是装饰）', () => {
    stubHost();
    const seen: unknown[] = [];
    const api = createWxApi({
      request: (o) => {
        seen.push(o);
      },
    });
    api.request({ url: 'https://x.test' });
    expect(seen).toHaveLength(1);
  });

  it('**不注入也不装宿主**时，覆盖项仍然可用（覆盖先于宿主）', () => {
    const api = createWxApi({ getStorageSync: () => 'injected' });
    expect(api.getStorageSync('token')).toBe('injected');
  });
});
