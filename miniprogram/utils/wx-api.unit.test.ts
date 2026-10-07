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
import { createWxApi, type RealtimeLogger, type WxAccountInfo } from './wx-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个假宿主，并记录被读到的调用。 */
function stubHost(
  over: {
    storage?: Record<string, unknown>;
    logger?: RealtimeLogger | undefined;
    accountInfo?: WxAccountInfo | undefined;
  } = {},
) {
  const seen: string[] = [];
  const storage: Record<string, unknown> = { ...(over.storage ?? {}) };
  const requested: unknown[] = [];
  const navigated: string[] = [];
  const backDelta: number[] = [];
  const modals: Array<{ success?: (res: { confirm: boolean; cancel: boolean }) => void }> = [];
  const payments: Array<{ package?: string }> = [];
  const clipped: string[] = [];
  const redirected: string[] = [];
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
    removeStorageSync: (k: string) => {
      seen.push(`remove:${k}`);
      delete storage[k];
    },
    navigateTo: (o: { url: string }) => {
      seen.push(`navigate:${o.url}`);
      navigated.push(o.url);
    },
    login: (o: { success?: (res: { code: string }) => void }) => {
      seen.push('login');
      o.success?.({ code: 'host-code-1' });
    },
    navigateBack: (o: { delta?: number }) => {
      seen.push(`back:${String(o?.delta ?? 1)}`);
      backDelta.push(o?.delta ?? 1);
    },
    showModal: (o: { success?: (res: { confirm: boolean; cancel: boolean }) => void }) => {
      seen.push('modal');
      modals.push(o);
      o.success?.({ confirm: true, cancel: false });
    },
    requestPayment: (o: { package?: string; success?: () => void }) => {
      seen.push(`pay:${o.package ?? ''}`);
      payments.push(o);
      o.success?.();
    },
    setClipboardData: (o: { data?: string; success?: () => void }) => {
      seen.push(`clip:${o.data ?? ''}`);
      clipped.push(o.data ?? '');
      o.success?.();
    },
    redirectTo: (o: { url: string }) => {
      seen.push(`redirect:${o.url}`);
      redirected.push(o.url);
    },
    ...(over.logger === undefined ? {} : { getRealtimeLogManager: () => over.logger }),
    ...(over.accountInfo === undefined
      ? {}
      : { getAccountInfoSync: () => over.accountInfo as WxAccountInfo }),
  });
  return { seen, storage, requested, navigated, backDelta, modals, payments, clipped, redirected };
}

