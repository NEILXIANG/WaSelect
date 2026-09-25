/**
 * 职责：小程序宿主能力（`wx.*`）的**唯一入口**（F14 第一单元）。
 *
 * @why 业务代码直接写 `wx.request` / `wx.getStorageSync` 有三个后果：
 *      ① **不可测**：`wx` 是运行时注入的全局，Node 侧一 import 就可能崩，
 *         于是每个用到它的模块都要各自发明一套"怎么绕开"的写法——
 *         本仓库在写这个模块之前已经有三种（`typeof wx !== 'undefined'` 守卫、
 *         "模块顶层不引用只在函数体里用"、测试注入 `deps.request`）。
 *         三种写法意味着"哪种是对的"没有答案。
 *      ② **错误形态不可控**：宿主缺失时崩在 `undefined.request` 这一行，
 *         报错信息指向业务代码，而不是"宿主不存在"。
 *      ③ **没有类型**：`wx.getStorageSync` 返回 `unknown`，每个调用方各写各的断言。
 *      收敛到一个入口后，这三点各有一处答案。
 *
 * @limitation 一：**只声明当前真用到的能力**（request / getStorageSync / setStorageSync /
 *              removeStorageSync / getRealtimeLogManager）。新增一个 wx API 就在这里加一个方法——
 *              不要预先铺满官方 API，铺了就会有人依赖上没被测试过的封装（本项目多次踩过"提前做是猜"）。
 * @limitation 二：`getStorageSync` 的契约是**只取字符串**：读到的不是字符串时一律当"没存过"（返回空串）。
 *              要存对象就先 JSON 序列化——小程序 storage 本身也是这个语义。
 *              这不是限制能力，是让"读出来到底是什么"在类型上就说清楚。
 * @limitation 三：**不吞异常**。storage 写失败、request 失败都原样往上抛：
 *              "token 没存上"若在这里被吞掉，表现是"用户每次都要重新登录"，
 *              而日志里什么都没有——那是最难查的一类问题（看起来像登录逻辑的 bug）。
 * @limitation 四：宿主在**每次调用时**取（`globalThis.wx`），不是 import 时取。
 *              这样本模块可以被 Node 侧单测 import：取不到 wx 只会在真正调用时才响亮失败。
 * @limitation 五：**没有 `wx.login` / `wx.getUserProfile` 等登录链**——登录业务在骨架期刻意留白
 *              （见 `app.js` 的 @limitation），等真做登录时再在这里登记，不预先加。
 *
 * @tradeoff 多一层转发换来可注入 + 可类型化 + 一处定义错误形态，
 *           代价是**所有 wx 用法都要先来这里登记**。忘登记的人会直接在业务代码里写 `wx.xxx`——
 *           已由 ESLint 的 `no-restricted-globals` 拦住（不是靠 review 记得）。
 *
 * @see docs/地基搭建清单.md F14；./request.js（第一个调用方）
 */

/** `wx.request` 的成功回调参数（只声明我们读的字段）。 */
export interface WxRequestSuccess {
  statusCode: number;
  data: unknown;
}

/** `wx.request` 的失败回调参数。 */
export interface WxRequestFail {
  errMsg?: string;
}

/** `wx.request` 的入参（**回调式**，与官方一致：不改成 Promise，见 @why）。 */
export interface WxRequestOption {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: unknown;
  header?: Record<string, string>;
  /** 毫秒。不传由宿主决定（官方默认 60000，对支付链路太长，调用方应当显式传）。 */
  timeout?: number;
  success?: (res: WxRequestSuccess) => void;
  fail?: (err: WxRequestFail) => void;
}

/**
 * 实时日志器（`wx.getRealtimeLogManager()` 的返回值）。
 *
 * @why 三个方法都标可选：官方在低版本基础库 / 部分场景下返回的对象方法不全，
 *      标成必填会让"方法不存在"变成运行期 `undefined is not a function`；
 *      标可选则逼调用方写 `?.`（我们在 `request.js` 里就是这么用的）。
 */
export interface RealtimeLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** 宿主能力的子集。**新增 wx API 就在这里加一个方法**。 */
export interface WxApi {
  request(option: WxRequestOption): void;
  /** 取字符串值；不存在或非字符串 → 空串。@see @limitation 二 */
  getStorageSync(key: string): string;
  setStorageSync(key: string, value: string): void;
  removeStorageSync(key: string): void;
  getRealtimeLogManager(): RealtimeLogger | undefined;
}

/** 宿主（`globalThis.wx`）上我们真正读到的形状——比 `WxApi` 宽松，因为官方签名返回 `unknown`。 */
interface WxHost {
  request(option: WxRequestOption): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  getRealtimeLogManager?: () => RealtimeLogger | undefined;
}

/**
 * 取宿主。
 *
 * @why **响亮失败**而不是返回 undefined：宿主不存在只有两种可能——
 *      ① 这段代码跑在 Node 里（测试忘了注入）；② 跑在了非小程序的环境里。
 *      两种都是**编程错误**，越早炸越好。静默返回 undefined 会让崩溃推迟到
 *      `undefined.request(...)`，报错信息指向业务行而不是根因。
 */
function host(): WxHost {
  const w = (globalThis as { wx?: WxHost }).wx;
  if (w === undefined) {
    throw new Error(
      'wx 宿主不存在：wx-api 只能在小程序运行时里调用（测试请 createWxApi({…}) 注入假实现）',
    );
  }
  return w;
}

/**
 * 造一个宿主能力入口。
 *
 * @param over 覆盖项——**测试注入假实现用**；生产不传。
 * @why 用"部分覆盖"而不是"整体替换"：调用方只关心自己要替换的那一个能力，
 *      其余仍走真实宿主。整体替换的后果是"测试里没替换到的能力静默变成 undefined"，
 *      表现为"这个用例能跑，换个用例就 undefined 崩"。
 */
export function createWxApi(over: Partial<WxApi> = {}): WxApi {
  const real: WxApi = {
    request: (option) => {
      host().request(option);
    },
    getStorageSync: (key) => {
      const value = host().getStorageSync(key);
      return typeof value === 'string' ? value : '';
    },
    setStorageSync: (key, value) => {
      host().setStorageSync(key, value);
    },
    removeStorageSync: (key) => {
      host().removeStorageSync(key);
    },
    getRealtimeLogManager: () => host().getRealtimeLogManager?.(),
  };
  return { ...real, ...over };
}