describe('宿主缺失时必须响亮失败（不是静默 undefined）', () => {
  it('不注入、也没有 `globalThis.wx` → 调用时抛，且错误信息指向"宿主不存在"', () => {
    const api = createWxApi();
    expect(() => api.request({ url: 'https://x.test' })).toThrow(/wx 宿主不存在/);
    expect(() => api.getStorageSync('token')).toThrow(/wx 宿主不存在/);
    expect(() => api.setStorageSync('token', 't')).toThrow(/wx 宿主不存在/);
    expect(() => api.removeStorageSync('token')).toThrow(/wx 宿主不存在/);
    expect(() => api.getRealtimeLogManager()).toThrow(/wx 宿主不存在/);
    expect(() => api.navigateTo({ url: '/pages/home/index' })).toThrow(/wx 宿主不存在/);
    expect(() => api.login({})).toThrow(/wx 宿主不存在/);
    expect(() => api.navigateBack()).toThrow(/wx 宿主不存在/);
    expect(() => api.showModal({})).toThrow(/wx 宿主不存在/);
    expect(() =>
      api.requestPayment({
        timeStamp: '1',
        nonceStr: 'n',
        package: 'prepay_id=x',
        signType: 'RSA',
        paySign: 's',
      }),
    ).toThrow(/wx 宿主不存在/);
    expect(() => api.setClipboardData({ data: 'x' })).toThrow(/wx 宿主不存在/);
    expect(() => api.redirectTo({ url: '/pages/order/index' })).toThrow(/wx 宿主不存在/);
    expect(() => api.getAccountInfoSync()).toThrow(/wx 宿主不存在/);
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

  it('removeStorageSync 真的删掉（不是写回空串——那条 key 会继续占配额）', () => {
    const { storage, seen } = stubHost({ storage: { token: 'tk-2' } });
    createWxApi().removeStorageSync('token');
    expect(storage.token).toBeUndefined();
    expect(seen).toContain('remove:token');
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

  /**
   * @why 这两条钉的是 B4 的环境判据来源。宿主没有这个方法（基础库 < 2.2.2）必须返回
   *      **undefined**（由 config.js 回落 develop），而不是抛、也不是返回一个猜出来的对象——
   *      猜的方向一旦反了就是"体验版打到了生产库"。@see wx-api.ts @limitation 十四
   */
  it('宿主没有 `getAccountInfoSync` → undefined（基础库过低，由上层回落 develop）', () => {
    stubHost();
    expect(createWxApi().getAccountInfoSync()).toBeUndefined();
  });

  it('有 `getAccountInfoSync` → 原样返回（envVersion 是唯一的运行环境判据）', () => {
    const accountInfo: WxAccountInfo = { miniProgram: { envVersion: 'release' } };
    stubHost({ accountInfo });
    expect(createWxApi().getAccountInfoSync()).toBe(accountInfo);
    expect(createWxApi().getAccountInfoSync()?.miniProgram?.envVersion).toBe('release');
  });

  it('navigateTo 原样转发 url（不做拼接、不补斜杠——路径错就该在真机上响亮失败）', () => {
    // @why 这条钉的是 `wx-api.ts` 的 @limitation 六："只登记不兜底"。
    //      若哪天有人在这里加"自动补 /pages 前缀"，本用例会红——
    //      那种兜底的表现是"路径拼错了居然还能跳"，于是错误路径长期不被发现。
    const { navigated } = stubHost();
    createWxApi().navigateTo({ url: '/pages/detail/index?id=p-1' });
    expect(navigated).toEqual(['/pages/detail/index?id=p-1']);
  });

  it('login 原样转发（回调式不包 Promise——Promise 化在 auth-session，一处）', () => {
    stubHost();
    let code = '';
    createWxApi().login({ success: (res) => (code = res.code) });
    expect(code).toBe('host-code-1');
  });

  it('navigateBack 原样转发 delta（不补默认值——默认由宿主定，@limitation 八）', () => {
    // @why 这条钉的是"只登记不兜底"：若在这里写 `delta ?? 1` 再传给宿主，
    //      "调用方没传 delta"这件事就被吞掉了，而官方默认值改了我们也不知道。
    const { backDelta } = stubHost();
    createWxApi().navigateBack({ delta: 2 });
    expect(backDelta).toEqual([2]);
  });

  it('⚠️ navigateBack 不传参也要能调（出栈一层是常态），且不报错', () => {
    const { seen } = stubHost();
    expect(() => createWxApi().navigateBack()).not.toThrow();
    expect(seen).toContain('back:1');
  });

  it('showModal 原样转发并把 confirm 回给调用方（删除确认靠它）', () => {
    const { modals } = stubHost();
    let confirmed: boolean | null = null;
    createWxApi().showModal({
      title: '删除地址',
      confirmText: '删除',
      success: (res) => (confirmed = res.confirm),
    });
    expect(modals).toHaveLength(1);
    expect(confirmed).toBe(true);
  });

  it('requestPayment 五参数原样转发（含 `package`——改名就要维护映射表）', () => {
    const { payments } = stubHost();
    const option = {
      timeStamp: '1712345678',
      nonceStr: 'n-abcdef1234',
      package: 'prepay_id=wx1234567890',
      signType: 'RSA',
      paySign: 'sign-xxxx',
      success: () => undefined,
    };
    createWxApi().requestPayment(option);
    expect(payments[0]?.package).toBe('prepay_id=wx1234567890');
    expect(payments[0]).toBe(option);
  });

  it('⚠️ 不判"用户取消"——cancel 与失败一视同仁（@limitation 十）', () => {
    // @why 宿主 fail 的 errMsg 是文案（含 "cancel"），解析它等于把宿主文案当契约；
    //      上层对两者同样处理：停在支付页，订单仍是 pending_payment。
    const { seen } = stubHost();
    createWxApi().requestPayment({
      timeStamp: '1',
      nonceStr: 'n',
      package: 'p',
      signType: 'RSA',
      paySign: 's',
    });
    expect(seen).toContain('pay:p');
  });

  it('setClipboardData 原样转发 data（只复制，不代跳——@limitation 十一）', () => {
    const { clipped } = stubHost();
    createWxApi().setClipboardData({ data: 'https://pay.test/l/abc' });
    expect(clipped).toEqual(['https://pay.test/l/abc']);
  });

  it('redirectTo 原样转发 url（不补前缀——@limitation 十二，同 navigateTo）', () => {
    const { redirected } = stubHost();
    createWxApi().redirectTo({ url: '/pages/order/index' });
    expect(redirected).toEqual(['/pages/order/index']);
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

describe('隐私 API（剩余清单 4-3）：宿主有才挂，没有就是 undefined', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('宿主有 getPrivacySetting / requirePrivacyAuthorize → 原样转发', () => {
    const seen: string[] = [];
    vi.stubGlobal('wx', {
      getPrivacySetting: () => seen.push('get'),
      requirePrivacyAuthorize: () => seen.push('require'),
    });
    const api = createWxApi();
    api.getPrivacySetting?.({});
    api.requirePrivacyAuthorize?.({});
    expect(seen).toEqual(['get', 'require']);
  });

  it('基础库过低（宿主没有这两个方法）→ undefined（由 privacy.js 判 unsupported）', () => {
    vi.stubGlobal('wx', {});
    const api = createWxApi();
    expect(api.getPrivacySetting).toBeUndefined();
    expect(api.requirePrivacyAuthorize).toBeUndefined();
  });
});

describe('getUpdateManager（剩余清单 4-9）：宿主有才挂', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('宿主有 → 返回宿主的管理器；没有 → undefined', () => {
    const mgr = {
      onUpdateReady: () => undefined,
      onUpdateFailed: () => undefined,
      applyUpdate: () => undefined,
    };
    vi.stubGlobal('wx', { getUpdateManager: () => mgr });
    expect(createWxApi().getUpdateManager?.()).toBe(mgr);
    vi.stubGlobal('wx', {});
    expect(createWxApi().getUpdateManager).toBeUndefined();
  });
});

describe('getPlatform（P2-33：开发版区分模拟器与真机）', () => {
  it('有 getDeviceInfo → 取它的 platform', () => {
    vi.stubGlobal('wx', { getDeviceInfo: () => ({ platform: 'ios' }) });
    try {
      expect(createWxApi().getPlatform()).toBe('ios');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('没有 getDeviceInfo、有 getSystemInfoSync（旧基础库）→ 退回它', () => {
    vi.stubGlobal('wx', { getSystemInfoSync: () => ({ platform: 'devtools' }) });
    try {
      expect(createWxApi().getPlatform()).toBe('devtools');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('两个都没有 / 返回形状不对 → undefined（由 config.js 保持原行为，不猜）', () => {
    vi.stubGlobal('wx', {});
    try {
      expect(createWxApi().getPlatform()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('wx', { getDeviceInfo: () => ({ platform: 3 }) });
    try {
      expect(createWxApi().getPlatform()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
